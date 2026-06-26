import { describe, it, expect } from 'vitest';
import { importPostmanCollection } from '../src/core/import/postman.js';

const baseInfo = {
  name: 'Sample',
  schema: 'https://schema.getpostman.com/json/collection/v2.1.0/collection.json',
};

describe('importPostmanCollection', () => {
  it('rejects non-collection input', () => {
    expect(() => importPostmanCollection({})).toThrow();
    expect(() => importPostmanCollection({ info: baseInfo })).toThrow();
  });

  it('imports a top-level request into root.http with method + URL', () => {
    const out = importPostmanCollection({
      info: baseInfo,
      item: [
        {
          name: 'list users',
          request: {
            method: 'GET',
            url: 'https://api.example.com/users',
            header: [{ key: 'Accept', value: 'application/json' }],
          },
        },
      ],
    });
    expect(out.files).toHaveLength(1);
    expect(out.files[0]!.filename).toBe('root.http');
    expect(out.files[0]!.contents).toContain('### list users');
    expect(out.files[0]!.contents).toContain('GET https://api.example.com/users');
    expect(out.files[0]!.contents).toContain('Accept: application/json');
  });

  it('splits one .http per top-level folder, nested folders flatten into prefixed names', () => {
    const out = importPostmanCollection({
      info: baseInfo,
      item: [
        {
          name: 'Users',
          item: [
            { name: 'list', request: { method: 'GET', url: 'https://x/users' } },
            {
              name: 'admin',
              item: [
                { name: 'invite', request: { method: 'POST', url: 'https://x/users/invite' } },
              ],
            },
          ],
        },
        {
          name: 'Orders',
          item: [{ name: 'list', request: { method: 'GET', url: 'https://x/orders' } }],
        },
      ],
    });
    const names = out.files.map((f) => f.filename).sort();
    expect(names).toEqual(['orders.http', 'users.http']);
    const users = out.files.find((f) => f.filename === 'users.http')!.contents;
    expect(users).toContain('### list');
    expect(users).toContain('### admin / invite');
  });

  it('rebuilds URL from url-object parts when raw is missing', () => {
    const out = importPostmanCollection({
      info: baseInfo,
      item: [
        {
          name: 'rebuilt',
          request: {
            method: 'GET',
            url: {
              protocol: 'https',
              host: ['api', 'example', 'com'],
              path: ['v1', 'things'],
              query: [
                { key: 'q', value: 'hello world' },
                { key: 'skip', value: '', disabled: true },
              ],
            },
          },
        },
      ],
    });
    const text = out.files[0]!.contents;
    expect(text).toContain('GET https://api.example.com/v1/things?q=hello%20world');
    expect(text).not.toContain('skip=');
  });

  it('skips disabled headers', () => {
    const out = importPostmanCollection({
      info: baseInfo,
      item: [
        {
          name: 'hdr',
          request: {
            method: 'GET',
            url: 'https://x',
            header: [
              { key: 'X-Keep', value: '1' },
              { key: 'X-Drop', value: '2', disabled: true },
            ],
          },
        },
      ],
    });
    const text = out.files[0]!.contents;
    expect(text).toContain('X-Keep: 1');
    expect(text).not.toContain('X-Drop');
  });

  it('renders raw JSON body and infers Content-Type from options.raw.language', () => {
    const out = importPostmanCollection({
      info: baseInfo,
      item: [
        {
          name: 'create',
          request: {
            method: 'POST',
            url: 'https://x/users',
            body: {
              mode: 'raw',
              raw: '{"name":"alice"}',
              options: { raw: { language: 'json' } },
            },
          },
        },
      ],
    });
    const text = out.files[0]!.contents;
    expect(text).toContain('Content-Type: application/json');
    expect(text).toContain('{"name":"alice"}');
  });

  it('urlencodes form body and skips disabled fields', () => {
    const out = importPostmanCollection({
      info: baseInfo,
      item: [
        {
          name: 'form',
          request: {
            method: 'POST',
            url: 'https://x/form',
            body: {
              mode: 'urlencoded',
              urlencoded: [
                { key: 'q', value: 'hi there' },
                { key: 'lang', value: 'en' },
                { key: 'gone', value: '1', disabled: true },
              ],
            },
          },
        },
      ],
    });
    const text = out.files[0]!.contents;
    expect(text).toContain('Content-Type: application/x-www-form-urlencoded');
    expect(text).toContain('q=hi%20there&lang=en');
    expect(text).not.toContain('gone=');
  });

  it('renders graphql bodies as JSON', () => {
    const out = importPostmanCollection({
      info: baseInfo,
      item: [
        {
          name: 'gql',
          request: {
            method: 'POST',
            url: 'https://x/graphql',
            body: {
              mode: 'graphql',
              graphql: { query: 'query { me { id } }', variables: '{"x":1}' },
            },
          },
        },
      ],
    });
    const text = out.files[0]!.contents;
    expect(text).toContain('Content-Type: application/json');
    expect(text).toContain('"query":"query { me { id } }"');
    expect(text).toContain('"variables":{"x":1}');
  });

  it('flags multipart formdata and file bodies as unsupported', () => {
    const out = importPostmanCollection({
      info: baseInfo,
      item: [
        {
          name: 'upload',
          request: {
            method: 'POST',
            url: 'https://x/up',
            body: {
              mode: 'formdata',
              formdata: [{ key: 'file', type: 'file', src: '/tmp/x.bin' }],
            },
          },
        },
      ],
    });
    expect(out.files[0]!.contents).toContain('# unsupported: multipart formdata body');
  });

  it('maps basic auth into Authorization header + @auth note', () => {
    const out = importPostmanCollection({
      info: baseInfo,
      item: [
        {
          name: 'auth',
          request: {
            method: 'GET',
            url: 'https://x',
            auth: { type: 'basic', basic: [{ key: 'username', value: 'alice' }, { key: 'password', value: 's3cret' }] },
          },
        },
      ],
    });
    const text = out.files[0]!.contents;
    expect(text).toContain('# @auth basic (user: alice)');
    expect(text).toMatch(/Authorization: Basic [A-Za-z0-9+/=]+/);
  });

  it('maps bearer auth', () => {
    const out = importPostmanCollection({
      info: baseInfo,
      item: [
        {
          name: 'b',
          request: {
            method: 'GET',
            url: 'https://x',
            auth: { type: 'bearer', bearer: [{ key: 'token', value: 'abc.def' }] },
          },
        },
      ],
    });
    expect(out.files[0]!.contents).toContain('Authorization: Bearer abc.def');
    expect(out.files[0]!.contents).toContain('# @auth bearer');
  });

  it('maps apikey-in-header and flags apikey-in-query as unsupported with hint', () => {
    const headerOut = importPostmanCollection({
      info: baseInfo,
      item: [
        {
          name: 'h',
          request: {
            method: 'GET',
            url: 'https://x',
            auth: {
              type: 'apikey',
              apikey: [{ key: 'key', value: 'X-Api-Key' }, { key: 'value', value: 'k' }, { key: 'in', value: 'header' }],
            },
          },
        },
      ],
    });
    expect(headerOut.files[0]!.contents).toContain('X-Api-Key: k');

    const queryOut = importPostmanCollection({
      info: baseInfo,
      item: [
        {
          name: 'q',
          request: {
            method: 'GET',
            url: 'https://x',
            auth: {
              type: 'apikey',
              apikey: [{ key: 'key', value: 'api_key' }, { key: 'value', value: 'k' }, { key: 'in', value: 'query' }],
            },
          },
        },
      ],
    });
    expect(queryOut.files[0]!.contents).toContain('# unsupported: apikey in query');
  });

  it('inherits collection-level auth when item does not override', () => {
    const out = importPostmanCollection({
      info: baseInfo,
      auth: { type: 'bearer', bearer: [{ key: 'token', value: 'TOP' }] },
      item: [
        {
          name: 'Folder',
          item: [{ name: 'r', request: { method: 'GET', url: 'https://x' } }],
        },
      ],
    });
    expect(out.files[0]!.contents).toContain('Authorization: Bearer TOP');
  });

  it('extracts collection variables into envVariables and preserves {{var}} tokens in URLs', () => {
    const out = importPostmanCollection({
      info: baseInfo,
      variable: [
        { key: 'baseUrl', value: 'https://api.example.com' },
        { key: 'token', value: '' },
      ],
      item: [
        {
          name: 'v',
          request: { method: 'GET', url: '{{baseUrl}}/me' },
        },
      ],
    });
    expect(out.envVariables).toEqual({ baseUrl: 'https://api.example.com', token: '' });
    expect(out.files[0]!.contents).toContain('GET {{baseUrl}}/me');
  });

  it('produces a warning instead of failing when a request has no URL', () => {
    const out = importPostmanCollection({
      info: baseInfo,
      item: [{ name: 'broken', request: { method: 'GET' } }],
    });
    expect(out.files).toHaveLength(0);
    expect(out.warnings.some((w) => /no URL/.test(w))).toBe(true);
  });

  it('de-duplicates filenames when two top-level folders share a sanitised name', () => {
    const out = importPostmanCollection({
      info: baseInfo,
      item: [
        { name: 'Users', item: [{ name: 'a', request: { method: 'GET', url: 'https://x/1' } }] },
        { name: 'users', item: [{ name: 'b', request: { method: 'GET', url: 'https://x/2' } }] },
      ],
    });
    const names = out.files.map((f) => f.filename).sort();
    expect(names).toEqual(['users-2.http', 'users.http']);
  });
});
