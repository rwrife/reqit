/**
 * Minimal, deterministic JSONPath subset for response/request chaining
 * (`# @name` + `{{ref.response.body.$.path}}` and `# @capture` refs).
 *
 * Design constraints (issue #47):
 *   - Pure module: no VS Code, no network, no dependencies.
 *   - No wildcard/slice/filter/recursive-descent — the grammar is bounded so
 *     imported collection data cannot trigger unbounded scans.
 *   - Property access is strict own-property (`Object.prototype.hasOwnProperty`)
 *     so a chain reference can never resolve to `Object.prototype` members
 *     like `constructor` or `toString`.
 *
 * Supported grammar:
 *   $                      root
 *   $.key                  identifier-ish key (any run of [A-Za-z0-9_-])
 *   $['key'] / $["key"]    quoted key (any inner characters except the quote)
 *   $[3]                   non-negative integer array index
 *   Chaining the above:    $.a.b[0]['c-d']
 *
 * Safety bounds:
 *   - Reserved prototype names (`__proto__`, `constructor`, `prototype`)
 *     are rejected as segment names at BOTH parse and evaluation time.
 *   - Paths are bounded to MAX_JSONPATH_DEPTH segments.
 */

export type JsonPathSegment =
  | { kind: 'key'; name: string }
  | { kind: 'index'; value: number };

/** Hard bound on path depth so hostile deep paths are rejected, not walked. */
export const MAX_JSONPATH_DEPTH = 64;

/** Names that must never be traversable, even as OWN hostile JSON keys. */
const RESERVED_SEGMENT_NAMES: ReadonlySet<string> = new Set([
  '__proto__',
  'constructor',
  'prototype',
]);

export interface JsonPathParsed {
  segments: JsonPathSegment[];
}

export interface JsonPathError {
  error: string;
}

export type ParseJsonPathResult = JsonPathParsed | JsonPathError;

export function parseJsonPath(path: string): ParseJsonPathResult {
  const src = path.trim();
  if (src.length === 0) return { error: 'JSONPath is empty' };
  if (src[0] !== '$') return { error: `JSONPath must start with '$': ${src}` };

  const segments: JsonPathSegment[] = [];
  const pushKey = (name: string): JsonPathError | null => {
    if (RESERVED_SEGMENT_NAMES.has(name)) {
      return { error: `Reserved segment name '${name}' is not allowed in JSONPath: ${src}` };
    }
    segments.push({ kind: 'key', name });
    return null;
  };
  let i = 1;
  // Expecting either `.` + key, or `[` + subscript, or end-of-input.
  while (i < src.length) {
    if (segments.length >= MAX_JSONPATH_DEPTH) {
      return { error: `JSONPath exceeds maximum depth of ${MAX_JSONPATH_DEPTH}: ${src}` };
    }
    const ch = src[i];
    if (ch === '.') {
      i += 1;
      const m = /^[A-Za-z0-9_-]+/.exec(src.slice(i));
      if (!m) return { error: `Invalid JSONPath near position ${i}: ${src}` };
      const err = pushKey(m[0]);
      if (err) return err;
      i += m[0].length;
      continue;
    }
    if (ch === '[') {
      i += 1;
      if (i >= src.length) return { error: `Unterminated '[' in JSONPath: ${src}` };
      const first = src[i];
      if (first === "'" || first === '"') {
        // Quote-aware scan: the key runs until the SAME quote char, then a
        // closing ']' must follow. Keys may therefore contain ] or }.
        let j = i + 1;
        while (j < src.length && src[j] !== first) j += 1;
        if (j >= src.length) return { error: `Unterminated quoted key in JSONPath: ${src}` };
        const name = src.slice(i + 1, j);
        if (src[j + 1] !== ']') {
          return { error: `Missing ']' after quoted key in JSONPath: ${src}` };
        }
        if (name.length === 0) return { error: `Empty quoted key in JSONPath: ${src}` };
        const err = pushKey(name);
        if (err) return err;
        i = j + 2;
        continue;
      }
      const close = src.indexOf(']', i);
      if (close === -1) return { error: `Unterminated '[' in JSONPath: ${src}` };
      const inner = src.slice(i, close);
      i = close + 1;
      if (inner.length === 0) return { error: `Empty '[]' subscript in JSONPath: ${src}` };
      if (/^\d+$/.test(inner)) {
        segments.push({ kind: 'index', value: Number.parseInt(inner, 10) });
        continue;
      }
      return { error: `Unsupported subscript '[${inner}]' in JSONPath: ${src}` };
    }
    return { error: `Invalid JSONPath near position ${i}: ${src}` };
  }
  return { segments };
}

export type JsonPathValueResult = { found: true; value: unknown };
export type JsonPathMissResult = { found: false; error: string };
export type JsonPathResult = JsonPathValueResult | JsonPathMissResult;

/**
 * Evaluate parsed segments against a JSON document.
 *
 * Misses are reported with the failing path prefix so callers can surface an
 * actionable error ("path miss at $.nested.missing"). Only own properties and
 * in-range array indexes resolve; `undefined` values on objects count as a
 * miss, explicit `null` counts as found. Reserved prototype names
 * (`__proto__`, `constructor`, `prototype`) are rejected even when present as
 * OWN hostile keys, and evaluation depth is bounded to MAX_JSONPATH_DEPTH.
 * Array holes resolve to `null`, matching JSON serialization semantics.
 */
export function evaluateJsonPath(doc: unknown, segments: readonly JsonPathSegment[]): JsonPathResult {
  if (segments.length > MAX_JSONPATH_DEPTH) {
    return { found: false, error: `Path exceeds maximum evaluation depth of ${MAX_JSONPATH_DEPTH}` };
  }
  let current: unknown = doc;
  let traversed = '$';

  for (const seg of segments) {
    if (seg.kind === 'key') {
      if (RESERVED_SEGMENT_NAMES.has(seg.name)) {
        return {
          found: false,
          error: `Reserved segment name '${seg.name}' is not traversable at ${traversed}`,
        };
      }
      if (current === null || typeof current !== 'object' || Array.isArray(current)) {
        return {
          found: false,
          error: `Cannot read key '${seg.name}' of non-object at ${traversed}`,
        };
      }
      const holder = current as Record<string, unknown>;
      if (!Object.prototype.hasOwnProperty.call(holder, seg.name)) {
        return {
          found: false,
          error: `Path miss at ${traversed}.${seg.name} (no such property)`,
        };
      }
      const value = holder[seg.name];
      if (value === undefined) {
        return {
          found: false,
          error: `Path miss at ${traversed}.${seg.name} (property value is undefined)`,
        };
      }
      current = value;
      traversed = `${traversed}.${seg.name}`;
      continue;
    }
    if (!Array.isArray(current)) {
      return {
        found: false,
        error: `Cannot index non-array with [${seg.value}] at ${traversed}`,
      };
    }
    if (seg.value >= current.length) {
      return {
        found: false,
        error: `Index [${seg.value}] out of range (length ${current.length}) at ${traversed}`,
      };
    }
    // Sparse-array holes behave like JSON serialization: null, not a miss.
    const element = current[seg.value];
    current = element === undefined ? null : element;
    traversed = `${traversed}[${seg.value}]`;
  }

  return { found: true, value: current };
}

/** Convenience: parse + evaluate in one call. */
export function queryJsonPath(doc: unknown, path: string): JsonPathResult {
  const parsed = parseJsonPath(path);
  if ('error' in parsed) return { found: false, error: parsed.error };
  return evaluateJsonPath(doc, parsed.segments);
}
