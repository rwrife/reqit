/**
 * Pure `.http-auth.json` schema + auth applier. No VS Code dependencies.
 *
 * `.http-auth.json` declares named auth profiles. Secret material (passwords,
 * tokens, signing keys, passphrases) is NEVER stored here — only references
 * via `{ "$secret": true }` markers, resolved at request time from
 * VS Code SecretStorage by the extension layer.
 *
 * Example:
 * {
 *   "github":  { "type": "bearer",    "token":     { "$secret": true } },
 *   "admin":   { "type": "basic",     "username":  "alice",
 *                                      "password":  { "$secret": true } },
 *   "x-api":   { "type": "apiKey",    "in": "header", "name": "X-API-Key",
 *                                      "value":     { "$secret": true } },
 *   "svc-jwt": { "type": "jwt",       "kind": "paste",
 *                                      "token":     { "$secret": true } },
 *   "gen-jwt": { "type": "jwt",       "kind": "generated",
 *                                      "alg":   "HS256",
 *                                      "secret": { "$secret": true },
 *                                      "claims": { "iss": "reqit", "sub": "test" },
 *                                      "ttlSec": 300 },
 *   "mtls":    { "type": "clientCert",
 *                                      "format": "pem",
 *                                      "certPath": "./certs/client.pem",
 *                                      "keyPath":  "./certs/client.key" }
 * }
 *
 * The `# @auth <name>` directive in a `.http` file selects the profile.
 *
 * This module produces a `ResolvedAuth` describing the headers to add and
 * (for clientCert) the TLS material the extension layer must wire into the
 * undici Agent. It never touches the network and never touches secrets that
 * aren't already resolved into plain strings by the caller.
 */
import { z } from 'zod';
import { HMAC_ALGS, signJwtHmac, type HmacAlg } from './jwt.js';
import { oauth2AuthSchema, type OAuth2Auth } from './oauth2.js';

export const secretMarkerSchema = z.object({ $secret: z.literal(true) });
export type SecretMarker = z.infer<typeof secretMarkerSchema>;

/** A value that may be a literal string or a $secret marker. */
export const stringOrSecretSchema = z.union([z.string(), secretMarkerSchema]);
export type StringOrSecret = z.infer<typeof stringOrSecretSchema>;

export function isSecretMarker(v: unknown): v is SecretMarker {
  return (
    typeof v === 'object' &&
    v !== null &&
    (v as Record<string, unknown>).$secret === true
  );
}

export const basicAuthSchema = z.object({
  type: z.literal('basic'),
  username: z.string().min(1),
  password: stringOrSecretSchema,
});

export const bearerAuthSchema = z.object({
  type: z.literal('bearer'),
  token: stringOrSecretSchema,
});

export const apiKeyAuthSchema = z.object({
  type: z.literal('apiKey'),
  in: z.enum(['header', 'query']),
  name: z.string().min(1),
  value: stringOrSecretSchema,
});

export const jwtPasteAuthSchema = z.object({
  type: z.literal('jwt'),
  kind: z.literal('paste'),
  token: stringOrSecretSchema,
  /** Scheme used for the Authorization header. Defaults to "Bearer". */
  scheme: z.string().optional(),
});

export const jwtGeneratedAuthSchema = z.object({
  type: z.literal('jwt'),
  kind: z.literal('generated'),
  alg: z.enum(HMAC_ALGS as unknown as [HmacAlg, ...HmacAlg[]]),
  secret: stringOrSecretSchema,
  claims: z.record(z.string(), z.unknown()).default({}),
  /** Optional `exp` injection — seconds from "now". */
  ttlSec: z.number().int().positive().optional(),
  /** Optional `iat` injection. Defaults to true. */
  setIat: z.boolean().default(true),
  scheme: z.string().optional(),
  header: z.record(z.string(), z.unknown()).optional(),
});

export const jwtAuthSchema = z.discriminatedUnion('kind', [
  jwtPasteAuthSchema,
  jwtGeneratedAuthSchema,
]);

export const clientCertPemSchema = z.object({
  type: z.literal('clientCert'),
  format: z.literal('pem'),
  certPath: z.string().min(1),
  keyPath: z.string().min(1),
  caPath: z.string().optional(),
  passphrase: stringOrSecretSchema.optional(),
});

export const clientCertPfxSchema = z.object({
  type: z.literal('clientCert'),
  format: z.literal('pfx'),
  pfxPath: z.string().min(1),
  passphrase: stringOrSecretSchema.optional(),
});

export const clientCertAuthSchema = z.discriminatedUnion('format', [
  clientCertPemSchema,
  clientCertPfxSchema,
]);

// zod's discriminatedUnion needs unique discriminator values, so we use a
// plain z.union and rely on each branch's literal `type` (+ `kind`/`format`
// for jwt/clientCert) to drive the discrimination via Zod's own try-each.
export const authProfileSchema = z.union([
  basicAuthSchema,
  bearerAuthSchema,
  apiKeyAuthSchema,
  jwtPasteAuthSchema,
  jwtGeneratedAuthSchema,
  clientCertPemSchema,
  clientCertPfxSchema,
  oauth2AuthSchema,
]);

export const authFileSchema = z.record(z.string(), authProfileSchema);

export type BasicAuth = z.infer<typeof basicAuthSchema>;
export type BearerAuth = z.infer<typeof bearerAuthSchema>;
export type ApiKeyAuth = z.infer<typeof apiKeyAuthSchema>;
export type JwtAuth = z.infer<typeof jwtAuthSchema>;
export type ClientCertAuth = z.infer<typeof clientCertAuthSchema>;
export type AuthProfile = z.infer<typeof authProfileSchema>;
export type AuthFile = z.infer<typeof authFileSchema>;

export interface ParseAuthFileResult {
  ok: boolean;
  profiles: AuthFile;
  error?: string;
}

/** Parse and validate `.http-auth.json` source text. Never throws. */
export function parseAuthFile(source: string): ParseAuthFileResult {
  let json: unknown;
  try {
    json = JSON.parse(source);
  } catch (err) {
    return { ok: false, profiles: {}, error: `Invalid JSON: ${(err as Error).message}` };
  }
  const parsed = authFileSchema.safeParse(json);
  if (!parsed.success) {
    const msg = parsed.error.issues
      .map((i) => `${i.path.join('.') || '<root>'}: ${i.message}`)
      .join('; ');
    return { ok: false, profiles: {}, error: msg };
  }
  return { ok: true, profiles: parsed.data };
}

/** List secret refs in an auth file, keyed by `<profileName>.<field>` for SecretStorage prompts. */
export function listAuthSecretRefs(file: AuthFile): Array<{ profile: string; field: string }> {
  const out: Array<{ profile: string; field: string }> = [];
  for (const [name, prof] of Object.entries(file)) {
    const check = (field: string, value: unknown) => {
      if (isSecretMarker(value)) out.push({ profile: name, field });
    };
    switch (prof.type) {
      case 'basic':
        check('password', prof.password);
        break;
      case 'bearer':
        check('token', prof.token);
        break;
      case 'apiKey':
        check('value', prof.value);
        break;
      case 'jwt':
        if (prof.kind === 'paste') check('token', prof.token);
        else check('secret', prof.secret);
        break;
      case 'clientCert':
        if (prof.passphrase !== undefined) check('passphrase', prof.passphrase);
        break;
      case 'oauth2':
        if (prof.flow === 'clientCredentials') check('clientSecret', prof.clientSecret);
        else if (prof.clientSecret !== undefined) check('clientSecret', prof.clientSecret);
        break;
    }
  }
  return out;
}

/* ------------------------------------------------------------------ */
/*  Applier                                                            */
/* ------------------------------------------------------------------ */

/** Material the extension layer needs to wire into the undici Agent for mTLS. */
export interface TlsMaterial {
  format: 'pem' | 'pfx';
  certPath?: string;
  keyPath?: string;
  caPath?: string;
  pfxPath?: string;
  passphrase?: string;
}

export interface ResolvedAuth {
  /** Headers to merge into the outgoing request. */
  headers: Record<string, string>;
  /** Query params to merge into the URL. */
  query: Record<string, string>;
  /** TLS material for clientCert profiles; consumed by the extension layer. */
  tls?: TlsMaterial;
}

/**
 * Resolver invoked for each `{ "$secret": true }` marker found while applying
 * a profile. Identified by `<profileName>.<field>` so the caller can pull the
 * right SecretStorage value.
 */
export type AuthSecretResolver = (profile: string, field: string) => string | undefined;

/**
 * Resolver invoked for oauth2 profiles. Returns a still-valid access token
 * (or `undefined` if one cannot be obtained — `applyAuth` will throw in that
 * case). The extension layer owns acquisition, caching, and refresh.
 */
export type OAuth2TokenResolver = (
  profile: string,
  auth: OAuth2Auth,
) => { accessToken: string; tokenType?: string } | undefined;

export class AuthApplyError extends Error {
  constructor(
    message: string,
    public readonly profile: string,
  ) {
    super(message);
    this.name = 'AuthApplyError';
  }
}

function resolveValue(
  v: StringOrSecret,
  profile: string,
  field: string,
  resolve: AuthSecretResolver,
): string {
  if (typeof v === 'string') return v;
  const got = resolve(profile, field);
  if (got === undefined || got === '') {
    throw new AuthApplyError(`Missing secret for ${profile}.${field}`, profile);
  }
  return got;
}

export interface ApplyAuthOptions {
  /** Profile name as referenced from `# @auth <name>`. */
  name: string;
  profile: AuthProfile;
  resolve: AuthSecretResolver;
  /** Resolver for oauth2 access tokens. Required when profile.type === 'oauth2'. */
  resolveOAuthToken?: OAuth2TokenResolver;
  /** Clock override for deterministic JWT iat/exp. ms since epoch. */
  now?: () => number;
}

/** Build the headers/query/tls a profile contributes to an outgoing request. */
export function applyAuth(opts: ApplyAuthOptions): ResolvedAuth {
  const { name, profile, resolve } = opts;
  const headers: Record<string, string> = {};
  const query: Record<string, string> = {};

  switch (profile.type) {
    case 'basic': {
      const pwd = resolveValue(profile.password, name, 'password', resolve);
      const b = Buffer.from(`${profile.username}:${pwd}`, 'utf8').toString('base64');
      headers['Authorization'] = `Basic ${b}`;
      return { headers, query };
    }
    case 'bearer': {
      const tok = resolveValue(profile.token, name, 'token', resolve);
      headers['Authorization'] = `Bearer ${tok}`;
      return { headers, query };
    }
    case 'apiKey': {
      const val = resolveValue(profile.value, name, 'value', resolve);
      if (profile.in === 'header') headers[profile.name] = val;
      else query[profile.name] = val;
      return { headers, query };
    }
    case 'jwt': {
      const scheme = profile.scheme ?? 'Bearer';
      if (profile.kind === 'paste') {
        const tok = resolveValue(profile.token, name, 'token', resolve);
        headers['Authorization'] = `${scheme} ${tok}`;
        return { headers, query };
      }
      const secret = resolveValue(profile.secret, name, 'secret', resolve);
      const nowMs = (opts.now ?? Date.now)();
      const nowSec = Math.floor(nowMs / 1000);
      const claims: Record<string, unknown> = { ...profile.claims };
      if (profile.setIat && claims.iat === undefined) claims.iat = nowSec;
      if (profile.ttlSec !== undefined && claims.exp === undefined) {
        claims.exp = nowSec + profile.ttlSec;
      }
      const signOpts: Parameters<typeof signJwtHmac>[0] = {
        alg: profile.alg,
        secret,
        claims,
      };
      if (profile.header) signOpts.header = profile.header;
      const tok = signJwtHmac(signOpts);
      headers['Authorization'] = `${scheme} ${tok}`;
      return { headers, query };
    }
    case 'oauth2': {
      if (!opts.resolveOAuthToken) {
        throw new AuthApplyError(
          `oauth2 profile '${name}' requires a token resolver`,
          name,
        );
      }
      const tok = opts.resolveOAuthToken(name, profile);
      if (!tok || !tok.accessToken) {
        throw new AuthApplyError(`No access token available for oauth2 profile '${name}'`, name);
      }
      const scheme = profile.scheme ?? tok.tokenType ?? 'Bearer';
      headers['Authorization'] = `${scheme} ${tok.accessToken}`;
      return { headers, query };
    }
    case 'clientCert': {
      const tls: TlsMaterial = { format: profile.format };
      if (profile.format === 'pem') {
        tls.certPath = profile.certPath;
        tls.keyPath = profile.keyPath;
        if (profile.caPath) tls.caPath = profile.caPath;
      } else {
        tls.pfxPath = profile.pfxPath;
      }
      if (profile.passphrase !== undefined) {
        tls.passphrase = resolveValue(profile.passphrase, name, 'passphrase', resolve);
      }
      return { headers, query, tls };
    }
    default: {
      // exhaustive — type system guarantees this is unreachable
      const _exhaustive: never = profile;
      throw new AuthApplyError(
        `Unknown auth profile type: ${(_exhaustive as { type: string }).type}`,
        name,
      );
    }
  }
}

/* ------------------------------------------------------------------ */
/*  URL helper                                                         */
/* ------------------------------------------------------------------ */

/** Merge query params into a URL string, preserving existing params and order. */
export function mergeQuery(url: string, params: Record<string, string>): string {
  const keys = Object.keys(params);
  if (keys.length === 0) return url;
  const hashIdx = url.indexOf('#');
  const hash = hashIdx >= 0 ? url.slice(hashIdx) : '';
  const base = hashIdx >= 0 ? url.slice(0, hashIdx) : url;
  const sep = base.includes('?') ? '&' : '?';
  const enc = keys
    .map((k) => `${encodeURIComponent(k)}=${encodeURIComponent(params[k])}`)
    .join('&');
  return `${base}${sep}${enc}${hash}`;
}
