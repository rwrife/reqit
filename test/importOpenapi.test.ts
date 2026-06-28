import { describe, it, expect } from 'vitest';
import { importOpenApi } from '../src/core/import/openapi.js';

const baseDoc = {
  openapi: '3.0.3',
  info: { title: 'Sample API' },
};

describe('importOpenApi', () => {
  it('rejects non-3.x docs', () => {
    expect(() => importOpenApi({})).toThrow();
    expect(() => importOpenApi({ openapi: '2.0' })).toThrow();
  });

  it('puts untagged operations into default.http and uses summary as request name', () => {
    const out = importOpenApi({
      ...baseDoc,
      servers: [{ url: 'https://api.example.com/v1' }],
      paths: {
        '/users': {
          get: { summary: 'list users' },
        },
      },
    });
    expect(out.files).toHaveLength(1);
    expect(out.files[0]!.filename).toBe('default.http');
    expect(out.files[0]!.contents).toContain('### list users');
    expect(out.files[0]!.contents).toContain('GET {{baseUrl}}/users');
    expect(out.envVariables.baseUrl).toBe('https://api.example.com/v1');
  });

  it('groups operations by their first tag, one file per tag', () => {
    const out = importOpenApi({
      ...baseDoc,
      paths: {
        '/a': { get: { tags: ['admin'], summary: 'a' } },
        '/b': { get: { tags: ['public'], summary: 'b' } },
        '/c': { post: { tags: ['admin'], summary: 'c' } },
      },
    });
    const filenames = out.files.map((f) => f.filename).sort();
    expect(filenames).toEqual(['admin.http', 'public.http']);
    const admin = out.files.find((f) => f.filename === 'admin.http')!;
    expect(admin.contents).toContain('### a');
    expect(admin.contents).toContain('### c');
    expect(admin.contents).toContain('POST {{baseUrl}}/c');
  });

  it('rewrites {pathParams} as {{pathParams}} and renders query/header parameters as vars', () => {
    const out = importOpenApi({
      ...baseDoc,
      paths: {
        '/users/{id}': {
          get: {
            parameters: [
              { name: 'id', in: 'path', required: true, schema: { type: 'string' } },
              { name: 'expand', in: 'query', schema: { type: 'string' } },
              { name: 'X-Trace', in: 'header', schema: { type: 'string' } },
            ],
          },
        },
      },
    });
    const body = out.files[0]!.contents;
    expect(body).toContain('GET {{baseUrl}}/users/{{id}}?expand={{expand}}');
    expect(body).toContain('X-Trace: {{X-Trace}}');
  });

  it('derives a JSON body sample from inline schema when no example is given', () => {
    const out = importOpenApi({
      ...baseDoc,
      paths: {
        '/users': {
          post: {
            requestBody: {
              content: {
                'application/json': {
                  schema: {
                    type: 'object',
                    properties: {
                      name: { type: 'string' },
                      age: { type: 'integer' },
                      tags: { type: 'array', items: { type: 'string' } },
                    },
                  },
                },
              },
            },
          },
        },
      },
    });
    const body = out.files[0]!.contents;
    expect(body).toContain('Content-Type: application/json');
    expect(body).toContain('"name": "string"');
    expect(body).toContain('"age": 0');
    expect(body).toContain('"tags"');
  });

  it('prefers an explicit example over a schema-derived sample', () => {
    const out = importOpenApi({
      ...baseDoc,
      paths: {
        '/x': {
          post: {
            requestBody: {
              content: {
                'application/json': {
                  example: { hello: 'world' },
                  schema: { type: 'object', properties: { other: { type: 'string' } } },
                },
              },
            },
          },
        },
      },
    });
    const body = out.files[0]!.contents;
    expect(body).toContain('"hello": "world"');
    expect(body).not.toContain('other');
  });

  it('resolves $ref into components.schemas', () => {
    const out = importOpenApi({
      ...baseDoc,
      paths: {
        '/u': {
          post: {
            requestBody: {
              content: {
                'application/json': { schema: { $ref: '#/components/schemas/User' } },
              },
            },
          },
        },
      },
      components: {
        schemas: {
          User: {
            type: 'object',
            properties: { id: { type: 'string', format: 'uuid' } },
          },
        },
      },
    });
    expect(out.files[0]!.contents).toContain('"id": "00000000-0000-0000-0000-000000000000"');
  });

  it('handles circular $ref without blowing up', () => {
    const out = importOpenApi({
      ...baseDoc,
      paths: {
        '/n': {
          post: {
            requestBody: {
              content: { 'application/json': { schema: { $ref: '#/components/schemas/Node' } } },
            },
          },
        },
      },
      components: {
        schemas: {
          Node: {
            type: 'object',
            properties: {
              name: { type: 'string' },
              parent: { $ref: '#/components/schemas/Node' },
            },
          },
        },
      },
    });
    expect(out.files[0]!.contents).toContain('"name": "string"');
  });

  it('renders application/x-www-form-urlencoded bodies as form pairs', () => {
    const out = importOpenApi({
      ...baseDoc,
      paths: {
        '/login': {
          post: {
            requestBody: {
              content: {
                'application/x-www-form-urlencoded': {
                  example: { user: 'alice', pass: 'p@ss' },
                },
              },
            },
          },
        },
      },
    });
    const body = out.files[0]!.contents;
    expect(body).toContain('Content-Type: application/x-www-form-urlencoded');
    expect(body).toContain('user=alice&pass=p%40ss');
  });

  it('maps a bearer security scheme to Authorization: Bearer {{bearerToken}}', () => {
    const out = importOpenApi({
      ...baseDoc,
      paths: { '/me': { get: { security: [{ jwt: [] }] } } },
      components: {
        securitySchemes: { jwt: { type: 'http', scheme: 'bearer' } },
      },
    });
    expect(out.files[0]!.contents).toContain('Authorization: Bearer {{bearerToken}}');
    expect(out.warnings.some((w) => w.includes('bearer'))).toBe(true);
  });

  it('maps an apiKey header security scheme', () => {
    const out = importOpenApi({
      ...baseDoc,
      paths: { '/me': { get: { security: [{ apiKeyAuth: [] }] } } },
      components: {
        securitySchemes: { apiKeyAuth: { type: 'apiKey', in: 'header', name: 'X-API-Key' } },
      },
    });
    expect(out.files[0]!.contents).toContain('X-API-Key: {{apiKey}}');
  });

  it('falls back to doc-level security when an operation has none', () => {
    const out = importOpenApi({
      ...baseDoc,
      security: [{ jwt: [] }],
      paths: { '/me': { get: {} } },
      components: { securitySchemes: { jwt: { type: 'http', scheme: 'bearer' } } },
    });
    expect(out.files[0]!.contents).toContain('Authorization: Bearer {{bearerToken}}');
  });

  it('returns warnings for >1 server and trims trailing slash on baseUrl', () => {
    const out = importOpenApi({
      ...baseDoc,
      servers: [{ url: 'https://a.example.com/' }, { url: 'https://b.example.com/' }],
      paths: { '/x': { get: {} } },
    });
    expect(out.envVariables.baseUrl).toBe('https://a.example.com');
    expect(out.warnings.some((w) => w.includes('2 servers'))).toBe(true);
  });

  it('flags server variables as a warning (no expansion)', () => {
    const out = importOpenApi({
      ...baseDoc,
      servers: [
        {
          url: 'https://{region}.example.com',
          variables: { region: { default: 'us', enum: ['us', 'eu'] } },
        },
      ],
      paths: { '/x': { get: {} } },
    });
    expect(out.envVariables.baseUrl).toBe('https://{region}.example.com');
    expect(out.warnings.some((w) => w.includes('variables'))).toBe(true);
  });

  it('uses operationId as request name when no summary is set', () => {
    const out = importOpenApi({
      ...baseDoc,
      paths: { '/x': { get: { operationId: 'getX' } } },
    });
    expect(out.files[0]!.contents).toContain('### getX');
  });
});
