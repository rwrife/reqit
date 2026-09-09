import { describe, expect, it } from 'vitest';
import {
  runSseTransport,
  runSseTransportWithReconnect,
  formatSseTranscriptLine,
  reconnectHeaders,
  clampRetryMs,
  SseTransportUserOptionsSchema,
  type SseEvent,
  type SseReconnectState,
} from '../src/core/sse/index.js';

/** Build an async iterable that yields the given chunks synchronously. */
function iter(chunks: string[]): AsyncIterable<string> {
  return {
    async *[Symbol.asyncIterator]() {
      for (const c of chunks) yield c;
    },
  };
}

/** Deferred-controlled async iterable, useful for interleaving stop conditions. */
class Pushable implements AsyncIterable<string> {
  private queue: string[] = [];
  private waiters: Array<(v: IteratorResult<string>) => void> = [];
  private done = false;
  push(chunk: string) {
    if (this.waiters.length) {
      const w = this.waiters.shift()!;
      w({ value: chunk, done: false });
    } else {
      this.queue.push(chunk);
    }
  }
  end() {
    this.done = true;
    while (this.waiters.length) {
      const w = this.waiters.shift()!;
      w({ value: undefined as unknown as string, done: true });
    }
  }
  [Symbol.asyncIterator](): AsyncIterator<string> {
    return {
      next: () => {
        if (this.queue.length) {
          return Promise.resolve({ value: this.queue.shift()!, done: false });
        }
        if (this.done) {
          return Promise.resolve({ value: undefined as unknown as string, done: true });
        }
        return new Promise((res) => this.waiters.push(res));
      },
    };
  }
}

describe('runSseTransport — happy paths', () => {
  it('drives a whole SSE payload through onEvent in order', async () => {
    const seen: SseEvent[] = [];
    const result = await runSseTransport({
      input: iter([
        'event: ping\ndata: 1\n\n',
        'event: pong\ndata: 2\nid: abc\n\n',
      ]),
      onEvent: (e) => {
        seen.push(e);
      },
    });
    expect(seen).toEqual([
      { type: 'ping', data: '1' },
      { type: 'pong', data: '2', lastEventId: 'abc' },
    ]);
    expect(result.reason).toBe('end-of-stream');
    expect(result.eventCount).toBe(2);
    expect(result.reconnect.lastEventId).toBe('abc');
  });

  it('handles chunk boundaries mid-frame', async () => {
    const seen: string[] = [];
    const result = await runSseTransport({
      input: iter(['data: hel', 'lo\n', '\ndata: wo', 'rld\n\n']),
      onEvent: (e) => {
        seen.push(e.data);
      },
    });
    expect(seen).toEqual(['hello', 'world']);
    expect(result.eventCount).toBe(2);
    expect(result.reason).toBe('end-of-stream');
  });

  it('tracks retry: into reconnect state', async () => {
    const state: SseReconnectState = { lastEventId: undefined, retryMs: undefined };
    const result = await runSseTransport({
      input: iter(['retry: 2500\ndata: x\n\n']),
      onEvent: () => {},
      reconnect: state,
    });
    expect(result.reconnect.retryMs).toBe(2500);
    expect(state.retryMs).toBe(2500);
  });

  it('carries reconnect state in the per-event meta', async () => {
    const metas: Array<{ index: number; lastEventId?: string }> = [];
    await runSseTransport({
      input: iter(['id: 1\ndata: a\n\n', 'id: 2\ndata: b\n\n']),
      onEvent: (_e, meta) => {
        metas.push({ index: meta.index, lastEventId: meta.reconnect.lastEventId });
      },
    });
    expect(metas).toEqual([
      { index: 0, lastEventId: '1' },
      { index: 1, lastEventId: '2' },
    ]);
  });
});

describe('runSseTransport — stop conditions', () => {
  it('stops on @sse-until match, without dispatching further events from the same chunk', async () => {
    const seen: string[] = [];
    const result = await runSseTransport({
      input: iter(['data: a\n\ndata: b\n\ndata: c\n\n']),
      onEvent: (e) => {
        seen.push(e.data);
      },
      until: 'event.data === "b"',
    });
    expect(result.reason).toBe('until-matched');
    // Event `b` is delivered to onEvent (predicate runs after dispatch),
    // but `c` must NOT be, even though it was in the same chunk.
    expect(seen).toEqual(['a', 'b']);
  });

  it('stops on maxEvents', async () => {
    const seen: string[] = [];
    const result = await runSseTransport({
      input: iter(['data: 1\n\ndata: 2\n\ndata: 3\n\n']),
      onEvent: (e) => {
        seen.push(e.data);
      },
      maxEvents: 2,
    });
    expect(result.reason).toBe('max-events');
    expect(seen).toEqual(['1', '2']);
    expect(result.eventCount).toBe(2);
  });

  it('stops on maxDurationMs using an injected clock', async () => {
    let t = 1000;
    const now = () => t;
    const pushable = new Pushable();
    const seen: string[] = [];
    const p = runSseTransport({
      input: pushable,
      onEvent: (e) => {
        seen.push(e.data);
      },
      maxDurationMs: 50,
      now,
    });
    pushable.push('data: a\n\n');
    // Let the driver dispatch 'a' before we bump the clock.
    await new Promise((r) => setImmediate(r));
    // Bump the clock past maxDurationMs before the next chunk lands.
    t = 2000;
    pushable.push('data: b\n\n');
    pushable.end();
    const result = await p;
    expect(result.reason).toBe('max-duration');
    // 'a' was delivered before the clock jumped; 'b' must not be.
    expect(seen).toEqual(['a']);
  });

  it('stops on idleMs using an injected clock', async () => {
    let t = 0;
    const now = () => t;
    const pushable = new Pushable();
    const seen: string[] = [];
    const p = runSseTransport({
      input: pushable,
      onEvent: (e) => {
        seen.push(e.data);
      },
      idleMs: 100,
      now,
    });
    pushable.push('data: a\n\n');
    // Yield so the driver dispatches 'a' at t=0 (lastEventAt=0).
    await new Promise((r) => setImmediate(r));
    // Simulate a big idle gap before the next chunk arrives.
    t = 10_000;
    pushable.push('data: b\n\n');
    pushable.end();
    const result = await p;
    expect(result.reason).toBe('idle-timeout');
    expect(seen).toEqual(['a']);
  });

  it('honors an aborted signal', async () => {
    const ctrl = new AbortController();
    const seen: string[] = [];
    const pushable = new Pushable();
    const p = runSseTransport({
      input: pushable,
      onEvent: (e) => {
        seen.push(e.data);
        if (e.data === 'a') ctrl.abort();
      },
      signal: ctrl.signal,
    });
    pushable.push('data: a\n\ndata: b\n\n');
    pushable.end();
    const result = await p;
    expect(result.reason).toBe('aborted');
    expect(seen).toEqual(['a']);
  });

  it('captures @sse-until compile errors without matching', async () => {
    const seen: string[] = [];
    const result = await runSseTransport({
      input: iter(['data: a\n\ndata: b\n\n']),
      onEvent: (e) => {
        seen.push(e.data);
      },
      until: 'this is not valid js @@@',
    });
    expect(result.reason).toBe('end-of-stream');
    expect(seen).toEqual(['a', 'b']);
    expect(result.untilError).toBeTruthy();
  });
});

describe('runSseTransport — iterator cleanup', () => {
  /** Iterable that records next()/return() calls. */
  function trackedIter(chunks: string[]): AsyncIterable<string> & {
    closed: boolean;
  } {
    const state = { closed: false };
    return Object.assign(state, {
      async *[Symbol.asyncIterator]() {
        try {
          for (const c of chunks) yield c;
        } finally {
          state.closed = true;
        }
      },
    });
  }

  it('closes the input iterator when stopped by maxEvents', async () => {
    const input = trackedIter(['data: a\n\n', 'data: b\n\n', 'data: c\n\n']);
    const result = await runSseTransport({
      input,
      onEvent: () => {},
      maxEvents: 1,
    });
    expect(result.reason).toBe('max-events');
    expect(input.closed).toBe(true);
  });

  it('closes the input iterator when stopped by abort', async () => {
    const controller = new AbortController();
    const input = trackedIter(['data: a\n\n', 'data: b\n\n']);
    const result = await runSseTransport({
      input,
      onEvent: () => {
        controller.abort();
      },
      signal: controller.signal,
    });
    expect(result.reason).toBe('aborted');
    expect(input.closed).toBe(true);
  });

  it('closes the input iterator when stopped by until-match', async () => {
    const input = trackedIter(['data: a\n\n', 'data: stop\n\n', 'data: c\n\n']);
    const result = await runSseTransport({
      input,
      onEvent: () => {},
      until: 'event.data === "stop"',
    });
    expect(result.reason).toBe('until-matched');
    expect(input.closed).toBe(true);
  });

  it('closes the input iterator when the event callback throws', async () => {
    const input = trackedIter(['data: a\n\n', 'data: b\n\n']);
    await expect(
      runSseTransport({
        input,
        onEvent: () => {
          throw new Error('boom');
        },
      }),
    ).rejects.toThrow('boom');
    expect(input.closed).toBe(true);
  });

  it('does NOT call return() after normal iterator exhaustion (for-await semantics)', async () => {
    let returnCalls = 0;
    const chunks = ['data: a\n\n'];
    let i = 0;
    const input: AsyncIterable<string> = {
      [Symbol.asyncIterator]() {
        return {
          next: async (): Promise<IteratorResult<string>> =>
            i < chunks.length
              ? { value: chunks[i++], done: false }
              : { value: undefined as unknown as string, done: true },
          return: async (): Promise<IteratorResult<string>> => {
            returnCalls += 1;
            return { value: undefined as unknown as string, done: true };
          },
        };
      },
    };
    const result = await runSseTransport({ input, onEvent: () => {} });
    expect(result.reason).toBe('end-of-stream');
    // `for await` only closes the iterator on early exit; a normally
    // exhausted iterator must not receive a spurious return() (which
    // could double-release non-idempotent resources).
    expect(returnCalls).toBe(0);
  });
});

describe('runSseTransportWithReconnect', () => {
  it('reconnects with Last-Event-ID and returns reconnect-limit when budget is exhausted', async () => {
    const seenHeaders: string[] = [];
    const seenEvents: string[] = [];
    const chunksByAttempt: string[][] = [
      ['id: one\nretry: 1\ndata: first\n\n'],
      ['id: two\ndata: second\n\n'],
    ];

    const result = await runSseTransportWithReconnect({
      maxReconnects: 1,
      connect: async ({ attempt, headers }) => {
        seenHeaders.push(headers['Last-Event-ID'] ?? '');
        return iter(chunksByAttempt[attempt] ?? []);
      },
      onEvent: (event) => {
        seenEvents.push(event.data);
      },
      sleep: async () => {},
    });

    expect(seenHeaders).toEqual(['', 'one']);
    expect(seenEvents).toEqual(['first', 'second']);
    expect(result.reason).toBe('reconnect-limit');
    expect(result.eventCount).toBe(2);
    expect(result.reconnect.lastEventId).toBe('two');
    expect(result.reconnectCount).toBe(1);
    expect(result.attempts).toBe(2);
  });

  it('aborts while parked in reconnect backoff without waiting for the sleep', async () => {
    const controller = new AbortController();
    let sleepStarted = false;
    const neverResolve = new Promise<void>(() => {});
    const result = await runSseTransportWithReconnect({
      maxReconnects: 5,
      signal: controller.signal,
      connect: async ({ attempt }) => {
        // First connection ends the stream cleanly so the loop enters backoff.
        return iter(attempt === 0 ? ['data: a\n\n'] : []);
      },
      onEvent: () => {},
      sleep: () => {
        sleepStarted = true;
        // Abort while the driver is parked in backoff.
        controller.abort();
        return neverResolve;
      },
    });
    expect(sleepStarted).toBe(true);
    expect(result.reason).toBe('aborted');
  });

  it('aborts while a reconnect connect() is still in flight', async () => {
    const controller = new AbortController();
    const connectPromise = new Promise<AsyncIterable<string>>(() => {});
    const result = await runSseTransportWithReconnect({
      maxReconnects: 5,
      signal: controller.signal,
      connect: async ({ attempt }) => {
        if (attempt === 0) return iter(['data: a\n\n']);
        // Second connect never resolves; abort fires while it is pending.
        controller.abort();
        return connectPromise;
      },
      onEvent: () => {},
      sleep: async () => {},
    });
    expect(result.reason).toBe('aborted');
    expect(result.attempts).toBe(1);
  });

  it('does not reconnect when the first run stops for a non-end-of-stream reason', async () => {
    const attempts: number[] = [];
    const result = await runSseTransportWithReconnect({
      maxReconnects: 5,
      connect: async ({ attempt }) => {
        attempts.push(attempt);
        return iter(['data: a\n\ndata: b\n\n']);
      },
      onEvent: () => {},
      maxEvents: 1,
      sleep: async () => {
        throw new Error('sleep should not be called when not reconnecting');
      },
    });

    expect(result.reason).toBe('max-events');
    expect(result.eventCount).toBe(1);
    expect(result.reconnectCount).toBe(0);
    expect(result.attempts).toBe(1);
    expect(attempts).toEqual([0]);
  });
});

describe('formatSseTranscriptLine', () => {
  it('emits a compact JSONL record with core fields', () => {
    const line = formatSseTranscriptLine(
      { type: 'message', data: 'hello' },
      { index: 0, timestamp: 1_700_000_000_000 },
    );
    const parsed = JSON.parse(line);
    expect(parsed).toEqual({
      i: 0,
      t: 1_700_000_000_000,
      type: 'message',
      data: 'hello',
    });
  });

  it('includes id and retry when present', () => {
    const line = formatSseTranscriptLine(
      { type: 'chunk', data: 'x', lastEventId: 'abc', retry: 2500 },
      { index: 4, timestamp: 1 },
    );
    const parsed = JSON.parse(line);
    expect(parsed.id).toBe('abc');
    expect(parsed.retry).toBe(2500);
  });

  it('produces one line with no embedded newlines from typical inputs', () => {
    const line = formatSseTranscriptLine(
      { type: 'message', data: 'no newline needed' },
      { index: 0, timestamp: 0 },
    );
    expect(line.includes('\n')).toBe(false);
  });
});

describe('reconnectHeaders', () => {
  it('omits Last-Event-ID when no id has been seen', () => {
    expect(reconnectHeaders({ lastEventId: undefined, retryMs: undefined })).toEqual({});
  });
  it('omits Last-Event-ID when empty string', () => {
    expect(reconnectHeaders({ lastEventId: '', retryMs: undefined })).toEqual({});
  });
  it('sets Last-Event-ID when a real id was captured', () => {
    expect(reconnectHeaders({ lastEventId: 'abc', retryMs: 1000 })).toEqual({
      'Last-Event-ID': 'abc',
    });
  });
});

describe('clampRetryMs', () => {
  it('uses fallback when suggested is missing or nonpositive', () => {
    expect(clampRetryMs(undefined)).toBe(3_000);
    expect(clampRetryMs(0)).toBe(3_000);
    expect(clampRetryMs(-1)).toBe(3_000);
    expect(clampRetryMs(Number.NaN)).toBe(3_000);
  });
  it('clamps into the [min, max] range', () => {
    expect(clampRetryMs(50)).toBe(100);
    expect(clampRetryMs(120_000)).toBe(30_000);
    expect(clampRetryMs(5_000)).toBe(5_000);
  });
});

describe('SseTransportUserOptionsSchema', () => {
  it('accepts a well-formed user-facing options object', () => {
    const parsed = SseTransportUserOptionsSchema.parse({
      until: 'event.data === "done"',
      maxEvents: 10,
      maxDurationMs: 5000,
      idleMs: 1000,
    });
    expect(parsed.maxEvents).toBe(10);
  });
  it('rejects non-positive or non-integer numeric limits', () => {
    expect(() => SseTransportUserOptionsSchema.parse({ maxEvents: 0 })).toThrow();
    expect(() => SseTransportUserOptionsSchema.parse({ maxDurationMs: -1 })).toThrow();
    expect(() => SseTransportUserOptionsSchema.parse({ idleMs: 1.5 })).toThrow();
  });
  it('rejects empty until expression', () => {
    expect(() => SseTransportUserOptionsSchema.parse({ until: '' })).toThrow();
  });
  it('rejects unknown fields (strict)', () => {
    expect(() =>
      SseTransportUserOptionsSchema.parse({ maxEvents: 1, wat: true } as unknown as object),
    ).toThrow();
  });
});
