import { describe, it, expect } from 'vitest';
import { parseCurl, renderImportedCurlAsHttp } from '../src/core/import/curl.js';

describe('parseCurl', () => {
  it('parses a minimal GET', () => {
    const r = parseCurl('curl https://example.com/api');
    expect(r.method).toBe('GET');
    expect(r.url).toBe('https://example.com/api');
    expect(r.headers).toEqual([]);
    expect(r.body).toBeUndefined();
  });

  it('handles backslash line continuations', () => {
    const r = parseCurl(`curl -X POST https://api.example.com/v1/users \\
      -H 'Content-Type: application/json' \\
      -d '{"name":"alice"}'`);
    expect(r.method).toBe('POST');
    expect(r.url).toBe('https://api.example.com/v1/users');
    expect(r.headers).toEqual([{ name: 'Content-Type', value: 'application/json' }]);
    expect(r.body).toBe('{"name":"alice"}');
  });

  it('defaults to POST when -d is present and no -X', () => {
    const r = parseCurl(`curl https://x.test -d 'a=1' -d 'b=2'`);
    expect(r.method).toBe('POST');
    expect(r.body).toBe('a=1&b=2');
    expect(r.headers).toContainEqual({
      name: 'Content-Type',
      value: 'application/x-www-form-urlencoded',
    });
  });

  it('respects an explicit Content-Type', () => {
    const r = parseCurl(`curl https://x.test -H 'content-type: text/plain' -d 'hi'`);
    expect(r.headers.filter((h) => h.name.toLowerCase() === 'content-type')).toHaveLength(1);
  });

  it('encodes --data-urlencode parts', () => {
    const r = parseCurl(`curl https://x.test --data-urlencode 'q=hello world' --data-urlencode 'lang=en'`);
    expect(r.body).toBe('q=hello%20world&lang=en');
  });

  it('preserves @file references in --data-urlencode', () => {
    const r = parseCurl(`curl https://x.test --data-urlencode 'payload=@/tmp/body.json'`);
    expect(r.body).toBe('payload=@/tmp/body.json');
  });

  it('expands -u into a Basic Authorization header and emits an auth hint', () => {
    const r = parseCurl(`curl -u 'alice:s3cret' https://x.test`);
    const auth = r.headers.find((h) => h.name === 'Authorization');
    expect(auth?.value).toBe(`Basic ${Buffer.from('alice:s3cret').toString('base64')}`);
    expect(r.authHints).toEqual([{ kind: 'basic', details: { user: 'alice' } }]);
  });

  it('collects --cert and --key into a single clientCert hint', () => {
    const r = parseCurl(
      `curl --cert /tmp/c.pem:hunter2 --key /tmp/c.key https://mtls.example.com`,
    );
    expect(r.authHints).toEqual([
      {
        kind: 'clientCert',
        details: { cert: '/tmp/c.pem', passphrase: 'hunter2', key: '/tmp/c.key' },
      },
    ]);
  });

  it('handles --header=NAME: VALUE inline form', () => {
    const r = parseCurl(`curl --header='X-Trace: abc' https://x.test`);
    expect(r.headers).toContainEqual({ name: 'X-Trace', value: 'abc' });
  });

  it('throws on a curl command without a URL', () => {
    expect(() => parseCurl(`curl -X POST -H 'X: y'`)).toThrow(/no URL/);
  });

  it('throws on unterminated quotes', () => {
    expect(() => parseCurl(`curl 'https://x.test`)).toThrow(/unterminated/);
  });

  it('tokenizes double-quoted strings with embedded escapes', () => {
    const r = parseCurl(`curl -H "X-Quote: he said \\"hi\\"" https://x.test`);
    expect(r.headers).toContainEqual({ name: 'X-Quote', value: 'he said "hi"' });
  });

  it('records unsupported flags rather than blowing up', () => {
    const r = parseCurl(`curl -L --insecure -o /tmp/out https://x.test`);
    expect(r.unsupported).toContain('-L');
    expect(r.unsupported).toContain('--insecure');
    expect(r.unsupported).toContain('-o');
    expect(r.url).toBe('https://x.test');
  });

  it('accepts --url as URL source', () => {
    const r = parseCurl(`curl --url https://api.example.com/foo -H 'A: 1'`);
    expect(r.url).toBe('https://api.example.com/foo');
  });
});

describe('renderImportedCurlAsHttp', () => {
  it('renders headers, body and auth directive', () => {
    const r = parseCurl(`curl -u alice:pw -X POST https://x.test -H 'X: y' -d 'hi'`);
    const http = renderImportedCurlAsHttp(r, 'create-user');
    expect(http).toContain('### create-user');
    expect(http).toContain('# @auth basic (user: alice)');
    expect(http).toContain('POST https://x.test');
    expect(http).toContain('X: y');
    expect(http).toContain('Authorization: Basic');
    expect(http).toMatch(/\n\nhi\n$/);
  });

  it('renders a bodyless GET cleanly', () => {
    const http = renderImportedCurlAsHttp(parseCurl('curl https://x.test'));
    expect(http).toBe('### imported\nGET https://x.test\n');
  });
});
