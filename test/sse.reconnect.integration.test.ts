import { afterEach, describe, expect, it } from 'vitest';
import { createServer, type IncomingMessage, type ServerResponse } from 'node:http';
import { request } from 'undici';

import { runSseTransportWithReconnect, type SseEvent } from '../src/core/sse/index.js';

interface SeenRequest {
  lastEventId: string | undefined;
}

describe('runSseTransportWithReconnect (integration)', () => {
  const servers: Array<{ close: () => void }> = [];

  afterEach(() => {
    for (const s of servers.splice(0, servers.length)) {
      s.close();
    }
  });

  it('reconnects once and forwards Last-Event-ID from the previous stream', async () => {
    const seenRequests: SeenRequest[] = [];
    let hit = 0;

    const server = createServer((req: IncomingMessage, res: ServerResponse) => {
      hit += 1;
      seenRequests.push({
        lastEventId: req.headers['last-event-id'] as string | undefined,
      });
      res.statusCode = 200;
      res.setHeader('content-type', 'text/event-stream; charset=utf-8');
      if (hit === 1) {
        res.write('id: first\nretry: 1\ndata: one\n\n');
        res.end();
        return;
      }
      if (hit === 2) {
        res.write('id: second\ndata: two\n\n');
        res.end();
        return;
      }
      res.end();
    });

    await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', () => resolve()));
    servers.push(server);
    const addr = server.address();
    if (!addr || typeof addr === 'string') {
      throw new Error('unexpected server address');
    }
    const url = `http://127.0.0.1:${addr.port}/events`;

    const seenEvents: string[] = [];
    const result = await runSseTransportWithReconnect({
      maxReconnects: 1,
      connect: async ({ headers }) => {
        const res = await request(url, { method: 'GET', headers });
        return res.body.setEncoding('utf8');
      },
      onEvent: (event: SseEvent) => {
        seenEvents.push(event.data);
      },
      sleep: async () => {},
    });

    expect(result.reason).toBe('reconnect-limit');
    expect(result.reconnect.lastEventId).toBe('second');
    expect(seenEvents).toEqual(['one', 'two']);
    expect(seenRequests).toEqual([
      { lastEventId: undefined },
      { lastEventId: 'first' },
    ]);
  });
});
