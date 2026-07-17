/**
 * Pure SSE transport driver. Turns an async iterable of decoded string chunks
 * (as produced by, e.g., undici's `body.setEncoding('utf-8')` or a Node
 * `TextDecoderStream`-backed pipe) into a stream of dispatched
 * {@link SseEvent}s, applying an optional `@sse-until` predicate, event-count
 * / duration / idle timeout guards, and tracking the reconnect state a
 * caller needs to open the next connection.
 *
 * This module deliberately has **no** VS Code, `undici`, or DOM
 * dependencies. It is fully unit-testable against a hand-rolled async
 * iterable. The VS Code / undici integration lives one layer up in
 * `src/extension/` and wires:
 *
 *   - `text/event-stream` detection on the response,
 *   - a `for await` loop over `body.setEncoding('utf-8')`,
 *   - reconnect logic driven by {@link SseReconnectState},
 *   - the response webview shovel.
 *
 * ## Stop conditions
 *
 * The driver stops draining as soon as any of the following becomes true:
 *
 *   - `signal.aborted` (user hit "Stop stream")
 *   - the `@sse-until` predicate matches
 *   - `maxEvents` events have been dispatched
 *   - `maxDurationMs` has elapsed since the driver started
 *   - `idleMs` has elapsed since the last dispatched event (approximate:
 *     enforced on the next chunk boundary, not via a wall-clock timer here —
 *     the caller can layer `AbortSignal.timeout(idleMs)` on the socket if
 *     stricter behavior is needed)
 *
 * ## Reconnect state
 *
 * The driver exposes an {@link SseReconnectState} that captures the last
 * seen `id:` (for the next connection's `Last-Event-ID` header) and the
 * last valid `retry:` interval. It survives a single call to
 * {@link runSseTransport}; the caller re-passes it on the next attempt.
 * The driver itself does NOT open sockets or sleep — the caller owns the
 * network side.
 */
import { z } from 'zod';

import { SseParser, type SseEvent } from './parser.js';
import { SseUntilGate } from './until.js';

/** Reason the transport stopped draining. */
export type SseStopReason =
  | 'end-of-stream'
  | 'aborted'
  | 'until-matched'
  | 'max-events'
  | 'max-duration'
  | 'idle-timeout';

/**
 * Persistent reconnect state carried across connection attempts. The
 * driver only reads/writes these fields — it never opens sockets.
 */
export interface SseReconnectState {
  /**
   * Last non-nullish `id:` seen on the stream so far. The caller sends
   * this as `Last-Event-ID: <value>` on the next reconnect attempt.
   */
  lastEventId: string | undefined;
  /**
   * Last valid `retry:` value (ms). Servers use this to suggest a
   * reconnection interval; callers should honor it as a lower bound,
   * clamped to something sane (a few ms .. tens of seconds).
   */
  retryMs: number | undefined;
}

/** Options for {@link runSseTransport}. */
export interface SseTransportOptions {
  /** Async iterable of decoded string chunks. UTF-8 already applied. */
  input: AsyncIterable<string>;
  /** Called for every dispatched event, in order. */
  onEvent: (event: SseEvent, meta: SseEventMeta) => void | Promise<void>;
  /**
   * Optional `@sse-until` predicate expression. When the predicate matches,
   * the driver stops and returns `{ reason: 'until-matched' }`.
   */
  until?: string;
  /** Cap total dispatched events. Default: unlimited. */
  maxEvents?: number;
  /** Cap total wall-clock duration in ms. Default: unlimited. */
  maxDurationMs?: number;
  /**
   * Idle timeout in ms since the last dispatched event, checked on each
   * chunk boundary. Default: unlimited.
   */
  idleMs?: number;
  /** External stop signal (e.g. user clicked "Stop stream"). */
  signal?: AbortSignal;
  /**
   * Reconnect state to hydrate + update. If omitted, a fresh one is
   * created and returned in the result.
   */
  reconnect?: SseReconnectState;
  /** Injectable clock for deterministic tests. Defaults to `Date.now`. */
  now?: () => number;
}

/** Per-event metadata surfaced to `onEvent` callbacks. */
export interface SseEventMeta {
  /** 0-based index within this run. */
  index: number;
  /** Milliseconds since the driver started. */
  elapsedMs: number;
  /** Snapshot of reconnect state after this event was consumed. */
  reconnect: Readonly<SseReconnectState>;
}

/** Terminal result of one driver run. */
export interface SseTransportResult {
  reason: SseStopReason;
  eventCount: number;
  durationMs: number;
  reconnect: SseReconnectState;
  /** `@sse-until` compile/runtime error, if any (does not force stop). */
  untilError?: string;
}

/**
 * Zod schema for {@link SseTransportOptions} — used to validate options
 * that came from user data (e.g. `.http` directives) before we drive an
 * async iterable with them. `input`, `onEvent`, `signal`, and `now` are
 * runtime values and validated structurally instead.
 */
export const SseTransportUserOptionsSchema = z
  .object({
    until: z.string().min(1).optional(),
    maxEvents: z.number().int().positive().optional(),
    maxDurationMs: z.number().int().positive().optional(),
    idleMs: z.number().int().positive().optional(),
  })
  .strict();

export type SseTransportUserOptions = z.infer<typeof SseTransportUserOptionsSchema>;

/**
 * Drive an SSE stream to completion (or to the first stop condition).
 *
 * @returns A {@link SseTransportResult} describing why the driver stopped
 *          and the reconnect state to use for the next attempt.
 */
export async function runSseTransport(
  options: SseTransportOptions,
): Promise<SseTransportResult> {
  const now = options.now ?? Date.now;
  const startedAt = now();
  const reconnect: SseReconnectState = options.reconnect ?? {
    lastEventId: undefined,
    retryMs: undefined,
  };
  const parser = new SseParser();
  const gate = options.until ? new SseUntilGate(options.until, { now }) : undefined;

  let eventCount = 0;
  let lastEventAt = startedAt;
  let stopReason: SseStopReason | undefined;

  // (Time caps are enforced inside flushDispatched between events.)
  void 0;

  const flushDispatched = async (): Promise<SseStopReason | undefined> => {
    const events = parser.drain();
    for (const event of events) {
      // Check time/abort caps between events so a chunk that carried
      // multiple frames doesn't blast past a stop condition.
      if (options.signal?.aborted) return 'aborted';
      if (
        options.maxDurationMs !== undefined &&
        now() - startedAt >= options.maxDurationMs
      ) {
        return 'max-duration';
      }
      if (options.idleMs !== undefined && now() - lastEventAt >= options.idleMs) {
        return 'idle-timeout';
      }

      if (event.lastEventId !== undefined) reconnect.lastEventId = event.lastEventId;
      if (typeof event.retry === 'number') reconnect.retryMs = event.retry;

      const index = eventCount;
      eventCount += 1;
      lastEventAt = now();

      await options.onEvent(event, {
        index,
        elapsedMs: lastEventAt - startedAt,
        reconnect: { ...reconnect },
      });

      if (gate) {
        const r = gate.test(event);
        if (r.matched) return 'until-matched';
      }
      if (options.maxEvents !== undefined && eventCount >= options.maxEvents) {
        return 'max-events';
      }
      if (options.signal?.aborted) return 'aborted';
    }
    return undefined;
  };

  outer: for await (const chunk of options.input) {
    if (options.signal?.aborted) {
      stopReason = 'aborted';
      break;
    }
    parser.push(chunk);
    const reason = await flushDispatched();
    if (reason) {
      stopReason = reason;
      break outer;
    }
  }

  if (stopReason === undefined) {
    parser.end();
    const reason = await flushDispatched();
    stopReason = reason ?? (options.signal?.aborted ? 'aborted' : 'end-of-stream');
  }

  return {
    reason: stopReason,
    eventCount,
    durationMs: now() - startedAt,
    reconnect,
    untilError: gate?.error,
  };
}

/**
 * Serialize an SSE event into one line of the on-disk transcript format
 * (`.sse.jsonl`). One JSON object per line; safe to `tail -f`.
 *
 * The format is intentionally minimal and additive — new fields may be
 * added in future versions, so consumers should tolerate unknown keys.
 * Never includes auth material; the caller is responsible for not
 * plumbing secrets into `event.data`.
 */
export function formatSseTranscriptLine(
  event: SseEvent,
  meta: { index: number; timestamp: number },
): string {
  const record: Record<string, unknown> = {
    i: meta.index,
    t: meta.timestamp,
    type: event.type,
    data: event.data,
  };
  if (event.lastEventId !== undefined) record.id = event.lastEventId;
  if (typeof event.retry === 'number') record.retry = event.retry;
  return JSON.stringify(record);
}

/**
 * Build the `Last-Event-ID` header value for the next reconnect attempt,
 * or `undefined` if none should be sent. Per spec, `Last-Event-ID` must
 * be omitted (not sent as empty) when no id has been observed yet.
 */
export function reconnectHeaders(state: Readonly<SseReconnectState>): Record<string, string> {
  const headers: Record<string, string> = {};
  if (typeof state.lastEventId === 'string' && state.lastEventId.length > 0) {
    headers['Last-Event-ID'] = state.lastEventId;
  }
  return headers;
}

/**
 * Clamp a server-suggested `retry:` interval into a sane range. Defaults
 * bound the caller to at most a 30s backoff and at least 100ms. Servers
 * occasionally send absurd values (0, or several minutes); we don't want
 * either extreme to freeze the reconnect loop.
 */
export function clampRetryMs(
  suggested: number | undefined,
  fallback = 3_000,
  min = 100,
  max = 30_000,
): number {
  const v =
    typeof suggested === 'number' && Number.isFinite(suggested) && suggested > 0
      ? suggested
      : fallback;
  return Math.min(max, Math.max(min, v));
}
