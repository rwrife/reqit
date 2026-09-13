/**
 * Pure request-chaining resolver for `# @name` + `{{ref}}` captures (issue #47).
 *
 * A "chain store" is a per-run, in-memory record of requests that were sent
 * and responses that came back, keyed by the `# @name <ident>` directive of
 * each request. The resolver substitutes chain references into text:
 *
 *   {{name.response.status}}                  — numeric status as text
 *   {{name.response.headers.<Header-Name>}}   — case-insensitive header lookup
 *   {{name.response.body.$.path.to.value}}    — JSONPath subset into the JSON body
 *   {{name.request.body.$.path.to.value}}     — JSONPath into the sent request body
 *
 * Everything here is payload-pure: no VS Code, no network, no persistence.
 * Captures are per-run in memory only (issue #47 — nothing is written to
 * disk). Non-chain references (`{{envVar}}`, `{{$guid}}`, …) pass through
 * untouched so the ordinary environment substitution pass can handle them.
 */

import { z } from 'zod';

import { parseJsonPath, queryJsonPath } from './jsonpath.js';

/** Identifier grammar for `# @name` and capture names (issue #47). */
const NAME_RE = /^[A-Za-z_][A-Za-z0-9_]*$/;

/** A recorded chain reference parsed out of `{{ ... }}` text. */
export type ChainReference =
  | { kind: 'response'; part: 'status'; requestName: string }
  | { kind: 'response'; part: 'headers'; requestName: string; headerName: string }
  | { kind: 'response'; part: 'body'; requestName: string; path: string }
  | { kind: 'request'; part: 'body'; requestName: string; path: string };

const CHAIN_REF_RE =
  /^([A-Za-z_][A-Za-z0-9_]*)\.(response|request)\.(status|headers|body)(?:\.(.+))?$/;

/** Recorded namespaces that mark a reference as chain-intent. */
const CHAIN_NAMESPACES: readonly ('response' | 'request')[] = ['response', 'request'];

/**
 * Parse one `{{...}}` inner reference into a chain reference, or return
 * `null` when the reference is not a chain ref (env var, built-in `$...`,
 * or a malformed combination such as `name.request.status`).
 */
export function parseChainReference(ref: string): ChainReference | null {
  const m = CHAIN_REF_RE.exec(ref);
  if (!m) return null;
  const [, requestName, kindRaw, partRaw, restRaw] = m;
  const kind = kindRaw as 'response' | 'request';
  const part = partRaw as 'status' | 'headers' | 'body';
  const rest = restRaw === undefined ? undefined : restRaw.trim();

  if (kind === 'request') {
    // Only `name.request.body.$.path` is defined.
    if (part !== 'body' || rest === undefined || !rest.startsWith('$')) return null;
    if ('error' in parseJsonPath(rest)) return null;
    return { kind, part, requestName, path: rest };
  }

  if (part === 'status') {
    if (rest !== undefined && rest.length > 0) return null;
    return { kind, part: 'status', requestName };
  }
  if (part === 'headers') {
    if (rest === undefined || rest.length === 0) return null;
    return { kind, part: 'headers', requestName, headerName: rest };
  }
  // response body: requires a JSONPath starting at `$`.
  if (rest === undefined || !rest.startsWith('$')) return null;
  if ('error' in parseJsonPath(rest)) return null;
  return { kind, part: 'body', requestName, path: rest };
}

// ---------------------------------------------------------------------------
// Capture directives (`# @capture name[: type [secret]] = $.path`)
// ---------------------------------------------------------------------------

export type CaptureType = 'string' | 'number' | 'boolean';

export interface ParsedCapture {
  name: string;
  /** Declared type from `name: type`, or `null` when untyped. */
  declaredType: CaptureType | null;
  secret: boolean;
  path: string;
}

export interface CaptureParseError {
  error: string;
}

const CAPTURE_RE =
  /^([A-Za-z_][A-Za-z0-9_]*)\s*(?::\s*([A-Za-z]+)(\s+secret)?)?\s*=\s*(\S.*)$/;

const CAPTURE_TYPES: readonly CaptureType[] = ['string', 'number', 'boolean'];

/** Parse the value after `# @capture` (already de-commented). */
export function parseCaptureDirective(
  source: string,
): ParsedCapture | CaptureParseError {
  const m = CAPTURE_RE.exec(source.trim());
  if (!m) {
    return {
      error: `Invalid capture directive: "${source}" (expected name[: type [secret]] = $.path)`,
    };
  }
  const [, name, typeRaw, secretRaw, pathRaw] = m;
  let declaredType: CaptureType | null = null;
  if (typeRaw !== undefined) {
    if (!CAPTURE_TYPES.includes(typeRaw as CaptureType)) {
      return { error: `Unknown capture type "${typeRaw}" (expected string | number | boolean)` };
    }
    declaredType = typeRaw as CaptureType;
  }
  const secret = secretRaw !== undefined;
  if (secret && declaredType === null) {
    return { error: '`secret` requires a declared type, e.g. `tok: string secret`' };
  }
  const path = pathRaw.trim();
  if (!path.startsWith('$')) {
    return { error: `Capture path must be a JSONPath starting with '$': "${pathRaw.trim()}"` };
  }
  if ('error' in parseJsonPath(path)) {
    return { error: `Unsupported capture path "${path}" (subset: $, .key, ['key'], [n])` };
  }
  return { name, declaredType, secret, path };
}

const TYPE_SCHEMAS: Record<CaptureType, z.ZodTypeAny> = {
  string: z.string(),
  number: z.number().finite(),
  boolean: z.boolean(),
};

export interface AppliedCapture {
  name: string;
  value: unknown;
  secret: boolean;
}

export interface CaptureApplyError {
  error: string;
}

/**
 * Evaluate a capture directive against a recorded response, validating the
 * captured value against the declared type when one was given.
 */
export function applyCapture(
  directiveSource: string,
  response: ChainResponseRecord,
): AppliedCapture | CaptureApplyError {
  const parsed = parseCaptureDirective(directiveSource);
  if ('error' in parsed) return parsed;

  let doc: unknown;
  try {
    doc = JSON.parse(response.body);
  } catch {
    return { error: `Response body is not valid JSON; cannot capture ${parsed.path}` };
  }
  const q = queryJsonPath(doc, parsed.path);
  if (!q.found) return { error: `Capture ${parsed.name}: ${q.error}` };

  if (parsed.declaredType !== null) {
    const schema = TYPE_SCHEMAS[parsed.declaredType];
    const check = schema.safeParse(q.value);
    if (!check.success) {
      return {
        error: `Capture ${parsed.name}: value at ${parsed.path} failed ${parsed.declaredType} validation`,
      };
    }
  }
  return { name: parsed.name, value: q.value, secret: parsed.secret };
}

// ---------------------------------------------------------------------------
// Chain store (per-run, in-memory only)
// ---------------------------------------------------------------------------

export interface ChainRequestRecord {
  /** The body that was actually sent (after env substitution). */
  body: string;
}

export interface ChainResponseRecord {
  status: number;
  headers: Record<string, string>;
  body: string;
}

/** A captured value stored for the run (capture values are never persisted). */
export interface CaptureRecord {
  value: unknown;
  secret: boolean;
}

export interface ChainStore {
  recordRequest(name: string, record: ChainRequestRecord): void;
  recordResponse(name: string, record: ChainResponseRecord): void;
  getRequest(name: string): ChainRequestRecord | undefined;
  getResponse(name: string): ChainResponseRecord | undefined;
  recordedNames(): string[];
  /**
   * Store capture results for the run. Returns human-readable diagnostics
   * (invalid or duplicate names); valid entries are stored even when some
   * entries in the same call are rejected (per-entry error collection).
   * Existing captures are never overwritten — duplicates are errors.
   */
  recordCaptures(captures: readonly AppliedCapture[]): string[];
  getCapture(name: string): CaptureRecord | undefined;
  captureNames(): string[];
  clear(): void;
}

/**
 * Deep-copy a capture value defensively on store/retrieve. Uses structured
 * clone where available for JSON-shaped data; primitives and anything
 * structuredClone rejects (functions, symbols, class instances) are stored
 * by reference — captures come from `applyCapture`, whose values are
 * always JSON-parsed document fragments.
 */
function cloneCaptureValue(value: unknown): unknown {
  if (value === null || typeof value !== 'object') return value;
  try {
    return structuredClone(value);
  } catch {
    return value;
  }
}

/**
 * Create an empty per-run chain store. Names are matched case-sensitively
 * (they are identifiers); response headers are matched case-insensitively.
 * Nothing here persists to disk and no values are treated as secrets by the
 * store itself — redaction is the caller's responsibility (see `secret`
 * flags on captures). Getters return defensive copies (capture values are
 * deep-copied for JSON-shaped data) so a caller mutating a returned record
 * can never rewrite stored history.
 */
export function createChainStore(): ChainStore {
  const requests = new Map<string, ChainRequestRecord>();
  const responses = new Map<string, ChainResponseRecord>();
  const captures = new Map<string, CaptureRecord>();
  return {
    recordRequest(name, record) {
      requests.set(name, { body: record.body });
    },
    recordResponse(name, record) {
      // Copy defensively so later caller mutations cannot rewrite history.
      responses.set(name, {
        status: record.status,
        headers: { ...record.headers },
        body: record.body,
      });
    },
    getRequest(name) {
      const rec = requests.get(name);
      return rec ? { body: rec.body } : undefined;
    },
    getResponse(name) {
      const rec = responses.get(name);
      return rec ? { status: rec.status, headers: { ...rec.headers }, body: rec.body } : undefined;
    },
    recordedNames() {
      return [...responses.keys()];
    },
    recordCaptures(capturesToStore) {
      const diagnostics: string[] = [];
      const batchSeen = new Set<string>();
      for (const cap of capturesToStore) {
        if (!NAME_RE.test(cap.name)) {
          diagnostics.push(
            `Invalid capture name '${cap.name}' (must start with a letter or underscore; letters, digits, underscore only)`,
          );
          continue;
        }
        if (captures.has(cap.name) || batchSeen.has(cap.name)) {
          diagnostics.push(`duplicate capture name '${cap.name}' (captures must be unique per run)`);
          continue;
        }
        batchSeen.add(cap.name);
        captures.set(cap.name, { value: cloneCaptureValue(cap.value), secret: cap.secret });
      }
      return diagnostics;
    },
    getCapture(name) {
      const rec = captures.get(name);
      return rec ? { value: cloneCaptureValue(rec.value), secret: rec.secret } : undefined;
    },
    captureNames() {
      return [...captures.keys()];
    },
    clear() {
      requests.clear();
      responses.clear();
      captures.clear();
    },
  };
}

// ---------------------------------------------------------------------------
// Resolution
// ---------------------------------------------------------------------------

export interface ChainDiagnostic {
  /** The full `{{...}}` reference text. */
  reference: string;
  /** The inner reference, e.g. `login.response.body.$.token`. */
  variable: string;
  message: string;
}

export interface ChainSubstituteResult {
  text: string;
  diagnostics: ChainDiagnostic[];
}

/**
 * Hard bound on how many chain references one resolution pass will act on.
 * Overflow references stay literal (with one diagnostic) so hostile text
 * cannot amplify work to O(references x body size).
 */
export const MAX_CHAIN_REFS_PER_PASS = 100;

function serializeValue(value: unknown): string {
  if (typeof value === 'string') return value;
  if (value === null || value === undefined) return 'null';
  if (typeof value === 'number' || typeof value === 'boolean') return String(value);
  return JSON.stringify(value) ?? 'null';
}

function lookupHeader(headers: Record<string, string>, wanted: string): string | undefined {
  const lowered = wanted.toLowerCase();
  for (const [name, value] of Object.entries(headers)) {
    if (name.toLowerCase() === lowered) return value;
  }
  return undefined;
}

/**
 * Per-pass resolution context: caches parsed JSON bodies (each recorded body
 * is parsed at most once per pass) and enforces the reference bound.
 */
interface ResolutionContext {
  store: ChainStore;
  jsonCache: Map<string, { ok: true; doc: unknown } | { ok: false }>;
  chainRefs: number;
  boundDiagPosted: boolean;
}

function createResolutionContext(store: ChainStore): ResolutionContext {
  return { store, jsonCache: new Map(), chainRefs: 0, boundDiagPosted: false };
}

function parsedBody(
  ctx: ResolutionContext,
  key: string,
  raw: string,
): { ok: true; doc: unknown } | { ok: false } {
  const cached = ctx.jsonCache.get(key);
  if (cached) return cached;
  let result: { ok: true; doc: unknown } | { ok: false };
  try {
    result = { ok: true, doc: JSON.parse(raw) };
  } catch {
    result = { ok: false };
  }
  ctx.jsonCache.set(key, result);
  return result;
}

/**
 * Classify a `{{...}}` inner reference for `store`:
 *  - a valid chain reference -> `{ ref }`
 *  - a malformed chain reference bound to a RECORDED name -> `{ malformed }`
 *    with an actionable message (fails loudly, never silently passed to env)
 *  - anything else -> `null` (ordinary env/built-in reference, passed through)
 *
 * Chain intent is recognized by EXACT namespace segments:
 * `<name>.response.…` / `<name>.request.…` where `<name>` has a recorded
 * entry under that namespace. Any non-valid remainder then produces a
 * diagnostic (missing part, empty/doubled dots, unknown part, bad path),
 * so `login.response`, `login.response.`, `login.response..status`, and
 * `login.response.1bad` can never hide as env variables. A segment like
 * `responseX` is NOT a namespace, so `login.responseX` stays an ordinary
 * dotted env name.
 */
export function classifyChainReference(
  inner: string,
  store: ChainStore,
): { ref: ChainReference } | { malformed: string } | null {
  const ref = parseChainReference(inner);
  if (ref !== null) return { ref };

  const firstDot = inner.indexOf('.');
  if (firstDot <= 0) return null;
  const name = inner.slice(0, firstDot);
  if (!NAME_RE.test(name)) return null;
  const rest = inner.slice(firstDot + 1);
  const ns = CHAIN_NAMESPACES.find((n) => rest === n || rest.startsWith(`${n}.`));
  if (ns === undefined) return null;

  const recorded = ns === 'response' ? store.getResponse(name) : store.getRequest(name);
  if (recorded === undefined) return null; // indistinguishable from a dotted env-var name

  const remainder = rest.slice(ns.length + 1); // text after `<name>.<ns>.`
  const expected =
    ns === 'request'
      ? `'${name}.request.body.$.path'`
      : `'${name}.response.status' | '${name}.response.headers.<Header-Name>' | '${name}.response.body.$.path'`;
  if (ns === 'request') {
    if (remainder === '' ) {
      return { malformed: `request chaining needs a body path: expected ${expected} (got '${inner}')` };
    }
    const part = remainder.split('.')[0];
    if (part !== 'body') {
      return { malformed: `request chaining only supports 'body' (got '${inner}'; expected ${expected})` };
    }
    return { malformed: `request body reference needs a JSONPath starting with '$': '${inner}'` };
  }
  if (remainder === '') {
    return { malformed: `response reference missing a part: expected ${expected} (got '${inner}')` };
  }
  const part = remainder.split('.')[0];
  if (part === '') {
    return { malformed: `empty chain part in '${inner}' (expected ${expected})` };
  }
  if (part === 'status') {
    return { malformed: `'${name}.response.status' takes no sub-path (got '${inner}')` };
  }
  if (part === 'headers') {
    return { malformed: `header reference missing a header name: '${inner}' (expected '${name}.response.headers.<Header-Name>')` };
  }
  if (part === 'body') {
    return { malformed: `response body reference needs a JSONPath starting with '$': '${inner}'` };
  }
  return {
    malformed: `unknown chain part '${part}' for '${name}.response' (expected ${expected})`,
  };
}

function resolveReference(ref: ChainReference, ctx: ResolutionContext): { value: string } | { error: string } {
  const { store } = ctx;
  if (ref.kind === 'request') {
    const rec = store.getRequest(ref.requestName);
    if (!rec) {
      return { error: `no recorded request named '${ref.requestName}' (run it first via a named file run)` };
    }
    const parsed = parsedBody(ctx, `req:${ref.requestName}`, rec.body);
    if (!parsed.ok) {
      return { error: `recorded request body for '${ref.requestName}' is not valid JSON` };
    }
    const q = queryJsonPath(parsed.doc, ref.path);
    if (!q.found) return { error: q.error };
    return { value: serializeValue(q.value) };
  }

  const rec = store.getResponse(ref.requestName);
  if (!rec) {
    return { error: `no recorded response for '${ref.requestName}' (send a request named '${ref.requestName}' first)` };
  }
  if (ref.part === 'status') return { value: String(rec.status) };
  if (ref.part === 'headers') {
    const v = lookupHeader(rec.headers, ref.headerName);
    if (v === undefined) {
      return { error: `no header '${ref.headerName}' in recorded response for '${ref.requestName}'` };
    }
    return { value: v };
  }
  const parsed = parsedBody(ctx, `resp:${ref.requestName}`, rec.body);
  if (!parsed.ok) {
    return { error: `recorded response body for '${ref.requestName}' is not valid JSON` };
  }
  const q = queryJsonPath(parsed.doc, ref.path);
  if (!q.found) return { error: q.error };
  return { value: serializeValue(q.value) };
}

/**
 * Scan `source` for `{{ ... }}` placeholders.
 *
 * Rules (fail-closed):
 *  - A candidate opens at `{{` and must close at the first top-level `}}`.
 *  - Quote mode is entered ONLY for a quote at a JSONPath `[` opener
 *    position (`[` + optional spaces + quote); a bare apostrophe in an
 *    env/header name (e.g. `X-O'Brien`) does NOT start a quoted span and
 *    cannot affect the `}}` terminator.
 *  - Inside a real quoted span ONLY the matching quote character closes it,
 *    so a JSON key may contain `]`, `}`, or even `}}`. An unterminated
 *    quoted span runs to end-of-input: the ENTIRE remaining text is
 *    abandoned (returned as untouched text, never rescanned).
 *  - A lone `}` inside a candidate (e.g. `{a}…`) abandons the candidate:
 *    scanning resumes AFTER the next `}}` terminator (or at end of input),
 *    so a placeholder nested inside the abandoned region can never resolve.
 *    The abandoned region is emitted byte-identically.
 *  - Empty placeholders (`{{}}`) are skipped and emitted verbatim.
 */
interface Placeholder {
  start: number;
  end: number;
  full: string;
  inner: string;
}

function nextDoubleBrace(source: string, from: number): number {
  for (let k = Math.max(from, 0); k < source.length - 1; k++) {
    if (source[k] === '}' && source[k + 1] === '}') return k;
  }
  return -1;
}

function findPlaceholders(source: string): Placeholder[] {
  const out: Placeholder[] = [];
  let i = 0;
  while (i < source.length - 1) {
    if (!(source[i] === '{' && source[i + 1] === '{')) {
      i += 1;
      continue;
    }
    // Candidate opened at i. Scan for the first top-level `}}`.
    let j = i + 2;
    let closed = -1;
    let abandoned = false;
    while (j < source.length) {
      const c = source[j];
      if (c === '}') {
        if (source[j + 1] === '}') {
          closed = j;
          break;
        }
        // lone `}` — not valid placeholder content; abandon candidate
        abandoned = true;
        break;
      }
      if (c === '[') {
        // possible JSONPath quoted key: '[' + optional spaces + quote
        let k = j + 1;
        while (k < source.length && source[k] === ' ') k += 1;
        const q = source[k];
        if (q === "'" || q === '"') {
          // Only the matching quote closes the span; `]`, `}`, `}}` are
          // ordinary key characters inside it.
          let m = k + 1;
          while (m < source.length && source[m] !== q) m += 1;
          if (m >= source.length) {
            // Unterminated quoted span reaches EOF: abandon through the end
            // of input. Advance j so recovery cannot resume after a nested
            // `}}` inside the still-open span.
            j = m;
            abandoned = true;
            break;
          }
          j = m + 1; // past the closing quote; `]` follows in the key text
          continue;
        }
        j = k; // plain subscript; continue scanning from after '['
        continue;
      }
      j += 1;
    }
    if (abandoned) {
      if (closed < 0 && j >= source.length) {
        // unterminated quoted span consumed everything
        break;
      }
      // Skip the whole abandoned region: resume after the next `}}`
      // terminator at/after the abandon point. Never resume INSIDE the
      // region — a nested placeholder there must not resolve.
      const term = nextDoubleBrace(source, j);
      i = term < 0 ? source.length : term + 2;
      continue;
    }
    if (closed < 0) {
      break; // unclosed candidate: nothing left that can resolve
    }
    const inner = source.slice(i + 2, closed).trim();
    if (inner.length > 0) {
      out.push({ start: i, end: closed + 2, full: source.slice(i, closed + 2), inner });
    }
    i = closed + 2;
  }
  return out;
}

/**
 * Substitute every chain reference in `source` using `store`. Non-chain
 * references are left untouched (with no diagnostics) so the ordinary
 * env/built-in substitution pass can process them later. Unresolved chain
 * references (and malformed chain references bound to a RECORDED name) are
 * reported as diagnostics and left in place so requests fail loudly instead
 * of silently sending a literal `{{...}}`. At most
 * MAX_CHAIN_REFS_PER_PASS references are acted on per pass; the overflow is
 * left literal with one diagnostic.
 */
export function resolveChainText(source: string, store: ChainStore): ChainSubstituteResult {
  return resolveChainTextWith(createResolutionContext(store), source);
}

function resolveChainTextWith(ctx: ResolutionContext, source: string): ChainSubstituteResult {
  const diagnostics: ChainDiagnostic[] = [];
  const placeholders = findPlaceholders(source);
  if (placeholders.length === 0) return { text: source, diagnostics };

  let out = '';
  let cursor = 0;
  for (const ph of placeholders) {
    out += source.slice(cursor, ph.start);
    cursor = ph.end;

    const classified = classifyChainReference(ph.inner, ctx.store);
    if (classified === null) {
      out += ph.full; // ordinary env/built-in reference
      continue;
    }
    if (ctx.chainRefs >= MAX_CHAIN_REFS_PER_PASS) {
      if (!ctx.boundDiagPosted) {
        ctx.boundDiagPosted = true;
        diagnostics.push({
          reference: ph.full,
          variable: ph.inner,
          message: `Too many chain references in one pass (limit ${MAX_CHAIN_REFS_PER_PASS}); remaining chain references left literal`,
        });
      }
      out += ph.full;
      continue;
    }
    ctx.chainRefs += 1;

    if ('malformed' in classified) {
      diagnostics.push({ reference: ph.full, variable: ph.inner, message: classified.malformed });
      out += ph.full;
      continue;
    }
    const resolved = resolveReference(classified.ref, ctx);
    if ('error' in resolved) {
      diagnostics.push({ reference: ph.full, variable: ph.inner, message: resolved.error });
      out += ph.full;
      continue;
    }
    out += resolved.value;
  }
  out += source.slice(cursor);
  return { text: out, diagnostics };
}

export interface ChainRequestInput {
  url: string;
  headers: Array<{ name: string; value: string }>;
  body: string;
}

export interface ChainRequestResult {
  url: string;
  headers: Array<{ name: string; value: string }>;
  body: string;
  diagnostics: ChainDiagnostic[];
}

/** Resolve chain references across a request's url, header values, and body. */
export function resolveChainRequest(
  req: ChainRequestInput,
  store: ChainStore,
): ChainRequestResult {
  const diagnostics: ChainDiagnostic[] = [];
  const ctx = createResolutionContext(store);
  const run = (text: string): string => {
    const r = resolveChainTextWith(ctx, text);
    for (const d of r.diagnostics) diagnostics.push(d);
    return r.text;
  };
  const url = run(req.url);
  const headers = req.headers.map((h) => ({ name: h.name, value: run(h.value) }));
  const body = run(req.body);
  return { url, headers, body, diagnostics };
}

// ---------------------------------------------------------------------------
// `# @name` validation
// ---------------------------------------------------------------------------

/**
 * Validate `# @name` identifiers across one file: alnum + underscore and
 * unique per file (issue #47). Returns human-readable diagnostics.
 */
export function validateRequestNames(names: readonly string[]): string[] {
  const diagnostics: string[] = [];
  const seen = new Set<string>();
  for (const name of names) {
    if (!NAME_RE.test(name)) {
      diagnostics.push(
        `Invalid request name '${name}' (must start with a letter or underscore; letters, digits, underscore only)`,
      );
      continue;
    }
    if (seen.has(name)) {
      diagnostics.push(`duplicate request name '${name}' (names must be unique per file)`);
      continue;
    }
    seen.add(name);
  }
  return diagnostics;
}
