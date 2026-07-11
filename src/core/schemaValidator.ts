/**
 * Pure JSON Schema validator for `# @schema` directives.
 *
 * Three forms of schema reference are supported (all resolved to a plain
 * JSON Schema object before validation):
 *
 *   1. `inline:<json>` — raw JSON Schema in the directive itself. For
 *      ergonomics we also accept a leading `{` as an implicit `inline:`.
 *   2. `openapi:<pointer>` — a JSON Pointer fragment (with or without a
 *      leading `#`) into an OpenAPI document supplied by the caller.
 *   3. `file:<path>` — file-loaded JSON Schema. This module does NOT touch
 *      the filesystem; the caller passes the loaded document via
 *      `SchemaResolveContext.file`.
 *
 * Keeping IO out of this module means the extension layer decides how to
 * read files (respecting `pathGuard`, workspace boundaries, etc.) and the
 * CLI layer can do the same.
 */

import Ajv, { type AnySchema, type ErrorObject, type ValidateFunction } from 'ajv';
import addFormats from 'ajv-formats';
import { z } from 'zod';

import { resolveSchemaRef } from './schemaRef';

/** Parsed form of a `# @schema <value>` directive. */
export type SchemaRef =
  | { kind: 'inline'; schema: unknown }
  | { kind: 'openapi'; pointer: string; docPath?: string }
  | { kind: 'file'; path: string; pointer?: string };

/** Loaded documents keyed by the path in the directive. */
export interface SchemaResolveContext {
  /** Parsed OpenAPI docs keyed by the path used in `openapi:<path>#/...`. */
  openapi?: Record<string, unknown>;
  /** Parsed JSON Schema docs keyed by the path used in `file:<path>`. */
  file?: Record<string, unknown>;
}

export interface SchemaViolation {
  /** JSON Pointer path into the response body where validation failed. */
  path: string;
  /** ajv keyword that failed (e.g. `required`, `type`). */
  rule: string;
  /** Plain-English reason from ajv. */
  message: string;
  /** Extra params ajv attached to the error (missing property, expected type…). */
  params: Record<string, unknown>;
}

export type SchemaValidationResult =
  | { ok: true; skipped: false; violations: [] }
  | { ok: false; skipped: false; violations: SchemaViolation[] }
  | { ok: true; skipped: true; reason: string; violations: [] };

const zSchemaValue = z.unknown();

/**
 * Parse the raw directive text (`{...}`, `inline:...`, `openapi:...#/...`,
 * `file:...`) into a structured `SchemaRef`. Throws on syntactically
 * invalid input; callers should catch and surface as parse diagnostics.
 */
export function parseSchemaDirective(raw: string): SchemaRef {
  const trimmed = raw.trim();
  if (trimmed === '') throw new Error('@schema directive is empty');

  // Implicit inline JSON: value starts with `{` or `[`.
  if (trimmed.startsWith('{') || trimmed.startsWith('[')) {
    const parsed = safeParseJson(trimmed, 'inline schema');
    zSchemaValue.parse(parsed);
    return { kind: 'inline', schema: parsed };
  }

  if (trimmed.startsWith('inline:')) {
    const parsed = safeParseJson(trimmed.slice('inline:'.length).trim(), 'inline schema');
    zSchemaValue.parse(parsed);
    return { kind: 'inline', schema: parsed };
  }

  if (trimmed.startsWith('openapi:')) {
    const rest = trimmed.slice('openapi:'.length);
    const hashIdx = rest.indexOf('#');
    if (hashIdx === -1) {
      throw new Error(
        `@schema openapi:<path>#/<pointer> is required, got: openapi:${rest}`,
      );
    }
    const docPath = rest.slice(0, hashIdx);
    const pointer = rest.slice(hashIdx + 1);
    if (!pointer.startsWith('/')) {
      throw new Error(`@schema openapi pointer must start with '/': ${pointer}`);
    }
    const ref: SchemaRef = { kind: 'openapi', pointer };
    if (docPath !== '') ref.docPath = docPath;
    return ref;
  }

  if (trimmed.startsWith('file:')) {
    const rest = trimmed.slice('file:'.length);
    const hashIdx = rest.indexOf('#');
    if (hashIdx === -1) return { kind: 'file', path: rest };
    const path = rest.slice(0, hashIdx);
    const pointer = rest.slice(hashIdx + 1);
    if (pointer !== '' && !pointer.startsWith('/')) {
      throw new Error(`@schema file pointer must start with '/': ${pointer}`);
    }
    const ref: SchemaRef = { kind: 'file', path };
    if (pointer !== '') ref.pointer = pointer;
    return ref;
  }

  throw new Error(
    `@schema value must be inline JSON, "inline:<json>", "openapi:<path>#/<pointer>", or "file:<path>[#/<pointer>]"; got: ${trimmed}`,
  );
}

function safeParseJson(text: string, label: string): unknown {
  try {
    return JSON.parse(text);
  } catch (e) {
    throw new Error(`invalid JSON for ${label}: ${(e as Error).message}`);
  }
}

/**
 * Resolve a parsed `SchemaRef` to a concrete JSON Schema object, given the
 * loaded documents the caller has already read from disk.
 */
export function resolveSchema(ref: SchemaRef, ctx: SchemaResolveContext = {}): unknown {
  switch (ref.kind) {
    case 'inline':
      return ref.schema;
    case 'openapi': {
      const key = ref.docPath ?? '';
      const doc = ctx.openapi?.[key];
      if (doc === undefined) {
        throw new Error(
          `@schema openapi:${key}#... references a document that was not loaded (missing ctx.openapi[${JSON.stringify(key)}])`,
        );
      }
      return resolveSchemaRef(doc, ref.pointer);
    }
    case 'file': {
      const doc = ctx.file?.[ref.path];
      if (doc === undefined) {
        throw new Error(
          `@schema file:${ref.path} references a document that was not loaded (missing ctx.file[${JSON.stringify(ref.path)}])`,
        );
      }
      if (ref.pointer === undefined || ref.pointer === '') return doc;
      return resolveSchemaRef(doc, ref.pointer);
    }
  }
}

/**
 * Single ajv instance, lazily built and reused. Compiled validators are
 * cached by `WeakMap` keyed on the schema object identity so hot paths
 * (repeated runs of the same `.http` file) don't recompile.
 */
let ajvInstance: Ajv | null = null;
const compiledCache = new WeakMap<object, ValidateFunction>();

function getAjv(): Ajv {
  if (ajvInstance) return ajvInstance;
  ajvInstance = new Ajv({ allErrors: true, strict: false });
  addFormats(ajvInstance);
  return ajvInstance;
}

function compile(schema: unknown): ValidateFunction {
  if (schema !== null && typeof schema === 'object') {
    const cached = compiledCache.get(schema as object);
    if (cached) return cached;
    const fn = getAjv().compile(schema as AnySchema);
    compiledCache.set(schema as object, fn);
    return fn;
  }
  // Primitive schemas (`true` / `false` / etc.) don't fit WeakMap; just compile.
  return getAjv().compile(schema as AnySchema);
}

/**
 * Validate `body` against `schema`. `body` should be the already-parsed
 * JSON (the caller decides whether/how to parse — usually the response
 * assertion context's `json` field).
 *
 * If the caller passes `undefined` for the body (non-JSON response) the
 * result is `skipped: true` with a reason, matching the acceptance-criteria
 * "ignored on non-JSON responses with a warning" behavior.
 */
export function validateAgainstSchema(
  schema: unknown,
  body: unknown,
  opts: { skipReason?: string } = {},
): SchemaValidationResult {
  if (opts.skipReason !== undefined) {
    return { ok: true, skipped: true, reason: opts.skipReason, violations: [] };
  }
  if (body === undefined) {
    return {
      ok: true,
      skipped: true,
      reason: 'response body is not JSON; schema validation skipped',
      violations: [],
    };
  }

  const validate = compile(schema);
  const ok = validate(body) as boolean;
  if (ok) return { ok: true, skipped: false, violations: [] };
  const violations = (validate.errors ?? []).map(formatError);
  return { ok: false, skipped: false, violations };
}

function formatError(err: ErrorObject): SchemaViolation {
  const path = err.instancePath === '' ? '/' : err.instancePath;
  const rule = err.keyword;
  const params = (err.params ?? {}) as Record<string, unknown>;
  const message = err.message ?? 'schema violation';
  // For `required`, ajv sets instancePath to the parent object; append the
  // missing property so the pointer points at the actual issue.
  if (rule === 'required' && typeof params.missingProperty === 'string') {
    const suffix = params.missingProperty as string;
    const joined = path === '/' ? `/${suffix}` : `${path}/${suffix}`;
    return { path: joined, rule, message: `missing required property "${suffix}"`, params };
  }
  return { path, rule, message, params };
}
