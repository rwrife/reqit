import { describe, expect, it } from 'vitest';

import { parseGrpcBlock, parseGrpcFile, parseGrpcTarget } from '../src/core/grpc.js';

describe('parseGrpcTarget', () => {
  it('parses host:port/Service/Method with default TLS', () => {
    const t = parseGrpcTarget('grpc.example.com:443/users.UserService/ListUsers');
    expect(t).toEqual({
      host: 'grpc.example.com',
      port: 443,
      service: 'users.UserService',
      method: 'ListUsers',
      plaintext: false,
    });
  });

  it('defaults port to 443 when omitted', () => {
    const t = parseGrpcTarget('grpc.example.com/users.UserService/ListUsers');
    expect(t.port).toBe(443);
    expect(t.plaintext).toBe(false);
  });

  it('honours `grpc://` plaintext scheme', () => {
    const t = parseGrpcTarget('grpc://localhost:50051/echo.v1.Echo/Say');
    expect(t.plaintext).toBe(true);
    expect(t.port).toBe(50051);
  });

  it('honours `grpcs://` as TLS (default)', () => {
    const t = parseGrpcTarget('grpcs://api.example.com/pkg.Svc/Method');
    expect(t.plaintext).toBe(false);
  });

  it('supports nested package names', () => {
    const t = parseGrpcTarget('h:1/a.b.c.Service/M');
    expect(t.service).toBe('a.b.c.Service');
  });

  it('rejects empty input', () => {
    expect(() => parseGrpcTarget('   ')).toThrow(/empty/);
  });

  it('rejects missing path', () => {
    expect(() => parseGrpcTarget('grpc.example.com:443')).toThrow(/missing \/Service\/Method/);
  });

  it('rejects unqualified service names', () => {
    expect(() => parseGrpcTarget('h:1/Service/M')).toThrow(/fully-qualified/);
  });

  it('rejects non-numeric port', () => {
    expect(() => parseGrpcTarget('h:abc/pkg.S/M')).toThrow(/non-numeric port/);
  });

  it('rejects out-of-range port', () => {
    expect(() => parseGrpcTarget('h:70000/pkg.S/M')).toThrow(/out of range/);
  });

  it('rejects bracketed IPv6 with a clear message', () => {
    expect(() => parseGrpcTarget('[::1]:50051/pkg.S/M')).toThrow(/IPv6/);
  });

  it('rejects extra path segments', () => {
    expect(() => parseGrpcTarget('h:1/pkg.S/M/extra')).toThrow(/exactly \/package\.Service\/Method/);
  });

  it('rejects invalid identifier characters', () => {
    expect(() => parseGrpcTarget('h:1/pkg.Svc/Bad-Method')).toThrow(/method "Bad-Method"/);
  });
});

describe('parseGrpcBlock', () => {
  it('parses a full block with auth + body', () => {
    const block = `### List users
GRPC grpc.example.com:443/users.UserService/ListUsers
# @auth corp-mtls
x-correlation-id: abc-123

{ "page_size": 10 }
`;
    const parsed = parseGrpcBlock(block);
    expect(parsed.target.service).toBe('users.UserService');
    expect(parsed.target.method).toBe('ListUsers');
    expect(parsed.authProfile).toBe('corp-mtls');
    expect(parsed.metadata).toEqual({ 'x-correlation-id': 'abc-123' });
    expect(parsed.body).toEqual({ page_size: 10 });
  });

  it('treats missing body as an empty unary call', () => {
    const parsed = parseGrpcBlock('GRPC h:1/pkg.S/M\n');
    expect(parsed.body).toBeUndefined();
    expect(parsed.authProfile).toBeUndefined();
    expect(parsed.metadata).toEqual({});
  });

  it('rejects non-JSON bodies', () => {
    expect(() =>
      parseGrpcBlock(`GRPC h:1/pkg.S/M\n\nnot json at all`),
    ).toThrow(/body must be JSON/);
  });

  it('rejects malformed header lines', () => {
    expect(() =>
      parseGrpcBlock(`GRPC h:1/pkg.S/M\nthis is not a header\n\n{}`),
    ).toThrow(/Invalid gRPC header line/);
  });

  it('rejects blocks that do not start with GRPC', () => {
    expect(() => parseGrpcBlock('GET https://example.com\n')).toThrow(/must start with `GRPC/);
  });

  it('ignores comment lines in the header section', () => {
    const parsed = parseGrpcBlock(
      `GRPC h:1/pkg.S/M\n# just a comment\n# @auth p1\n\n{"a":1}`,
    );
    expect(parsed.authProfile).toBe('p1');
    expect(parsed.body).toEqual({ a: 1 });
  });
});

describe('parseGrpcFile', () => {
  it('parses an empty file with no requests', () => {
    const { requests, diagnostics } = parseGrpcFile('');
    expect(requests).toEqual([]);
    expect(diagnostics).toEqual([]);
  });

  it('parses a single implicit block (no ### separator)', () => {
    const src = `GRPC localhost:50051/echo.v1.Echo/Say\n\n{"msg":"hi"}`;
    const { requests, diagnostics } = parseGrpcFile(src);
    expect(diagnostics).toEqual([]);
    expect(requests).toHaveLength(1);
    expect(requests[0].target.method).toBe('Say');
    expect(requests[0].body).toEqual({ msg: 'hi' });
    expect(requests[0].requestLineIndex).toBe(0);
  });

  it('parses multiple blocks separated by ###', () => {
    const src = [
      '### list',
      'GRPC localhost:50051/users.UserService/ListUsers',
      '',
      '{"page_size": 10}',
      '',
      '### get',
      'GRPC localhost:50051/users.UserService/GetUser',
      '# @auth my-prof',
      '',
      '{"id": 1}',
    ].join('\n');
    const { requests, diagnostics } = parseGrpcFile(src);
    expect(diagnostics).toEqual([]);
    expect(requests).toHaveLength(2);
    expect(requests[0].name).toBe('list');
    expect(requests[0].target.method).toBe('ListUsers');
    expect(requests[1].name).toBe('get');
    expect(requests[1].authProfile).toBe('my-prof');
    expect(requests[1].target.method).toBe('GetUser');
    expect(requests[0].requestLineIndex).toBe(1);
    expect(requests[1].requestLineIndex).toBe(6);
  });

  it('skips empty blocks silently', () => {
    const src = '### empty\n\n### real\nGRPC h:1/pkg.S/M\n';
    const { requests, diagnostics } = parseGrpcFile(src);
    expect(diagnostics).toEqual([]);
    expect(requests).toHaveLength(1);
    expect(requests[0].name).toBe('real');
  });

  it('collects diagnostics for malformed blocks and keeps valid ones', () => {
    const src = [
      '### bad',
      'GET https://example.com/oops',
      '',
      '### good',
      'GRPC h:1/pkg.S/M',
    ].join('\n');
    const { requests, diagnostics } = parseGrpcFile(src);
    expect(requests).toHaveLength(1);
    expect(requests[0].name).toBe('good');
    expect(diagnostics).toHaveLength(1);
    expect(diagnostics[0].message).toMatch(/must start with `GRPC/);
  });

  it('normalises CRLF line endings', () => {
    const src = '### one\r\nGRPC h:1/pkg.S/M\r\n';
    const { requests, diagnostics } = parseGrpcFile(src);
    expect(diagnostics).toEqual([]);
    expect(requests).toHaveLength(1);
    expect(requests[0].target.service).toBe('pkg.S');
  });
});
