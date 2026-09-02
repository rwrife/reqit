/**
 * Pure mapping from `.http` directives (as collected by `parseHttpFile`)
 * onto validated {@link SseTransportUserOptions}.
 *
 * Recognized directives (all optional):
 *   - `@sse-until <expr>`        — predicate expression; stops on match.
 *   - `@sse-max-events <n>`      — hard cap on dispatched events.
 *   - `@sse-max-duration-ms <n>` — hard wall-clock cap in ms.
 *   - `@sse-idle-ms <n>`         — idle-timeout cap in ms.
 *
 * Numeric directives must parse as positive integers; anything else is
 * surfaced as a diagnostic so the extension can show a red error strip
 * instead of silently dropping the value.
 *
 * No VS Code, no network, no undici — fully unit-testable.
 */
import {
  SseTransportUserOptionsSchema,
  type SseTransportUserOptions,
} from './transport.js';

export interface SseDirectiveDiagnostic {
  /** Directive key without the `@` (e.g. `sse-max-events`). */
  directive: string;
  /** Raw value as it appeared in the source. */
  value: string;
  /** Human-readable reason parsing failed. */
  message: string;
}

export interface SseDirectivesResult {
  /** Validated options to feed into {@link runSseTransport}. */
  options: SseTransportUserOptions;
  /** Per-directive parse errors. Options for bad entries are dropped. */
  diagnostics: SseDirectiveDiagnostic[];
}

const NUMERIC_KEYS: ReadonlyArray<{
  key: 'sse-max-events' | 'sse-max-duration-ms' | 'sse-idle-ms';
  target: keyof SseTransportUserOptions;
}> = [
  { key: 'sse-max-events', target: 'maxEvents' },
  { key: 'sse-max-duration-ms', target: 'maxDurationMs' },
  { key: 'sse-idle-ms', target: 'idleMs' },
];

function parsePositiveInt(raw: string): number | null {
  const trimmed = raw.trim();
  if (!/^\d+$/.test(trimmed)) return null;
  const n = Number.parseInt(trimmed, 10);
  if (!Number.isFinite(n) || n <= 0) return null;
  return n;
}

/**
 * Extract SSE-related options from the generic `directives` record on a
 * {@link ParsedRequest}. Unknown SSE-prefixed directives are ignored (they
 * will be surfaced by a future linter, not by this function).
 */
export function sseOptionsFromDirectives(
  directives: Readonly<Record<string, string>>,
): SseDirectivesResult {
  const diagnostics: SseDirectiveDiagnostic[] = [];
  const raw: Record<string, unknown> = {};

  const untilExpr = directives['sse-until'];
  if (untilExpr !== undefined) {
    const trimmed = untilExpr.trim();
    if (trimmed === '') {
      diagnostics.push({
        directive: 'sse-until',
        value: untilExpr,
        message: '@sse-until requires a non-empty expression',
      });
    } else {
      raw.until = trimmed;
    }
  }

  for (const { key, target } of NUMERIC_KEYS) {
    const value = directives[key];
    if (value === undefined) continue;
    const n = parsePositiveInt(value);
    if (n === null) {
      diagnostics.push({
        directive: key,
        value,
        message: `@${key} must be a positive integer, got: ${value}`,
      });
      continue;
    }
    raw[target] = n;
  }

  const parsed = SseTransportUserOptionsSchema.safeParse(raw);
  if (!parsed.success) {
    // Should be unreachable given the guards above, but surface anyway so
    // future contributors aren't left staring at a silent drop.
    for (const issue of parsed.error.issues) {
      diagnostics.push({
        directive: String(issue.path[0] ?? 'sse'),
        value: '',
        message: issue.message,
      });
    }
    return { options: {}, diagnostics };
  }
  return { options: parsed.data, diagnostics };
}

/**
 * True when the response headers indicate a Server-Sent Events stream.
 * Matches `text/event-stream` with any parameters (`; charset=utf-8`).
 * Header names are compared case-insensitively.
 */
export function isSseResponse(
  headers: Readonly<Record<string, string | string[] | undefined>>,
): boolean {
  for (const [k, v] of Object.entries(headers)) {
    if (k.toLowerCase() !== 'content-type') continue;
    const value = Array.isArray(v) ? v.join(', ') : String(v ?? '');
    if (/^\s*text\/event-stream(\s*;.*)?$/i.test(value)) return true;
  }
  return false;
}
