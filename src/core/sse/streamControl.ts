/**
 * Pure stream stop/cancellation control for SSE sessions.
 *
 * The extension host (and any future CLI/MCP driver) owns one
 * {@link SseStreamRegistry}; every live SSE session gets a
 * {@link SseStreamHandle} whose `AbortSignal` is passed to
 * {@link runSseTransportWithReconnect}. A dedicated "Stop stream" action
 * calls {@link SseStreamRegistry.stopActive}, which aborts every live
 * session exactly once and lets the transport finish its current await
 * point without emitting further events.
 *
 * Design rules (see docs/security/local-data-and-threat-model.md):
 *   - Cancellation is temporal: after `stopActive()`/`abort()`, no further
 *     events may be dispatched, reconnect attempts may not start, and
 *     late-arriving chunks are dropped by the transport.
 *   - This module is pure TypeScript with no VS Code dependency so the
 *     same semantics are testable in vitest and reusable by CLI/MCP.
 */

export interface SseStreamHandle {
  /** Stable id for this registration (monotonic per registry). */
  readonly id: number;
  /** Signal forwarded to the transport driver. */
  readonly signal: AbortSignal;
  /**
   * Stop this one stream. Returns `true` when this call performed the
   * stop, `false` when the stream was already stopped (idempotent).
   */
  abort(): boolean;
  /**
   * Deregister a stream that finished on its own (normal end-of-stream,
   * until-match, caps...). Never aborts the signal, so consumers that
   * still read the final result are unaffected.
   */
  release(): void;
}

/**
 * Registry of live SSE streams. Tracks only sessions whose driver has not
 * finished yet; handles deregister themselves on completion or stop.
 */
export class SseStreamRegistry {
  private nextId = 1;
  private readonly active = new Map<number, AbortController>();

  /** Number of currently live (un-stopped, un-finished) streams. */
  get activeCount(): number {
    return this.active.size;
  }

  /** Register a new live stream and return its control handle. */
  start(): SseStreamHandle {
    const id = this.nextId++;
    const controller = new AbortController();
    this.active.set(id, controller);
    return {
      id,
      signal: controller.signal,
      abort: (): boolean => {
        if (!this.active.has(id)) return false;
        this.active.delete(id);
        controller.abort();
        return true;
      },
      release: (): void => {
        this.active.delete(id);
      },
    };
  }

  /**
   * Stop every currently live stream and deregister them.
   *
   * @returns how many streams were stopped by this call (0 is a no-op).
   */
  stopActive(): number {
    const ids = [...this.active.keys()];
    for (const id of ids) {
      const controller = this.active.get(id);
      if (!controller) continue;
      this.active.delete(id);
      controller.abort();
    }
    return ids.length;
  }

  /**
   * Force-abort all remaining signals (extension deactivate path). Unlike
   * {@link stopActive} this also leaves handles' own `abort()` returning
   * `false` afterwards, because deregistration already happened.
   */
  abortAll(): void {
    this.stopActive();
  }
}

/**
 * Run `close()` exactly once when `signal` aborts. If the signal is
 * already aborted, `close()` runs synchronously. The returned function
 * detaches the listener so a completed session never closes a resource
 * late (e.g. after the caller already released it).
 */
export function closeOnAbort(signal: AbortSignal, close: () => void): () => void {
  if (signal.aborted) {
    close();
    return () => {};
  }
  const onAbort = (): void => {
    signal.removeEventListener('abort', onAbort);
    close();
  };
  signal.addEventListener('abort', onAbort, { once: true });
  return () => {
    signal.removeEventListener('abort', onAbort);
  };
}
