import { describe, expect, it } from 'vitest';
import {
  parseChainReference,
  parseCaptureDirective,
  createChainStore,
  resolveChainText,
  resolveChainRequest,
  applyCapture,
  validateRequestNames,
} from '../src/core/chain/resolver.js';

describe('parseChainReference', () => {
  it('parses response body JSONPath refs', () => {
    const r = parseChainReference('login.response.body.$.data.token');
    expect(r).toEqual({
      kind: 'response',
      part: 'body',
      requestName: 'login',
      path: '$.data.token',
    });
  });

  it('parses response status refs', () => {
    expect(parseChainReference('login.response.status')).toEqual({
      kind: 'response',
      part: 'status',
      requestName: 'login',
    });
  });

  it('parses response header refs preserving the header name', () => {
    expect(parseChainReference('login.response.headers.X-Trace-Id')).toEqual({
      kind: 'response',
      part: 'headers',
      requestName: 'login',
      headerName: 'X-Trace-Id',
    });
  });

  it('parses request body JSONPath refs', () => {
    expect(parseChainReference('login.request.body.$.correlation_id')).toEqual({
      kind: 'request',
      part: 'body',
      requestName: 'login',
      path: '$.correlation_id',
    });
  });

  it('returns null for non-chain references', () => {
    expect(parseChainReference('baseUrl')).toBeNull();
    expect(parseChainReference('$guid')).toBeNull();
    expect(parseChainReference('login.response.body')).toBeNull(); // body needs $.path
    expect(parseChainReference('login.request.status')).toBeNull(); // status is response-only
    expect(parseChainReference('1bad.response.status')).toBeNull();
  });
});

describe('parseCaptureDirective', () => {
  it('parses an untyped capture', () => {
    expect(parseCaptureDirective('token = $.access_token')).toEqual({
      name: 'token',
      declaredType: null,
      secret: false,
      path: '$.access_token',
    });
  });

  it('parses a typed capture', () => {
    expect(parseCaptureDirective('count: number = $.meta.count')).toEqual({
      name: 'count',
      declaredType: 'number',
      secret: false,
      path: '$.meta.count',
    });
  });

  it('parses a typed secret capture', () => {
    expect(parseCaptureDirective('tok: string secret = $.auth.token')).toEqual({
      name: 'tok',
      declaredType: 'string',
      secret: true,
      path: '$.auth.token',
    });
  });

  it('rejects invalid names, types, and shapes', () => {
    expect('error' in parseCaptureDirective('bad name = $.x')).toBe(true);
    expect('error' in parseCaptureDirective('tok: jsonp = $.x')).toBe(true);
    expect('error' in parseCaptureDirective('tok = notapath')).toBe(true);
    expect('error' in parseCaptureDirective('= $.x')).toBe(true);
    expect('error' in parseCaptureDirective('tok: string secret extra = $.x')).toBe(true);
  });
});

describe('validateRequestNames', () => {
  it('accepts unique alnum+underscore names', () => {
    expect(validateRequestNames(['login', 'me_v2', 'logout'])).toEqual([]);
  });

  it('flags duplicates and invalid identifiers', () => {
    const diags = validateRequestNames(['login', 'login', '1bad', 'ok']);
    expect(diags.some((d) => d.includes('duplicate'))).toBe(true);
    expect(diags.some((d) => d.includes('1bad'))).toBe(true);
  });
});

describe('resolveChainText / resolveChainRequest', () => {
  const store = () => {
    const s = createChainStore();
    s.recordRequest('login', { body: JSON.stringify({ correlation_id: 'cid-9', nested: { a: 1 } }) });
    s.recordResponse('login', {
      status: 201,
      headers: { 'content-type': 'application/json', 'X-Trace-Id': 'trace-abc' },
      body: JSON.stringify({
        access_token: 'tok-123',
        meta: { count: 7, flag: true, nothing: null },
        items: [{ id: 10 }, { id: 20 }],
      }),
    });
    return s;
  };

  it('substitutes status, headers, body JSONPath, and request body JSONPath', () => {
    const s = store();
    const r = resolveChainText(
      'S {{login.response.status}} {{login.response.headers.x-trace-id}} {{login.response.body.$.access_token}} {{login.request.body.$.correlation_id}}',
      s,
    );
    expect(r.text).toBe('S 201 trace-abc tok-123 cid-9');
    expect(r.diagnostics).toEqual([]);
  });

  it('header lookup is case-insensitive both directions', () => {
    const s = store();
    expect(resolveChainText('{{login.response.headers.X-TRACE-ID}}', s).text).toBe('trace-abc');
    expect(resolveChainText('{{login.response.headers.Content-Type}}', s).text).toBe('application/json');
  });

  it('serializes JSON values: numbers/booleans plain, objects/arrays compact JSON', () => {
    const s = store();
    expect(resolveChainText('{{login.response.body.$.meta.count}}', s).text).toBe('7');
    expect(resolveChainText('{{login.response.body.$.meta.flag}}', s).text).toBe('true');
    expect(resolveChainText('{{login.response.body.$.meta.nothing}}', s).text).toBe('null');
    expect(resolveChainText('{{login.response.body.$.items[1].id}}', s).text).toBe('20');
    expect(resolveChainText('{{login.response.body.$.items}}', s).text).toBe('[{"id":10},{"id":20}]');
  });

  it('leaves non-chain references untouched for later env substitution', () => {
    const s = store();
    const r = resolveChainText('{{baseUrl}}/x {{$guid}} {{unknown}}', s);
    expect(r.text).toBe('{{baseUrl}}/x {{$guid}} {{unknown}}');
    expect(r.diagnostics).toEqual([]);
  });

  it('reports actionable diagnostics for unresolved chains and leaves the ref in place', () => {
    const s = store();
    const r = resolveChainText(
      '{{missing.response.status}} {{login.response.body.$.nope.deep}} {{login.response.headers.X-Absent}} {{login.response.body.$.notjson}}',
      s,
    );
    expect(r.text).toContain('{{missing.response.status}}');
    expect(r.text).toContain('{{login.response.body.$.nope.deep}}');
    expect(r.diagnostics.map((d) => d.variable)).toEqual([
      'missing.response.status',
      'login.response.body.$.nope.deep',
      'login.response.headers.X-Absent',
      'login.response.body.$.notjson',
    ]);
    expect(r.diagnostics[0].message).toContain('no recorded response');
    expect(r.diagnostics[1].message).toContain('Path miss');
    expect(r.diagnostics[2].message).toContain('X-Absent');
    expect(r.diagnostics[3].message).toContain('Path miss');
  });

  it('diagnoses malformed body paths and invalid JSON request bodies', () => {
    const s = createChainStore();
    s.recordRequest('weird', { body: 'not json' });
    const r = resolveChainText('{{weird.request.body.$.x}}', s);
    expect(r.text).toBe('{{weird.request.body.$.x}}');
    expect(r.diagnostics[0].message).toContain('not valid JSON');
  });

  it('resolveChainRequest covers url, header values, and body', () => {
    const s = store();
    const r = resolveChainRequest(
      {
        url: 'https://api/{{login.response.body.$.meta.count}}',
        headers: [
          { name: 'Authorization', value: 'Bearer {{login.response.body.$.access_token}}' },
          { name: 'X-Trace', value: '{{login.response.headers.X-Trace-Id}}' },
          { name: 'X-Static', value: 'plain' },
        ],
        body: '{"cid":"{{login.request.body.$.correlation_id}}"}',
      },
      s,
    );
    expect(r.url).toBe('https://api/7');
    expect(r.headers[0].value).toBe('Bearer tok-123');
    expect(r.headers[1].value).toBe('trace-abc');
    expect(r.headers[2].value).toBe('plain');
    expect(r.body).toBe('{"cid":"cid-9"}');
    expect(r.diagnostics).toEqual([]);
  });
});

describe('applyCapture', () => {
  const response = {
    status: 200,
    headers: {},
    body: JSON.stringify({
      access_token: 'tok',
      meta: { count: 7, flag: false, name: 'ada' },
    }),
  };

  it('captures untyped values with the raw JSON type preserved', () => {
    const c = applyCapture('token = $.access_token', response);
    expect('error' in c).toBe(false);
    if (!('error' in c)) {
      expect(c).toEqual({ name: 'token', value: 'tok', secret: false });
    }
  });

  it('validates declared types with zod and reports mismatches', () => {
    const okNum = applyCapture('n: number = $.meta.count', response);
    expect('error' in okNum).toBe(false);
    const badNum = applyCapture('n: number = $.meta.name', response);
    expect('error' in badNum).toBe(true);
    if ('error' in badNum) expect(badNum.error).toContain('number');
    const badBool = applyCapture('b: boolean = $.meta.count', response);
    expect('error' in badBool).toBe(true);
  });

  it('propagates the secret flag', () => {
    const c = applyCapture('tok: string secret = $.access_token', response);
    if ('error' in c) throw new Error('should parse');
    expect(c.secret).toBe(true);
  });

  it('reports path misses and parse errors as errors', () => {
    expect('error' in applyCapture('x = $.missing.path', response)).toBe(true);
    expect('error' in applyCapture('bad name = $.x', response)).toBe(true);
  });
});
