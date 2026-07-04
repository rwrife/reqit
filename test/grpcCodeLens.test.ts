import { describe, expect, it } from 'vitest';

import { buildGrpcCodeLenses, parseGrpcFile } from '../src/core/grpc.js';

const DOC_URI = 'file:///workspace/.requests/users.grpc';

describe('buildGrpcCodeLenses', () => {
  it('emits one Send Request lens per parsed block, anchored on the GRPC line', () => {
    const source = [
      '### List users',
      'GRPC grpc.example.com:443/users.UserService/ListUsers',
      '',
      '{ "page_size": 10 }',
      '',
      '### Get user',
      'GRPC grpc.example.com/users.UserService/GetUser',
      '',
      '{ "id": "abc" }',
    ].join('\n');

    const parsed = parseGrpcFile(source);
    const specs = buildGrpcCodeLenses(parsed, DOC_URI);

    expect(specs).toHaveLength(2);
    expect(specs[0]).toMatchObject({
      title: '▶ Send Request',
      command: 'reqit.sendGrpcRequest',
      arg: { documentUri: DOC_URI },
    });
    // Anchor lines should match the parsed `requestLineIndex`.
    expect(specs[0].line).toBe(parsed.requests[0].requestLineIndex);
    expect(specs[1].line).toBe(parsed.requests[1].requestLineIndex);
    expect(specs[0].arg.requestLineIndex).toBe(parsed.requests[0].requestLineIndex);
    expect(specs[1].arg.requestLineIndex).toBe(parsed.requests[1].requestLineIndex);
  });

  it('skips blocks that only produced diagnostics — no lens without an anchor', () => {
    const source = [
      'GRPC grpc.example.com/users.UserService/ListUsers',
      '',
      '{ "page_size": 10 }',
      '',
      '### Bad block',
      'this is not a grpc request',
    ].join('\n');

    const parsed = parseGrpcFile(source);
    expect(parsed.diagnostics.length).toBeGreaterThan(0);
    const specs = buildGrpcCodeLenses(parsed, DOC_URI);
    expect(specs).toHaveLength(1);
    expect(specs[0].line).toBe(0);
  });

  it('returns an empty list for an empty file', () => {
    const parsed = parseGrpcFile('');
    const specs = buildGrpcCodeLenses(parsed, DOC_URI);
    expect(specs).toEqual([]);
  });

  it('always targets reqit.sendGrpcRequest with a stringifiable arg payload', () => {
    const source =
      'GRPC grpc://localhost:50051/echo.v1.Echo/Say\n\n{ "msg": "hi" }';
    const parsed = parseGrpcFile(source);
    const [spec] = buildGrpcCodeLenses(parsed, DOC_URI);
    expect(spec.command).toBe('reqit.sendGrpcRequest');
    // JSON.stringify round-trip guards against accidental non-serializable values
    // (regex, functions, etc.) sneaking into the command args payload.
    expect(JSON.parse(JSON.stringify(spec.arg))).toEqual(spec.arg);
  });
});
