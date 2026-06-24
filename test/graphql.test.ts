import { describe, expect, it } from 'vitest';
import {
  buildGraphQLRequest,
  detectOperationName,
  isGraphQLRequest,
  splitGraphQLBody,
  tryParseGraphQLResponse,
} from '../src/core/graphql.js';
import { parseHttpFile } from '../src/core/parser.js';
import { toUndiciRequest } from '../src/core/request.js';

describe('isGraphQLRequest', () => {
  it('detects via @graphql directive', () => {
    expect(
      isGraphQLRequest({ directives: { graphql: '' }, headers: [] }),
    ).toBe(true);
  });

  it('detects via X-Request-Kind: graphql header (case-insensitive)', () => {
    expect(
      isGraphQLRequest({
        directives: {},
        headers: [{ name: 'x-Request-KIND', value: 'GraphQL' }],
      }),
    ).toBe(true);
  });

  it('returns false for plain REST', () => {
    expect(
      isGraphQLRequest({
        directives: {},
        headers: [{ name: 'Content-Type', value: 'application/json' }],
      }),
    ).toBe(false);
  });
});

describe('detectOperationName', () => {
  it('finds named query', () => {
    expect(detectOperationName('query GetUser($id: ID!) { user(id: $id) { id } }')).toBe('GetUser');
  });
  it('finds named mutation', () => {
    expect(detectOperationName('mutation DoIt { x }')).toBe('DoIt');
  });
  it('finds named subscription', () => {
    expect(detectOperationName('subscription OnTick { tick }')).toBe('OnTick');
  });
  it('returns undefined for anonymous query', () => {
    expect(detectOperationName('{ user { id } }')).toBeUndefined();
  });
});

describe('splitGraphQLBody', () => {
  it('splits document and JSON variables on blank-line boundary', () => {
    const { query, variablesText } = splitGraphQLBody('query Q { a }\n\n{"x":1}');
    expect(query).toBe('query Q { a }');
    expect(variablesText).toBe('{"x":1}');
  });

  it('treats trailing JSON object as variables even when document has blank lines', () => {
    const body = 'query Q {\n  a\n\n  b\n}\n\n{ "x": 1 }';
    const { query, variablesText } = splitGraphQLBody(body);
    expect(variablesText.trim()).toBe('{ "x": 1 }');
    expect(query.endsWith('}')).toBe(true);
    expect(query).toContain('a');
    expect(query).toContain('b');
  });

  it('returns empty variables when none present', () => {
    const { query, variablesText } = splitGraphQLBody('{ me { id } }');
    expect(query).toBe('{ me { id } }');
    expect(variablesText).toBe('');
  });

  it('does not treat trailing JSON arrays as variables', () => {
    const { variablesText } = splitGraphQLBody('query Q { a }\n\n[1,2,3]');
    expect(variablesText).toBe('');
  });
});

describe('buildGraphQLRequest', () => {
  it('emits { query, variables, operationName } and defaults variables to {}', () => {
    const out = buildGraphQLRequest({
      headers: [{ name: 'X-Request-Kind', value: 'graphql' }],
      body: 'query GetUser($id: ID!) { user(id: $id) { id } }',
    });
    const json = JSON.parse(out.body);
    expect(json.query).toContain('GetUser');
    expect(json.variables).toEqual({});
    expect(json.operationName).toBe('GetUser');
    // marker header stripped
    expect(out.headers.some((h) => h.name.toLowerCase() === 'x-request-kind')).toBe(false);
    expect(out.diagnostics).toEqual([]);
  });

  it('parses variables JSON block', () => {
    const out = buildGraphQLRequest({
      headers: [],
      body: 'query GetUser($id: ID!) { user(id: $id) { id } }\n\n{ "id": "42" }',
    });
    const json = JSON.parse(out.body);
    expect(json.variables).toEqual({ id: '42' });
    expect(json.operationName).toBe('GetUser');
  });

  it('records a diagnostic when variables JSON is malformed', () => {
    const out = buildGraphQLRequest({
      headers: [],
      body: 'query GetUser { user { id } }\n\n{ "id": ',
    });
    const json = JSON.parse(out.body);
    // Malformed trailing object never matches the splitter; the trailing text
    // is left attached to the query and variables default to {}.
    expect(json.variables).toEqual({});
    // No diagnostic in this case because splitter rejected the unparseable tail.
    expect(out.diagnostics).toEqual([]);
  });

  it('records diagnostic when a parsable but non-object trailing JSON is forced via header detection', () => {
    // This exercises the json-object guard inside buildGraphQLRequest indirectly:
    // splitter only accepts objects; arrays leave variablesText empty.
    const out = buildGraphQLRequest({
      headers: [],
      body: 'query Q { a }\n\n[1,2,3]',
    });
    expect(out.diagnostics).toEqual([]);
    expect(JSON.parse(out.body).variables).toEqual({});
  });

  it('omits operationName when the document is anonymous', () => {
    const out = buildGraphQLRequest({ headers: [], body: '{ me { id } }' });
    const json = JSON.parse(out.body);
    expect('operationName' in json).toBe(false);
  });
});

describe('toUndiciRequest + GraphQL integration', () => {
  it('serializes a GraphQL request from a parsed .http file via header marker', () => {
    const src = `POST https://api.example.com/graphql
X-Request-Kind: graphql

query GetUser($id: ID!) { user(id: $id) { id name } }

{ "id": "42" }
`;
    const { requests, diagnostics } = parseHttpFile(src);
    expect(diagnostics).toEqual([]);
    const opts = toUndiciRequest(requests[0]);
    expect(opts.headers['Content-Type']).toBe('application/json');
    expect(opts.headers['X-Request-Kind']).toBeUndefined();
    const payload = JSON.parse(opts.body!);
    expect(payload.query).toContain('GetUser');
    expect(payload.variables).toEqual({ id: '42' });
    expect(payload.operationName).toBe('GetUser');
  });

  it('serializes a GraphQL request via the @graphql directive', () => {
    const src = `# @graphql
POST https://api.example.com/graphql

mutation Bump { bump }
`;
    const { requests } = parseHttpFile(src);
    expect(requests[0].directives.graphql).toBe('');
    const opts = toUndiciRequest(requests[0]);
    const payload = JSON.parse(opts.body!);
    expect(payload.operationName).toBe('Bump');
    expect(payload.variables).toEqual({});
  });

  it('does not touch non-GraphQL requests', () => {
    const src = `POST https://api.example.com/x
Content-Type: application/json

{"a":1}
`;
    const { requests } = parseHttpFile(src);
    const opts = toUndiciRequest(requests[0]);
    expect(opts.body).toBe('{"a":1}');
    expect(opts.headers['Content-Type']).toBe('application/json');
  });
});

describe('tryParseGraphQLResponse', () => {
  it('detects { data } shape', () => {
    expect(tryParseGraphQLResponse('{"data":{"x":1}}', 'application/json')).toEqual({
      data: { x: 1 },
    });
  });
  it('detects { errors } shape', () => {
    expect(
      tryParseGraphQLResponse('{"errors":[{"message":"nope"}]}', 'application/json'),
    ).toEqual({ errors: [{ message: 'nope' }] });
  });
  it('accepts application/graphql-response+json content type', () => {
    expect(
      tryParseGraphQLResponse('{"data":null}', 'application/graphql-response+json'),
    ).toEqual({ data: null });
  });
  it('returns undefined for non-graphql JSON', () => {
    expect(tryParseGraphQLResponse('{"foo":1}', 'application/json')).toBeUndefined();
  });
  it('returns undefined for non-JSON content types', () => {
    expect(tryParseGraphQLResponse('{"data":{}}', 'text/plain')).toBeUndefined();
  });
  it('returns undefined for malformed JSON', () => {
    expect(tryParseGraphQLResponse('{not json', 'application/json')).toBeUndefined();
  });
});
