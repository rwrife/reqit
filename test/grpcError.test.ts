import { describe, it, expect } from 'vitest';
import {
  GrpcStatusCode,
  REFLECTION_UNSUPPORTED_CODE,
  reportForStatus,
  reflectionUnsupportedReport,
  isOk,
} from '../src/core/grpcError.js';

describe('reportForStatus', () => {
  it('names OK and treats it as success', () => {
    const r = reportForStatus(GrpcStatusCode.OK);
    expect(r.code).toBe(0);
    expect(r.name).toBe('OK');
    expect(isOk(r.code)).toBe(true);
    expect(r.hint).toMatch(/succeeded/i);
  });

  it('surfaces UNAVAILABLE with a "check host/port/TLS" hint', () => {
    const r = reportForStatus(GrpcStatusCode.UNAVAILABLE);
    expect(r.name).toBe('UNAVAILABLE');
    expect(r.hint).toMatch(/host\/port/i);
  });

  it('surfaces UNAUTHENTICATED with an @auth-profile hint', () => {
    const r = reportForStatus(GrpcStatusCode.UNAUTHENTICATED, 'invalid signature');
    expect(r.name).toBe('UNAUTHENTICATED');
    expect(r.message).toBe('invalid signature');
    expect(r.hint).toMatch(/@auth/i);
    expect(r.hint).toMatch(/mTLS/i);
  });

  it('surfaces UNIMPLEMENTED with a "wrong service/method" hint', () => {
    const r = reportForStatus(GrpcStatusCode.UNIMPLEMENTED);
    expect(r.name).toBe('UNIMPLEMENTED');
    expect(r.hint).toMatch(/service\/method name/i);
  });

  it('trims whitespace from server messages and drops empty ones', () => {
    const withWs = reportForStatus(GrpcStatusCode.INTERNAL, '   \n  ');
    expect(withWs.message).toBeUndefined();
    const trimmed = reportForStatus(GrpcStatusCode.INTERNAL, '  boom  ');
    expect(trimmed.message).toBe('boom');
  });

  it('falls back to UNKNOWN(<code>) for unrecognized numeric codes', () => {
    const r = reportForStatus(42);
    expect(r.name).toBe('UNKNOWN(42)');
    expect(r.hint).toMatch(/unexpected status/i);
    expect(isOk(r.code)).toBe(false);
  });

  it('covers every enum value with a status name AND a hint', () => {
    for (const value of Object.values(GrpcStatusCode)) {
      if (typeof value !== 'number') continue;
      const r = reportForStatus(value);
      expect(r.name, `name for code ${value}`).not.toMatch(/^UNKNOWN\(/);
      expect(r.hint.length, `hint for code ${value}`).toBeGreaterThan(0);
    }
  });
});

describe('reflectionUnsupportedReport', () => {
  it('uses the synthetic sentinel code and REFLECTION_UNSUPPORTED name', () => {
    const r = reflectionUnsupportedReport();
    expect(r.code).toBe(REFLECTION_UNSUPPORTED_CODE);
    expect(r.name).toBe('REFLECTION_UNSUPPORTED');
    expect(r.hint).toMatch(/reflection/i);
    expect(isOk(r.code)).toBe(false);
  });

  it('surfaces an optional detail string', () => {
    const r = reflectionUnsupportedReport('server sent UNIMPLEMENTED for ServerReflection');
    expect(r.message).toBe('server sent UNIMPLEMENTED for ServerReflection');
  });

  it('omits blank details', () => {
    const r = reflectionUnsupportedReport('   ');
    expect(r.message).toBeUndefined();
  });

  it('sentinel code does not collide with any real gRPC status', () => {
    // Every real status code is non-negative. The synthetic one is < 0.
    expect(REFLECTION_UNSUPPORTED_CODE).toBeLessThan(0);
    for (const value of Object.values(GrpcStatusCode)) {
      if (typeof value !== 'number') continue;
      expect(value).not.toBe(REFLECTION_UNSUPPORTED_CODE);
    }
  });
});

describe('isOk', () => {
  it('is true only for status code 0', () => {
    expect(isOk(0)).toBe(true);
    expect(isOk(1)).toBe(false);
    expect(isOk(-1)).toBe(false);
    expect(isOk(GrpcStatusCode.UNAUTHENTICATED)).toBe(false);
  });
});
