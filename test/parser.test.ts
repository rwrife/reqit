import { describe, expect, it } from 'vitest';
import { parseHttpFile } from '../src/core/parser.js';
import { toUndiciRequest } from '../src/core/request.js';

describe('parseHttpFile', () => {
  it('parses a single GET request', () => {
    const { requests, diagnostics } = parseHttpFile('GET https://example.com/api\n');
    expect(diagnostics).toEqual([]);
    expect(requests).toHaveLength(1);
    expect(requests[0]).toMatchObject({
      method: 'GET',
      url: 'https://example.com/api',
      headers: [],
      body: '',
    });
  });

  it('parses headers and body', () => {
    const src = `POST https://example.com/x
Content-Type: application/json
X-Trace: abc

{"a":1}
`;
    const { requests, diagnostics } = parseHttpFile(src);
    expect(diagnostics).toEqual([]);
    expect(requests).toHaveLength(1);
    expect(requests[0].method).toBe('POST');
    expect(requests[0].headers).toEqual([
      { name: 'Content-Type', value: 'application/json' },
      { name: 'X-Trace', value: 'abc' },
    ]);
    expect(requests[0].body).toBe('{"a":1}');
  });

  it('splits on ### separators and captures names', () => {
    const src = `### first
GET https://a.test/

### second
POST https://b.test/
Content-Type: text/plain

hi
`;
    const { requests } = parseHttpFile(src);
    expect(requests).toHaveLength(2);
    expect(requests[0].name).toBe('first');
    expect(requests[1].name).toBe('second');
    expect(requests[1].body).toBe('hi');
  });

  it('skips comment lines but keeps blank-line body separator', () => {
    const src = `# this is a comment
// also a comment
GET https://example.com/
Accept: */*

`;
    const { requests, diagnostics } = parseHttpFile(src);
    expect(diagnostics).toEqual([]);
    expect(requests[0].headers).toEqual([{ name: 'Accept', value: '*/*' }]);
    expect(requests[0].body).toBe('');
  });

  it('reports invalid request line as diagnostic', () => {
    const src = `NOTAMETHOD https://example.com/\n`;
    const { requests, diagnostics } = parseHttpFile(src);
    expect(requests).toHaveLength(0);
    expect(diagnostics).toHaveLength(1);
    expect(diagnostics[0].line).toBe(0);
  });

  it('handles CRLF line endings', () => {
    const src = `GET https://example.com/\r\nAccept: */*\r\n\r\n`;
    const { requests } = parseHttpFile(src);
    expect(requests).toHaveLength(1);
    expect(requests[0].headers).toEqual([{ name: 'Accept', value: '*/*' }]);
  });

  it('preserves multi-line JSON body verbatim', () => {
    const src = `POST https://example.com/
Content-Type: application/json

{
  "a": 1,
  "b": [1, 2, 3]
}
`;
    const { requests } = parseHttpFile(src);
    expect(requests[0].body).toBe('{\n  "a": 1,\n  "b": [1, 2, 3]\n}');
  });
});

describe('toUndiciRequest', () => {
  it('validates a well-formed request', () => {
    const { requests } = parseHttpFile('GET https://example.com/\nAccept: */*\n');
    const opts = toUndiciRequest(requests[0]);
    expect(opts.method).toBe('GET');
    expect(opts.url).toBe('https://example.com/');
    expect(opts.headers).toEqual({ Accept: '*/*' });
    expect(opts.body).toBeUndefined();
  });

  it('rejects an invalid URL', () => {
    const { requests } = parseHttpFile('GET not-a-url\n');
    expect(() => toUndiciRequest(requests[0])).toThrow();
  });

  it('includes body when present', () => {
    const { requests } = parseHttpFile(
      'POST https://example.com/\nContent-Type: application/json\n\n{"x":1}\n',
    );
    const opts = toUndiciRequest(requests[0]);
    expect(opts.body).toBe('{"x":1}');
  });
});
