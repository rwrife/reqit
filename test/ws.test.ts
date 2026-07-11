import { describe, expect, it } from 'vitest';
import {
  ParsedWebSocketRequestSchema,
  parseWsRequest,
} from '../src/core/ws';

describe('parseWsRequest', () => {
  it('parses a minimal target-only file', () => {
    const parsed = parseWsRequest('wss://stream.example.com/v1/ticker\n');
    expect(parsed.url).toBe('wss://stream.example.com/v1/ticker');
    expect(parsed.scheme).toBe('wss');
    expect(parsed.headers).toEqual([]);
    expect(parsed.frames).toEqual([]);
    expect(parsed.directives).toEqual({});
    expect(parsed.name).toBeUndefined();
  });

  it('supports plaintext ws:// scheme', () => {
    const parsed = parseWsRequest('ws://localhost:8080/socket');
    expect(parsed.scheme).toBe('ws');
    expect(parsed.url).toBe('ws://localhost:8080/socket');
  });

  it('parses preamble directives and headers', () => {
    const src = [
      '# @name subscribeToTicker',
      '# @auth my-bearer',
      '// @custom foo',
      'wss://stream.example.com/v1/ticker?symbol=BTC',
      'Sec-WebSocket-Protocol: json',
      'Authorization: Bearer {{token}}',
      '',
    ].join('\n');
    const parsed = parseWsRequest(src);
    expect(parsed.name).toBe('subscribeToTicker');
    expect(parsed.directives).toEqual({
      name: 'subscribeToTicker',
      auth: 'my-bearer',
      custom: 'foo',
    });
    expect(parsed.headers).toEqual([
      { name: 'Sec-WebSocket-Protocol', value: 'json' },
      { name: 'Authorization', value: 'Bearer {{token}}' },
    ]);
  });

  it('parses interleaved send/recv frames', () => {
    const src = [
      'wss://api.example.com/rt',
      '',
      '--- send',
      '{"op":"subscribe","channel":"trades"}',
      '--- recv',
      '{"op":"subscribed"}',
      '--- send',
      '{"op":"ping"}',
      '',
    ].join('\n');
    const parsed = parseWsRequest(src);
    expect(parsed.frames).toHaveLength(3);
    expect(parsed.frames[0]).toMatchObject({
      direction: 'send',
      data: '{"op":"subscribe","channel":"trades"}',
    });
    expect(parsed.frames[1]).toMatchObject({
      direction: 'recv',
      data: '{"op":"subscribed"}',
    });
    expect(parsed.frames[2]).toMatchObject({
      direction: 'send',
      data: '{"op":"ping"}',
    });
    // Line numbers point at the marker.
    expect(parsed.frames[0].line).toBeGreaterThan(0);
    expect(parsed.frames[1].line).toBeGreaterThan(parsed.frames[0].line);
  });

  it('preserves multi-line frame bodies verbatim (minus trailing blanks)', () => {
    const src = [
      'wss://h/p',
      '',
      '--- send',
      '{',
      '  "a": 1,',
      '  "b": 2',
      '}',
      '',
      '',
      '--- recv',
      'ok',
    ].join('\n');
    const parsed = parseWsRequest(src);
    expect(parsed.frames[0].data).toBe('{\n  "a": 1,\n  "b": 2\n}');
    expect(parsed.frames[1].data).toBe('ok');
  });

  it('treats frame markers case-insensitively and tolerates trailing whitespace', () => {
    const src = ['wss://h/p', '--- SEND   ', 'hi', '--- Recv', 'bye'].join('\n');
    const parsed = parseWsRequest(src);
    expect(parsed.frames.map((f) => f.direction)).toEqual(['send', 'recv']);
  });

  it('allows the header block to end at a frame marker without a blank line', () => {
    const src = [
      'wss://h/p',
      'Authorization: Bearer x',
      '--- send',
      'hello',
    ].join('\n');
    const parsed = parseWsRequest(src);
    expect(parsed.headers).toEqual([
      { name: 'Authorization', value: 'Bearer x' },
    ]);
    expect(parsed.frames).toEqual([
      { direction: 'send', data: 'hello', line: 3 },
    ]);
  });

  it('throws when there is no target URL', () => {
    expect(() => parseWsRequest('# just a comment\n')).toThrow(/no target URL/);
  });

  it('throws when the scheme is not ws/wss', () => {
    expect(() => parseWsRequest('https://nope.example.com/')).toThrow(
      /ws:\/\/ or wss:\/\//,
    );
  });

  it('throws on a malformed header line', () => {
    const src = ['wss://h/p', 'not-a-header', ''].join('\n');
    expect(() => parseWsRequest(src)).toThrow(/malformed/);
  });

  it('throws on a header with an empty name', () => {
    // A single space before the colon gives colon index > 0 (so we get past
    // the malformed check) but leaves the name empty after trimming.
    const src = ['wss://h/p', ' : value', ''].join('\n');
    expect(() => parseWsRequest(src)).toThrow(/empty name/);
  });

  it('throws on stray content between the header block and the first frame marker', () => {
    const src = [
      'wss://h/p',
      'Authorization: Bearer x',
      '',
      'oops stray text',
      '--- send',
      'x',
    ].join('\n');
    expect(() => parseWsRequest(src)).toThrow(/outside a frame block/);
  });

  it('produces output that satisfies the exported zod schema', () => {
    const parsed = parseWsRequest(
      'wss://h/p\nAuthorization: Bearer x\n\n--- send\nhi\n',
    );
    expect(() => ParsedWebSocketRequestSchema.parse(parsed)).not.toThrow();
  });
});
