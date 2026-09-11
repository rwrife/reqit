import type { SseEvent } from './parser.js';
import { formatSseTranscriptLine } from './transport.js';

export interface SseTranscriptRecord {
  event: SseEvent;
  index: number;
  timestampMs: number;
}

/**
 * THE capture boundary used by every production driver (extension host,
 * future CLI/MCP): builds a transcript record from a dispatched event via
 * an explicit allowlist. Anything ELSE that happens to be in scope at the
 * call site — request headers, auth material, URLs with credentials — is
 * structurally incapable of entering a record, because only these three
 * fields are copied. Extra input properties are dropped, not merged.
 */
export function pickSseTranscriptRecord(input: {
  event: SseEvent;
  index: number;
  timestampMs: number;
  [extra: string]: unknown;
}): SseTranscriptRecord {
  const e = input.event;
  return {
    event: {
      type: e.type,
      data: e.data,
      ...(e.lastEventId !== undefined ? { lastEventId: e.lastEventId } : {}),
      ...(typeof e.retry === 'number' ? { retry: e.retry } : {}),
    },
    index: input.index,
    timestampMs: input.timestampMs,
  };
}

function pad2(value: number): string {
  return value.toString().padStart(2, '0');
}

/**
 * Build a deterministic default basename for an SSE transcript file.
 *
 * Example: `sse-20260905-154007.sse.jsonl`
 */
export function buildSseTranscriptFileName(atMs: number): string {
  const date = new Date(atMs);
  const y = date.getUTCFullYear();
  const m = pad2(date.getUTCMonth() + 1);
  const d = pad2(date.getUTCDate());
  const hh = pad2(date.getUTCHours());
  const mm = pad2(date.getUTCMinutes());
  const ss = pad2(date.getUTCSeconds());
  return `sse-${y}${m}${d}-${hh}${mm}${ss}.sse.jsonl`;
}

/**
 * Serialize captured SSE records to the on-disk transcript format.
 *
 * One compact JSON object per line (`.sse.jsonl`). Returns an empty string
 * when no records exist.
 */
export function serializeSseTranscript(records: readonly SseTranscriptRecord[]): string {
  if (records.length === 0) return '';
  const lines = records.map((record) =>
    formatSseTranscriptLine(record.event, {
      index: record.index,
      timestamp: record.timestampMs,
    }),
  );
  return `${lines.join('\n')}\n`;
}
