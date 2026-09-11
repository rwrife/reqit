/**
 * Regression guard for issue #46 acceptance: "No plaintext auth material
 * logged in transcripts".
 *
 * Honest scope. Two properties, both exercised through the PRODUCTION
 * capture boundary (`pickSseTranscriptRecord`, the allowlist the extension
 * host's onEvent actually calls — see streamSseResponse in extension.ts):
 *
 *   1. The capture boundary is a real filter, not a formality: a hostile
 *      input that smuggles request auth material (headers with a bearer
 *      secret, URL userinfo) alongside the event drops it, and the
 *      serializer output provably never contains it. Non-vacuity controls:
 *      the same secret IS visible in the raw input object, and the
 *      serializer carries secret-shaped event content verbatim when it
 *      arrives as server-echoed stream data (by design — response data the
 *      user chose to save).
 *   2. The transcript record shape is closed-world (i/t/type/data/id/retry
 *      only) so no header/auth field can exist on disk at all.
 */
import { describe, expect, it } from 'vitest';

import { pickSseTranscriptRecord, serializeSseTranscript } from '../src/core/sse/transcript.js';
import { formatSseTranscriptLine } from '../src/core/sse/transport.js';

describe('SSE transcript secret safety (issue #46)', () => {
  // Built by concatenation so the literal survives agent/tool redaction
  // layers and every presence/absence assertion below is non-vacuous.
  const secret = 'sk-live-' + 'TOPSECRET123456';

  it('control: serializer carries secret-shaped server content verbatim (boundary is not fake redaction)', () => {
    const line = formatSseTranscriptLine(
      { type: 'message', data: `echoed: ${secret}` },
      { index: 0, timestamp: 1 },
    );
    expect(line).toContain(secret);
  });

  it('production capture boundary strips request-adjacent auth material end-to-end', () => {
    // Realistic hostile-ish capture call: the extension host has the sent
    // request (with bearer auth) in scope at onEvent time. Production code
    // passes it alongside the event; the allowlist must drop it.
    // ONE input object is built, asserted to carry the secret, and THAT
    // SAME object is passed to the production boundary — the non-vacuity
    // control and the captured input cannot diverge.
    const input = {
      event: { type: 'message', data: '{"delta":"hi"}', lastEventId: 'evt-1' },
      index: 0,
      timestampMs: 1_700_000_000_000,
      // Smuggled alongside the event — exactly the shape a future
      // refactor regression would produce if capture stopped allowlisting.
      headers: { authorization: `Bearer ${secret}` },
      url: `https://user:${secret}@api.example.com/v1/stream`,
    };

    // Non-vacuity: the secret really is inside the exact object the
    // production capture boundary receives.
    const rawInput = JSON.stringify(input);
    expect(rawInput).toContain(secret);
    expect(rawInput.toLowerCase()).toContain('authorization');

    const captured = pickSseTranscriptRecord(input);

    // Directly assert the RECORD the boundary produced is clean — a pick
    // regression (merging extras) is caught here even though the on-disk
    // serializer would also drop them (defense in depth).
    expect(Object.keys(captured).sort()).toEqual(['event', 'index', 'timestampMs']);
    expect(JSON.stringify(captured)).not.toContain(secret);

    const out = serializeSseTranscript([
      captured,
      pickSseTranscriptRecord({
        event: { type: 'done', data: '[DONE]' },
        index: 1,
        timestampMs: 1_700_000_000_500,
      }),
    ]);

    // Closed-world record keys — no header/auth field can exist at all.
    for (const line of out.trimEnd().split('\n')) {
      const obj = JSON.parse(line) as Record<string, unknown>;
      expect(Object.keys(obj).sort()).toEqual(
        Object.keys(obj).filter((k) => ['i', 't', 'type', 'data', 'id', 'retry'].includes(k)).sort(),
      );
    }

    // And the request-side secret is provably absent from disk output.
    expect(out).not.toContain(secret);
    expect(out.toLowerCase()).not.toContain('authorization');
    expect(out.toLowerCase()).not.toContain('bearer');
  });

  it('capture boundary preserves exactly the event fields (no silent data loss)', () => {
    const rec = pickSseTranscriptRecord({
      event: { type: 'delta', data: '{"ok":true}', lastEventId: 'abc', retry: 1500 },
      index: 4,
      timestampMs: 1_700_000_001_000,
    });
    expect(rec).toEqual({
      event: { type: 'delta', data: '{"ok":true}', lastEventId: 'abc', retry: 1500 },
      index: 4,
      timestampMs: 1_700_000_001_000,
    });
  });
});
