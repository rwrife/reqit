import { describe, expect, it } from 'vitest';
import {
  parseJsonPath,
  evaluateJsonPath,
  type JsonPathSegment,
} from '../src/core/chain/jsonpath.js';

describe('parseJsonPath', () => {
  it('accepts the root path $', () => {
    expect(parseJsonPath('$')).toEqual({ segments: [] });
  });

  it('parses dot-notation keys', () => {
    const r = parseJsonPath('$.access_token');
    expect(r).toEqual({ segments: [{ kind: 'key', name: 'access_token' }] });
  });

  it('parses nested dot-notation keys', () => {
    const r = parseJsonPath('$.data.user.name');
    expect(r).toEqual({
      segments: [
        { kind: 'key', name: 'data' },
        { kind: 'key', name: 'user' },
        { kind: 'key', name: 'name' },
      ],
    });
  });

  it('parses bracket numeric indexes', () => {
    const r = parseJsonPath('$.items[2].id');
    expect(r).toEqual({
      segments: [
        { kind: 'key', name: 'items' },
        { kind: 'index', value: 2 },
        { kind: 'key', name: 'id' },
      ],
    });
  });

  it('parses bracket string keys with single or double quotes', () => {
    expect(parseJsonPath("$['x-api-key']")).toEqual({
      segments: [{ kind: 'key', name: 'x-api-key' }],
    });
    expect(parseJsonPath('$["a b"]')).toEqual({
      segments: [{ kind: 'key', name: 'a b' }],
    });
  });

  it('parses quoted keys containing ] and } (quote-aware bracket scan)', () => {
    expect(parseJsonPath("$['a]b']")).toEqual({
      segments: [{ kind: 'key', name: 'a]b' }],
    });
    expect(parseJsonPath('$["c}d"]')).toEqual({
      segments: [{ kind: 'key', name: 'c}d' }],
    });
    // A quote char of the OTHER kind must not terminate the quoted key.
    expect(parseJsonPath("$[\"it's\"]")).toEqual({
      segments: [{ kind: 'key', name: "it's" }],
    });
    // Unterminated quoted key (no closing quote before end) is rejected.
    expect('error' in parseJsonPath("$['oops]")).toBe(true);
  });

  it('rejects reserved prototype segment names at parse time', () => {
    expect('error' in parseJsonPath('$.__proto__')).toBe(true);
    expect('error' in parseJsonPath('$.a.constructor')).toBe(true);
    expect('error' in parseJsonPath("$['prototype']")).toBe(true);
    expect('error' in parseJsonPath("$['__proto__'].x")).toBe(true);
  });

  it('bounds path depth to prevent hostile deep paths', () => {
    const deepOk = '$' + '.a'.repeat(64);
    expect('error' in parseJsonPath(deepOk)).toBe(false);
    const deepBad = '$' + '.a'.repeat(65);
    expect('error' in parseJsonPath(deepBad)).toBe(true);
  });

  it('rejects a path not starting with $', () => {
    const r = parseJsonPath('access_token');
    expect('error' in r).toBe(true);
  });

  it('rejects wildcards and slices (documented subset)', () => {
    expect('error' in parseJsonPath('$.*')).toBe(true);
    expect('error' in parseJsonPath('$.items[*]')).toBe(true);
    expect('error' in parseJsonPath('$.items[1:3]')).toBe(true);
  });

  it('rejects empty brackets and trailing dots', () => {
    expect('error' in parseJsonPath('$[]')).toBe(true);
    expect('error' in parseJsonPath('$.')).toBe(true);
  });
});

describe('evaluateJsonPath', () => {
  const doc = {
    access_token: 'tok-123',
    count: 7,
    ok: true,
    nested: { user: { name: 'ada' } },
    items: [{ id: 10 }, { id: 20 }],
    'weird-key': { 'a.b': 'slash' },
  };

  it('returns the root value for $', () => {
    const r = evaluateJsonPath(doc, []);
    expect(r).toEqual({ found: true, value: doc });
  });

  it('resolves a top-level key', () => {
    const { segments } = parseJsonPath('$.access_token') as { segments: never };
    expect(evaluateJsonPath(doc, segments)).toEqual({ found: true, value: 'tok-123' });
  });

  it('resolves nested keys and indexes', () => {
    const a = parseJsonPath('$.nested.user.name') as { segments: never };
    expect(evaluateJsonPath(doc, a.segments)).toEqual({ found: true, value: 'ada' });
    const b = parseJsonPath('$.items[1].id') as { segments: never };
    expect(evaluateJsonPath(doc, b.segments)).toEqual({ found: true, value: 20 });
  });

  it('resolves quoted keys containing dots', () => {
    const a = parseJsonPath("$['weird-key']['a.b']") as { segments: never };
    expect(evaluateJsonPath(doc, a.segments)).toEqual({ found: true, value: 'slash' });
  });

  it('reports a path miss with the failing prefix', () => {
    const a = parseJsonPath('$.nested.missing.name') as { segments: never };
    const r = evaluateJsonPath(doc, a.segments);
    expect('found' in r && r.found).toBe(false);
    if ('found' in r && !r.found) {
      expect(r.error).toContain('$.nested.missing');
    }
  });

  it('reports indexing a non-array and out-of-range index', () => {
    const a = parseJsonPath('$.nested[0]') as { segments: never };
    expect(evaluateJsonPath(doc, a.segments)).toHaveProperty('found', false);
    const b = parseJsonPath('$.items[9].id') as { segments: never };
    expect(evaluateJsonPath(doc, b.segments)).toHaveProperty('found', false);
  });

  it('returns found for an explicit null value (null is a value, not a miss)', () => {
    const doc2 = { a: null };
    const a = parseJsonPath('$.a') as { segments: never };
    expect(evaluateJsonPath(doc2, a.segments)).toEqual({ found: true, value: null });
  });

  it('treats an own property whose value is undefined as a miss', () => {
    const doc2 = { a: undefined };
    const a = parseJsonPath('$.a') as { segments: never };
    const r = evaluateJsonPath(doc2, a.segments);
    expect(r).toHaveProperty('found', false);
    if ('found' in r && !r.found) expect(r.error).toContain('undefined');
  });

  it('resolves sparse-array holes to null like JSON serialization does', () => {
    const sparse: unknown[] = [1, 2, 3];
    delete sparse[1]; // create a hole
    const segments: JsonPathSegment[] = [{ kind: 'index', value: 1 }];
    const r = evaluateJsonPath(sparse, segments);
    expect(r).toEqual({ found: true, value: null });
  });

  it('rejects reserved segment names defensively at evaluation time too', () => {
    // Defense in depth: even a hand-built segment list cannot traverse
    // prototype-sensitive names, including OWN hostile keys from JSON.parse.
    const hostile = JSON.parse('{"__proto__": {"evil": 1}, "a": {"constructor": 2}}') as Record<string, unknown>;
    expect(evaluateJsonPath(hostile, [{ kind: 'key', name: '__proto__' }])).toHaveProperty('found', false);
    expect(evaluateJsonPath(hostile, [{ kind: 'key', name: 'a' }, { kind: 'key', name: 'constructor' }])).toHaveProperty('found', false);
    expect(evaluateJsonPath(hostile, [{ kind: 'key', name: 'prototype' }])).toHaveProperty('found', false);
  });

  it('bounds evaluation depth against hand-built hostile segment lists', () => {
    const deep: JsonPathSegment[] = Array.from({ length: 65 }, () => ({ kind: 'key', name: 'a' }) as JsonPathSegment);
    const r = evaluateJsonPath({ a: {} }, deep);
    expect(r).toHaveProperty('found', false);
    if ('found' in r && !r.found) expect(r.error).toContain('depth');
  });

  it('rejects prototype keys so chains cannot reach Object.prototype', () => {
    const doc3 = JSON.parse('{"a":1}') as Record<string, unknown>;
    expect(Object.prototype.hasOwnProperty.call(doc3, 'toString')).toBe(false);
    const a = parseJsonPath('$.a.__proto__.toString') as { segments: never };
    expect('error' in a).toBe(true); // rejected at parse time
    const b = parseJsonPath('$.constructor');
    expect('error' in b).toBe(true); // rejected at parse time
    // Defense in depth: hand-built segments are still rejected at evaluation.
    expect(evaluateJsonPath(doc3, [{ kind: 'key', name: 'toString' }])).toHaveProperty('found', false);
  });
});
