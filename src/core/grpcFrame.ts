/**
 * gRPC message framing — the 5-byte length-prefixed frame format defined
 * in the gRPC HTTP/2 wire protocol.
 *
 * Every gRPC message on the wire, request or response, is wrapped in a
 * frame with this layout:
 *
 *   +---------+----------------+----------------------------+
 *   | 1 byte  | 4 bytes        | N bytes                    |
 *   | flags   | length (BE u32)| serialized message payload |
 *   +---------+----------------+----------------------------+
 *
 * `flags` is a bit field. Today only bit 0 (0x01) is defined, indicating
 * the payload is gRPC-compressed with the message-encoding named in the
 * `grpc-encoding` metadata. Reqit does not send compressed messages in
 * v1 (issue #24 acceptance criteria: unary calls only, no streaming, no
 * negotiated compression); we still parse the flag on the wire and
 * surface a clear error when a server sends a compressed response back.
 *
 * Scope for this slice:
 *   - Pure encode/decode. No `@grpc/grpc-js` import, no VS Code import,
 *     no transport. `Buffer` is used because we ship on Node ≥ 20 and
 *     the runner will hand these bytes straight to a gRPC client which
 *     also speaks `Buffer`.
 *   - Multi-frame parsing (`decodeFrames`) so the same code can walk
 *     server-streaming responses even though the dispatcher only exposes
 *     unary in v1 — one less refactor when streaming lands.
 *   - Zero heuristics. Malformed input rejects with a message that
 *     names the byte offset, which the response panel surfaces verbatim.
 *
 * This module is trivially unit-testable and lives in `src/core/` per
 * AGENTS.md standards.
 */

/** Bit set on `flags` when the payload is compressed with `grpc-encoding`. */
export const GRPC_FRAME_COMPRESSED_FLAG = 0x01;

/** Fixed frame header size: 1 flags byte + 4 length bytes. */
export const GRPC_FRAME_HEADER_SIZE = 5;

/**
 * A single decoded gRPC message frame. `payload` is a *view* over the
 * caller-supplied buffer when we can avoid a copy, and a fresh
 * `Uint8Array` when the caller passed a `number[]` or the payload
 * straddled a chunk boundary — either way, treat it as read-only.
 */
export interface GrpcFrame {
  /** Raw flags byte. Bit 0 = compressed. Other bits reserved and currently 0. */
  flags: number;
  /** True iff the compressed bit (`0x01`) is set on `flags`. */
  compressed: boolean;
  /** Message payload bytes. Length matches the frame's length prefix exactly. */
  payload: Uint8Array;
}

/**
 * Encode a single gRPC message frame.
 *
 * Throws `Error` when the payload is larger than can be expressed in the
 * 4-byte length prefix. gRPC's own limit (`grpc.max_send_message_length`)
 * defaults to 4 MiB and is enforced by the client; this framer allows up
 * to the full 32-bit range so tests can construct edge cases.
 *
 * `compressed` defaults to `false`. We currently never emit compressed
 * request bodies — Reqit doesn't negotiate `grpc-encoding` — but the
 * flag is exposed so tests can exercise the round-trip.
 */
export function encodeFrame(payload: Uint8Array, compressed = false): Uint8Array {
  if (payload.length > 0xffffffff) {
    throw new Error(
      `gRPC frame payload is ${payload.length} bytes; length prefix caps at 2^32 - 1`,
    );
  }
  const out = new Uint8Array(GRPC_FRAME_HEADER_SIZE + payload.length);
  out[0] = compressed ? GRPC_FRAME_COMPRESSED_FLAG : 0;
  // Big-endian u32 length prefix, per gRPC wire spec.
  const len = payload.length >>> 0;
  out[1] = (len >>> 24) & 0xff;
  out[2] = (len >>> 16) & 0xff;
  out[3] = (len >>> 8) & 0xff;
  out[4] = len & 0xff;
  out.set(payload, GRPC_FRAME_HEADER_SIZE);
  return out;
}

/**
 * Decode exactly one gRPC frame from the start of `bytes`.
 *
 * Returns the parsed frame plus the number of bytes consumed
 * (`GRPC_FRAME_HEADER_SIZE + payload.length`). Callers walking a stream
 * should slice `bytes` past `consumed` and call again — see
 * `decodeFrames` for the batched form.
 *
 * Throws `Error` when the buffer is too small to hold either the header
 * or the promised payload, so callers know they need to read more bytes
 * before retrying.
 */
export function decodeFrame(bytes: Uint8Array): { frame: GrpcFrame; consumed: number } {
  if (bytes.length < GRPC_FRAME_HEADER_SIZE) {
    throw new Error(
      `gRPC frame truncated: need at least ${GRPC_FRAME_HEADER_SIZE} header bytes, have ${bytes.length}`,
    );
  }
  const flags = bytes[0]!;
  const length =
    ((bytes[1]! << 24) >>> 0) | (bytes[2]! << 16) | (bytes[3]! << 8) | bytes[4]!;
  const end = GRPC_FRAME_HEADER_SIZE + length;
  if (bytes.length < end) {
    throw new Error(
      `gRPC frame truncated: header promises ${length}-byte payload, have ${bytes.length - GRPC_FRAME_HEADER_SIZE} bytes after header`,
    );
  }
  return {
    frame: {
      flags,
      compressed: (flags & GRPC_FRAME_COMPRESSED_FLAG) !== 0,
      payload: bytes.subarray(GRPC_FRAME_HEADER_SIZE, end),
    },
    consumed: end,
  };
}

/**
 * Decode every full frame in `bytes`. Returns the parsed frames plus a
 * `leftover` view containing any trailing bytes that don't form a
 * complete frame (i.e. a header without its full payload, or a partial
 * header).
 *
 * Streaming callers should append the next chunk to `leftover` and call
 * again; unary callers should error out if `leftover.length !== 0` after
 * the response body finishes. Throws only when a *complete* frame header
 * decodes but its length prefix is nonsense in a way the incremental
 * parser can't distinguish from truncation — which today it can't, so
 * we never throw here and always fall through to leftover-based retry.
 */
export function decodeFrames(bytes: Uint8Array): {
  frames: GrpcFrame[];
  leftover: Uint8Array;
} {
  const frames: GrpcFrame[] = [];
  let pos = 0;
  while (pos + GRPC_FRAME_HEADER_SIZE <= bytes.length) {
    const length =
      ((bytes[pos + 1]! << 24) >>> 0) |
      (bytes[pos + 2]! << 16) |
      (bytes[pos + 3]! << 8) |
      bytes[pos + 4]!;
    const end = pos + GRPC_FRAME_HEADER_SIZE + length;
    if (end > bytes.length) break;
    const flags = bytes[pos]!;
    frames.push({
      flags,
      compressed: (flags & GRPC_FRAME_COMPRESSED_FLAG) !== 0,
      payload: bytes.subarray(pos + GRPC_FRAME_HEADER_SIZE, end),
    });
    pos = end;
  }
  return { frames, leftover: bytes.subarray(pos) };
}
