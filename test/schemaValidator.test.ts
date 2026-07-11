import { describe, expect, it } from 'vitest';

import {
  parseSchemaDirective,
  resolveSchema,
  validateAgainstSchema,
} from '../src/core/schemaValidator';
import { parseHttpFile } from '../src/core/parser';

describe('parseSchemaDirective', () => {
  it('accepts implicit inline JSON starting with {', () => {
    const ref = parseSchemaDirective('{ "type": "object", "required": ["id"] }');
    expect(ref).toEqual({
      kind: 'inline',
      schema: { type: 'object', required: ['id'] },
    });
  });

  it('accepts explicit inline: prefix', () => {
    const ref = parseSchemaDirective('inline: { "type": "string" }');
    expect(ref).toEqual({ kind: 'inline', schema: { type: 'string' } });
  });

  it('parses openapi:<path>#/<pointer>', () => {
    const ref = parseSchemaDirective(
      'openapi:./api.yaml#/paths/~1users~1{id}/get/responses/200',
    );
    expect(ref).toEqual({
      kind: 'openapi',
      docPath: './api.yaml',
      pointer: '/paths/~1users~1{id}/get/responses/200',
    });
  });

  it('parses openapi with empty docPath (same-file)', () => {
    const ref = parseSchemaDirective('openapi:#/components/schemas/User');
    expect(ref).toEqual({ kind: 'openapi', pointer: '/components/schemas/User' });
  });

  it('parses file: with and without pointer', () => {
    expect(parseSchemaDirective('file:./user.schema.json')).toEqual({
      kind: 'file',
      path: './user.schema.json',
    });
    expect(parseSchemaDirective('file:./bundle.json#/definitions/User')).toEqual({
      kind: 'file',
      path: './bundle.json',
      pointer: '/definitions/User',
    });
  });

  it('rejects empty, unknown, and syntactically bad input', () => {
    expect(() => parseSchemaDirective('   ')).toThrow(/empty/);
    expect(() => parseSchemaDirective('nope:thing')).toThrow(/must be inline/);
    expect(() => parseSchemaDirective('openapi:./api.yaml')).toThrow(/pointer/);
    expect(() => parseSchemaDirective('openapi:./api.yaml#components')).toThrow(/must start with/);
    expect(() => parseSchemaDirective('{ not json')).toThrow(/invalid JSON/);
  });
});

describe('resolveSchema', () => {
  it('returns inline schema as-is', () => {
    expect(resolveSchema({ kind: 'inline', schema: { type: 'string' } })).toEqual({
      type: 'string',
    });
  });

  it('resolves openapi ref against the loaded doc', () => {
    const openapi = {
      components: { schemas: { User: { type: 'object', required: ['id'] } } },
    };
    const out = resolveSchema(
      { kind: 'openapi', docPath: './api.yaml', pointer: '/components/schemas/User' },
      { openapi: { './api.yaml': openapi } },
    );
    expect(out).toEqual({ type: 'object', required: ['id'] });
  });

  it('errors when the referenced document was not loaded', () => {
    expect(() =>
      resolveSchema({ kind: 'openapi', docPath: './missing.yaml', pointer: '/x' }, {}),
    ).toThrow(/was not loaded/);
  });

  it('resolves a file ref (whole doc) or via pointer', () => {
    const schema = { type: 'array', items: { type: 'number' } };
    const bundle = { definitions: { Nums: schema } };
    expect(
      resolveSchema({ kind: 'file', path: './u.json' }, { file: { './u.json': schema } }),
    ).toEqual(schema);
    expect(
      resolveSchema(
        { kind: 'file', path: './b.json', pointer: '/definitions/Nums' },
        { file: { './b.json': bundle } },
      ),
    ).toEqual(schema);
  });
});

describe('validateAgainstSchema', () => {
  const schema = {
    type: 'object',
    required: ['id', 'name'],
    properties: {
      id: { type: 'integer' },
      name: { type: 'string' },
      email: { type: 'string', format: 'email' },
    },
  };

  it('returns ok:true for valid body', () => {
    const res = validateAgainstSchema(schema, { id: 1, name: 'Ryan' });
    expect(res).toEqual({ ok: true, skipped: false, violations: [] });
  });

  it('reports missing required property with the property in the path', () => {
    const res = validateAgainstSchema(schema, { name: 'Ryan' });
    expect(res.ok).toBe(false);
    if (res.ok || res.skipped) throw new Error('expected failure');
    expect(res.violations).toHaveLength(1);
    expect(res.violations[0]).toMatchObject({
      path: '/id',
      rule: 'required',
      message: 'missing required property "id"',
    });
  });

  it('reports type errors with the failing pointer path', () => {
    const res = validateAgainstSchema(schema, { id: 'oops', name: 'Ryan' });
    expect(res.ok).toBe(false);
    if (res.ok || res.skipped) throw new Error('expected failure');
    expect(res.violations[0]).toMatchObject({ path: '/id', rule: 'type' });
  });

  it('honors ajv-formats (email)', () => {
    const res = validateAgainstSchema(schema, { id: 1, name: 'r', email: 'nope' });
    expect(res.ok).toBe(false);
  });

  it('skips (not fails) when body is undefined (non-JSON response)', () => {
    const res = validateAgainstSchema(schema, undefined);
    expect(res).toEqual({
      ok: true,
      skipped: true,
      reason: expect.stringContaining('not JSON'),
      violations: [],
    });
  });

  it('supports explicit skipReason passthrough', () => {
    const res = validateAgainstSchema(schema, { id: 1, name: 'r' }, { skipReason: 'test' });
    expect(res).toMatchObject({ ok: true, skipped: true, reason: 'test' });
  });
});

describe('parser recognizes @schema directive', () => {
  it('captures @schema value in request.directives', () => {
    const src = [
      '### get-user',
      '# @schema openapi:./api.yaml#/components/schemas/User',
      'GET https://api.example.com/users/1',
      '',
    ].join('\n');
    const { requests, diagnostics } = parseHttpFile(src);
    expect(diagnostics).toEqual([]);
    expect(requests).toHaveLength(1);
    expect(requests[0].directives.schema).toBe(
      'openapi:./api.yaml#/components/schemas/User',
    );
  });

  it('captures inline JSON @schema (single-line)', () => {
    const src = [
      '### post-thing',
      '# @schema { "type": "object", "required": ["id"] }',
      'POST https://api.example.com/things',
      '',
    ].join('\n');
    const { requests } = parseHttpFile(src);
    // Parser stores the raw directive value; schemaValidator parses it later.
    const raw = requests[0].directives.schema;
    expect(raw).toBe('{ "type": "object", "required": ["id"] }');
    const ref = parseSchemaDirective(raw);
    expect(ref).toEqual({
      kind: 'inline',
      schema: { type: 'object', required: ['id'] },
    });
  });
});
