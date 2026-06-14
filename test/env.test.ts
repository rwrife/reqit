import { describe, expect, it } from 'vitest';
import { isSecretMarker, listSecretVars, parseEnvFile } from '../src/core/env.js';

describe('parseEnvFile', () => {
  it('parses a multi-env file with scalars', () => {
    const src = JSON.stringify({
      default: { baseUrl: 'https://a.test', port: 443, debug: false },
      staging: { baseUrl: 'https://b.test' },
    });
    const r = parseEnvFile(src);
    expect(r.ok).toBe(true);
    expect(r.envs.default.baseUrl).toBe('https://a.test');
    expect(r.envs.default.port).toBe(443);
    expect(r.envs.default.debug).toBe(false);
    expect(r.envs.staging.baseUrl).toBe('https://b.test');
  });

  it('accepts secret markers', () => {
    const src = JSON.stringify({ default: { apiKey: { $secret: true } } });
    const r = parseEnvFile(src);
    expect(r.ok).toBe(true);
    expect(isSecretMarker(r.envs.default.apiKey)).toBe(true);
  });

  it('rejects malformed JSON', () => {
    const r = parseEnvFile('{not json');
    expect(r.ok).toBe(false);
    expect(r.error).toMatch(/Invalid JSON/);
  });

  it('rejects unsupported value types', () => {
    const src = JSON.stringify({ default: { weird: { $secret: 'no' } } });
    const r = parseEnvFile(src);
    expect(r.ok).toBe(false);
  });

  it('rejects arrays as env values', () => {
    const src = JSON.stringify({ default: { arr: [1, 2, 3] } });
    const r = parseEnvFile(src);
    expect(r.ok).toBe(false);
  });

  it('listSecretVars collects (env, name) tuples across envs', () => {
    const src = JSON.stringify({
      default: { apiKey: { $secret: true }, baseUrl: 'x' },
      prod: { apiKey: { $secret: true }, token: { $secret: true } },
    });
    const r = parseEnvFile(src);
    expect(r.ok).toBe(true);
    const secrets = listSecretVars(r.envs).sort((a, b) =>
      (a.env + a.name).localeCompare(b.env + b.name),
    );
    expect(secrets).toEqual([
      { env: 'default', name: 'apiKey' },
      { env: 'prod', name: 'apiKey' },
      { env: 'prod', name: 'token' },
    ]);
  });

  it('isSecretMarker is strict about shape', () => {
    expect(isSecretMarker({ $secret: true })).toBe(true);
    expect(isSecretMarker({ $secret: false })).toBe(false);
    expect(isSecretMarker({ secret: true })).toBe(false);
    expect(isSecretMarker(null)).toBe(false);
    expect(isSecretMarker('string')).toBe(false);
  });
});
