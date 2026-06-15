import { describe, expect, it } from 'vitest';
import {
  signJwtHmac,
  decodeJwt,
  verifyJwtHmac,
  HMAC_ALGS,
} from '../src/core/jwt.js';

describe('signJwtHmac', () => {
  it('produces a known HS256 token for fixed inputs', () => {
    // Vector adapted from jwt.io defaults.
    const token = signJwtHmac({
      alg: 'HS256',
      secret: 'your-256-bit-secret',
      claims: { sub: '1234567890', name: 'John Doe', iat: 1516239022 },
    });
    expect(token).toBe(
      'eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJzdWIiOiIxMjM0NTY3ODkwIiwibmFtZSI6IkpvaG4gRG9lIiwiaWF0IjoxNTE2MjM5MDIyfQ.SflKxwRJSMeKKF2QT4fwpMeJf36POk6yJV_adQssw5c',
    );
  });

  it('round-trips for each HMAC alg', () => {
    for (const alg of HMAC_ALGS) {
      const token = signJwtHmac({ alg, secret: 's3cret', claims: { foo: 'bar' } });
      expect(verifyJwtHmac(token, 's3cret')).toBe(true);
      const dec = decodeJwt(token);
      expect(dec.ok).toBe(true);
      if (dec.ok) {
        expect(dec.decoded.header.alg).toBe(alg);
        expect(dec.decoded.payload).toEqual({ foo: 'bar' });
      }
    }
  });

  it('verifyJwtHmac rejects wrong secret and tampered payload', () => {
    const tok = signJwtHmac({ alg: 'HS256', secret: 'right', claims: { a: 1 } });
    expect(verifyJwtHmac(tok, 'wrong')).toBe(false);

    const parts = tok.split('.');
    const tampered = `${parts[0]}.${Buffer.from('{"a":2}').toString('base64url')}.${parts[2]}`;
    expect(verifyJwtHmac(tampered, 'right')).toBe(false);
  });

  it('decodeJwt fails gracefully on garbage input', () => {
    expect(decodeJwt('not-a-jwt').ok).toBe(false);
    expect(decodeJwt('a.b').ok).toBe(false);
    expect(decodeJwt('!!.!!.!!').ok).toBe(false);
  });

  it('signJwtHmac throws on non-HMAC alg', () => {
    expect(() =>
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      signJwtHmac({ alg: 'RS256' as any, secret: 's', claims: {} }),
    ).toThrow(/Unsupported alg/);
  });
});
