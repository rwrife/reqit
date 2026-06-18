import { describe, expect, it } from 'vitest';
import { requestToCurl } from '../src/core/curl.js';
import type { UndiciRequestOptions } from '../src/core/request.js';

const base: UndiciRequestOptions = {
  method: 'GET',
  url: 'https://example.com/api',
  headers: {},
};

describe('requestToCurl', () => {
  it('renders a bare GET without an explicit method flag', () => {
    expect(requestToCurl(base)).toBe(`curl 'https://example.com/api'`);
  });

  it('emits headers as -H flags with single-quoted values', () => {
    const out = requestToCurl({
      ...base,
      headers: { Accept: 'application/json', 'X-Trace': 'abc 123' },
    });
    expect(out).toContain(`-H 'Accept: application/json'`);
    expect(out).toContain(`-H 'X-Trace: abc 123'`);
  });

  it('uses -X and --data-raw for non-GET with a body', () => {
    const out = requestToCurl({
      method: 'POST',
      url: 'https://example.com/x',
      headers: { 'Content-Type': 'application/json' },
      body: '{"a":1}',
    });
    expect(out).toContain(`-X POST`);
    expect(out).toContain(`--data-raw '{"a":1}'`);
  });

  it('emits -X GET when a GET carries a body (rare but legal)', () => {
    const out = requestToCurl({ ...base, body: 'hello' });
    expect(out).toContain(`-X GET`);
    expect(out).toContain(`--data-raw 'hello'`);
  });

  it("escapes embedded single quotes via the '\\'' trick", () => {
    const out = requestToCurl({
      ...base,
      headers: { 'X-Note': "it's fine" },
    });
    expect(out).toContain(`-H 'X-Note: it'\\''s fine'`);
  });

  it('redacts secret values everywhere they appear', () => {
    const out = requestToCurl(
      {
        method: 'POST',
        url: 'https://example.com/secret/s3cr3t',
        headers: { Authorization: 'Bearer s3cr3t' },
        body: 'token=s3cr3t&id=1',
      },
      { redact: ['s3cr3t'] },
    );
    expect(out).not.toContain('s3cr3t');
    expect(out).toContain('***REDACTED***');
    // Should be redacted in URL, header, and body.
    expect(out.match(/\*\*\*REDACTED\*\*\*/g)?.length).toBe(3);
  });

  it('honours a custom redaction placeholder', () => {
    const out = requestToCurl(
      { ...base, headers: { Authorization: 'Bearer abc' } },
      { redact: ['abc'], redactPlaceholder: '<redacted>' },
    );
    expect(out).toContain('<redacted>');
    expect(out).not.toContain('abc');
  });

  it('ignores empty redact strings (never produces a degenerate split)', () => {
    const out = requestToCurl(
      { ...base, headers: { 'X-A': 'one' } },
      { redact: ['', 'one'] },
    );
    expect(out).toContain('***REDACTED***');
    expect(out).not.toContain(`X-A: one`);
  });
});
