/**
 * Pure OpenAPI 3.x → reqit importer. No VS Code, no IO.
 *
 * Input: an already-parsed OpenAPI document (object). YAML→object conversion
 * is the caller's job (the extension layer uses the `yaml` package; tests
 * pass plain objects).
 *
 * Output: one `.http` file per tag (operations without tags land in
 * `default.http`), plus an `envVariables` map derived from `servers[]` so the
 * user can pick a base URL via `{{baseUrl}}`. Servers with variables are
 * surfaced as `unsupported` notes since we don't try to enumerate combinations.
 *
 * Body strategy: prefer `application/json` then `application/x-www-form-urlencoded`
 * then any other media type. Within the chosen media type, prefer an
 * `example`, else the first named `examples` entry, else a schema-derived
 * sample (recursive, honours `type` / `enum` / `default` / `properties` /
 * `items`; `$ref` resolution within the same document is supported).
 *
 * Auth: `securitySchemes` are mapped to reqit auth hints (`basic`, `bearer`
 * for `http` schemes, `apiKey` for header/query). The first operation-level
 * `security` requirement wins; `oauth2` / `openIdConnect` produce a hint
 * but no auto-wired profile (user must finish in `.http-auth.json`).
 *
 * Validates with zod before doing any work.
 */

import { z } from 'zod';

// ---------- OpenAPI schema (loose subset, we tolerate extras) ----------

const serverVariableSchema = z.object({
  default: z.string(),
  enum: z.array(z.string()).optional(),
  description: z.string().optional(),
});

const serverSchema = z.object({
  url: z.string(),
  description: z.string().optional(),
  variables: z.record(serverVariableSchema).optional(),
});

const securitySchemeSchema = z.object({
  type: z.enum(['apiKey', 'http', 'oauth2', 'openIdConnect', 'mutualTLS']),
  scheme: z.string().optional(),
  bearerFormat: z.string().optional(),
  name: z.string().optional(),
  in: z.enum(['header', 'query', 'cookie']).optional(),
  description: z.string().optional(),
});

const openapiDocSchema = z
  .object({
    openapi: z.string().regex(/^3\./, 'only OpenAPI 3.x is supported'),
    info: z.object({ title: z.string().optional() }).optional(),
    servers: z.array(serverSchema).optional(),
    paths: z.record(z.any()).optional(),
    components: z
      .object({
        securitySchemes: z.record(securitySchemeSchema).optional(),
        schemas: z.record(z.any()).optional(),
      })
      .passthrough()
      .optional(),
    security: z.array(z.record(z.array(z.string()))).optional(),
  })
  .passthrough();

export type OpenApiDoc = z.infer<typeof openapiDocSchema>;

// ---------- Output types ----------

export interface ImportedHttpFile {
  filename: string;
  contents: string;
}

export interface ImportedOpenApi {
  files: ImportedHttpFile[];
  /** Derived env entries (e.g. `baseUrl`). */
  envVariables: Record<string, string>;
  /** Things we didn't (or couldn't) model. One line each. */
  warnings: string[];
}

const HTTP_METHODS = ['get', 'put', 'post', 'delete', 'patch', 'head', 'options', 'trace'] as const;

interface OperationBag {
  tag: string;
  name: string;
  method: string;
  path: string;
  operation: Record<string, unknown>;
}

/**
 * Public entry point. Throws if the doc is unrecognisable.
 */
export function importOpenApi(doc: unknown): ImportedOpenApi {
  const parsed = openapiDocSchema.parse(doc);
  const warnings: string[] = [];

  // ----- env: baseUrl from first server -----
  const envVariables: Record<string, string> = {};
  const firstServer = parsed.servers?.[0];
  if (firstServer) {
    if (firstServer.variables && Object.keys(firstServer.variables).length > 0) {
      warnings.push(
        `server "${firstServer.url}" has variables — using the URL verbatim; substitute by hand if needed`,
      );
    }
    envVariables.baseUrl = firstServer.url.replace(/\/+$/, '');
  }
  if ((parsed.servers?.length ?? 0) > 1) {
    warnings.push(
      `${parsed.servers!.length} servers in spec — only the first was used for {{baseUrl}}`,
    );
  }

  // ----- gather operations by tag -----
  const operations: OperationBag[] = [];
  const paths = parsed.paths ?? {};
  for (const [pathKey, pathItemRaw] of Object.entries(paths)) {
    if (!pathItemRaw || typeof pathItemRaw !== 'object') continue;
    const pathItem = pathItemRaw as Record<string, unknown>;
    for (const method of HTTP_METHODS) {
      const op = pathItem[method];
      if (!op || typeof op !== 'object') continue;
      const opObj = op as Record<string, unknown>;
      const tags = Array.isArray(opObj.tags) && opObj.tags.length > 0
        ? (opObj.tags as unknown[]).filter((t): t is string => typeof t === 'string')
        : ['default'];
      const tag = tags[0] ?? 'default';
      const summary = typeof opObj.summary === 'string' ? opObj.summary : undefined;
      const operationId = typeof opObj.operationId === 'string' ? opObj.operationId : undefined;
      const name = summary ?? operationId ?? `${method.toUpperCase()} ${pathKey}`;
      operations.push({ tag, name, method: method.toUpperCase(), path: pathKey, operation: opObj });
    }
  }

  // group by tag (stable order: insertion order of first-seen tag)
  const byTag = new Map<string, OperationBag[]>();
  for (const op of operations) {
    if (!byTag.has(op.tag)) byTag.set(op.tag, []);
    byTag.get(op.tag)!.push(op);
  }

  const ctx: RenderContext = {
    doc: parsed,
    warnings,
  };

  const files: ImportedHttpFile[] = [];
  for (const [tag, ops] of byTag) {
    const filename = `${slugForFilename(tag)}.http`;
    const parts: string[] = [];
    parts.push(`# Imported from OpenAPI: ${parsed.info?.title ?? 'spec'} (tag: ${tag})`);
    parts.push('');
    for (const op of ops) {
      parts.push(renderOperation(op, ctx));
    }
    files.push({ filename, contents: parts.join('\n').replace(/\n{3,}/g, '\n\n').trimEnd() + '\n' });
  }

  return { files, envVariables, warnings };
}

interface RenderContext {
  doc: OpenApiDoc;
  warnings: string[];
}

function renderOperation(op: OperationBag, ctx: RenderContext): string {
  const lines: string[] = [];
  lines.push(`### ${op.name}`);

  const opObj = op.operation;
  const description = typeof opObj.description === 'string' ? opObj.description : undefined;
  if (description) {
    for (const ln of description.split(/\r?\n/)) {
      if (ln.trim().length > 0) lines.push(`# ${ln}`);
    }
  }

  // Parameters: split into path / query / header.
  const params = collectParameters(opObj, ctx);

  // Build URL: {{baseUrl}} + path with path-params substituted to {{name}}.
  const pathSubbed = op.path.replace(/\{([^}]+)\}/g, (_m, name) => `{{${String(name)}}}`);
  const url = `{{baseUrl}}${pathSubbed}`;
  const queryString =
    params.query.length > 0
      ? '?' +
        params.query
          .map((p) => `${encodeURIComponent(p.name)}={{${p.name}}}`)
          .join('&')
      : '';
  lines.push(`${op.method} ${url}${queryString}`);

  // Auth → header (if we can model it).
  const authHeader = pickAuthHeader(opObj, ctx);
  if (authHeader) lines.push(`${authHeader.name}: ${authHeader.value}`);
  for (const h of params.header) {
    lines.push(`${h.name}: {{${h.name}}}`);
  }

  // Body.
  const body = pickRequestBody(opObj, ctx);
  if (body) {
    lines.push(`Content-Type: ${body.contentType}`);
    lines.push('');
    lines.push(body.body);
  }

  // Notes for things we couldn't model precisely.
  if (params.warnings.length > 0) {
    lines.push('');
    for (const w of params.warnings) lines.push(`# unsupported: ${w}`);
  }

  return lines.join('\n') + '\n';
}

interface CollectedParams {
  path: Array<{ name: string }>;
  query: Array<{ name: string }>;
  header: Array<{ name: string }>;
  warnings: string[];
}

function collectParameters(op: Record<string, unknown>, ctx: RenderContext): CollectedParams {
  const result: CollectedParams = { path: [], query: [], header: [], warnings: [] };
  const params = Array.isArray(op.parameters) ? (op.parameters as unknown[]) : [];
  for (const raw of params) {
    const resolved = resolveRef(raw, ctx.doc);
    if (!resolved || typeof resolved !== 'object') continue;
    const p = resolved as Record<string, unknown>;
    const name = typeof p.name === 'string' ? p.name : undefined;
    const where = typeof p.in === 'string' ? p.in : undefined;
    if (!name || !where) continue;
    if (where === 'path') result.path.push({ name });
    else if (where === 'query') result.query.push({ name });
    else if (where === 'header') result.header.push({ name });
    else if (where === 'cookie') result.warnings.push(`cookie parameter "${name}" not modelled`);
  }
  return result;
}

interface RenderedBody {
  contentType: string;
  body: string;
}

function pickRequestBody(op: Record<string, unknown>, ctx: RenderContext): RenderedBody | undefined {
  const reqBodyRaw = op.requestBody;
  if (!reqBodyRaw) return undefined;
  const reqBody = resolveRef(reqBodyRaw, ctx.doc);
  if (!reqBody || typeof reqBody !== 'object') return undefined;
  const content = (reqBody as Record<string, unknown>).content;
  if (!content || typeof content !== 'object') return undefined;
  const contentMap = content as Record<string, unknown>;

  const prefer = ['application/json', 'application/x-www-form-urlencoded'];
  const types = Object.keys(contentMap);
  const chosen =
    prefer.find((t) => types.includes(t)) ?? types[0];
  if (!chosen) return undefined;
  const mediaTypeRaw = contentMap[chosen];
  if (!mediaTypeRaw || typeof mediaTypeRaw !== 'object') return undefined;
  const mediaType = mediaTypeRaw as Record<string, unknown>;

  // Prefer example > first examples entry > schema-derived sample.
  let sample: unknown;
  if (mediaType.example !== undefined) {
    sample = mediaType.example;
  } else if (mediaType.examples && typeof mediaType.examples === 'object') {
    const first = Object.values(mediaType.examples as Record<string, unknown>)[0];
    if (first && typeof first === 'object' && 'value' in (first as Record<string, unknown>)) {
      sample = (first as Record<string, unknown>).value;
    }
  }
  if (sample === undefined) {
    const schema = mediaType.schema ? resolveRef(mediaType.schema, ctx.doc) : undefined;
    if (schema && typeof schema === 'object') {
      sample = sampleFromSchema(schema as Record<string, unknown>, ctx.doc, new Set());
    }
  }
  if (sample === undefined) {
    return { contentType: chosen, body: '' };
  }

  if (chosen === 'application/x-www-form-urlencoded' && sample && typeof sample === 'object') {
    const entries = Object.entries(sample as Record<string, unknown>).map(
      ([k, v]) => `${encodeURIComponent(k)}=${encodeURIComponent(String(v ?? ''))}`,
    );
    return { contentType: chosen, body: entries.join('&') };
  }

  if (chosen.includes('json') || (typeof sample === 'object' && sample !== null)) {
    return { contentType: chosen, body: JSON.stringify(sample, null, 2) };
  }
  return { contentType: chosen, body: String(sample) };
}

function pickAuthHeader(
  op: Record<string, unknown>,
  ctx: RenderContext,
): { name: string; value: string } | undefined {
  // operation-level security wins; else fall back to doc-level.
  const sec = (Array.isArray(op.security) && op.security.length > 0
    ? op.security
    : ctx.doc.security) as Array<Record<string, unknown>> | undefined;
  if (!sec || sec.length === 0) return undefined;
  const first = sec[0];
  if (!first || typeof first !== 'object') return undefined;
  const schemeName = Object.keys(first)[0];
  if (!schemeName) return undefined;
  const schemes = ctx.doc.components?.securitySchemes;
  if (!schemes) return undefined;
  const scheme = schemes[schemeName];
  if (!scheme) return undefined;

  if (scheme.type === 'http' && (scheme.scheme === 'basic' || scheme.scheme === 'bearer')) {
    if (scheme.scheme === 'basic') {
      ctx.warnings.push(
        `auth "${schemeName}" → basic; set {{basicAuth}} to a base64 user:pass or wire a profile in .http-auth.json`,
      );
      return { name: 'Authorization', value: 'Basic {{basicAuth}}' };
    }
    ctx.warnings.push(
      `auth "${schemeName}" → bearer; set {{bearerToken}} or wire a profile in .http-auth.json`,
    );
    return { name: 'Authorization', value: 'Bearer {{bearerToken}}' };
  }
  if (scheme.type === 'apiKey' && scheme.in === 'header' && scheme.name) {
    ctx.warnings.push(`auth "${schemeName}" → apiKey header "${scheme.name}"; set {{apiKey}}`);
    return { name: scheme.name, value: '{{apiKey}}' };
  }
  if (scheme.type === 'apiKey' && scheme.in === 'query') {
    ctx.warnings.push(
      `auth "${schemeName}" → apiKey in query; add &${scheme.name}={{apiKey}} by hand`,
    );
    return undefined;
  }
  if (scheme.type === 'oauth2' || scheme.type === 'openIdConnect') {
    ctx.warnings.push(
      `auth "${schemeName}" → ${scheme.type}; wire an oauth2 profile in .http-auth.json and add # @auth ${schemeName}`,
    );
    return { name: 'Authorization', value: 'Bearer {{accessToken}}' };
  }
  if (scheme.type === 'mutualTLS') {
    ctx.warnings.push(
      `auth "${schemeName}" → mutualTLS; configure a clientCert profile in .http-auth.json`,
    );
    return undefined;
  }
  return undefined;
}

// ---------- schema sampling ----------

function sampleFromSchema(
  schemaIn: Record<string, unknown>,
  doc: OpenApiDoc,
  seen: Set<string>,
): unknown {
  const schema = (resolveRefWithKey(schemaIn, doc, seen) ?? schemaIn) as Record<string, unknown>;
  if (schema.example !== undefined) return schema.example;
  if (schema.default !== undefined) return schema.default;
  if (Array.isArray(schema.enum) && schema.enum.length > 0) return schema.enum[0];

  // Handle composition keywords by sampling the first option.
  for (const k of ['oneOf', 'anyOf', 'allOf'] as const) {
    const arr = schema[k];
    if (Array.isArray(arr) && arr.length > 0) {
      // allOf: shallow-merge the sampled objects.
      if (k === 'allOf') {
        const merged: Record<string, unknown> = {};
        for (const sub of arr) {
          const s = sampleFromSchema(sub as Record<string, unknown>, doc, seen);
          if (s && typeof s === 'object' && !Array.isArray(s)) Object.assign(merged, s);
        }
        return merged;
      }
      return sampleFromSchema(arr[0] as Record<string, unknown>, doc, seen);
    }
  }

  const type = typeof schema.type === 'string' ? schema.type : undefined;
  if (type === 'object' || schema.properties) {
    const props = (schema.properties as Record<string, unknown>) ?? {};
    const out: Record<string, unknown> = {};
    for (const [k, v] of Object.entries(props)) {
      if (v && typeof v === 'object') {
        out[k] = sampleFromSchema(v as Record<string, unknown>, doc, seen);
      }
    }
    return out;
  }
  if (type === 'array') {
    const items = schema.items;
    if (items && typeof items === 'object') {
      return [sampleFromSchema(items as Record<string, unknown>, doc, seen)];
    }
    return [];
  }
  if (type === 'integer' || type === 'number') return 0;
  if (type === 'boolean') return false;
  if (type === 'string') {
    const fmt = typeof schema.format === 'string' ? schema.format : undefined;
    if (fmt === 'date-time') return '1970-01-01T00:00:00Z';
    if (fmt === 'date') return '1970-01-01';
    if (fmt === 'uuid') return '00000000-0000-0000-0000-000000000000';
    if (fmt === 'email') return 'user@example.com';
    return 'string';
  }
  return null;
}

// ---------- $ref resolution (within the same document) ----------

function resolveRef(node: unknown, doc: OpenApiDoc): unknown {
  return resolveRefWithKey(node, doc, new Set());
}

function resolveRefWithKey(node: unknown, doc: OpenApiDoc, seen: Set<string>): unknown {
  if (!node || typeof node !== 'object') return node;
  const ref = (node as Record<string, unknown>).$ref;
  if (typeof ref !== 'string') return node;
  if (!ref.startsWith('#/')) return node; // external refs unsupported
  if (seen.has(ref)) return undefined;
  seen.add(ref);
  const segments = ref.slice(2).split('/').map(decodeJsonPointer);
  let cursor: unknown = doc;
  for (const seg of segments) {
    if (cursor && typeof cursor === 'object' && seg in (cursor as Record<string, unknown>)) {
      cursor = (cursor as Record<string, unknown>)[seg];
    } else {
      return undefined;
    }
  }
  // Recurse in case the resolved node is itself a $ref.
  return resolveRefWithKey(cursor, doc, seen);
}

function decodeJsonPointer(s: string): string {
  return s.replace(/~1/g, '/').replace(/~0/g, '~');
}

// ---------- filename slug ----------

function slugForFilename(tag: string): string {
  const cleaned = tag
    .trim()
    .replace(/[^A-Za-z0-9._-]+/g, '-')
    .replace(/^-+|-+$/g, '');
  return cleaned.length > 0 ? cleaned : 'imported';
}
