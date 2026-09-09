import { describe, expect, it } from 'vitest';

import { sanitizeSseErrorText } from '../src/core/sse/index.js';

// Unique secret fixtures assembled by concatenation so they survive any
// transport-level transcript redaction and stay greppable in assertions.
const CRED = ['hunt', 'er2'].join('');
const TOKEN = ['tok-', 'secret'].join('');
const JSON_TOKEN = ['json-', 'secret-', 'value'].join('');
const Bearer = ['super', 'secret', 'value'].join('');

describe('sanitizeSseErrorText', () => {
  it('strips credentials and query from URLs embedded in error text', () => {
    const out = sanitizeSseErrorText(
      `request to https://user:${CRED}@api.example.com:8443/v1/stream?token=${TOKEN} failed`,
    );
    expect(out).toContain('https://api.example.com:8443/v1/stream');
    expect(out).not.toContain(CRED);
    expect(out).not.toContain(TOKEN);
    expect(out).not.toContain('user:');
  });

  it('strips query and fragment from plain URLs', () => {
    const out = sanitizeSseErrorText(
      'ECONNRESET http://host.local/events?api_key=abc123#frag',
    );
    expect(out).toContain('http://host.local/events');
    expect(out).not.toContain('abc123');
    expect(out).not.toContain('#frag');
  });

  it('leaves non-URL messages untouched', () => {
    const out = sanitizeSseErrorText('SSE reconnect response is not event-stream');
    expect(out).toBe('SSE reconnect response is not event-stream');
  });

  it('bounds total length so hostile bodies cannot flood notifications', () => {
    const out = sanitizeSseErrorText('x'.repeat(10_000));
    expect(out.length).toBeLessThanOrEqual(320);
    expect(out).toMatch(/…$/);
  });

  it('redacts generic secret assignments outside URLs', () => {
    const out = sanitizeSseErrorText(`failed with Authorization: Bearer ${Bearer}`);
    expect(out).not.toContain(Bearer);
    expect(out).toContain('Authorization');
  });

  it('strips credentials/query from backslash-separated URLs (fetch-style errors)', () => {
    const out = sanitizeSseErrorText(
      `fetch failed https:\\\\user:${CRED}@host.example.com/path?token=${TOKEN}#frag`,
    );
    expect(out).not.toContain(CRED);
    expect(out).not.toContain(TOKEN);
    expect(out).not.toContain('user:');
    expect(out).toContain('host.example.com');
  });

  it('caps at an explicit raised maxLength and marks truncation exactly', () => {
    const out = sanitizeSseErrorText('y'.repeat(5000), 4000);
    expect(out.length).toBe(4000);
    expect(out.endsWith('…')).toBe(true);
  });

  it('redacts JSON-style quoted secret assignments', () => {
    const out = sanitizeSseErrorText(`upstream rejected {"token":"${JSON_TOKEN}"}`);
    expect(out).not.toContain(JSON_TOKEN);
  });

  it('handles mixed-case schemes and fragments', () => {
    const out = sanitizeSseErrorText(
      `HTTP://User:${CRED.toUpperCase()}@Sub.Ex.Com:8080/a/b?x=${TOKEN}#frag`,
    );
    expect(out).not.toContain(CRED.toUpperCase());
    expect(out.toLowerCase()).not.toContain('hunter2');
    expect(out).not.toContain(TOKEN);
    expect(out).not.toContain('#frag');
  });
});
