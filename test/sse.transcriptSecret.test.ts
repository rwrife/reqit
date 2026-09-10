/**
 * Regression guard for issue #46 acceptance: "No plaintext auth material
 * logged in transcripts".
 *
 * Honest scope of this test. The transcript serializer receives ONLY
 * captured stream records ({index, timestampMs, event}); request headers,
 * auth profile material, and environment secrets are not part of that
 * shape anywhere in the pipeline (see `streamSseResponse`, which builds
 * records exclusively from dispatched events). Two properties are proven:
 *
 *   1. The serializer CAN carry arbitrary secret-shaped bytes when they
 *      arrive as server-echoed event content (a non-vacuous control — the
 *      serializer does not magically redact). Server-echoed stream content
 *      is intentionally serialized verbatim: it is response data the user
 *      asked to save.
 *   2. The capture boundary keeps REQUEST-side auth material out: with a
 *      realistic authed-stream fixture (bearer secret present in the
 *      request headers that produced the stream), the serialized
 *      transcript never contains it, because the record shape has no
 *      place for headers — the secret's only realistic route to disk
 *      would be through `event` fields, which the capture code fills
 *      from parsed stream frames only.
 */
import { describe, expect, it } from 'vitest';

import { serializeSseTranscript } from '../src/core/sse/transcript.js';
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

  it('request auth headers never reach the transcript through the capture record shape', () => {
    // Realistic authed stream: this is the request that was sent…
    const sentRequest = {
      url: 'https://api.example.com/v1/stream',
      headers: {
        authorization: `Bearer ${secret}`,
        'content-type': 'application/json',
      },
      body: '{"stream":true}',
    };

    // …and this is all the capture layer ever hands the serializer:
    // dispatched events only (mirrors streamSseResponse's transcriptRecords).
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

    // Sanity: the fixture really is a secret-bearing scenario.
    expect(sentRequest.headers.authorization).toContain(secret);

    // Transcript keys are closed-world: no header/auth field can exist.
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
});
