/**
 * Pure JWT helpers — encode (HS256/384/512), decode, and inspect.
 * No VS Code dependencies; uses Node's built-in `crypto`.
 *
 * Scope of this slice:
 *   - HS256 / HS384 / HS512 signing
 *   - Decode any JWS-compact token (header + payload + signature pieces)
 *   - HMAC signature verification (HS*)
 *
 * RS256 / ES256 are intentionally deferred to a follow-up — they require key
 * loading (PEM / JWK) which is out of scope for the initial M3 slice.
 */
import { createHmac, timingSafeEqual } from 'node:crypto';

export type HmacAlg = 'HS256' | 'HS384' | 'HS512';
export const HMAC_ALGS: readonly HmacAlg[] = ['HS256', 'HS384', 'HS512'];

const HMAC_NODE_ALG: Record<HmacAlg, string> = {
  HS256: 'sha256',
  HS384: 'sha384',
  HS512: 'sha512',
};

function b64urlEncode(buf: Buffer | string): string {
  const b = typeof buf === 'string' ? Buffer.from(buf, 'utf8') : buf;
  return b.toString('base64').replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}

function b64urlDecode(s: string): Buffer {
  const pad = s.length % 4 === 0 ? '' : '='.repeat(4 - (s.length % 4));
  const b64 = s.replace(/-/g, '+').replace(/_/g, '/') + pad;
  return Buffer.from(b64, 'base64');
}

export interface JwtSignOptions {
  alg: HmacAlg;
  /** HMAC secret. UTF-8 string or raw bytes. */
  secret: string | Buffer;
  /** Claims object; serialized as JSON. */
  claims: Record<string, unknown>;
  /** Extra header fields merged after `{alg, typ:'JWT'}`. */
  header?: Record<string, unknown>;
}

/** Sign a JWS-compact JWT with an HMAC algorithm. */
export function signJwtHmac(opts: JwtSignOptions): string {
  if (!HMAC_ALGS.includes(opts.alg)) {
    throw new Error(`Unsupported alg for signJwtHmac: ${opts.alg as string}`);
  }
  const header = { alg: opts.alg, typ: 'JWT', ...(opts.header ?? {}) };
  const h = b64urlEncode(JSON.stringify(header));
  const p = b64urlEncode(JSON.stringify(opts.claims));
  const signingInput = `${h}.${p}`;
  const sig = createHmac(HMAC_NODE_ALG[opts.alg], opts.secret).update(signingInput).digest();
  return `${signingInput}.${b64urlEncode(sig)}`;
}

export interface DecodedJwt {
  header: Record<string, unknown>;
  payload: Record<string, unknown>;
  /** Raw base64url signature segment (may be empty for `alg: none`). */
  signature: string;
  /** The `${header}.${payload}` portion that signatures are computed over. */
  signingInput: string;
}

export interface JwtDecodeError {
  ok: false;
  error: string;
}
export interface JwtDecodeOk {
  ok: true;
  decoded: DecodedJwt;
}
export type JwtDecodeResult = JwtDecodeOk | JwtDecodeError;

/** Decode a compact JWT. Does NOT verify the signature. Never throws. */
export function decodeJwt(token: string): JwtDecodeResult {
  const parts = token.split('.');
  if (parts.length !== 3) {
    return { ok: false, error: `Expected 3 segments, got ${parts.length}` };
  }
  let header: Record<string, unknown>;
  let payload: Record<string, unknown>;
  try {
    const h = JSON.parse(b64urlDecode(parts[0]).toString('utf8'));
    const p = JSON.parse(b64urlDecode(parts[1]).toString('utf8'));
    if (typeof h !== 'object' || h === null) return { ok: false, error: 'Header is not an object' };
    if (typeof p !== 'object' || p === null) return { ok: false, error: 'Payload is not an object' };
    header = h as Record<string, unknown>;
    payload = p as Record<string, unknown>;
  } catch (err) {
    return { ok: false, error: `Base64/JSON decode failed: ${(err as Error).message}` };
  }
  return {
    ok: true,
    decoded: {
      header,
      payload,
      signature: parts[2],
      signingInput: `${parts[0]}.${parts[1]}`,
    },
  };
}

/** Verify an HMAC-signed JWT. Returns true iff alg matches and signature is valid. */
export function verifyJwtHmac(token: string, secret: string | Buffer): boolean {
  const dec = decodeJwt(token);
  if (!dec.ok) return false;
  const alg = dec.decoded.header.alg;
  if (typeof alg !== 'string' || !HMAC_ALGS.includes(alg as HmacAlg)) return false;
  const expected = createHmac(HMAC_NODE_ALG[alg as HmacAlg], secret)
    .update(dec.decoded.signingInput)
    .digest();
  let actual: Buffer;
  try {
    actual = b64urlDecode(dec.decoded.signature);
  } catch {
    return false;
  }
  if (actual.length !== expected.length) return false;
  return timingSafeEqual(actual, expected);
}
