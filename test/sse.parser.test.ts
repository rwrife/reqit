import { describe, it, expect } from 'vitest';
import { SseParser, SseEventSchema, parseSse } from '../src/core/sse/index.js';

describe('SSE frame parser', () => {
  it('parses the canonical spec example (data-only, LF-terminated)', () => {
    const events = parseSse('data: YHOO\ndata: +2\ndata: 10\n\n');
    expect(events).toHaveLength(1);
    expect(events[0]).toEqual({ type: 'message', data: 'YHOO\n+2\n10' });
  });

  it('defaults event type to "message" when no event: field', () => {
    const events = parseSse('data: hello\n\n');
    expect(events[0]?.type).toBe('message');
  });

  it('honors a named event: field', () => {
    const events = parseSse('event: userlogin\ndata: {"u":"a"}\n\n');
    expect(events).toEqual([{ type: 'userlogin', data: '{"u":"a"}' }]);
  });

  it('handles CRLF line terminators', () => {
    const events = parseSse('event: ping\r\ndata: 1\r\n\r\n');
    expect(events).toEqual([{ type: 'ping', data: '1' }]);
  });

  it('handles bare CR line terminators', () => {
    const events = parseSse('event: ping\rdata: 1\r\r');
    expect(events).toEqual([{ type: 'ping', data: '1' }]);
  });

  it('strips a leading UTF-8 BOM from the first chunk only', () => {
    const p = new SseParser();
    p.push('\uFEFFdata: a\n\n');
    p.push('\uFEFFdata: b\n\n'); // second BOM must NOT be stripped -> ignored as unknown field
    p.end();
    const events = p.drain();
    expect(events).toEqual([
      { type: 'message', data: 'a' },
      // The second event's payload is dropped because '\uFEFFdata' is an
      // unknown field. But per spec, non-BOM-stripped chunks still parse
      // normal lines. So this event has no data -> not dispatched.
      // Only the first event should be present.
    ]);
  });

  it('treats leading ":" as a comment', () => {
    const events = parseSse(': keepalive\ndata: hi\n\n');
    expect(events).toEqual([{ type: 'message', data: 'hi' }]);
  });

  it('strips exactly one leading space from value, but preserves the rest', () => {
    const events = parseSse('data:  spaced\n\n');
    expect(events[0]?.data).toBe(' spaced');
  });

  it('treats a line with no colon as a field with empty value', () => {
    // "data" with no colon => field=data, value=''
    const events = parseSse('data\ndata\n\n');
    expect(events).toEqual([{ type: 'message', data: '\n' }]);
  });

  it('does NOT dispatch an event when no data: lines are present', () => {
    const events = parseSse('event: heartbeat\n\ndata: real\n\n');
    // First frame (event only) -> discarded. Second frame -> dispatched
    // as default 'message' because the event-type buffer was reset.
    expect(events).toEqual([{ type: 'message', data: 'real' }]);
  });

  it('carries lastEventId stickily across events', () => {
    const events = parseSse(
      'id: 1\ndata: a\n\ndata: b\n\nid: 2\ndata: c\n\ndata: d\n\n',
    );
    expect(events.map((e) => e.lastEventId)).toEqual(['1', '1', '2', '2']);
  });

  it('ignores id: values containing a NUL byte', () => {
    const events = parseSse('id: ok\ndata: a\n\nid: bad\u0000thing\ndata: b\n\n');
    expect(events[0]?.lastEventId).toBe('ok');
    expect(events[1]?.lastEventId).toBe('ok'); // unchanged
  });

  it('parses retry: only when all-ASCII-digits', () => {
    const p = new SseParser();
    p.push('retry: 5000\ndata: a\n\n');
    p.push('retry: not-a-number\ndata: b\n\n');
    p.end();
    const events = p.drain();
    expect(events[0]?.retry).toBe(5000);
    expect(events[1]?.retry).toBe(5000); // sticky, previous value retained
    expect(p.getRetry()).toBe(5000);
  });

  it('ignores unknown fields', () => {
    const events = parseSse('foo: bar\ndata: real\nqux: quux\n\n');
    expect(events).toEqual([{ type: 'message', data: 'real' }]);
  });

  it('streams across chunk boundaries mid-line', () => {
    const p = new SseParser();
    p.push('data: hel');
    p.push('lo\ndata: wor');
    p.push('ld\n\n');
    p.end();
    expect(p.drain()).toEqual([{ type: 'message', data: 'hello\nworld' }]);
  });

  it('streams across chunk boundaries mid-CRLF', () => {
    const p = new SseParser();
    p.push('data: a\r');
    p.push('\ndata: b\r\n\r\n');
    p.end();
    expect(p.drain()).toEqual([{ type: 'message', data: 'a\nb' }]);
  });

  it('dispatches a trailing event on end() even without a final blank line', () => {
    const p = new SseParser();
    p.push('data: last');
    p.end();
    expect(p.drain()).toEqual([{ type: 'message', data: 'last' }]);
  });

  it('drain() empties the internal queue', () => {
    const p = new SseParser();
    p.push('data: a\n\ndata: b\n\n');
    p.end();
    expect(p.drain()).toHaveLength(2);
    expect(p.drain()).toHaveLength(0);
  });

  it('resets event-type between events but keeps id/retry sticky', () => {
    const events = parseSse(
      'event: x\nid: 1\nretry: 3000\ndata: a\n\ndata: b\n\n',
    );
    expect(events).toEqual([
      { type: 'x', data: 'a', lastEventId: '1', retry: 3000 },
      { type: 'message', data: 'b', lastEventId: '1', retry: 3000 },
    ]);
  });

  it('handles empty data: lines by joining with a newline', () => {
    const events = parseSse('data:\ndata:\ndata: end\n\n');
    expect(events[0]?.data).toBe('\n\nend');
  });

  it('zod schema accepts a valid event and rejects garbage', () => {
    expect(() =>
      SseEventSchema.parse({ type: 'message', data: 'hi' }),
    ).not.toThrow();
    expect(() =>
      SseEventSchema.parse({ type: 'message', data: 'hi', retry: -1 }),
    ).toThrow();
    expect(() =>
      SseEventSchema.parse({ type: '', data: 'hi' }),
    ).toThrow();
  });

  it('getLastEventId reflects the latest observed id', () => {
    const p = new SseParser();
    p.push('id: 42\ndata: a\n\n');
    p.end();
    p.drain();
    expect(p.getLastEventId()).toBe('42');
  });
});
