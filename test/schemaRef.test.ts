import { describe, expect, it } from 'vitest';

import {
  decodePointerToken,
  inlineRefs,
  parseJsonPointer,
  resolveJsonPointer,
  resolveSchemaRef,
} from '../src/core/schemaRef';

describe('decodePointerToken', () => {
  it('decodes ~1 → / and ~0 → ~', () => {
    expect(decodePointerToken('a~1b')).toBe('a/b');
    expect(decodePointerToken('a~0b')).toBe('a~b');
    // Order matters per RFC 6901: ~01 must decode to ~1, not /.
    expect(decodePointerToken('~01')).toBe('~1');
  });
});

describe('parseJsonPointer', () => {
  it('returns [] for empty pointer (whole doc)', () => {
    expect(parseJsonPointer('')).toEqual([]);
  });

  it('splits and decodes tokens', () => {
    expect(parseJsonPointer('/a/b/0')).toEqual(['a', 'b', '0']);
    expect(parseJsonPointer('/paths/~1users~1{id}/get')).toEqual([
      'paths',
      '/users/{id}',
      'get',
    ]);
  });

  it('rejects pointers that do not start with /', () => {
    expect(() => parseJsonPointer('foo')).toThrow(/must start with/);
  });
});

describe('resolveJsonPointer', () => {
  const doc = {
    paths: {
      '/users/{id}': {
        get: { responses: { '200': { schema: { type: 'object' } } } },
      },
    },
    tags: ['a', 'b', 'c'],
  };

  it('walks nested objects and arrays', () => {
    expect(resolveJsonPointer(doc, '/tags/1')).toBe('b');
    expect(
      resolveJsonPointer(doc, '/paths/~1users~1{id}/get/responses/200/schema'),
    ).toEqual({ type: 'object' });
  });

  it('returns the whole doc for empty pointer', () => {
    expect(resolveJsonPointer(doc, '')).toBe(doc);
  });

  it('throws when key is missing', () => {
    expect(() => resolveJsonPointer(doc, '/nope')).toThrow(/key not found/);
  });

  it('throws when array index is out of range or non-numeric', () => {
    expect(() => resolveJsonPointer(doc, '/tags/9')).toThrow(/out of range/);
    expect(() => resolveJsonPointer(doc, '/tags/x')).toThrow(/numeric index/);
  });

  it('throws when descending into a primitive', () => {
    expect(() => resolveJsonPointer(doc, '/tags/0/foo')).toThrow(/cannot descend/);
  });
});

describe('inlineRefs', () => {
  it('replaces $ref with the referenced value', () => {
    const doc = {
      components: { schemas: { User: { type: 'object', required: ['id'] } } },
      target: { $ref: '#/components/schemas/User' },
    };
    expect(inlineRefs(doc, doc.target)).toEqual({ type: 'object', required: ['id'] });
  });

  it('recursively inlines nested $refs', () => {
    const doc = {
      components: {
        schemas: {
          Id: { type: 'string' },
          User: { type: 'object', properties: { id: { $ref: '#/components/schemas/Id' } } },
        },
      },
    };
    const out = inlineRefs(doc, { $ref: '#/components/schemas/User' }) as {
      properties: { id: unknown };
    };
    expect(out.properties.id).toEqual({ type: 'string' });
  });

  it('detects circular $refs', () => {
    const doc: Record<string, unknown> = {};
    doc.a = { $ref: '#/b' };
    doc.b = { $ref: '#/a' };
    expect(() => inlineRefs(doc, doc.a)).toThrow(/circular/);
  });

  it('leaves cross-document $refs untouched', () => {
    const doc = { target: { $ref: './other.yaml#/foo' } };
    expect(inlineRefs(doc, doc.target)).toEqual({ $ref: './other.yaml#/foo' });
  });
});

describe('resolveSchemaRef', () => {
  it('resolves pointer and inlines refs in one call', () => {
    const doc = {
      components: {
        schemas: {
          Id: { type: 'string' },
          User: { type: 'object', properties: { id: { $ref: '#/components/schemas/Id' } } },
        },
      },
    };
    expect(resolveSchemaRef(doc, '/components/schemas/User')).toEqual({
      type: 'object',
      properties: { id: { type: 'string' } },
    });
  });
});
