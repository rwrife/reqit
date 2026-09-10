/**
 * Tests for the pure SSE stream-view HTML builder (`src/core/sse/streamView.ts`).
 *
 * The builder renders the live-streaming response panel, including the
 * dedicated "Stop stream" button required by issue #46. It must be:
 *   - pure (no VS Code import),
 *   - XSS-safe (all dynamic values escaped; hostile event data cannot
 *     break out of its markup context),
 *   - locked down with a strict CSP + per-render script nonce so only our
 *     own click-to-postMessage shim can run,
 *   - honest: the button only exists while the stream is live.
 */
import { describe, expect, it } from 'vitest';

import {
  buildSseStreamHtml,
  isSseStopMessage,
  SSE_STOP_MESSAGE_TYPE,
  type SseStreamViewModel,
} from '../src/core/sse/streamView.js';

function model(overrides: Partial<SseStreamViewModel> = {}): SseStreamViewModel {
  return {
    method: 'GET',
    url: 'http://127.0.0.1:8123/stream',
    status: 200,
    headers: { 'content-type': 'text/event-stream' },
    elapsedMs: 120,
    streaming: true,
    events: [
      {
        index: 0,
        type: 'message',
        elapsedMs: 100,
        timestamp: '2026-09-10T15:00:00.000Z',
        data: 'hello',
      },
    ],
    ...overrides,
  };
}

const NONCE = 'aGVsbG8td29ybGQ=';

function html(m: SseStreamViewModel = model(), nonce = NONCE): string {
  return buildSseStreamHtml(m, { nonce });
}

describe('buildSseStreamHtml — stop button (issue #46)', () => {
  it('renders a Stop stream button while the stream is live', () => {
    const out = html();
    expect(out).toContain('<button');
    expect(out).toContain('id="reqit-sse-stop"');
    expect(/Stop stream/i.test(out)).toBe(true);
  });

  it('renders exactly one stop button', () => {
    const out = html();
    const matches = out.match(/id="reqit-sse-stop"/g) ?? [];
    expect(matches).toHaveLength(1);
  });

  it('does NOT render the stop button after the stream has ended', () => {
    const out = html(model({ streaming: false, stopReason: 'done' }));
    expect(out).not.toContain('id="reqit-sse-stop"');
  });

  it('wires the button to the host stop-message contract via postMessage', () => {
    const out = html();
    // The inline shim must post the exact message type the extension host validates.
    expect(out).toContain(SSE_STOP_MESSAGE_TYPE);
    expect(out).toContain('acquireVsCodeApi');
    expect(out).toContain('postMessage');
  });

  it('emits the stop-message type as a constant matching the documented shape', () => {
    expect(SSE_STOP_MESSAGE_TYPE).toBe('reqit-sse-stop');
  });
});

describe('buildSseStreamHtml — CSP + nonce lockdown', () => {
  it('includes a strict CSP meta tag with script-src bound to the nonce', () => {
    const out = html();
    expect(out).toContain('Content-Security-Policy');
    expect(out).toContain("default-src 'none'");
    expect(out).toContain(`script-src 'nonce-${NONCE}'`);
  });

  it('binds the inline script tag to the same nonce', () => {
    const out = html();
    expect(out).toContain(`<script nonce="${NONCE}">`);
  });

  it('uses a different nonce per render (caller-provided, echoed verbatim)', () => {
    const a = html(model(), 'nonceA');
    const b = html(model(), 'nonceB');
    expect(a).toContain("script-src 'nonce-nonceA'");
    expect(b).toContain("script-src 'nonce-nonceB'");
    expect(a).not.toContain('nonceB');
  });

  it('rejects nonces that could break attribute or CSP context', () => {
    expect(() => html(model(), 'bad"nonce')).toThrow();
    expect(() => html(model(), "bad'nonce")).toThrow();
    expect(() => html(model(), 'bad;nonce')).toThrow();
    expect(() => html(model(), 'bad nonce')).toThrow();
    expect(() => html(model(), '')).toThrow();
  });
});

describe('buildSseStreamHtml — escaping (untrusted event data)', () => {
  it('escapes hostile event data so it cannot inject markup or scripts', () => {
    const hostile = '</pre><script>alert("xss")</script>';
    const out = html(model({ events: [{ index: 0, type: 'x', elapsedMs: 1, timestamp: 't', data: hostile }] }));
    expect(out).not.toContain('<script>alert');
    expect(out).not.toContain('</pre><script>');
    expect(out).toContain('&lt;script&gt;');
  });

  it('escapes hostile event type, id, and timestamp fields', () => {
    const out = html(
      model({
        events: [
          {
            index: 0,
            type: '<img src=x onerror=1>',
            lastEventId: '"><b>x',
            elapsedMs: 1,
            timestamp: '"><i>t',
            data: 'safe',
          },
        ],
      }),
    );
    expect(out).not.toContain('<img src=x');
    expect(out).not.toContain('"><b>');
    expect(out).not.toContain('"><i>');
    expect(out).toContain('&lt;img src=x onerror=1&gt;');
  });

  it('escapes hostile request url/method and header content', () => {
    const out = html(
      model({
        method: 'GET"><s',
        url: 'http://x/"<b>',
        headers: { 'x-a': '<script>bad</script>' },
      }),
    );
    expect(out).not.toContain('"><s');
    expect(out).not.toContain('"><b>');
    expect(out).not.toContain('<script>bad');
  });

  it('escapes notes (directive diagnostics, until-errors)', () => {
    const out = html(model({ note: '<script>note</script>' }));
    expect(out).not.toContain('<script>note');
    expect(out).toContain('&lt;script&gt;note&lt;/script&gt;');
  });

  it('pretty-prints JSON event data', () => {
    const out = html(
      model({ events: [{ index: 0, type: 'message', elapsedMs: 1, timestamp: 't', data: '{"a":1}' }] }),
    );
    // JSON.stringify(..., null, 2) splits lines even after HTML escaping.
    expect(out).toContain('&quot;a&quot;');
  });

  it('surfaces the stop reason after the stream ends', () => {
    const out = html(model({ streaming: false, stopReason: 'aborted' }));
    expect(out).toContain('aborted');
  });

  it('renders a no-events placeholder when nothing streamed yet', () => {
    const out = html(model({ events: [] }));
    expect(out).toContain('no events yet');
  });
});

describe('isSseStopMessage — host-side message validation', () => {
  it('accepts the exact stop message shape', () => {
    expect(isSseStopMessage({ type: SSE_STOP_MESSAGE_TYPE })).toBe(true);
  });

  it('rejects unknown, nullish, and non-object messages', () => {
    expect(isSseStopMessage({ type: 'other' })).toBe(false);
    expect(isSseStopMessage({ type: 'reqit-sse-stop', extra: 'nope' })).toBe(false);
    expect(isSseStopMessage(undefined)).toBe(false);
    expect(isSseStopMessage(null)).toBe(false);
    expect(isSseStopMessage('reqit-sse-stop')).toBe(false);
    expect(isSseStopMessage(42)).toBe(false);
    expect(isSseStopMessage([{ type: SSE_STOP_MESSAGE_TYPE }])).toBe(false);
  });

  it('rejects prototype-injected type values', () => {
    const forged = Object.create({ type: SSE_STOP_MESSAGE_TYPE });
    expect(isSseStopMessage(forged)).toBe(false);
  });
});
