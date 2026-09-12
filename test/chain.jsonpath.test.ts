import { describe, expect, it } from 'vitest';
import { parseJsonPath, evaluateJsonPath } from '../src/core/chain/jsonpath.js';

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

  it('returns found for null/undefined-ish values without treating them as misses', () => {
    const doc2 = { a: null };
    const a = parseJsonPath('$.a') as { segments: never };
    expect(evaluateJsonPath(doc2, a.segments)).toEqual({ found: true, value: null });
  });

  it('rejects prototype keys so chains cannot reach Object.prototype', () => {
    const doc3 = JSON.parse('{"a":1}') as Record<string, unknown>;
    expect(Object.prototype.hasOwnProperty.call(doc3, 'toString')).toBe(false);
    const a = parseJsonPath('$.a.__proto__.toString') as { segments: never };
    expect(evaluateJsonPath(doc3, a.segments)).toHaveProperty('found', false);
    const b = parseJsonPath('$.constructor') as { segments: never };
    expect(evaluateJsonPath(doc3, b.segments)).toHaveProperty('found', false);
  });
});
