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
  | 'idle-timeout'
  | 'reconnect-limit';

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

export interface SseReconnectConnectContext {
  attempt: number;
  reconnect: Readonly<SseReconnectState>;
  headers: Readonly<Record<string, string>>;
}

export interface SseTransportWithReconnectOptions
  extends Omit<SseTransportOptions, 'input' | 'reconnect'> {
  connect: (ctx: SseReconnectConnectContext) => Promise<AsyncIterable<string>>;
  reconnect?: SseReconnectState;
  maxReconnects?: number;
  sleep?: (ms: number) => Promise<void>;
}

export interface SseTransportWithReconnectResult extends SseTransportResult {
  attempts: number;
  reconnectCount: number;
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
 * Race a backoff sleep against an AbortSignal so a parked reconnect wait
 * resolves immediately when the user stops the stream, instead of keeping
 * the driver (and the "streaming" UI state) alive for the full delay.
 */
const SSE_ABORTED_SLEEP = Symbol('sse-aborted-sleep');

async function sleepOrAbort(
  sleepPromise: Promise<void>,
  signal?: AbortSignal,
): Promise<void | typeof SSE_ABORTED_SLEEP> {
  if (!signal) return sleepPromise;
  if (signal.aborted) {
    // The sleep promise was already constructed by the caller; keep its
    // rejection observed (e.g. an injected sleep that rejects synchronously
    // while aborting) instead of surfacing an unhandled rejection.
    sleepPromise.catch(() => {});
    return SSE_ABORTED_SLEEP;
  }
  return new Promise((resolve, reject) => {
    const onAbort = (): void => {
      cleanup();
      resolve(SSE_ABORTED_SLEEP);
    };
    const cleanup = (): void => {
      signal.removeEventListener('abort', onAbort);
    };
    signal.addEventListener('abort', onAbort, { once: true });
    sleepPromise.then(
      () => {
        cleanup();
        resolve(undefined);
      },
      (err) => {
        cleanup();
        reject(err);
      },
    );
  });
}

/**
 * Race a reconnect connection attempt against an AbortSignal so a pending
 * `connect()` cannot outlive a stop. When the signal aborts first, the
 * late-resolving input is closed defensively by the caller and never
 * driven, so a stopped stream cannot emit late events or surface a late
 * connect error as a failure.
 */
const SSE_ABORTED_CONNECT = Symbol('sse-aborted-connect');

async function raceWithAbort<T>(
  promise: Promise<T>,
  signal?: AbortSignal,
): Promise<T | typeof SSE_ABORTED_CONNECT> {
  if (!signal) return promise;
  if (signal.aborted) return SSE_ABORTED_CONNECT;
  return new Promise((resolve, reject) => {
    const onAbort = (): void => {
      cleanup();
      resolve(SSE_ABORTED_CONNECT);
    };
    const cleanup = (): void => {
      signal.removeEventListener('abort', onAbort);
    };
    signal.addEventListener('abort', onAbort, { once: true });
    promise.then(
      (value) => {
        cleanup();
        resolve(value);
      },
      (err) => {
        cleanup();
        reject(err);
      },
    );
  });
}

/**
 * Best-effort close of an async input that was abandoned after a stop
 * (e.g. a reconnect body whose request resolved late). Never throws.
 */
async function closeLateInput(input: AsyncIterable<string>): Promise<void> {
  try {
    const it = input[Symbol.asyncIterator]?.();
    await it?.return?.();
  } catch {
    // Resource already gone or close unsupported — nothing to release.
  }
}

/**
 * Race a pending iterator step against an AbortSignal so a stalled
 * connection (no chunks arriving) can still be cancelled. When the signal
 * aborts first, the pending step is abandoned and never dispatched —
 * late chunks cannot produce late events.
 */
const SSE_ABORTED_STEP = Symbol('sse-aborted-step');

async function nextChunkOrAbort(
  iterator: AsyncIterator<string>,
  signal?: AbortSignal,
): Promise<IteratorResult<string> | typeof SSE_ABORTED_STEP> {
  if (!signal) return iterator.next();
  if (signal.aborted) return SSE_ABORTED_STEP;
  return new Promise((resolve, reject) => {
    const onAbort = (): void => {
      cleanup();
      resolve(SSE_ABORTED_STEP);
    };
    const cleanup = (): void => {
      signal.removeEventListener('abort', onAbort);
    };
    signal.addEventListener('abort', onAbort, { once: true });
    iterator.next().then(
      (step) => {
        cleanup();
        resolve(step);
      },
      (err) => {
        cleanup();
        // Genuine iterator failures propagate like `for await` would.
        // After an abort the promise is already settled, so a rejection
        // from a caller-destroyed body is absorbed here instead of
        // surfacing as an unhandled rejection.
        reject(err);
      },
    );
  });
}

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
  const inputIterator = options.input[Symbol.asyncIterator]();
  const gate = options.until ? new SseUntilGate(options.until, { now }) : undefined;

  let eventCount = 0;
  let lastEventAt = startedAt;
  let stopReason: SseStopReason | undefined;
  let exhaustedNormally = false;

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

  try {
    outer: for (;;) {
      if (options.signal?.aborted) {
        stopReason = 'aborted';
        break;
      }
      const step = await nextChunkOrAbort(inputIterator, options.signal);
      if (step === SSE_ABORTED_STEP) {
        // The user stopped the stream while we were parked waiting for the
        // next chunk; any late-arriving chunk is intentionally abandoned.
        stopReason = 'aborted';
        break outer;
      }
      if (step.done) {
        exhaustedNormally = true;
        break;
      }
      parser.push(step.value);
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
  } finally {
    // Replicate `for await` iterator-close semantics precisely: the
    // iterator is closed ONLY when the loop exits early (abort, caps,
    // until-match) or with an exception (thrown callback/parser error),
    // never after normal exhaustion — a normally-finished resource has
    // already released itself, and a spurious return() could double-close
    // non-idempotent inputs. Cleanup errors never replace the primary
    // error or stop reason.
    if (!exhaustedNormally) {
      try {
        await inputIterator.return?.();
      } catch {
        // Cleanup failure never masks the primary outcome.
      }
    }
  }

  return {
    reason: stopReason,
    eventCount,
    durationMs: now() - startedAt,
    reconnect,
    untilError: gate?.error,
  };
}

export async function runSseTransportWithReconnect(
  options: SseTransportWithReconnectOptions,
): Promise<SseTransportWithReconnectResult> {
  const now = options.now ?? Date.now;
  const reconnect: SseReconnectState = options.reconnect ?? {
    lastEventId: undefined,
    retryMs: undefined,
  };
  const maxReconnects = options.maxReconnects ?? 5;
  const sleep =
    options.sleep ??
    ((ms: number) =>
      new Promise<void>((resolve) => {
        setTimeout(resolve, ms);
      }));
  let attempts = 0;
  let reconnectCount = 0;
  let totalEvents = 0;
  const startedAt = now();
  let untilError: string | undefined;

  while (attempts <= maxReconnects) {
    // Never start (or keep waiting on) a connection once stopped: check
    // for a pre-aborted signal, and race an in-flight connect() against
    // the signal so a hanging reconnect request cannot outlive the stop.
    if (options.signal?.aborted) {
      return {
        reason: 'aborted',
        eventCount: totalEvents,
        durationMs: now() - startedAt,
        reconnect,
        attempts,
        reconnectCount,
        ...(untilError !== undefined ? { untilError } : {}),
      };
    }
    const connectPromise = options.connect({
      attempt: attempts,
      reconnect,
      headers: reconnectHeaders(reconnect),
    });
    const connectOutcome = await raceWithAbort(connectPromise, options.signal);
    if (connectOutcome === SSE_ABORTED_CONNECT) {
      // The reconnect request is still pending; the caller's adapter owns
      // its cancellation (e.g. via the abort signal passed to undici).
      // Suppress the late result instead of surfacing it as an error.
      void connectPromise.then(
        async (late) => {
          await closeLateInput(late);
        },
        () => {
          // Late connect failures after a stop are intentionally dropped.
        },
      );
      return {
        reason: 'aborted',
        eventCount: totalEvents,
        durationMs: now() - startedAt,
        reconnect,
        attempts,
        reconnectCount,
        ...(untilError !== undefined ? { untilError } : {}),
      };
    }
    const input = connectOutcome;
    attempts += 1;

    const result = await runSseTransport({
      input,
      onEvent: options.onEvent,
      ...(options.until !== undefined ? { until: options.until } : {}),
      ...(options.maxEvents !== undefined ? { maxEvents: options.maxEvents } : {}),
      ...(options.maxDurationMs !== undefined
        ? { maxDurationMs: options.maxDurationMs }
        : {}),
      ...(options.idleMs !== undefined ? { idleMs: options.idleMs } : {}),
      ...(options.signal !== undefined ? { signal: options.signal } : {}),
      reconnect,
      ...(options.now !== undefined ? { now: options.now } : {}),
    });

    totalEvents += result.eventCount;
    untilError = result.untilError;

    if (result.reason !== 'end-of-stream') {
      return {
        ...result,
        eventCount: totalEvents,
        durationMs: now() - startedAt,
        attempts,
        reconnectCount,
        ...(untilError !== undefined ? { untilError } : {}),
      };
    }

    if (options.signal?.aborted) {
      return {
        ...result,
        reason: 'aborted',
        eventCount: totalEvents,
        durationMs: now() - startedAt,
        attempts,
        reconnectCount,
        ...(untilError !== undefined ? { untilError } : {}),
      };
    }

    if (reconnectCount >= maxReconnects) {
      return {
        ...result,
        reason: 'reconnect-limit',
        eventCount: totalEvents,
        durationMs: now() - startedAt,
        attempts,
        reconnectCount,
        ...(untilError !== undefined ? { untilError } : {}),
      };
    }

    reconnectCount += 1;
    const sleepMs = clampRetryMs(reconnect.retryMs);
    await sleepOrAbort(sleep(sleepMs), options.signal);
    if (options.signal?.aborted) {
      return {
        ...result,
        reason: 'aborted',
        eventCount: totalEvents,
        durationMs: now() - startedAt,
        attempts,
        reconnectCount,
        ...(untilError !== undefined ? { untilError } : {}),
      };
    }
  }

  throw new Error('SSE reconnect loop exhausted unexpectedly');
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
