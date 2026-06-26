/**
 * Pure Postman v2.1 collection → reqit importer. No VS Code, no IO.
 *
 * Input: a parsed Postman Collection v2.1 JSON object (validated with zod).
 * Output: a flat list of generated `.http` files (one per top-level folder,
 * plus a `root.http` for any items that live at the collection root), and a
 * derived environment object suitable for writing alongside `.http-env.json`.
 *
 * Scope (intentionally narrow — covers the bits real-world collections use):
 *   - Method + URL (string OR url-object with raw/host/path/query/variable)
 *   - Headers (skipping `disabled: true`)
 *   - Body: raw, urlencoded, formdata (multipart noted as unsupported),
 *           file (noted), graphql (rendered as JSON body)
 *   - Auth at item or collection level:
 *       basic / bearer / apikey (header or query) / oauth2 (header hint)
 *   - Collection-level `variable` array → env entries; `{{var}}` tokens are
 *     preserved verbatim in the output since reqit uses the same syntax.
 *   - Folder nesting (one file per top-level folder; nested folders are
 *     flattened into prefixed request names).
 *
 * Anything we can't model is captured in an `unsupported` array per request
 * and rendered as `# unsupported:` comment lines so the user sees what was
 * dropped.
 */

import { z } from 'zod';

// ---------- Postman schema (subset) ----------

const postmanHeaderSchema = z.object({
  key: z.string(),
  value: z.string().optional(),
  disabled: z.boolean().optional(),
});

const postmanQuerySchema = z.object({
  key: z.string(),
  value: z.string().optional(),
  disabled: z.boolean().optional(),
});

const postmanUrlObjectSchema = z.object({
  raw: z.string().optional(),
  protocol: z.string().optional(),
  host: z.union([z.string(), z.array(z.string())]).optional(),
  path: z.union([z.string(), z.array(z.string())]).optional(),
  port: z.string().optional(),
  query: z.array(postmanQuerySchema).optional(),
  variable: z
    .array(z.object({ key: z.string(), value: z.string().optional() }))
    .optional(),
});

const postmanUrlSchema = z.union([z.string(), postmanUrlObjectSchema]);

const postmanBodySchema = z.object({
  mode: z.string().optional(),
  raw: z.string().optional(),
  urlencoded: z
    .array(z.object({ key: z.string(), value: z.string().optional(), disabled: z.boolean().optional() }))
    .optional(),
  formdata: z
    .array(
      z.object({
        key: z.string(),
        value: z.string().optional(),
        type: z.string().optional(),
        src: z.union([z.string(), z.array(z.string())]).optional(),
        disabled: z.boolean().optional(),
      }),
    )
    .optional(),
  file: z.object({ src: z.string().optional() }).passthrough().optional(),
  graphql: z
    .object({
      query: z.string().optional(),
      variables: z.union([z.string(), z.record(z.string(), z.unknown())]).optional(),
    })
    .optional(),
  options: z.record(z.string(), z.unknown()).optional(),
});

const postmanAuthSchema = z
  .object({
    type: z.string(),
  })
  .catchall(z.unknown());

// Use lazy() so we can self-reference for folder nesting. We let zod
// infer the types here — the input/output split with `.default()` makes
// explicit annotation noisy and brittle.
type PostmanItem = z.infer<typeof postmanItemSchema>;
export type PostmanRequest = z.infer<typeof postmanRequestSchema>;

const postmanRequestSchema = z.object({
  method: z.string().optional(),
  url: postmanUrlSchema.optional(),
  header: z.array(postmanHeaderSchema).optional(),
  body: postmanBodySchema.optional(),
  auth: postmanAuthSchema.optional(),
});

const postmanItemBaseSchema = z.object({
  name: z.string().optional(),
  request: postmanRequestSchema.optional(),
  auth: postmanAuthSchema.optional(),
});

type PostmanItemRaw = z.infer<typeof postmanItemBaseSchema> & { item?: PostmanItemRaw[] };

const postmanItemSchema: z.ZodType<PostmanItemRaw> = postmanItemBaseSchema.extend({
  item: z.lazy(() => z.array(postmanItemSchema)).optional(),
});

export const postmanCollectionSchema = z.object({
  info: z
    .object({
      name: z.string().optional(),
      schema: z.string().optional(),
    })
    .passthrough(),
  item: z.array(postmanItemSchema),
  variable: z
    .array(z.object({ key: z.string(), value: z.string().optional() }))
    .optional(),
  auth: postmanAuthSchema.optional(),
});

export type PostmanCollection = z.infer<typeof postmanCollectionSchema>;

// ---------- Output ----------

export interface ImportedHttpFile {
  /** Relative filename inside `.requests/`, e.g. `users.http`. */
  filename: string;
  /** Full text contents. */
  contents: string;
}

export interface ImportedPostman {
  files: ImportedHttpFile[];
  /** Variables to merge into the user's env (under a chosen env name). */
  envVariables: Record<string, string>;
  /** Things we noticed but couldn't model. Surfaced to the user. */
  warnings: string[];
}

/**
 * Convert a Postman collection (already JSON-parsed) into a set of `.http`
 * files plus extracted env variables. Throws on schema validation failure.
 */
export function importPostmanCollection(raw: unknown): ImportedPostman {
  const collection = postmanCollectionSchema.parse(raw);

  const envVariables: Record<string, string> = {};
  for (const v of collection.variable ?? []) {
    if (v.key.length > 0) envVariables[v.key] = v.value ?? '';
  }

  const warnings: string[] = [];
  const fileBuckets = new Map<string, string[]>();
  const usedFilenames = new Set<string>();
  const ensureBucket = (raw: string): string => {
    const base = sanitiseFilename(raw);
    let candidate = base;
    let n = 2;
    while (usedFilenames.has(candidate)) candidate = `${base}-${n++}`;
    usedFilenames.add(candidate);
    fileBuckets.set(candidate, []);
    return candidate;
  };

  const collectionAuth = collection.auth;

  // Walk: top-level items either fold into root.http or split per folder.
  for (const top of collection.item) {
    if (isFolder(top)) {
      const bucket = ensureBucket(top.name ?? 'folder');
      walkFolder(top, bucket, [], fileBuckets, warnings, top.auth ?? collectionAuth);
    } else {
      const bucket = ensureBucket('root');
      const block = renderRequest(top, [], warnings, top.auth ?? collectionAuth);
      if (block !== undefined) fileBuckets.get(bucket)!.push(block);
    }
  }

  const files: ImportedHttpFile[] = [];
  for (const [name, blocks] of fileBuckets) {
    if (blocks.length === 0) continue;
    files.push({ filename: `${name}.http`, contents: blocks.join('\n') + '\n' });
  }

  return { files, envVariables, warnings };
}

function isFolder(item: PostmanItem): boolean {
  return Array.isArray(item.item);
}

function walkFolder(
  folder: PostmanItem,
  bucketName: string,
  prefix: string[],
  buckets: Map<string, string[]>,
  warnings: string[],
  inheritedAuth: z.infer<typeof postmanAuthSchema> | undefined,
): void {
  // `prefix` is the path-segments *above* this folder's immediate children.
  // The top-level folder is the bucket itself, so its direct children use
  // an empty prefix; deeper folders add their own names to the prefix.
  for (const child of folder.item ?? []) {
    if (isFolder(child)) {
      walkFolder(
        child,
        bucketName,
        [...prefix, child.name ?? 'folder'],
        buckets,
        warnings,
        child.auth ?? inheritedAuth,
      );
    } else {
      const block = renderRequest(child, prefix, warnings, child.auth ?? inheritedAuth);
      if (block !== undefined) buckets.get(bucketName)!.push(block);
    }
  }
}

function renderRequest(
  item: PostmanItem,
  prefix: string[],
  warnings: string[],
  inheritedAuth: z.infer<typeof postmanAuthSchema> | undefined,
): string | undefined {
  const req = item.request;
  if (!req) return undefined;
  const name = [...prefix, item.name ?? 'request'].join(' / ');
  const lines: string[] = [];
  lines.push(`### ${name}`);

  const method = (req.method ?? 'GET').toUpperCase();
  const url = renderUrl(req.url);
  if (url === undefined) {
    warnings.push(`${name}: skipped — no URL`);
    return undefined;
  }

  const headers: Array<{ name: string; value: string }> = [];
  for (const h of req.header ?? []) {
    if (h.disabled) continue;
    if (h.key.length === 0) continue;
    headers.push({ name: h.key, value: h.value ?? '' });
  }

  let body: string | undefined;
  const unsupported: string[] = [];
  if (req.body) {
    const rendered = renderBody(req.body, headers, unsupported);
    body = rendered;
  }

  const auth = req.auth ?? inheritedAuth;
  const authNotes: string[] = [];
  if (auth) applyAuth(auth, headers, authNotes, unsupported);

  for (const note of authNotes) lines.push(`# @auth ${note}`);
  for (const u of unsupported) lines.push(`# unsupported: ${u}`);
  lines.push(`${method} ${url}`);
  for (const h of headers) lines.push(`${h.name}: ${h.value}`);
  if (body !== undefined) {
    lines.push('');
    lines.push(body);
  }
  lines.push('');
  return lines.join('\n');
}

function renderUrl(url: z.infer<typeof postmanUrlSchema> | undefined): string | undefined {
  if (url === undefined) return undefined;
  if (typeof url === 'string') return url.length > 0 ? url : undefined;
  if (url.raw && url.raw.length > 0) return url.raw;
  // Rebuild from parts.
  const protocol = url.protocol ?? 'https';
  const host = Array.isArray(url.host) ? url.host.join('.') : (url.host ?? '');
  if (host.length === 0) return undefined;
  const port = url.port ? `:${url.port}` : '';
  const pathParts = Array.isArray(url.path) ? url.path : url.path ? [url.path] : [];
  const path = pathParts.length > 0 ? '/' + pathParts.join('/') : '';
  const query = (url.query ?? [])
    .filter((q) => !q.disabled && q.key.length > 0)
    .map((q) => `${encodeURIComponent(q.key)}=${encodeURIComponent(q.value ?? '')}`)
    .join('&');
  return `${protocol}://${host}${port}${path}${query ? `?${query}` : ''}`;
}

function renderBody(
  body: z.infer<typeof postmanBodySchema>,
  headers: Array<{ name: string; value: string }>,
  unsupported: string[],
): string | undefined {
  const mode = body.mode;
  if (mode === 'raw') {
    const lang = (body.options as { raw?: { language?: string } } | undefined)?.raw?.language;
    if (lang === 'json' && !hasHeader(headers, 'Content-Type')) {
      headers.push({ name: 'Content-Type', value: 'application/json' });
    } else if (lang === 'xml' && !hasHeader(headers, 'Content-Type')) {
      headers.push({ name: 'Content-Type', value: 'application/xml' });
    }
    return body.raw ?? '';
  }
  if (mode === 'urlencoded') {
    const parts = (body.urlencoded ?? [])
      .filter((p) => !p.disabled && p.key.length > 0)
      .map((p) => `${encodeURIComponent(p.key)}=${encodeURIComponent(p.value ?? '')}`);
    if (!hasHeader(headers, 'Content-Type')) {
      headers.push({ name: 'Content-Type', value: 'application/x-www-form-urlencoded' });
    }
    return parts.join('&');
  }
  if (mode === 'graphql' && body.graphql) {
    if (!hasHeader(headers, 'Content-Type')) {
      headers.push({ name: 'Content-Type', value: 'application/json' });
    }
    const variables =
      typeof body.graphql.variables === 'string'
        ? safeParseJson(body.graphql.variables)
        : (body.graphql.variables ?? {});
    return JSON.stringify({ query: body.graphql.query ?? '', variables });
  }
  if (mode === 'formdata') {
    unsupported.push('multipart formdata body (not yet supported)');
    return undefined;
  }
  if (mode === 'file') {
    unsupported.push(`file body (src: ${body.file?.src ?? '?'})`);
    return undefined;
  }
  if (mode !== undefined) unsupported.push(`body mode: ${mode}`);
  return body.raw;
}

function applyAuth(
  auth: z.infer<typeof postmanAuthSchema>,
  headers: Array<{ name: string; value: string }>,
  notes: string[],
  unsupported: string[],
): void {
  switch (auth.type) {
    case 'basic': {
      const cfg = pickKv(auth.basic);
      const user = cfg.username ?? '';
      const pass = cfg.password ?? '';
      const encoded = base64Utf8(`${user}:${pass}`);
      if (!hasHeader(headers, 'Authorization')) {
        headers.push({ name: 'Authorization', value: `Basic ${encoded}` });
      }
      notes.push(`basic (user: ${user})`);
      break;
    }
    case 'bearer': {
      const cfg = pickKv(auth.bearer);
      const token = cfg.token ?? '';
      if (!hasHeader(headers, 'Authorization')) {
        headers.push({ name: 'Authorization', value: `Bearer ${token}` });
      }
      notes.push('bearer');
      break;
    }
    case 'apikey': {
      const cfg = pickKv(auth.apikey);
      const key = cfg.key ?? 'X-API-Key';
      const value = cfg.value ?? '';
      const where = cfg.in ?? 'header';
      if (where === 'query') {
        unsupported.push(`apikey in query (${key}) — append manually to URL`);
        notes.push(`apikey (in: query, name: ${key})`);
      } else {
        if (!hasHeader(headers, key)) headers.push({ name: key, value });
        notes.push(`apikey (in: header, name: ${key})`);
      }
      break;
    }
    case 'oauth2': {
      const cfg = pickKv(auth.oauth2);
      const token = cfg.accessToken ?? cfg.access_token ?? '';
      if (token.length > 0 && !hasHeader(headers, 'Authorization')) {
        headers.push({ name: 'Authorization', value: `Bearer ${token}` });
      }
      notes.push('oauth2 (configure in .http-auth.json)');
      break;
    }
    case 'noauth':
      break;
    default:
      unsupported.push(`auth type: ${auth.type}`);
  }
}

function pickKv(node: unknown): Record<string, string> {
  // Postman serialises auth params as either { key: 'x', value: 'y' }[] OR
  // { x: 'y' }. Normalise to a flat record.
  if (Array.isArray(node)) {
    const out: Record<string, string> = {};
    for (const entry of node) {
      if (
        entry &&
        typeof entry === 'object' &&
        'key' in entry &&
        typeof (entry as { key: unknown }).key === 'string'
      ) {
        const k = (entry as { key: string }).key;
        const v = (entry as { value?: unknown }).value;
        out[k] = typeof v === 'string' ? v : v == null ? '' : String(v);
      }
    }
    return out;
  }
  if (node && typeof node === 'object') {
    const out: Record<string, string> = {};
    for (const [k, v] of Object.entries(node as Record<string, unknown>)) {
      out[k] = typeof v === 'string' ? v : v == null ? '' : String(v);
    }
    return out;
  }
  return {};
}

function hasHeader(headers: Array<{ name: string }>, name: string): boolean {
  const lc = name.toLowerCase();
  return headers.some((h) => h.name.toLowerCase() === lc);
}

function sanitiseFilename(name: string): string {
  const cleaned = name
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9._-]+/g, '-')
    .replace(/^-+|-+$/g, '');
  return cleaned.length > 0 ? cleaned : 'folder';
}

function base64Utf8(s: string): string {
  if (typeof Buffer !== 'undefined') return Buffer.from(s, 'utf8').toString('base64');
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const g: any = globalThis as any;
  if (typeof g.btoa === 'function') return g.btoa(unescape(encodeURIComponent(s)));
  throw new Error('no base64 encoder available');
}

function safeParseJson(s: string): unknown {
  try {
    return JSON.parse(s);
  } catch {
    return s;
  }
}
