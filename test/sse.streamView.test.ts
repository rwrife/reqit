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

const NONCE = 'QUJDRA==';
// Per-session stop token: base64url charset only, safe inside the shim's
// JS string literal.
const STOP_TOKEN = 'SESSIONtok0123456789';

function html(m: SseStreamViewModel = model(), nonce = NONCE): string {
  return buildSseStreamHtml(m, { nonce, stopToken: STOP_TOKEN });
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

  it('binds the posted message to the per-session stop token (queued old clicks cannot hit a new owner)', () => {
    const out = html();
    expect(out).toContain(STOP_TOKEN);
    const script = out.slice(out.indexOf('<script'), out.indexOf('</script>'));
    expect(script).toContain(`token: '${STOP_TOKEN}'`);
  });

  it('rejects a missing or malformed per-session stop token at build time', () => {
    expect(() => buildSseStreamHtml(model(), { nonce: NONCE, stopToken: '' })).toThrow();
    expect(() => buildSseStreamHtml(model(), { nonce: NONCE, stopToken: 'bad token' })).toThrow();
    expect(() => buildSseStreamHtml(model(), { nonce: NONCE, stopToken: "bad'tok" })).toThrow();
    expect(() => buildSseStreamHtml(model(), { nonce: NONCE } as never)).toThrow();
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
    const a = html(model(), 'bm9uY2VB'); // canonical base64 of "nonceA"
    const b = html(model(), 'bm9uY2VC'); // canonical base64 of "nonceB"
    expect(a).toContain("script-src 'nonce-bm9uY2VB'");
    expect(b).toContain("script-src 'nonce-bm9uY2VC'");
    expect(a).not.toContain('bm9uY2VC');
  });

  it('rejects nonces that could break attribute or CSP context', () => {
    expect(() => html(model(), 'bad"nonce')).toThrow();
    expect(() => html(model(), "bad'nonce")).toThrow();
    expect(() => html(model(), 'bad;nonce')).toThrow();
    expect(() => html(model(), 'bad nonce')).toThrow();
    expect(() => html(model(), '')).toThrow();
  });

  it('rejects non-canonical base64 shapes (embedded =, misplaced padding, nonzero pad bits)', () => {
    expect(() => html(model(), 'a=b')).toThrow();
    expect(() => html(model(), 'QQ==QQ==')).toThrow();
    expect(() => html(model(), 'A')).toThrow();
    expect(() => html(model(), 'AA=')).toThrow();
    expect(() => html(model(), '====')).toThrow();
    // Canonical-form checks: decode/re-encode must round-trip exactly.
    // 'AB==' encodes 1 byte as 0x00|bits — trailing bits nonzero => non-canonical.
    expect(() => html(model(), 'AB==')).toThrow();
    expect(() => html(model(), 'AAB=')).toThrow();
  });

  it('accepts canonical base64 nonces (unpadded and padded forms)', () => {
    expect(() => html(model(), 'aGVsbG8td29ybGQ=')).not.toThrow();
    expect(() => html(model(), 'QQ==')).not.toThrow();
    expect(() => html(model(), 'QUJD')).not.toThrow();
    expect(() => html(model(), 'QUJDRA==')).not.toThrow();
    // The exact shape makeSseNonce produces: 12 random bytes -> 16 unpadded chars.
    expect(() => html(model(), 'AAECAwQFBgcICQoLDA0O')).not.toThrow();
  });
});

describe('buildSseStreamHtml — fail-closed numeric fields', () => {
  it('coerces non-finite numeric view fields to 0 instead of echoing garbage', () => {
    const hostile = model({
      elapsedMs: Number.POSITIVE_INFINITY,
      status: Number.NaN,
      events: [
        { index: Number.NaN, type: 'x', elapsedMs: Number.NaN, timestamp: 't', data: 'd' },
      ],
    }) as unknown as SseStreamViewModel;
    const out = html(hostile);
    expect(out).not.toContain('Infinity');
    expect(out).not.toContain('NaN');
    expect(out).toContain('#0');
    expect(out).toContain('0ms');
    expect(out).toContain('HTTP 0');
  });
});

describe('buildSseStreamHtml — stop shim at-most-once latch', () => {
  it('latches and disables the button BEFORE attempting postMessage', () => {
    const out = html();
    const script = out.slice(out.indexOf('<script'), out.indexOf('</script>'));
    const latchIdx = script.indexOf('posted = true');
    const disableIdx = script.indexOf('btn.disabled = true');
    const postIdx = script.indexOf('api.postMessage');
    expect(latchIdx).toBeGreaterThan(-1);
    expect(disableIdx).toBeGreaterThan(-1);
    expect(postIdx).toBeGreaterThan(-1);
    expect(latchIdx).toBeLessThan(postIdx);
    expect(disableIdx).toBeLessThan(postIdx);
    // The old failure path re-armed the latch inside catch (`posted = false`
    // after the declaration). Only the initial `var posted = false;` may exist.
    const reArm = script.match(/posted\s*=\s*false/g) ?? [];
    expect(reArm).toHaveLength(1);
    expect(script.indexOf('posted = false')).toBe(script.indexOf('var posted = false') + 4);
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
  const TOK = 'tok-A';

  it('accepts the exact token-bound stop message shape', () => {
    expect(isSseStopMessage({ type: SSE_STOP_MESSAGE_TYPE, token: TOK }, TOK)).toBe(true);
  });

  it('rejects messages carrying a foreign or missing token', () => {
    // A queued click from a superseded session must never abort the new owner.
    expect(isSseStopMessage({ type: SSE_STOP_MESSAGE_TYPE, token: 'tok-B' }, TOK)).toBe(false);
    expect(isSseStopMessage({ type: SSE_STOP_MESSAGE_TYPE }, TOK)).toBe(false);
    expect(isSseStopMessage({ type: SSE_STOP_MESSAGE_TYPE, token: '' }, TOK)).toBe(false);
  });

  it('rejects unknown, nullish, and non-object messages', () => {
    expect(isSseStopMessage({ type: 'other', token: TOK }, TOK)).toBe(false);
    expect(isSseStopMessage({ type: SSE_STOP_MESSAGE_TYPE, token: TOK, extra: 'nope' }, TOK)).toBe(false);
    expect(isSseStopMessage(undefined, TOK)).toBe(false);
    expect(isSseStopMessage(null, TOK)).toBe(false);
    expect(isSseStopMessage('reqit-sse-stop', TOK)).toBe(false);
    expect(isSseStopMessage(42, TOK)).toBe(false);
    expect(isSseStopMessage([{ type: SSE_STOP_MESSAGE_TYPE, token: TOK }], TOK)).toBe(false);
  });

  it('rejects prototype-injected type values', () => {
    const forged = Object.create({ type: SSE_STOP_MESSAGE_TYPE, token: TOK });
    expect(isSseStopMessage(forged, TOK)).toBe(false);
  });

  it('rejects a plain object with an own type property but a forged prototype chain', () => {
    const obj = { type: SSE_STOP_MESSAGE_TYPE, token: TOK };
    Object.setPrototypeOf(obj, { evil: true });
    expect(isSseStopMessage(obj, TOK)).toBe(false);
  });

  it('rejects objects carrying extra symbol-keyed properties', () => {
    const obj: Record<PropertyKey, unknown> = { type: SSE_STOP_MESSAGE_TYPE, token: TOK };
    Object.defineProperty(obj, Symbol('smuggle'), { value: 1, enumerable: false });
    expect(isSseStopMessage(obj, TOK)).toBe(false);
  });

  it('rejects a constant-folded token via getter weirdness (own enumerable data props only)', () => {
    const obj = { type: SSE_STOP_MESSAGE_TYPE } as Record<string, unknown>;
    Object.defineProperty(obj, 'token', { get: () => TOK, enumerable: true });
    // DefineProperty created an accessor; Reflect.ownKeys sees it, but the
    // value read must still match. Accessor tokens ARE accepted if they
    // return the right value — this asserts the contract stays value-based.
    expect(isSseStopMessage(obj, TOK)).toBe(true);
  });

  it('accepts only the canonical prototype with exactly the two own keys', () => {
    expect(isSseStopMessage(JSON.parse('{"type":"reqit-sse-stop","token":"tok-A"}'), TOK)).toBe(true);
  });
});
