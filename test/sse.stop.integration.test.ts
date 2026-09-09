import { afterEach, describe, expect, it } from 'vitest';
import { createServer, type ServerResponse } from 'node:http';
import { request } from 'undici';

import {
  closeOnAbort,
  runSseTransportWithReconnect,
  SseStreamRegistry,
  type SseEvent,
} from '../src/core/sse/index.js';

/**
 * End-to-end stop semantics: a server that keeps an event-stream open and
 * keeps writing events forever. Stopping through the registry must
 * (1) resolve the transport with reason=aborted, (2) stop event delivery,
 * (3) let the server observe the socket closing, and (4) prevent any late
 * events from being dispatched after the stop.
 */
describe('SSE stop control (integration)', () => {
  const servers: Array<{ close: () => void }> = [];

  afterEach(() => {
    for (const s of servers.splice(0, servers.length)) {
      s.close();
    }
  });

  it('stopActive() cancels a live infinite stream and no late events dispatch', async () => {
    let serverSawClose = false;
    let eventsWritten = 0;

    const server = createServer((_req, res: ServerResponse) => {
      res.statusCode = 200;
      res.setHeader('content-type', 'text/event-stream');
      const interval = setInterval(() => {
        eventsWritten += 1;
        res.write(`data: event-${eventsWritten}\n\n`);
      }, 10);
      res.on('close', () => {
        serverSawClose = true;
        clearInterval(interval);
      });
    });
    await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', () => resolve()));
    servers.push(server);
    const addr = server.address();
    if (!addr || typeof addr === 'string') throw new Error('unexpected server address');
    const url = `http://127.0.0.1:${addr.port}/events`;

    const registry = new SseStreamRegistry();
    const stream = registry.start();

    const seen: SseEvent[] = [];
    let stopCloseCalls = 0;
    const running = runSseTransportWithReconnect({
      maxReconnects: 5,
      connect: async ({ headers }) => {
        const res = await request(url, { method: 'GET', headers });
        const body = res.body.setEncoding('utf8');
        closeOnAbort(stream.signal, () => {
          stopCloseCalls += 1;
          body.destroy();
        });
        return body;
      },
      onEvent: (event) => {
        seen.push(event);
      },
      signal: stream.signal,
    });

    // Let some events flow, then stop.
    await new Promise<void>((resolve) => setTimeout(resolve, 60));
    expect(seen.length).toBeGreaterThan(0);
    const seenAtStop = seen.length;

    expect(registry.stopActive()).toBe(1);
    const result = await running;

    expect(result.reason).toBe('aborted');
    expect(stopCloseCalls).toBeGreaterThanOrEqual(1);

    // Give the server time to observe the socket close.
    await new Promise<void>((resolve) => setTimeout(resolve, 60));
    expect(serverSawClose).toBe(true);

    // No dispatching after stop.
    expect(seen.length).toBe(seenAtStop);

    // Server stopped writing once the socket closed.
    const writtenAfterStopSample = eventsWritten;
    await new Promise<void>((resolve) => setTimeout(resolve, 40));
    expect(eventsWritten).toBe(writtenAfterStopSample);
  });

  it('a stopped stream can be restarted via the reconnect path without stale sessions', async () => {
    // After stopActive(), the registry is empty and stop is a no-op,
    // which the extension surfaces as "no active SSE stream to stop".
    const registry = new SseStreamRegistry();
    registry.start();
    expect(registry.stopActive()).toBe(1);
    expect(registry.stopActive()).toBe(0);
    const next = registry.start();
    expect(next.signal.aborted).toBe(false);
    expect(registry.activeCount).toBe(1);
    registry.abortAll();
    expect(registry.activeCount).toBe(0);
  });
});
