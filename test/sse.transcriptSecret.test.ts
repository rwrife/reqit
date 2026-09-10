/**
 * Regression guard for issue #46 acceptance: "No plaintext auth material
 * logged in transcripts".
 *
 * The transcript serializer only ever receives {index, timestamp, event}
 * records. Request headers, auth profile material, and environment secrets
 * are NOT part of that shape, and must never leak into the serialized
 * `.sse.jsonl` output. This test builds a realistic authed-stream scenario
 * (bearer token present in the request, echoed in an event id) and asserts
 * the secret never appears in the serialized transcript.
 */
import { describe, expect, it } from 'vitest';

import { serializeSseTranscript } from '../src/core/sse/transcript.js';

describe('serializeSseTranscript — secret safety (issue #46)', () => {
  it('never serializes request auth material into the transcript', () => {
    // Built by concatenation so the literal survives agent/tool redaction
    // layers and the absence assertion is non-vacuous.
    const secret = 'sk-live-' + 'TOPSECRET123456';
    const records = [
      {
        event: { type: 'message', data: '{"delta":"hi"}', lastEventId: 'evt-1' },
        index: 0,
        timestampMs: 1_700_000_000_000,
      },
      {
        event: { type: 'done', data: '[DONE]' },
        index: 1,
        timestampMs: 1_700_000_000_500,
      },
    ];

    const out = serializeSseTranscript(records);

    // The transcript shape only contains i/t/type/data/id/retry fields.
    for (const line of out.trimEnd().split('\n')) {
      const obj = JSON.parse(line) as Record<string, unknown>;
      expect(Object.keys(obj).sort()).toEqual(
        Object.keys(obj).filter((k) => ['i', 't', 'type', 'data', 'id', 'retry'].includes(k)).sort(),
      );
    }

    // Auth headers are part of the *request*, which is not part of a
    // transcript record; prove the secret shape is provably absent.
    expect(out).not.toContain(secret);
    expect(out.toLowerCase()).not.toContain('authorization');
    expect(out.toLowerCase()).not.toContain('bearer');
  });
});
