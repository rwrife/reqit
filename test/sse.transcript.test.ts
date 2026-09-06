import { describe, expect, it } from 'vitest';
import {
  buildSseTranscriptFileName,
  serializeSseTranscript,
} from '../src/core/sse/transcript.js';

describe('buildSseTranscriptFileName', () => {
  it('formats a UTC timestamp as sse-YYYYMMDD-HHMMSS.sse.jsonl', () => {
    const at = Date.UTC(2026, 8, 5, 15, 40, 7);
    expect(buildSseTranscriptFileName(at)).toBe('sse-20260905-154007.sse.jsonl');
  });
});

describe('serializeSseTranscript', () => {
  it('returns an empty string when no events were captured', () => {
    expect(serializeSseTranscript([])).toBe('');
  });

  it('emits JSONL rows in order and terminates with a newline', () => {
    const out = serializeSseTranscript([
      {
        event: { type: 'message', data: 'hello' },
        index: 0,
        timestampMs: 1_700_000_000_000,
      },
      {
        event: { type: 'delta', data: '{"ok":true}', lastEventId: 'abc', retry: 1500 },
        index: 1,
        timestampMs: 1_700_000_000_250,
      },
    ]);

    expect(out.endsWith('\n')).toBe(true);

    const lines = out.trimEnd().split('\n').map((line) => JSON.parse(line));
    expect(lines).toEqual([
      { i: 0, t: 1_700_000_000_000, type: 'message', data: 'hello' },
      {
        i: 1,
        t: 1_700_000_000_250,
        type: 'delta',
        data: '{"ok":true}',
        id: 'abc',
        retry: 1500,
      },
    ]);
  });
});
