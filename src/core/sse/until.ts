/**
 * Pure predicate evaluator for the `# @sse-until <expr>` directive.
 *
 * When streaming a `text/event-stream` response, users can attach a directive
 * such as:
 *
 *   # @sse-until event.data.done === true
 *   # @sse-until json.choices[0].finish_reason
 *   # @sse-until count >= 5
 *
 * The expression is a single-line JavaScript snippet. After each dispatched
 * SSE event, the runtime evaluates the expression against a frozen context
 * describing the event and stream-wide state. If it returns a truthy value,
 * the transport stops draining and closes the stream.
 *
 * Design mirrors `src/core/assertions.ts`:
 *
 *   - `new Function(...)` compilation. No `vm`, no `eval`.
 *   - Common global-escape names (`globalThis`, `process`, `require`,
 *     `Function`, `eval`, timers, `fetch`, ...) are shadowed to `undefined`.
 *   - Only a small allow-list of safe globals is exposed (`Math`, `JSON`,
 *     `Date`, plus primitive wrappers / `RegExp` / `parse*`).
 *   - Threat model: user's own workspace files. Best-effort defense-in-depth,
 *     not adversarial sandboxing.
 *   - No synchronous timeouts. Callers running truly untrusted content should
 *     evaluate in a worker.
 *
 * The evaluator is pure: no VS Code, no network, no I/O. Fully unit-testable.
 */
import { z } from 'zod';

import type { SseEvent } from './parser.js';

/** Stream-level context passed to every `@sse-until` evaluation. */
export interface SseUntilContext {
  /**
   * 0-based index of the current event within the stream (i.e. how many
   * events have been dispatched so far, including this one).
   */
  index: number;
  /** Wall-clock ms elapsed since the stream started. */
  elapsedMs: number;
  /**
   * Total count of events observed so far (== `index + 1`). Exposed as a
   * convenience binding named `count` so predicates read naturally
   * (`count >= 5`).
   */
  count: number;
}

/** Result of a single `@sse-until` evaluation. */
export interface SseUntilResult {
  /** The original expression source, trimmed. */
  expression: string;
  /** Truthy result → stream should stop. */
  matched: boolean;
  /** Raw value the expression returned (only set if it didn't throw). */
  value?: unknown;
  /** Error message if the expression threw or failed to compile. */
  error?: string;
}

/**
 * Optional zod schema for the (event, context) pair — mostly used to catch
 * programmer mistakes in refactors, not to gate untrusted input (SseEvent
 * itself is already validated by `SseEventSchema` upstream).
 */
export const SseUntilInputSchema = z.object({
  event: z.object({
    type: z.string().min(1),
    data: z.string(),
    lastEventId: z.string().optional(),
    retry: z.number().int().nonnegative().optional(),
  }),
  context: z.object({
    index: z.number().int().nonnegative(),
    elapsedMs: z.number().nonnegative(),
    count: z.number().int().positive(),
  }),
});

const SAFE_GLOBAL_NAMES = [
  'Math',
  'Date',
  'JSON',
  'Number',
  'String',
  'Boolean',
  'Array',
  'Object',
  'RegExp',
  'parseInt',
  'parseFloat',
  'isNaN',
  'isFinite',
] as const;

const SHADOWED_NAMES = [
  'globalThis',
  'global',
  'self',
  'window',
  'process',
  'require',
  'module',
  'exports',
  '__dirname',
  '__filename',
  'eval',
  'Function',
  'fetch',
  'setTimeout',
  'setInterval',
  'setImmediate',
  'queueMicrotask',
] as const;

/**
 * Try to parse `event.data` as JSON. Returns `undefined` on any parse
 * failure (blank data, non-JSON payloads, partial frames). Exposed to the
 * predicate as the `json` binding so LLM-streaming patterns like
 * `json.choices[0].finish_reason` "just work".
 */
function tryParseJson(data: string): unknown {
  const trimmed = data.trim();
  if (trimmed === '') return undefined;
  // Fast path: SSE JSON payloads almost always start with `{` or `[`, and the
  // OpenAI-style `data: [DONE]` sentinel is deliberately not JSON. Skip the
  // parser cost for obvious non-JSON to keep the hot loop cheap.
  const first = trimmed[0];
  if (first !== '{' && first !== '[' && first !== '"') return undefined;
  try {
    return JSON.parse(trimmed);
  } catch {
    return undefined;
  }
}

/**
 * Evaluate a single `@sse-until` expression against one dispatched event.
 *
 * @param expression Trimmed or untrimmed source of the predicate expression.
 * @param event      The just-dispatched `SseEvent`.
 * @param context    Stream-level bookkeeping (index, elapsedMs, count).
 * @returns          `matched: true` if the predicate returned a truthy value
 *                   and the caller should stop the stream.
 */
export function evaluateSseUntil(
  expression: string,
  event: SseEvent,
  context: SseUntilContext,
): SseUntilResult {
  const expr = expression.trim();
  if (expr === '') {
    return { expression: expr, matched: false, error: 'empty expression' };
  }

  const paramNames = [
    ...SHADOWED_NAMES,
    ...SAFE_GLOBAL_NAMES,
    'event',
    'data',
    'text',
    'json',
    'type',
    'id',
    'retry',
    'index',
    'elapsedMs',
    'count',
  ];

  let fn: (...args: unknown[]) => unknown;
  try {
    // eslint-disable-next-line @typescript-eslint/no-implied-eval
    fn = new Function(...paramNames, `return (${expr});`) as (
      ...args: unknown[]
    ) => unknown;
  } catch (e) {
    return {
      expression: expr,
      matched: false,
      error: `compile error: ${(e as Error).message}`,
    };
  }

  const shadowed = SHADOWED_NAMES.map(() => undefined);
  const safeGlobals: unknown[] = [
    Math,
    Date,
    JSON,
    Number,
    String,
    Boolean,
    Array,
    Object,
    RegExp,
    parseInt,
    parseFloat,
    isNaN,
    isFinite,
  ];

  const json = tryParseJson(event.data);
  // Freeze the event view so predicates can't mutate shared state between
  // evaluations (e.g. two `@sse-until` predicates on the same stream).
  const eventView = Object.freeze({
    type: event.type,
    data: event.data,
    id: event.lastEventId,
    retry: event.retry,
    json,
  });

  const bindings: unknown[] = [
    eventView,
    event.data,
    event.data, // `text` alias for `data`
    json,
    event.type,
    event.lastEventId,
    event.retry,
    context.index,
    context.elapsedMs,
    context.count,
  ];

  try {
    const value = fn(...shadowed, ...safeGlobals, ...bindings);
    return { expression: expr, matched: Boolean(value), value };
  } catch (e) {
    return {
      expression: expr,
      matched: false,
      error: (e as Error).message,
    };
  }
}

/**
 * Stateful helper wrapping {@link evaluateSseUntil} for the common case
 * where a single predicate is applied to a live stream. Maintains the
 * event counter and elapsed-time clock so callers only need to feed
 * events as they arrive.
 *
 * Usage:
 *
 * ```ts
 * const gate = new SseUntilGate('event.data.done === true');
 * for await (const ev of sseEvents) {
 *   const r = gate.test(ev);
 *   if (r.error) console.warn('@sse-until:', r.error);
 *   if (r.matched) break;
 * }
 * ```
 */
export class SseUntilGate {
  private readonly expression: string;
  private readonly startedAt: number;
  private readonly now: () => number;
  private eventCount = 0;
  private stopped = false;
  private lastError: string | undefined;

  /**
   * @param expression The `@sse-until` predicate source (as written in the
   *                   `.http` directive; leading/trailing whitespace ok).
   * @param options.now Injectable clock for deterministic tests. Defaults
   *                   to `Date.now`.
   */
  constructor(expression: string, options: { now?: () => number } = {}) {
    this.expression = expression;
    this.now = options.now ?? Date.now;
    this.startedAt = this.now();
  }

  /** Number of events fed through {@link test} so far. */
  get count(): number {
    return this.eventCount;
  }

  /** `true` once a predicate evaluation has returned truthy. */
  get isStopped(): boolean {
    return this.stopped;
  }

  /** Last compile/runtime error message, if any (does NOT stop the gate). */
  get error(): string | undefined {
    return this.lastError;
  }

  /**
   * Evaluate the predicate against a newly dispatched event. Errors are
   * captured on the gate (`gate.error`) but never cause `matched: true`
   * on their own — a broken predicate must not silently truncate a stream.
   */
  test(event: SseEvent): SseUntilResult {
    if (this.stopped) {
      return {
        expression: this.expression.trim(),
        matched: true,
        value: true,
      };
    }
    const index = this.eventCount;
    this.eventCount += 1;
    const result = evaluateSseUntil(this.expression, event, {
      index,
      elapsedMs: this.now() - this.startedAt,
      count: this.eventCount,
    });
    if (result.error) this.lastError = result.error;
    if (result.matched) this.stopped = true;
    return result;
  }
}
