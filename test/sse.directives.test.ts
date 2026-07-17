import { describe, expect, it } from 'vitest';

import {
  isSseResponse,
  sseOptionsFromDirectives,
} from '../src/core/sse/directives.js';

describe('sseOptionsFromDirectives', () => {
  it('returns empty options when no sse directives are present', () => {
    const r = sseOptionsFromDirectives({ auth: 'prod', name: 'foo' });
    expect(r.options).toEqual({});
    expect(r.diagnostics).toEqual([]);
  });

  it('extracts a valid @sse-until predicate', () => {
    const r = sseOptionsFromDirectives({ 'sse-until': 'event.data === "[DONE]"' });
    expect(r.options.until).toBe('event.data === "[DONE]"');
    expect(r.diagnostics).toEqual([]);
  });

  it('flags an empty @sse-until as a diagnostic and drops it', () => {
    const r = sseOptionsFromDirectives({ 'sse-until': '   ' });
    expect(r.options.until).toBeUndefined();
    expect(r.diagnostics).toHaveLength(1);
    expect(r.diagnostics[0].directive).toBe('sse-until');
  });

  it('parses numeric caps', () => {
    const r = sseOptionsFromDirectives({
      'sse-max-events': '10',
      'sse-max-duration-ms': '5000',
      'sse-idle-ms': '2500',
    });
    expect(r.options).toEqual({ maxEvents: 10, maxDurationMs: 5000, idleMs: 2500 });
    expect(r.diagnostics).toEqual([]);
  });

  it('rejects non-integer / non-positive numeric values with diagnostics', () => {
    const r = sseOptionsFromDirectives({
      'sse-max-events': '3.5',
      'sse-max-duration-ms': '-1',
      'sse-idle-ms': 'soon',
    });
    expect(r.options).toEqual({});
    expect(r.diagnostics.map((d) => d.directive).sort()).toEqual([
      'sse-idle-ms',
      'sse-max-duration-ms',
      'sse-max-events',
    ]);
  });

  it('coexists with unrelated directives without leaking them', () => {
    const r = sseOptionsFromDirectives({
      auth: 'prod',
      'sse-until': 'count >= 3',
      'sse-max-events': '3',
    });
    expect(r.options).toEqual({ until: 'count >= 3', maxEvents: 3 });
    expect((r.options as Record<string, unknown>).auth).toBeUndefined();
  });
});

describe('isSseResponse', () => {
  it('matches text/event-stream with parameters', () => {
    expect(isSseResponse({ 'content-type': 'text/event-stream' })).toBe(true);
    expect(isSseResponse({ 'Content-Type': 'text/event-stream; charset=utf-8' })).toBe(true);
    expect(isSseResponse({ 'CONTENT-TYPE': ['text/event-stream'] })).toBe(true);
  });

  it('rejects non-SSE content types', () => {
    expect(isSseResponse({ 'content-type': 'application/json' })).toBe(false);
    expect(isSseResponse({ 'content-type': 'text/plain' })).toBe(false);
    expect(isSseResponse({})).toBe(false);
  });

  it('ignores non-content-type headers even if they contain the mime', () => {
    expect(isSseResponse({ accept: 'text/event-stream' })).toBe(false);
  });
});
