import type { SseEvent } from './parser.js';
import { formatSseTranscriptLine } from './transport.js';

export interface SseTranscriptRecord {
  event: SseEvent;
  index: number;
  timestampMs: number;
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
