import { describe, it, expect } from 'vitest';
import {
  encodeFrame,
  decodeFrame,
  decodeFrames,
  GRPC_FRAME_HEADER_SIZE,
  GRPC_FRAME_COMPRESSED_FLAG,
} from '../src/core/grpcFrame.js';

/**
 * Cross-check helper — build a frame by hand so tests don't rely on the
 * encoder to verify the decoder.
 */
function handFrame(payload: number[], flags = 0): Uint8Array {
  const len = payload.length;
  return new Uint8Array([
    flags & 0xff,
    (len >>> 24) & 0xff,
    (len >>> 16) & 0xff,
    (len >>> 8) & 0xff,
    len & 0xff,
    ...payload,
  ]);
}

describe('encodeFrame', () => {
  it('prefixes payload with a 5-byte header (flags=0 by default)', () => {
    const payload = new Uint8Array([1, 2, 3, 4, 5]);
    const framed = encodeFrame(payload);
    expect(framed.length).toBe(GRPC_FRAME_HEADER_SIZE + payload.length);
    expect(framed[0]).toBe(0);
    // Length prefix big-endian = 5.
    expect(framed[1]).toBe(0);
    expect(framed[2]).toBe(0);
    expect(framed[3]).toBe(0);
    expect(framed[4]).toBe(5);
    expect(Array.from(framed.subarray(5))).toEqual([1, 2, 3, 4, 5]);
  });

  it('sets the compressed flag bit when compressed=true', () => {
    const framed = encodeFrame(new Uint8Array([9]), true);
    expect(framed[0]).toBe(GRPC_FRAME_COMPRESSED_FLAG);
  });

  it('encodes an empty payload as a 5-byte header with length=0', () => {
    const framed = encodeFrame(new Uint8Array(0));
    expect(framed.length).toBe(GRPC_FRAME_HEADER_SIZE);
    expect(Array.from(framed)).toEqual([0, 0, 0, 0, 0]);
  });

  it('encodes a multi-byte length prefix correctly (300 bytes)', () => {
    const payload = new Uint8Array(300).fill(0xab);
    const framed = encodeFrame(payload);
    // 300 = 0x0000012C
    expect(framed[1]).toBe(0x00);
    expect(framed[2]).toBe(0x00);
    expect(framed[3]).toBe(0x01);
    expect(framed[4]).toBe(0x2c);
    expect(framed.length).toBe(GRPC_FRAME_HEADER_SIZE + 300);
  });
});

describe('decodeFrame', () => {
  it('round-trips an encoded frame', () => {
    const payload = new Uint8Array([10, 20, 30]);
    const framed = encodeFrame(payload);
    const { frame, consumed } = decodeFrame(framed);
    expect(frame.flags).toBe(0);
    expect(frame.compressed).toBe(false);
    expect(Array.from(frame.payload)).toEqual([10, 20, 30]);
    expect(consumed).toBe(framed.length);
  });

  it('reports the compressed flag as parsed', () => {
    const bytes = handFrame([42], GRPC_FRAME_COMPRESSED_FLAG);
    const { frame } = decodeFrame(bytes);
    expect(frame.compressed).toBe(true);
    expect(frame.flags).toBe(GRPC_FRAME_COMPRESSED_FLAG);
    expect(Array.from(frame.payload)).toEqual([42]);
  });

  it('throws when the buffer is shorter than the 5-byte header', () => {
    expect(() => decodeFrame(new Uint8Array([0, 0, 0]))).toThrow(
      /truncated.*header/,
    );
  });

  it('throws when the header promises more payload than we have', () => {
    // Header says 100 bytes, buffer only has 5 payload bytes.
    const bytes = new Uint8Array([0, 0, 0, 0, 100, 1, 2, 3, 4, 5]);
    expect(() => decodeFrame(bytes)).toThrow(/truncated.*100-byte payload/);
  });

  it('reads only the promised payload length even when buffer has trailing bytes', () => {
    const bytes = new Uint8Array([
      ...handFrame([7, 8]),
      // Trailing bytes that would be the next frame in a stream.
      0xff, 0xff, 0xff,
    ]);
    const { frame, consumed } = decodeFrame(bytes);
    expect(Array.from(frame.payload)).toEqual([7, 8]);
    expect(consumed).toBe(GRPC_FRAME_HEADER_SIZE + 2);
  });
});

describe('decodeFrames', () => {
  it('walks a buffer of concatenated frames', () => {
    const bytes = new Uint8Array([
      ...encodeFrame(new Uint8Array([1, 2, 3])),
      ...encodeFrame(new Uint8Array([9])),
      ...encodeFrame(new Uint8Array()),
    ]);
    const { frames, leftover } = decodeFrames(bytes);
    expect(frames.map((f) => Array.from(f.payload))).toEqual([
      [1, 2, 3],
      [9],
      [],
    ]);
    expect(leftover.length).toBe(0);
  });

  it('returns leftover bytes when the last frame is incomplete (partial payload)', () => {
    const good = encodeFrame(new Uint8Array([1, 2, 3]));
    // Header for the next frame says 10 bytes, we only supply 4.
    const partial = new Uint8Array([0, 0, 0, 0, 10, 100, 101, 102, 103]);
    const bytes = new Uint8Array([...good, ...partial]);
    const { frames, leftover } = decodeFrames(bytes);
    expect(frames.length).toBe(1);
    expect(Array.from(frames[0]!.payload)).toEqual([1, 2, 3]);
    expect(Array.from(leftover)).toEqual([0, 0, 0, 0, 10, 100, 101, 102, 103]);
  });

  it('returns leftover bytes when only a partial header is present', () => {
    const good = encodeFrame(new Uint8Array([5]));
    const partialHeader = new Uint8Array([0, 0, 0]); // 3 of 5 header bytes
    const bytes = new Uint8Array([...good, ...partialHeader]);
    const { frames, leftover } = decodeFrames(bytes);
    expect(frames.length).toBe(1);
    expect(Array.from(leftover)).toEqual([0, 0, 0]);
  });

  it('returns no frames and full leftover for an empty buffer', () => {
    const { frames, leftover } = decodeFrames(new Uint8Array());
    expect(frames).toEqual([]);
    expect(leftover.length).toBe(0);
  });
});
