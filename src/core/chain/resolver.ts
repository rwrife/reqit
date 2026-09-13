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

/**
 * Chain-SHAPED detector: `<ident>.response.<part>…` / `<ident>.request.<part>…`.
 * Used to distinguish a malformed chain reference bound to a RECORDED name
 * (fail loudly) from an ordinary dotted env-var name (pass through).
 */
const CHAIN_SHAPE_RE =
  /^([A-Za-z_][A-Za-z0-9_]*)(?:\.(response|request)(?:\.([A-Za-z_][A-Za-z0-9_]*)(.*))?)?$/;

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
 * Create an empty per-run chain store. Names are matched case-sensitively
 * (they are identifiers); response headers are matched case-insensitively.
 * Nothing here persists to disk and no values are treated as secrets by the
 * store itself — redaction is the caller's responsibility (see `secret`
 * flags on captures). Getters return defensive copies so a caller mutating
 * a returned record can never rewrite stored history.
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
        captures.set(cap.name, { value: cap.value, secret: cap.secret });
      }
      return diagnostics;
    },
    getCapture(name) {
      const rec = captures.get(name);
      return rec ? { value: rec.value, secret: rec.secret } : undefined;
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
 */
export function classifyChainReference(
  inner: string,
  store: ChainStore,
): { ref: ChainReference } | { malformed: string } | null {
  const ref = parseChainReference(inner);
  if (ref !== null) return { ref };

  const m = CHAIN_SHAPE_RE.exec(inner);
  if (!m) return null;
  const name = m[1];
  const kind = m[2] as 'response' | 'request' | undefined;
  const part = m[3];
  if (kind === undefined || part === undefined) return null;

  const recorded =
    kind === 'response' ? store.getResponse(name) !== undefined : store.getRequest(name) !== undefined;
  if (!recorded) return null; // indistinguishable from a dotted env-var name

  if (kind === 'request') {
    if (part !== 'body') {
      return { malformed: `request chaining only supports '${name}.request.body.$.path' (got '${inner}')` };
    }
    return { malformed: `request body reference needs a JSONPath starting with '$': '${inner}'` };
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
    malformed: `unknown chain part '${part}' for '${name}' (expected response.status | response.headers.<H> | response.body.$.path | request.body.$.path)`,
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
 * Scan `source` for `{{ ... }}` placeholders. Unlike a naive `[^}]+` regex,
 * this understands QUOTED spans inside a placeholder, so a chain body path
 * like `login.response.body.$['weird}key']` survives intact. Returns each
 * placeholder as `{ start, end, full, inner }` (inner is already trimmed);
 * text between placeholders is untouched and re-emitted verbatim, so
 * pass-through references are byte-identical to the input.
 */
interface Placeholder {
  start: number;
  end: number;
  full: string;
  inner: string;
}

function findPlaceholders(source: string): Placeholder[] {
  const out: Placeholder[] = [];
  let i = 0;
  while (i < source.length - 1) {
    if (source[i] === '{' && source[i + 1] === '{') {
      let j = i + 2;
      let closed = -1;
      while (j < source.length) {
        const c = source[j];
        if (c === "'" || c === '"') {
          // Skip to the matching quote; an unterminated quote cannot form a
          // valid placeholder, so bail out of this candidate.
          let k = j + 1;
          while (k < source.length && source[k] !== c) k += 1;
          if (k >= source.length) break;
          j = k + 1;
          continue;
        }
        if (c === '}' && source[j + 1] === '}') {
          closed = j;
          break;
        }
        j += 1;
      }
      if (closed >= 0) {
        const inner = source.slice(i + 2, closed).trim();
        if (inner.length > 0) {
          out.push({ start: i, end: closed + 2, full: source.slice(i, closed + 2), inner });
        }
        i = closed + 2;
        continue;
      }
      i += 2;
      continue;
    }
    i += 1;
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
