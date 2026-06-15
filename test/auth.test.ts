import { describe, expect, it } from 'vitest';
import {
  parseAuthFile,
  applyAuth,
  mergeQuery,
  listAuthSecretRefs,
  type AuthSecretResolver,
} from '../src/core/auth.js';
import { verifyJwtHmac, decodeJwt } from '../src/core/jwt.js';

const noResolve: AuthSecretResolver = () => undefined;

describe('parseAuthFile', () => {
  it('accepts all profile types', () => {
    const src = JSON.stringify({
      a: { type: 'basic', username: 'u', password: { $secret: true } },
      b: { type: 'bearer', token: 'tok' },
      c: { type: 'apiKey', in: 'header', name: 'X-Key', value: { $secret: true } },
      d: { type: 'jwt', kind: 'paste', token: { $secret: true } },
      e: {
        type: 'jwt',
        kind: 'generated',
        alg: 'HS256',
        secret: { $secret: true },
        claims: { iss: 'reqit' },
        ttlSec: 60,
      },
      f: {
        type: 'clientCert',
        format: 'pem',
        certPath: './c.pem',
        keyPath: './k.pem',
      },
      g: {
        type: 'clientCert',
        format: 'pfx',
        pfxPath: './c.pfx',
        passphrase: { $secret: true },
      },
    });
    const r = parseAuthFile(src);
    expect(r.ok).toBe(true);
    expect(Object.keys(r.profiles)).toHaveLength(7);
  });

  it('rejects invalid JSON and unknown auth type', () => {
    expect(parseAuthFile('not json').ok).toBe(false);
    expect(
      parseAuthFile(JSON.stringify({ x: { type: 'magic' } })).ok,
    ).toBe(false);
  });
});

describe('listAuthSecretRefs', () => {
  it('enumerates secret refs across profile types', () => {
    const r = parseAuthFile(
      JSON.stringify({
        a: { type: 'basic', username: 'u', password: { $secret: true } },
        b: { type: 'bearer', token: 'plain' },
        c: { type: 'apiKey', in: 'query', name: 'k', value: { $secret: true } },
      }),
    );
    expect(r.ok).toBe(true);
    const refs = listAuthSecretRefs(r.profiles).sort((x, y) =>
      x.profile.localeCompare(y.profile),
    );
    expect(refs).toEqual([
      { profile: 'a', field: 'password' },
      { profile: 'c', field: 'value' },
    ]);
  });
});

describe('applyAuth', () => {
  it('basic — builds Authorization: Basic header', () => {
    const r = parseAuthFile(
      JSON.stringify({ p: { type: 'basic', username: 'alice', password: 'open sesame' } }),
    );
    expect(r.ok).toBe(true);
    const out = applyAuth({ name: 'p', profile: r.profiles.p, resolve: noResolve });
    expect(out.headers.Authorization).toBe(
      'Basic ' + Buffer.from('alice:open sesame').toString('base64'),
    );
  });

  it('basic — resolves $secret password via resolver', () => {
    const r = parseAuthFile(
      JSON.stringify({
        p: { type: 'basic', username: 'alice', password: { $secret: true } },
      }),
    );
    const out = applyAuth({
      name: 'p',
      profile: r.profiles.p,
      resolve: (prof, field) => (prof === 'p' && field === 'password' ? 'hunter2' : undefined),
    });
    expect(out.headers.Authorization).toBe(
      'Basic ' + Buffer.from('alice:hunter2').toString('base64'),
    );
  });

  it('basic — throws AuthApplyError when secret is missing', () => {
    const r = parseAuthFile(
      JSON.stringify({
        p: { type: 'basic', username: 'alice', password: { $secret: true } },
      }),
    );
    expect(() => applyAuth({ name: 'p', profile: r.profiles.p, resolve: noResolve })).toThrow(
      /Missing secret for p\.password/,
    );
  });

  it('bearer — Authorization: Bearer <token>', () => {
    const r = parseAuthFile(JSON.stringify({ p: { type: 'bearer', token: 'abc' } }));
    const out = applyAuth({ name: 'p', profile: r.profiles.p, resolve: noResolve });
    expect(out.headers.Authorization).toBe('Bearer abc');
  });

  it('apiKey header vs query', () => {
    const r = parseAuthFile(
      JSON.stringify({
        h: { type: 'apiKey', in: 'header', name: 'X-API-Key', value: 'k1' },
        q: { type: 'apiKey', in: 'query', name: 'api_key', value: 'k2' },
      }),
    );
    expect(
      applyAuth({ name: 'h', profile: r.profiles.h, resolve: noResolve }).headers['X-API-Key'],
    ).toBe('k1');
    const qOut = applyAuth({ name: 'q', profile: r.profiles.q, resolve: noResolve });
    expect(qOut.query).toEqual({ api_key: 'k2' });
    expect(qOut.headers).toEqual({});
  });

  it('jwt paste — uses supplied token verbatim with default Bearer scheme', () => {
    const r = parseAuthFile(
      JSON.stringify({ p: { type: 'jwt', kind: 'paste', token: 'jjj' } }),
    );
    expect(
      applyAuth({ name: 'p', profile: r.profiles.p, resolve: noResolve }).headers.Authorization,
    ).toBe('Bearer jjj');
  });

  it('jwt generated — signs with HMAC, injects iat/exp from clock', () => {
    const r = parseAuthFile(
      JSON.stringify({
        p: {
          type: 'jwt',
          kind: 'generated',
          alg: 'HS256',
          secret: 's3cret',
          claims: { iss: 'reqit' },
          ttlSec: 300,
        },
      }),
    );
    const fixedNow = 1_700_000_000_000;
    const out = applyAuth({
      name: 'p',
      profile: r.profiles.p,
      resolve: noResolve,
      now: () => fixedNow,
    });
    const tok = out.headers.Authorization.replace(/^Bearer /, '');
    expect(verifyJwtHmac(tok, 's3cret')).toBe(true);
    const dec = decodeJwt(tok);
    expect(dec.ok).toBe(true);
    if (dec.ok) {
      expect(dec.decoded.payload).toMatchObject({
        iss: 'reqit',
        iat: 1_700_000_000,
        exp: 1_700_000_000 + 300,
      });
      expect(dec.decoded.header.alg).toBe('HS256');
    }
  });

  it('clientCert pem — produces TLS material, no headers', () => {
    const r = parseAuthFile(
      JSON.stringify({
        m: {
          type: 'clientCert',
          format: 'pem',
          certPath: './c.pem',
          keyPath: './k.pem',
          caPath: './ca.pem',
        },
      }),
    );
    const out = applyAuth({ name: 'm', profile: r.profiles.m, resolve: noResolve });
    expect(out.headers).toEqual({});
    expect(out.tls).toEqual({
      format: 'pem',
      certPath: './c.pem',
      keyPath: './k.pem',
      caPath: './ca.pem',
    });
  });

  it('clientCert pfx — resolves passphrase via $secret', () => {
    const r = parseAuthFile(
      JSON.stringify({
        m: {
          type: 'clientCert',
          format: 'pfx',
          pfxPath: './c.pfx',
          passphrase: { $secret: true },
        },
      }),
    );
    const out = applyAuth({
      name: 'm',
      profile: r.profiles.m,
      resolve: (p, f) => (p === 'm' && f === 'passphrase' ? 'pw' : undefined),
    });
    expect(out.tls).toEqual({ format: 'pfx', pfxPath: './c.pfx', passphrase: 'pw' });
  });
});

describe('mergeQuery', () => {
  it('appends to a URL without existing params', () => {
    expect(mergeQuery('https://x.test/p', { a: '1' })).toBe('https://x.test/p?a=1');
  });
  it('uses & when params already present, preserves order', () => {
    expect(mergeQuery('https://x.test/p?z=9', { a: '1', b: '2' })).toBe(
      'https://x.test/p?z=9&a=1&b=2',
    );
  });
  it('keeps fragment intact', () => {
    expect(mergeQuery('https://x.test/p#top', { a: '1' })).toBe('https://x.test/p?a=1#top');
  });
  it('encodes special chars', () => {
    expect(mergeQuery('https://x.test/p', { 'a b': 'v&w' })).toBe(
      'https://x.test/p?a%20b=v%26w',
    );
  });
  it('returns input unchanged for empty params', () => {
    expect(mergeQuery('https://x.test/', {})).toBe('https://x.test/');
  });
});
