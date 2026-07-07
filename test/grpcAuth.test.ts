import { describe, it, expect } from 'vitest';
import { buildGrpcCredentials } from '../src/core/grpcAuth.js';
import type { ParsedGrpcRequest } from '../src/core/grpc.js';
import type { ResolvedAuth } from '../src/core/auth.js';

function request(
  overrides: Partial<ParsedGrpcRequest> & {
    plaintext?: boolean;
    metadata?: Record<string, string>;
  } = {},
): ParsedGrpcRequest {
  return {
    target: {
      host: overrides.target?.host ?? 'grpc.example.com',
      port: overrides.target?.port ?? 443,
      service: overrides.target?.service ?? 'users.v1.UserService',
      method: overrides.target?.method ?? 'ListUsers',
      plaintext:
        overrides.target?.plaintext ?? overrides.plaintext ?? false,
    },
    authProfile: overrides.authProfile,
    body: overrides.body,
    metadata: overrides.metadata ?? {},
  };
}

describe('buildGrpcCredentials — bare request (no auth)', () => {
  it('returns empty metadata for a bare request against grpcs://', () => {
    const creds = buildGrpcCredentials({ request: request() });
    expect(creds.metadata).toEqual({});
    expect(creds.channelSecurity).toBe('tls');
    expect(creds.tls).toBeUndefined();
    expect(creds.warnings).toEqual([]);
    expect(creds.errors).toEqual([]);
  });

  it('reports plaintext when the target used grpc://', () => {
    const creds = buildGrpcCredentials({ request: request({ plaintext: true }) });
    expect(creds.channelSecurity).toBe('plaintext');
    expect(creds.tls).toBeUndefined();
    expect(creds.errors).toEqual([]);
  });
});

describe('buildGrpcCredentials — request metadata sanitization', () => {
  it('lowercases metadata keys and passes user headers through', () => {
    const creds = buildGrpcCredentials({
      request: request({
        metadata: {
          'X-Correlation-Id': 'abc-123',
          'X-Trace-Sampled': '1',
        },
      }),
    });
    expect(creds.metadata).toEqual({
      'x-correlation-id': 'abc-123',
      'x-trace-sampled': '1',
    });
    expect(creds.warnings).toEqual([]);
    expect(creds.errors).toEqual([]);
  });

  it('drops reserved gRPC transport headers with a warning', () => {
    const creds = buildGrpcCredentials({
      request: request({
        metadata: {
          'content-type': 'application/grpc',
          te: 'trailers',
          'grpc-timeout': '5S',
          Host: 'example.com',
          Connection: 'keep-alive',
          'x-good': 'ok',
        },
      }),
    });
    expect(creds.metadata).toEqual({ 'x-good': 'ok' });
    // One warning per stripped reserved header — order matches iteration
    // but we only assert count + substrings to stay implementation-agnostic.
    expect(creds.warnings.length).toBe(5);
    for (const key of ['content-type', 'te', 'grpc-timeout', 'Host', 'Connection']) {
      expect(creds.warnings.some((w) => w.includes(key))).toBe(true);
    }
    expect(creds.errors).toEqual([]);
  });

  it('drops metadata keys with invalid characters (uppercase after lowering is fine, but slashes are not)', () => {
    const creds = buildGrpcCredentials({
      request: request({
        metadata: {
          'x-space here': 'bad',
          'x/slash': 'bad',
          'x-valid.name_1': 'ok',
        },
      }),
    });
    expect(creds.metadata).toEqual({ 'x-valid.name_1': 'ok' });
    expect(creds.warnings.length).toBe(2);
    expect(creds.warnings.some((w) => w.includes('x-space here'))).toBe(true);
    expect(creds.warnings.some((w) => w.includes('x/slash'))).toBe(true);
  });
});

describe('buildGrpcCredentials — bearer / basic / api-key (header) auth', () => {
  it('folds a bearer Authorization header into metadata', () => {
    const auth: ResolvedAuth = {
      headers: { Authorization: 'Bearer abc.def.ghi' },
      query: {},
    };
    const creds = buildGrpcCredentials({
      request: request(),
      auth,
      authName: 'github',
    });
    expect(creds.metadata).toEqual({ authorization: 'Bearer abc.def.ghi' });
    expect(creds.channelSecurity).toBe('tls');
    expect(creds.errors).toEqual([]);
  });

  it('folds an apiKey header profile into metadata', () => {
    const auth: ResolvedAuth = {
      headers: { 'X-Api-Key': 'top-secret' },
      query: {},
    };
    const creds = buildGrpcCredentials({ request: request(), auth });
    expect(creds.metadata).toEqual({ 'x-api-key': 'top-secret' });
    expect(creds.errors).toEqual([]);
  });

  it('warns when auth overrides a header already set in the request block', () => {
    const auth: ResolvedAuth = {
      headers: { Authorization: 'Bearer FROM_AUTH' },
      query: {},
    };
    const creds = buildGrpcCredentials({
      request: request({ metadata: { authorization: 'Bearer FROM_BLOCK' } }),
      auth,
      authName: 'svc-jwt',
    });
    expect(creds.metadata).toEqual({ authorization: 'Bearer FROM_AUTH' });
    expect(creds.warnings.length).toBe(1);
    expect(creds.warnings[0]).toContain('svc-jwt');
    expect(creds.warnings[0]).toContain('authorization');
    expect(creds.errors).toEqual([]);
  });

  it('warns when an auth profile tries to emit a reserved header', () => {
    const auth: ResolvedAuth = {
      headers: { 'Content-Type': 'application/grpc-web' },
      query: {},
    };
    const creds = buildGrpcCredentials({
      request: request(),
      auth,
      authName: 'weird',
    });
    expect(creds.metadata).toEqual({});
    expect(creds.warnings.length).toBe(1);
    expect(creds.warnings[0]).toContain('weird');
    expect(creds.warnings[0]).toContain('Content-Type');
    expect(creds.errors).toEqual([]);
  });
});

describe('buildGrpcCredentials — apiKey in=query is a blocking error for gRPC', () => {
  it('reports an error and lists the offending query params', () => {
    const auth: ResolvedAuth = {
      headers: {},
      query: { api_key: 'k1', region: 'us-west' },
    };
    const creds = buildGrpcCredentials({
      request: request(),
      auth,
      authName: 'x-api',
    });
    expect(creds.errors.length).toBe(1);
    expect(creds.errors[0]).toContain('x-api');
    expect(creds.errors[0]).toContain('api_key');
    expect(creds.errors[0]).toContain('region');
    expect(creds.errors[0]).toContain('apiKey in=header');
  });
});

describe('buildGrpcCredentials — clientCert (mTLS) profiles', () => {
  it('surfaces PEM tls material and marks channelSecurity as mtls', () => {
    const auth: ResolvedAuth = {
      headers: {},
      query: {},
      tls: {
        format: 'pem',
        certPath: '/certs/client.pem',
        keyPath: '/certs/client.key',
        caPath: '/certs/ca.pem',
      },
    };
    const creds = buildGrpcCredentials({
      request: request(),
      auth,
      authName: 'corp-mtls',
    });
    expect(creds.channelSecurity).toBe('mtls');
    expect(creds.tls).toEqual(auth.tls);
    expect(creds.metadata).toEqual({});
    expect(creds.errors).toEqual([]);
  });

  it('surfaces PFX tls material with the passphrase already resolved', () => {
    const auth: ResolvedAuth = {
      headers: {},
      query: {},
      tls: { format: 'pfx', pfxPath: '/certs/client.pfx', passphrase: 'hunter2' },
    };
    const creds = buildGrpcCredentials({ request: request(), auth });
    expect(creds.channelSecurity).toBe('mtls');
    expect(creds.tls).toEqual(auth.tls);
    expect(creds.errors).toEqual([]);
  });

  it('errors when clientCert is combined with grpc:// (plaintext) target', () => {
    const auth: ResolvedAuth = {
      headers: {},
      query: {},
      tls: { format: 'pem', certPath: '/c.pem', keyPath: '/c.key' },
    };
    const creds = buildGrpcCredentials({
      request: request({ plaintext: true }),
      auth,
      authName: 'corp-mtls',
    });
    expect(creds.channelSecurity).toBe('plaintext');
    // Cert material dropped when the target is plaintext — it can't ride.
    expect(creds.tls).toBeUndefined();
    expect(creds.errors.length).toBe(1);
    expect(creds.errors[0]).toContain('corp-mtls');
    expect(creds.errors[0]).toContain('grpc://');
    expect(creds.errors[0]).toContain('grpcs://');
  });
});

describe('buildGrpcCredentials — combined profiles', () => {
  it('merges auth headers with request metadata and keeps mTLS material', () => {
    const auth: ResolvedAuth = {
      headers: { Authorization: 'Bearer tok' },
      query: {},
      tls: { format: 'pem', certPath: '/c.pem', keyPath: '/c.key' },
    };
    const creds = buildGrpcCredentials({
      request: request({
        metadata: {
          'x-request-id': 'req-42',
          'X-Trace': 'trace-1',
        },
      }),
      auth,
      authName: 'combined',
    });
    expect(creds.metadata).toEqual({
      authorization: 'Bearer tok',
      'x-request-id': 'req-42',
      'x-trace': 'trace-1',
    });
    expect(creds.channelSecurity).toBe('mtls');
    expect(creds.tls?.format).toBe('pem');
    expect(creds.warnings).toEqual([]);
    expect(creds.errors).toEqual([]);
  });

  it('defaults authName to "auth" when omitted', () => {
    const auth: ResolvedAuth = {
      headers: {},
      query: { key: 'v' },
    };
    const creds = buildGrpcCredentials({ request: request(), auth });
    expect(creds.errors[0]).toMatch(/^Auth profile "auth"/);
  });
});
