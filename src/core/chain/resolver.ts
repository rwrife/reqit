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

export interface ChainStore {
  recordRequest(name: string, record: ChainRequestRecord): void;
  recordResponse(name: string, record: ChainResponseRecord): void;
  getRequest(name: string): ChainRequestRecord | undefined;
  getResponse(name: string): ChainResponseRecord | undefined;
  recordedNames(): string[];
  clear(): void;
}

/**
 * Create an empty per-run chain store. Names are matched case-sensitively
 * (they are identifiers); response headers are matched case-insensitively.
 * Nothing here persists to disk and no values are treated as secrets by the
 * store itself — redaction is the caller's responsibility (see `secret`
 * flags on captures).
 */
export function createChainStore(): ChainStore {
  const requests = new Map<string, ChainRequestRecord>();
  const responses = new Map<string, ChainResponseRecord>();
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
      return requests.get(name);
    },
    getResponse(name) {
      return responses.get(name);
    },
    recordedNames() {
      return [...responses.keys()];
    },
    clear() {
      requests.clear();
      responses.clear();
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

const REF_RE = /\{\{\s*([^}]+?)\s*\}\}/g;

function serializeValue(value: unknown): string {
  if (typeof value === 'string') return value;
  if (value === null) return 'null';
  if (typeof value === 'number' || typeof value === 'boolean') return String(value);
  return JSON.stringify(value);
}

function lookupHeader(headers: Record<string, string>, wanted: string): string | undefined {
  const lowered = wanted.toLowerCase();
  for (const [name, value] of Object.entries(headers)) {
    if (name.toLowerCase() === lowered) return value;
  }
  return undefined;
}

function resolveReference(ref: ChainReference, store: ChainStore): { value: string } | { error: string } {
  if (ref.kind === 'request') {
    const rec = store.getRequest(ref.requestName);
    if (!rec) {
      return { error: `no recorded request named '${ref.requestName}' (run it first via a named file run)` };
    }
    let doc: unknown;
    try {
      doc = JSON.parse(rec.body);
    } catch {
      return { error: `recorded request body for '${ref.requestName}' is not valid JSON` };
    }
    const q = queryJsonPath(doc, ref.path);
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
  let doc: unknown;
  try {
    doc = JSON.parse(rec.body);
  } catch {
    return { error: `recorded response body for '${ref.requestName}' is not valid JSON` };
  }
  const q = queryJsonPath(doc, ref.path);
  if (!q.found) return { error: q.error };
  return { value: serializeValue(q.value) };
}

/**
 * Substitute every chain reference in `source` using `store`. Non-chain
 * references are left untouched (with no diagnostics) so the ordinary
 * env/built-in substitution pass can process them later. Unresolved chain
 * references are reported as diagnostics and left in place so requests fail
 * loudly instead of silently sending a literal `{{...}}`.
 */
export function resolveChainText(source: string, store: ChainStore): ChainSubstituteResult {
  const diagnostics: ChainDiagnostic[] = [];
  const text = source.replace(REF_RE, (match, raw: string) => {
    const inner = raw.trim();
    const ref = parseChainReference(inner);
    if (ref === null) return match;
    const resolved = resolveReference(ref, store);
    if ('error' in resolved) {
      diagnostics.push({ reference: match, variable: inner, message: resolved.error });
      return match;
    }
    return resolved.value;
  });
  return { text, diagnostics };
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
  const push = (items: ChainDiagnostic[]): void => {
    for (const d of items) diagnostics.push(d);
  };
  const url = resolveChainText(req.url, store);
  push(url.diagnostics);
  const headers = req.headers.map((h) => {
    const value = resolveChainText(h.value, store);
    push(value.diagnostics);
    return { name: h.name, value: value.text };
  });
  const body = resolveChainText(req.body, store);
  push(body.diagnostics);
  return { url: url.text, headers, body: body.text, diagnostics };
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
