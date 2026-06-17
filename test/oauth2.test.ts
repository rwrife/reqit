import { describe, it, expect } from 'vitest';
import { createHash } from 'node:crypto';
import {
  generatePkce,
  generateState,
  buildAuthorizationUrl,
  buildClientCredentialsBody,
  buildAuthCodeBody,
  buildRefreshBody,
  encodeForm,
  parseTokenResponse,
  parseAuthorizationRedirect,
  isTokenExpired,
  OAuth2Error,
  oauth2AuthSchema,
  type OAuth2AuthorizationCodeAuth,
  type OAuth2ClientCredentialsAuth,
} from '../src/core/oauth2.js';

const ccProfile: OAuth2ClientCredentialsAuth = {
  type: 'oauth2',
  flow: 'clientCredentials',
  tokenUrl: 'https://idp.example.com/token',
  clientId: 'svc',
  clientSecret: 'shh',
  scope: 'read write',
};

const acProfile: OAuth2AuthorizationCodeAuth = {
  type: 'oauth2',
  flow: 'authorizationCode',
  authorizationUrl: 'https://idp.example.com/authorize',
  tokenUrl: 'https://idp.example.com/token',
  clientId: 'web-app',
  redirectUri: 'http://127.0.0.1:53682/callback',
  scope: 'openid profile',
};

describe('oauth2 schema', () => {
  it('accepts clientCredentials and authorizationCode profiles', () => {
    expect(oauth2AuthSchema.safeParse(ccProfile).success).toBe(true);
    expect(oauth2AuthSchema.safeParse(acProfile).success).toBe(true);
  });
  it('rejects unknown flow', () => {
    const bad = { ...ccProfile, flow: 'password' };
    expect(oauth2AuthSchema.safeParse(bad).success).toBe(false);
  });
});

describe('generatePkce', () => {
  it('produces a 43-char base64url verifier and matching S256 challenge', () => {
    const pair = generatePkce();
    expect(pair.method).toBe('S256');
    expect(pair.verifier).toMatch(/^[A-Za-z0-9_-]{43}$/);
    const expected = createHash('sha256')
      .update(pair.verifier)
      .digest('base64')
      .replace(/\+/g, '-')
      .replace(/\//g, '_')
      .replace(/=+$/, '');
    expect(pair.challenge).toBe(expected);
  });
  it('is deterministic when randomness is injected', () => {
    const rand = (n: number) => Buffer.alloc(n, 0xab);
    const a = generatePkce(rand);
    const b = generatePkce(rand);
    expect(a).toEqual(b);
  });
});

describe('generateState', () => {
  it('returns a base64url string with no padding', () => {
    const s = generateState();
    expect(s).toMatch(/^[A-Za-z0-9_-]{22}$/); // 16 bytes => 22 chars
  });
});

describe('buildAuthorizationUrl', () => {
  it('includes all PKCE + standard params', () => {
    const url = buildAuthorizationUrl({
      profile: acProfile,
      state: 'xyz',
      codeChallenge: 'CHAL',
    });
    const u = new URL(url);
    expect(u.origin + u.pathname).toBe('https://idp.example.com/authorize');
    expect(u.searchParams.get('response_type')).toBe('code');
    expect(u.searchParams.get('client_id')).toBe('web-app');
    expect(u.searchParams.get('redirect_uri')).toBe('http://127.0.0.1:53682/callback');
    expect(u.searchParams.get('scope')).toBe('openid profile');
    expect(u.searchParams.get('state')).toBe('xyz');
    expect(u.searchParams.get('code_challenge')).toBe('CHAL');
    expect(u.searchParams.get('code_challenge_method')).toBe('S256');
  });
  it('merges extraAuthParams', () => {
    const url = buildAuthorizationUrl({
      profile: { ...acProfile, extraAuthParams: { audience: 'api://x' } },
      state: 's',
      codeChallenge: 'c',
    });
    expect(new URL(url).searchParams.get('audience')).toBe('api://x');
  });
});

describe('encodeForm', () => {
  it('percent-encodes keys and values', () => {
    expect(encodeForm({ 'a b': 'c+d', e: 'f' })).toBe('a%20b=c%2Bd&e=f');
  });
});

describe('buildClientCredentialsBody', () => {
  it('produces the correct grant_type body', () => {
    const body = buildClientCredentialsBody(ccProfile, 'shh');
    const p = new URLSearchParams(body);
    expect(p.get('grant_type')).toBe('client_credentials');
    expect(p.get('client_id')).toBe('svc');
    expect(p.get('client_secret')).toBe('shh');
    expect(p.get('scope')).toBe('read write');
  });
});

describe('buildAuthCodeBody', () => {
  it('includes verifier and omits client_secret when not provided', () => {
    const body = buildAuthCodeBody({
      profile: acProfile,
      code: 'AUTHCODE',
      verifier: 'V',
    });
    const p = new URLSearchParams(body);
    expect(p.get('grant_type')).toBe('authorization_code');
    expect(p.get('code')).toBe('AUTHCODE');
    expect(p.get('code_verifier')).toBe('V');
    expect(p.get('client_id')).toBe('web-app');
    expect(p.has('client_secret')).toBe(false);
  });
  it('includes client_secret when provided', () => {
    const body = buildAuthCodeBody({
      profile: acProfile,
      code: 'C',
      verifier: 'V',
      clientSecret: 'S',
    });
    expect(new URLSearchParams(body).get('client_secret')).toBe('S');
  });
});

describe('buildRefreshBody', () => {
  it('builds a refresh_token body', () => {
    const body = buildRefreshBody({ clientId: 'web-app', refreshToken: 'rt' });
    const p = new URLSearchParams(body);
    expect(p.get('grant_type')).toBe('refresh_token');
    expect(p.get('refresh_token')).toBe('rt');
    expect(p.get('client_id')).toBe('web-app');
  });
});

describe('parseTokenResponse', () => {
  it('parses a success response and computes expiresAtMs', () => {
    const t = parseTokenResponse({
      status: 200,
      body: JSON.stringify({ access_token: 'AT', token_type: 'Bearer', expires_in: 60, refresh_token: 'RT' }),
      now: 1_000_000,
    });
    expect(t.accessToken).toBe('AT');
    expect(t.refreshToken).toBe('RT');
    expect(t.expiresAtMs).toBe(1_000_000 + 60_000);
  });
  it('defaults token_type to Bearer when omitted', () => {
    const t = parseTokenResponse({ status: 200, body: JSON.stringify({ access_token: 'X' }) });
    expect(t.tokenType).toBe('Bearer');
    expect(t.expiresAtMs).toBeUndefined();
  });
  it('throws OAuth2Error on RFC-shaped error body', () => {
    expect(() =>
      parseTokenResponse({
        status: 400,
        body: JSON.stringify({ error: 'invalid_grant', error_description: 'bad code' }),
      }),
    ).toThrowError(OAuth2Error);
  });
  it('throws on non-JSON bodies', () => {
    expect(() => parseTokenResponse({ status: 500, body: '<html>nope</html>' })).toThrowError(
      OAuth2Error,
    );
  });
  it('throws on missing access_token', () => {
    expect(() => parseTokenResponse({ status: 200, body: JSON.stringify({ foo: 'bar' }) })).toThrowError(
      OAuth2Error,
    );
  });
});

describe('isTokenExpired', () => {
  it('returns false when expiresAtMs is undefined', () => {
    expect(isTokenExpired({})).toBe(false);
  });
  it('respects leeway', () => {
    const now = 1_000_000;
    expect(isTokenExpired({ expiresAtMs: now + 20_000 }, now, 30)).toBe(true);
    expect(isTokenExpired({ expiresAtMs: now + 60_000 }, now, 30)).toBe(false);
  });
});

describe('parseAuthorizationRedirect', () => {
  it('returns code + state on success', () => {
    const r = parseAuthorizationRedirect(
      'http://127.0.0.1:53682/callback?code=ABC&state=xyz',
      'xyz',
    );
    expect(r).toEqual({ code: 'ABC', state: 'xyz' });
  });
  it('throws on state mismatch (CSRF)', () => {
    expect(() =>
      parseAuthorizationRedirect('http://127.0.0.1/cb?code=A&state=zzz', 'xyz'),
    ).toThrowError(/state.*mismatch/i);
  });
  it('throws on error= response', () => {
    expect(() =>
      parseAuthorizationRedirect(
        'http://127.0.0.1/cb?error=access_denied&error_description=nope',
        'xyz',
      ),
    ).toThrowError(/access_denied/);
  });
  it('throws on missing code', () => {
    expect(() => parseAuthorizationRedirect('http://127.0.0.1/cb?state=xyz', 'xyz')).toThrowError(
      /missing.*code/,
    );
  });
});
