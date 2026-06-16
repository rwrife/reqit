/**
 * Pure OAuth2 building blocks: schemas, PKCE, URL/body construction, token
 * response parsing, expiry helpers. No VS Code dependencies, no `undici`
 * imports — the network round-trip is done by an injected `TokenHttp` so
 * this module stays unit-testable.
 *
 * Two flows are supported per PLAN.md M4:
 *   - `clientCredentials` — server-to-server, no user interaction
 *   - `authorizationCode` with PKCE — uses an external browser + loopback
 *      redirect (the extension layer drives that part)
 *
 * The extension layer is responsible for:
 *   - storing access/refresh tokens in VS Code SecretStorage
 *   - opening the system browser via `vscode.env.openExternal`
 *   - running the loopback HTTP listener that receives the redirect
 *   - calling `applyAuth` with a `getOAuthToken` resolver that returns a
 *     still-valid (or freshly-refreshed) access token for the named profile
 */
import { createHash, randomBytes } from 'node:crypto';
import { z } from 'zod';

// Local copy of the secret-marker union to avoid a circular import with auth.ts.
const secretMarkerSchema = z.object({ $secret: z.literal(true) });
const stringOrSecretSchema = z.union([z.string(), secretMarkerSchema]);

/* ------------------------------------------------------------------ */
/*  Schemas                                                            */
/* ------------------------------------------------------------------ */

export const oauth2ClientCredentialsSchema = z.object({
  type: z.literal('oauth2'),
  flow: z.literal('clientCredentials'),
  tokenUrl: z.string().url(),
  clientId: z.string().min(1),
  clientSecret: stringOrSecretSchema,
  /** Space-separated list, per RFC 6749 §3.3. */
  scope: z.string().optional(),
  /** Extra params merged into the token request body. */
  extraParams: z.record(z.string(), z.string()).optional(),
  /** Authorization header style. Defaults to "Bearer". */
  scheme: z.string().optional(),
});

export const oauth2AuthorizationCodeSchema = z.object({
  type: z.literal('oauth2'),
  flow: z.literal('authorizationCode'),
  authorizationUrl: z.string().url(),
  tokenUrl: z.string().url(),
  clientId: z.string().min(1),
  /** Public clients (typical for PKCE) MAY omit clientSecret. */
  clientSecret: stringOrSecretSchema.optional(),
  /** Loopback redirect; the extension layer picks the port. */
  redirectUri: z.string().url(),
  scope: z.string().optional(),
  /** Extra query params merged into the authorization URL. */
  extraAuthParams: z.record(z.string(), z.string()).optional(),
  /** Extra body params merged into the token request. */
  extraTokenParams: z.record(z.string(), z.string()).optional(),
  scheme: z.string().optional(),
});

export const oauth2AuthSchema = z.discriminatedUnion('flow', [
  oauth2ClientCredentialsSchema,
  oauth2AuthorizationCodeSchema,
]);

export type OAuth2ClientCredentialsAuth = z.infer<typeof oauth2ClientCredentialsSchema>;
export type OAuth2AuthorizationCodeAuth = z.infer<typeof oauth2AuthorizationCodeSchema>;
export type OAuth2Auth = z.infer<typeof oauth2AuthSchema>;

/* ------------------------------------------------------------------ */
/*  PKCE                                                               */
/* ------------------------------------------------------------------ */

export interface PkcePair {
  verifier: string;
  challenge: string;
  method: 'S256';
}

/** base64url without padding, per RFC 7636 §4.2. */
function base64url(buf: Buffer): string {
  return buf.toString('base64').replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}

/**
 * Generate a PKCE verifier (43–128 chars, RFC 7636 §4.1) and its S256
 * challenge. Uses 32 random bytes → 43-char base64url verifier.
 */
export function generatePkce(rand: (n: number) => Buffer = randomBytes): PkcePair {
  const verifier = base64url(rand(32));
  const challenge = base64url(createHash('sha256').update(verifier).digest());
  return { verifier, challenge, method: 'S256' };
}

/** Cryptographically random `state` value for CSRF protection. */
export function generateState(rand: (n: number) => Buffer = randomBytes): string {
  return base64url(rand(16));
}

/* ------------------------------------------------------------------ */
/*  URL / body builders                                                */
/* ------------------------------------------------------------------ */

export interface BuildAuthorizationUrlOptions {
  profile: OAuth2AuthorizationCodeAuth;
  state: string;
  codeChallenge: string;
}

/** Build the `GET <authorizationUrl>?...` URL the user's browser opens. */
export function buildAuthorizationUrl(opts: BuildAuthorizationUrlOptions): string {
  const { profile, state, codeChallenge } = opts;
  const u = new URL(profile.authorizationUrl);
  u.searchParams.set('response_type', 'code');
  u.searchParams.set('client_id', profile.clientId);
  u.searchParams.set('redirect_uri', profile.redirectUri);
  if (profile.scope) u.searchParams.set('scope', profile.scope);
  u.searchParams.set('state', state);
  u.searchParams.set('code_challenge', codeChallenge);
  u.searchParams.set('code_challenge_method', 'S256');
  if (profile.extraAuthParams) {
    for (const [k, v] of Object.entries(profile.extraAuthParams)) u.searchParams.set(k, v);
  }
  return u.toString();
}

/** application/x-www-form-urlencoded body builder. */
export function encodeForm(params: Record<string, string>): string {
  return Object.entries(params)
    .map(([k, v]) => `${encodeURIComponent(k)}=${encodeURIComponent(v)}`)
    .join('&');
}

/** Build the client_credentials token request body. */
export function buildClientCredentialsBody(
  profile: OAuth2ClientCredentialsAuth,
  clientSecret: string,
): string {
  const params: Record<string, string> = {
    grant_type: 'client_credentials',
    client_id: profile.clientId,
    client_secret: clientSecret,
  };
  if (profile.scope) params.scope = profile.scope;
  if (profile.extraParams) Object.assign(params, profile.extraParams);
  return encodeForm(params);
}

export interface BuildAuthCodeBodyOptions {
  profile: OAuth2AuthorizationCodeAuth;
  code: string;
  verifier: string;
  clientSecret?: string;
}

/** Build the authorization_code redemption body (PKCE-aware). */
export function buildAuthCodeBody(opts: BuildAuthCodeBodyOptions): string {
  const { profile, code, verifier, clientSecret } = opts;
  const params: Record<string, string> = {
    grant_type: 'authorization_code',
    code,
    redirect_uri: profile.redirectUri,
    client_id: profile.clientId,
    code_verifier: verifier,
  };
  if (clientSecret) params.client_secret = clientSecret;
  if (profile.extraTokenParams) Object.assign(params, profile.extraTokenParams);
  return encodeForm(params);
}

export interface BuildRefreshBodyOptions {
  clientId: string;
  refreshToken: string;
  clientSecret?: string;
  scope?: string;
}

export function buildRefreshBody(opts: BuildRefreshBodyOptions): string {
  const params: Record<string, string> = {
    grant_type: 'refresh_token',
    refresh_token: opts.refreshToken,
    client_id: opts.clientId,
  };
  if (opts.clientSecret) params.client_secret = opts.clientSecret;
  if (opts.scope) params.scope = opts.scope;
  return encodeForm(params);
}

/* ------------------------------------------------------------------ */
/*  Token response parsing                                             */
/* ------------------------------------------------------------------ */

export const tokenResponseSchema = z.object({
  access_token: z.string().min(1),
  token_type: z.string().optional(),
  expires_in: z.number().int().positive().optional(),
  refresh_token: z.string().optional(),
  scope: z.string().optional(),
  id_token: z.string().optional(),
});
export type TokenResponse = z.infer<typeof tokenResponseSchema>;

export const tokenErrorResponseSchema = z.object({
  error: z.string().min(1),
  error_description: z.string().optional(),
  error_uri: z.string().optional(),
});
export type TokenErrorResponse = z.infer<typeof tokenErrorResponseSchema>;

export interface ParsedToken {
  accessToken: string;
  tokenType: string;
  refreshToken?: string;
  scope?: string;
  idToken?: string;
  /** Absolute expiry time (ms since epoch). `undefined` when server omits expires_in. */
  expiresAtMs?: number;
}

export class OAuth2Error extends Error {
  constructor(
    message: string,
    public readonly code?: string,
    public readonly description?: string,
  ) {
    super(message);
    this.name = 'OAuth2Error';
  }
}

export interface ParseTokenResponseOptions {
  status: number;
  body: string;
  /** ms since epoch used to compute `expiresAtMs`. Defaults to `Date.now()`. */
  now?: number;
}

/** Parse + validate a token endpoint response. Throws `OAuth2Error` on failure. */
export function parseTokenResponse(opts: ParseTokenResponseOptions): ParsedToken {
  const now = opts.now ?? Date.now();
  let json: unknown;
  try {
    json = JSON.parse(opts.body);
  } catch {
    throw new OAuth2Error(
      `Token endpoint returned non-JSON (status ${opts.status}): ${opts.body.slice(0, 200)}`,
    );
  }
  if (opts.status >= 400) {
    const errParsed = tokenErrorResponseSchema.safeParse(json);
    if (errParsed.success) {
      throw new OAuth2Error(
        `OAuth2 ${errParsed.data.error}${errParsed.data.error_description ? ': ' + errParsed.data.error_description : ''}`,
        errParsed.data.error,
        errParsed.data.error_description,
      );
    }
    throw new OAuth2Error(`Token endpoint returned ${opts.status}: ${opts.body.slice(0, 200)}`);
  }
  const parsed = tokenResponseSchema.safeParse(json);
  if (!parsed.success) {
    throw new OAuth2Error(
      `Invalid token response: ${parsed.error.issues
        .map((i) => `${i.path.join('.') || '<root>'}: ${i.message}`)
        .join('; ')}`,
    );
  }
  const t = parsed.data;
  const out: ParsedToken = {
    accessToken: t.access_token,
    tokenType: t.token_type ?? 'Bearer',
  };
  if (t.refresh_token) out.refreshToken = t.refresh_token;
  if (t.scope) out.scope = t.scope;
  if (t.id_token) out.idToken = t.id_token;
  if (t.expires_in !== undefined) out.expiresAtMs = now + t.expires_in * 1000;
  return out;
}

/* ------------------------------------------------------------------ */
/*  Expiry helpers                                                     */
/* ------------------------------------------------------------------ */

/** A token is considered expired `leewaySec` seconds before its real expiry. */
export function isTokenExpired(
  token: Pick<ParsedToken, 'expiresAtMs'>,
  now: number = Date.now(),
  leewaySec = 30,
): boolean {
  if (token.expiresAtMs === undefined) return false;
  return now + leewaySec * 1000 >= token.expiresAtMs;
}

/* ------------------------------------------------------------------ */
/*  Authorization redirect parsing                                     */
/* ------------------------------------------------------------------ */

export interface AuthRedirectResult {
  code: string;
  state: string;
}

/**
 * Parse the loopback redirect URL the IdP sent the user's browser to. The
 * extension's loopback HTTP listener feeds the full request URL here.
 * Throws `OAuth2Error` on `error=...` responses or `state` mismatch.
 */
export function parseAuthorizationRedirect(
  redirectUrl: string,
  expectedState: string,
): AuthRedirectResult {
  const u = new URL(redirectUrl);
  const err = u.searchParams.get('error');
  if (err) {
    throw new OAuth2Error(
      `Authorization failed: ${err}${u.searchParams.get('error_description') ? ' — ' + u.searchParams.get('error_description') : ''}`,
      err,
      u.searchParams.get('error_description') ?? undefined,
    );
  }
  const code = u.searchParams.get('code');
  const state = u.searchParams.get('state');
  if (!code) throw new OAuth2Error('Authorization redirect missing `code`');
  if (!state) throw new OAuth2Error('Authorization redirect missing `state`');
  if (state !== expectedState) throw new OAuth2Error('Authorization `state` mismatch (CSRF)');
  return { code, state };
}
