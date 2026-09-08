import { describe, expect, it } from 'vitest';

import {
  SseStreamRegistry,
  closeOnAbort,
  runSseTransport,
  type SseEvent,
} from '../src/core/sse/index.js';

/** Async iterable that yields queued chunks and then stalls forever. */
class Stalling implements AsyncIterable<string> {
  private queue: string[] = [];
  private waiters: Array<(v: IteratorResult<string>) => void> = [];
  private closed = false;
  push(chunk: string) {
    if (this.waiters.length) {
      const w = this.waiters.shift()!;
      w({ value: chunk, done: false });
    } else {
      this.queue.push(chunk);
    }
  }
  close() {
    this.closed = true;
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
        if (this.closed) {
          return Promise.resolve({ value: undefined as unknown as string, done: true });
        }
        return new Promise((res) => this.waiters.push(res));
      },
    };
  }
}

const tick = () => new Promise<void>((resolve) => setTimeout(resolve, 0));

describe('SseStreamRegistry', () => {
  it('start() registers an active handle with a live (un-aborted) signal', () => {
    const registry = new SseStreamRegistry();
    const handle = registry.start();
    expect(registry.activeCount).toBe(1);
    expect(handle.signal.aborted).toBe(false);
    expect(handle.id).toBeTypeOf('number');
  });

  it('stopActive() aborts the signal, reports the transition count, and drains the registry', () => {
    const registry = new SseStreamRegistry();
    const a = registry.start();
    const b = registry.start();
    const stopped = registry.stopActive();
    expect(stopped).toBe(2);
    expect(a.signal.aborted).toBe(true);
    expect(b.signal.aborted).toBe(true);
    expect(registry.activeCount).toBe(0);
    expect(registry.stopActive()).toBe(0);
  });

  it('handle.abort() deregisters itself and returns true only for the first call', () => {
    const registry = new SseStreamRegistry();
    const handle = registry.start();
    expect(handle.abort()).toBe(true);
    expect(registry.activeCount).toBe(0);
    expect(handle.abort()).toBe(false);
    expect(registry.stopActive()).toBe(0);
  });

  it('handles are independent: stopping one leaves the other streaming', () => {
    const registry = new SseStreamRegistry();
    const keep = registry.start();
    const kill = registry.start();
    expect(kill.abort()).toBe(true);
    expect(keep.signal.aborted).toBe(false);
    expect(registry.activeCount).toBe(1);
  });

  it('handle.release() deregisters a completed stream without aborting its signal', () => {
    const registry = new SseStreamRegistry();
    const handle = registry.start();
    handle.release();
    expect(registry.activeCount).toBe(0);
    expect(handle.signal.aborted).toBe(false);
    // A released handle can no longer be stopped by the registry.
    expect(registry.stopActive()).toBe(0);
    expect(handle.abort()).toBe(false);
  });

  it('abortAll() stops every active stream (extension deactivate path)', () => {
    const registry = new SseStreamRegistry();
    const handles = [registry.start(), registry.start(), registry.start()];
    registry.abortAll();
    expect(handles.every((h) => h.signal.aborted)).toBe(true);
    expect(registry.activeCount).toBe(0);
  });

  it('dispatching after stop can never emit late events and reports reason=aborted', async () => {
    const registry = new SseStreamRegistry();
    const stream = registry.start();
    const input = new Stalling();
    const seen: SseEvent[] = [];

    input.push('data: one\n\n');
    const running = runSseTransport({
      input,
      onEvent: (event) => {
        seen.push(event);
      },
      signal: stream.signal,
    });
    await tick();
    expect(seen.map((e) => e.data)).toEqual(['one']);

    expect(registry.stopActive()).toBe(1);
    const result = await running;
    expect(result.reason).toBe('aborted');

    // Late chunks pushed after the stop must never surface as events.
    input.push('data: late\n\n');
    input.close();
    await tick();
    expect(seen.map((e) => e.data)).toEqual(['one']);
  });

  it('iterator rejections after abort never surface as unhandled rejections', async () => {
    const rejections: unknown[] = [];
    const onUnhandled = (err: unknown): void => {
      rejections.push(err);
    };
    process.on('unhandledRejection', onUnhandled);
    try {
      const registry = new SseStreamRegistry();
      const stream = registry.start();
      // Generator that yields once, then rejects its next() the way a
      // destroyed undici body rejects after `body.destroy()`.
      let first = true;
      const input: AsyncIterable<string> = {
        [Symbol.asyncIterator]: (): AsyncIterator<string> => ({
          next: () => {
            if (first) {
              first = false;
              return Promise.resolve({ value: 'data: one\n\n', done: false });
            }
            return new Promise((_resolve, reject) => {
              // Reject only after the stop has settled the race.
              stream.signal.addEventListener(
                'abort',
                () => reject(new Error('body destroyed')),
                { once: true },
              );
            });
          },
          return: () => Promise.resolve({ value: undefined, done: true } as IteratorResult<string>),
        }),
      };

      const seen: SseEvent[] = [];
      const running = runSseTransport({
        input,
        onEvent: (event) => {
          seen.push(event);
        },
        signal: stream.signal,
      });
      await tick();
      registry.stopActive();
      const result = await running;
      expect(result.reason).toBe('aborted');

      // Let any unhandled rejection microtask/timer fire.
      await new Promise<void>((resolve) => setTimeout(resolve, 50));
      expect(rejections).toEqual([]);
    } finally {
      process.off('unhandledRejection', onUnhandled);
    }
  });

  it('stop while the transport is stalled (no chunks arriving) resolves once the body is closed', async () => {
    const registry = new SseStreamRegistry();
    const stream = registry.start();
    const input = new Stalling();
    let closed = false;
    closeOnAbort(stream.signal, () => {
      closed = true;
      input.close();
    });

    const seen: SseEvent[] = [];
    input.push('data: first\n\n');
    const running = runSseTransport({
      input,
      onEvent: (event) => {
        seen.push(event);
      },
      signal: stream.signal,
    });
    await tick();
    expect(seen.length).toBe(1);

    // Driver is now parked waiting for the next chunk.
    registry.stopActive();
    const result = await running;
    expect(result.reason).toBe('aborted');
    expect(closed).toBe(true);
    expect(seen.length).toBe(1);
  });
});

describe('closeOnAbort', () => {
  it('invokes the close callback when the signal aborts', () => {
    const registry = new SseStreamRegistry();
    const stream = registry.start();
    let calls = 0;
    closeOnAbort(stream.signal, () => {
      calls += 1;
    });
    expect(calls).toBe(0);
    registry.stopActive();
    expect(calls).toBe(1);
  });

  it('fires immediately when the signal is already aborted', () => {
    const registry = new SseStreamRegistry();
    const stream = registry.start();
    registry.stopActive();
    let calls = 0;
    closeOnAbort(stream.signal, () => {
      calls += 1;
    });
    expect(calls).toBe(1);
  });

  it('returned detach prevents later close invocations', () => {
    const registry = new SseStreamRegistry();
    const stream = registry.start();
    let calls = 0;
    const detach = closeOnAbort(stream.signal, () => {
      calls += 1;
    });
    detach();
    registry.stopActive();
    expect(calls).toBe(0);
  });
});
