/**
 * Pure schema reference resolver — no VS Code, no IO.
 *
 * Handles two things:
 *
 *   1. JSON Pointer resolution per RFC 6901 (`/foo/bar/0`), including the
 *      RFC-mandated `~0` (→ `~`) and `~1` (→ `/`) escapes.
 *   2. OpenAPI 3.x `$ref` resolution restricted to the same document. We
 *      inline `$ref` strings that start with `#/` by walking the pointer. A
 *      `$ref` pointing outside the current document is left as-is (callers
 *      that want cross-file refs should preprocess the document).
 *
 * The typical usage from `# @schema openapi:./api.yaml#/paths/~1users/get/…`
 * is: caller loads and parses the YAML into a JS object, then calls
 * `resolveJsonPointer` / `resolveSchemaRef` here.
 */

/** Decode a single JSON Pointer reference token per RFC 6901. */
export function decodePointerToken(token: string): string {
  return token.replace(/~1/g, '/').replace(/~0/g, '~');
}

/**
 * Parse a JSON Pointer string into its component tokens.
 * `''` and `'/'` are both valid: `''` refers to the whole document, `'/'`
 * refers to the empty-string key at the root.
 */
export function parseJsonPointer(pointer: string): string[] {
  if (pointer === '') return [];
  if (!pointer.startsWith('/')) {
    throw new Error(`invalid JSON Pointer (must start with '/' or be empty): ${pointer}`);
  }
  return pointer.slice(1).split('/').map(decodePointerToken);
}

/**
 * Walk `doc` following the JSON Pointer. Returns the resolved value or
 * throws with a helpful message when a token cannot be resolved.
 */
export function resolveJsonPointer(doc: unknown, pointer: string): unknown {
  const tokens = parseJsonPointer(pointer);
  let current: unknown = doc;
  for (let i = 0; i < tokens.length; i++) {
    const token = tokens[i];
    if (current === null || current === undefined) {
      throw new Error(
        `JSON Pointer ${pointer} failed at token ${JSON.stringify(token)} (index ${i}): value is ${current === null ? 'null' : 'undefined'}`,
      );
    }
    if (Array.isArray(current)) {
      // `-` is legal per RFC but refers to a non-existent index; treat as error.
      if (!/^\d+$/.test(token)) {
        throw new Error(
          `JSON Pointer ${pointer} failed at token ${JSON.stringify(token)} (index ${i}): array requires numeric index`,
        );
      }
      const idx = Number(token);
      if (idx < 0 || idx >= current.length) {
        throw new Error(
          `JSON Pointer ${pointer} failed at token ${JSON.stringify(token)} (index ${i}): array index out of range`,
        );
      }
      current = current[idx];
      continue;
    }
    if (typeof current === 'object') {
      const obj = current as Record<string, unknown>;
      if (!Object.prototype.hasOwnProperty.call(obj, token)) {
        throw new Error(
          `JSON Pointer ${pointer} failed at token ${JSON.stringify(token)} (index ${i}): key not found`,
        );
      }
      current = obj[token];
      continue;
    }
    throw new Error(
      `JSON Pointer ${pointer} failed at token ${JSON.stringify(token)} (index ${i}): cannot descend into ${typeof current}`,
    );
  }
  return current;
}

/**
 * Resolve any in-document `$ref` strings by walking the pointer and inlining
 * the referenced value. Cross-document refs (anything that does not start
 * with `#/`) are left untouched — callers can preprocess if they need them.
 *
 * Circular `$ref` chains are detected and rejected (they would blow the
 * stack under ajv without a `$id` scheme, and we don't want to encourage
 * that pattern in `.http` inline schemas).
 */
export function inlineRefs(root: unknown, node: unknown = root, seen: Set<string> = new Set()): unknown {
  if (node === null || typeof node !== 'object') return node;
  if (Array.isArray(node)) return node.map((n) => inlineRefs(root, n, seen));

  const obj = node as Record<string, unknown>;
  const ref = obj['$ref'];
  if (typeof ref === 'string' && ref.startsWith('#/')) {
    if (seen.has(ref)) {
      throw new Error(`circular $ref detected at ${ref}`);
    }
    const next = new Set(seen);
    next.add(ref);
    const resolved = resolveJsonPointer(root, ref.slice(1));
    return inlineRefs(root, resolved, next);
  }

  const out: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(obj)) {
    out[k] = inlineRefs(root, v, seen);
  }
  return out;
}

/**
 * Convenience: given an OpenAPI-style doc + a `#/…` pointer, resolve the
 * pointer AND recursively inline `$ref`s so the returned value is a
 * self-contained schema suitable for ajv.
 */
export function resolveSchemaRef(doc: unknown, pointer: string): unknown {
  const raw = resolveJsonPointer(doc, pointer);
  return inlineRefs(doc, raw);
}
