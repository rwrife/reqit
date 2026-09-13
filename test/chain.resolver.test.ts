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

  it('diagnoses an invalid recorded RESPONSE body as not valid JSON', () => {
    const s = createChainStore();
    s.recordResponse('weird', { status: 200, headers: {}, body: 'not json' });
    const r = resolveChainText('{{weird.response.body.$.x}}', s);
    expect(r.text).toBe('{{weird.response.body.$.x}}');
    expect(r.diagnostics).toHaveLength(1);
    expect(r.diagnostics[0].message).toContain('not valid JSON');
  });

  it('flags chain-shaped references bound to a recorded name even when malformed', () => {
    const s = store();
    // `login` is recorded and the ref is chain-shaped, so chain intent wins:
    // these must NOT silently pass through to env substitution.
    const r = resolveChainText(
      '{{login.response.status.extra}} {{login.request.status}} {{login.response.body.notjson.$}}',
      s,
    );
    expect(r.diagnostics.map((d) => d.variable)).toEqual([
      'login.response.status.extra',
      'login.request.status',
      'login.response.body.notjson.$',
    ]);
    // literal stays in place
    expect(r.text).toContain('{{login.response.status.extra}}');
    expect(r.diagnostics[0].message).toMatch(/status/);
    expect(r.diagnostics[1].message).toMatch(/request/);
    expect(r.diagnostics[2].message).toMatch(/JSONPath/);
  });

  it('leaves malformed chain-shaped refs to UNKNOWN names for env substitution', () => {
    const s = store();
    // `checkout` was never recorded and the ref is malformed chain-shaped:
    // indistinguishable from an ordinary (possibly dotted) env var name, so
    // it passes through untouched per the pass-through contract.
    const r = resolveChainText('{{checkout.response.status.extra}}', s);
    expect(r.text).toBe('{{checkout.response.status.extra}}');
    expect(r.diagnostics).toEqual([]);
  });

  it('diagnoses validly-shaped refs to unknown names (no recorded response)', () => {
    const s = store();
    const r = resolveChainText('{{checkout.response.status}}', s);
    expect(r.text).toBe('{{checkout.response.status}}');
    expect(r.diagnostics).toHaveLength(1);
    expect(r.diagnostics[0].message).toContain('no recorded response');
  });

  it('parses a body ref with a quoted key containing }', () => {
    // 'weird}key' survives the placeholder scan and resolves.
    const s2 = createChainStore();
    s2.recordResponse('login', {
      status: 200,
      headers: {},
      body: JSON.stringify({ 'weird}key': 'ok' }),
    });
    const r = resolveChainText("{{login.response.body.$['weird}key']}}", s2);
    expect(r.text).toBe('ok');
    expect(r.diagnostics).toEqual([]);
  });

  it('bounds the number of references resolved in one text', () => {
    const s = store();
    const hostile = Array(101)
      .fill('a{{login.response.status}}')
      .join('');
    const r = resolveChainText(hostile, s);
    // First 100 resolve normally; the overflow is left literal with one diagnostic.
    const resolvedCount = (r.text.match(/a201/g) ?? []).length;
    expect(resolvedCount).toBe(100);
    expect(r.text).toContain('a{{login.response.status}}'); // overflow stays literal
    expect(r.diagnostics).toHaveLength(1);
    expect(r.diagnostics[0].message).toMatch(/too many/i);
  });

  it('returns defensive copies from store getters (no stored-history mutation)', () => {
    const s = store();
    const rec = s.getResponse('login')!;
    rec.status = 500;
    rec.headers['X-Trace-Id'] = 'tampered';
    rec.body = 'tampered';
    const again = s.getResponse('login')!;
    expect(again.status).toBe(201);
    expect(again.headers['X-Trace-Id']).toBe('trace-abc');
    expect(again.body).not.toBe('tampered');

    const req = s.getRequest('login')!;
    req.body = 'tampered';
    expect(s.getRequest('login')!.body).not.toBe('tampered');
  });

  it('stores captures per run with duplicate detection and secret flags', () => {
    const s = store();
    const errs = s.recordCaptures([
      { name: 'token', value: 'tok', secret: true },
      { name: 'count', value: 7, secret: false },
    ]);
    expect(errs).toEqual([]);
    expect(s.getCapture('token')).toEqual({ value: 'tok', secret: true });
    expect(s.getCapture('count')).toEqual({ value: 7, secret: false });
    expect(s.getCapture('absent')).toBeUndefined();
    expect(s.captureNames().sort()).toEqual(['count', 'token']);

    // duplicate names are rejected per-run (must be caught before wiring)
    const dup = s.recordCaptures([{ name: 'token', value: 'tok2', secret: true }]);
    expect(dup).toHaveLength(1);
    expect(dup[0]).toContain('duplicate capture');
    expect(s.getCapture('token')).toEqual({ value: 'tok', secret: true }); // first wins

    // invalid names rejected
    const bad = s.recordCaptures([{ name: '1bad', value: 'x', secret: false }]);
    expect(bad.some((d) => d.includes('1bad'))).toBe(true);

    // clear() wipes captures too
    s.clear();
    expect(s.getCapture('token')).toBeUndefined();
    expect(s.captureNames()).toEqual([]);
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
