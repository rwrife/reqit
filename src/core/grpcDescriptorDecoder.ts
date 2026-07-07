/**
 * Decode raw `FileDescriptorProto` bytes (as returned by gRPC server
 * reflection) into the plain-JS `FileDescriptorProto` shape our
 * `DescriptorIndex` consumes.
 *
 * This is the load-bearing bridge between the `ReflectionCache` (which
 * holds opaque `Uint8Array` payloads) and the `DescriptorIndex` (which
 * needs `{ name, package, services, messages }` objects). Without this
 * module the two halves of gRPC reflection support can't talk to each
 * other — the cache stores bytes, the index needs decoded shapes.
 *
 * Scope for this slice (issue #24):
 *   - Decode enough of `google.protobuf.FileDescriptorProto` to answer
 *     "does this file expose Service X, and if so what are its methods
 *     and their input/output type FQNs?". That's exactly what the
 *     preflight report needs to verify a `.grpc` request before dispatch.
 *   - Skip everything we don't consume today: extensions, enum types,
 *     source-code info, syntax, deprecated proto3 flags. Unknown tags
 *     are read-and-discarded, not treated as errors — a newer proto
 *     compiler adding a field should never break our decoder.
 *   - Zod-validate the *decoded* shape against `FileDescriptorProtoSchema`
 *     before returning it, so downstream code gets the same guarantees
 *     as a hand-built descriptor in a test.
 *
 * Non-goals:
 *   - Encoding. Reqit never sends `FileDescriptorProto` bytes.
 *   - Full field coverage. `protobufjs` exists if we ever need it; for
 *     now a tight hand-rolled decoder keeps the dep graph clean and
 *     stays trivially unit-testable.
 *   - Enum types. Preflight only needs message + service shapes.
 *
 * This module is pure, VS Code-free, transport-free, and never touches
 * `@grpc/grpc-js`. It lives in `src/core/` per AGENTS.md coding standards.
 */

import {
  FileDescriptorProtoSchema,
  type FileDescriptorProto,
  type MessageDescriptor,
  type MethodDescriptor,
  type ServiceDescriptor,
} from './grpcDescriptorIndex.js';

// ---- Public API ------------------------------------------------------------

/**
 * Decode a single serialized `FileDescriptorProto` into its plain-JS
 * shape. The returned object is validated through
 * `FileDescriptorProtoSchema` before being handed back so callers get
 * the same runtime guarantees as any other descriptor in the codebase.
 *
 * Optionally pass a `fallbackName` to fill in when the encoded
 * `FileDescriptorProto.name` field is empty — gRPC server reflection
 * reports the file name at the transport layer separately from the
 * `FileDescriptorProto.name` field, and some servers ship files whose
 * encoded name is empty. Passing the transport-level name here keeps
 * downstream code (which needs *some* stable file key) working.
 *
 * Throws `Error` with an actionable message when the payload isn't a
 * valid protobuf wire format encoding (truncated varints, malformed
 * length-delimited fields, etc.), or when the decoded shape (after any
 * fallbacks) still fails schema validation.
 */
export function decodeFileDescriptorProto(
  bytes: Uint8Array,
  fallbackName?: string,
): FileDescriptorProto {
  const raw = decodeFileDescriptorRaw(bytes);
  if (raw.name.length === 0 && fallbackName !== undefined && fallbackName.length > 0) {
    raw.name = fallbackName;
  }
  // Fold through zod so any downstream code sees a validated shape,
  // matching what `DescriptorIndex.addFile` would do anyway. Bubble
  // ZodErrors as regular Errors so callers get a stable message shape.
  const result = FileDescriptorProtoSchema.safeParse(raw);
  if (!result.success) {
    throw new Error(
      `decoded FileDescriptorProto failed schema validation: ${result.error.message}`,
    );
  }
  return result.data;
}

/**
 * Decode an array of raw `FileDescriptor` cache entries (as produced by
 * `ReflectionCache.getFileDescriptors`) into their plain-JS shape.
 * Convenience wrapper — decodes each file independently so one bad
 * descriptor doesn't lose the rest of the batch.
 *
 * Returns both the successfully decoded files and any diagnostics for
 * files that failed to decode. Callers typically feed the `files` array
 * straight into `DescriptorIndex.from(...)` and surface diagnostics in
 * the preflight panel.
 *
 * Each entry's transport-level `name` is used as the `fallbackName` for
 * `decodeFileDescriptorProto`, so files whose encoded name is empty
 * still end up with a usable file key.
 */
export function decodeFileDescriptorSet(
  entries: ReadonlyArray<{ name: string; bytes: Uint8Array }>,
): {
  files: FileDescriptorProto[];
  diagnostics: Array<{ name: string; message: string }>;
} {
  const files: FileDescriptorProto[] = [];
  const diagnostics: Array<{ name: string; message: string }> = [];
  for (const entry of entries) {
    try {
      files.push(decodeFileDescriptorProto(entry.bytes, entry.name));
    } catch (err) {
      diagnostics.push({
        name: entry.name,
        message: (err as Error).message,
      });
    }
  }
  return { files, diagnostics };
}

// ---- Internals: protobuf wire-format reader -------------------------------

/**
 * Minimal protobuf wire-format reader. Only the pieces we need to walk
 * `FileDescriptorProto` — varints, length-delimited fields, fixed32/64
 * (as skip-only). Groups (deprecated wire type 3/4) are treated as
 * malformed input.
 */
class WireReader {
  private pos = 0;
  constructor(private readonly buf: Uint8Array) {}

  get eof(): boolean {
    return this.pos >= this.buf.length;
  }

  /** Read a raw varint as a number. Throws if it doesn't fit in a JS integer. */
  readVarint(): number {
    let result = 0;
    let shift = 0;
    for (;;) {
      if (this.pos >= this.buf.length) {
        throw new Error('varint truncated');
      }
      const byte = this.buf[this.pos++];
      // Guard against values that don't fit safely in a double. Descriptor
      // fields are all small (tag numbers, string lengths), so anything
      // bigger than 2^32 is almost certainly a corrupt payload.
      if (shift >= 32 && (byte & 0x7f) !== 0) {
        throw new Error('varint exceeds 32-bit range');
      }
      result |= (byte & 0x7f) << shift;
      if ((byte & 0x80) === 0) {
        // Force unsigned interpretation — bitwise ops in JS produce signed 32-bit ints.
        return result >>> 0;
      }
      shift += 7;
      if (shift > 35) {
        throw new Error('varint overrun');
      }
    }
  }

  /** Read a length-delimited chunk, returning a *view* into the source buffer. */
  readBytes(): Uint8Array {
    const len = this.readVarint();
    if (this.pos + len > this.buf.length) {
      throw new Error('length-delimited field truncated');
    }
    const slice = this.buf.subarray(this.pos, this.pos + len);
    this.pos += len;
    return slice;
  }

  /** Read a length-delimited chunk and decode as UTF-8. */
  readString(): string {
    const bytes = this.readBytes();
    // TextDecoder is available in Node ≥ 20 and every VS Code target.
    return new TextDecoder('utf-8', { fatal: false }).decode(bytes);
  }

  /** Read + discard a single field given its wire type. Used for tags we don't care about. */
  skipField(wireType: number): void {
    switch (wireType) {
      case 0: // varint
        this.readVarint();
        return;
      case 1: // fixed64
        if (this.pos + 8 > this.buf.length) {
          throw new Error('fixed64 truncated');
        }
        this.pos += 8;
        return;
      case 2: // length-delimited
        this.readBytes();
        return;
      case 5: // fixed32
        if (this.pos + 4 > this.buf.length) {
          throw new Error('fixed32 truncated');
        }
        this.pos += 4;
        return;
      case 3: // start group (deprecated, proto2-only)
      case 4: // end group
        throw new Error(`unsupported wire type ${wireType} (proto2 groups)`);
      default:
        throw new Error(`unknown wire type ${wireType}`);
    }
  }
}

/** Combined field-number + wire-type from a varint tag. */
interface Tag {
  fieldNumber: number;
  wireType: number;
}

function readTag(reader: WireReader): Tag {
  const tag = reader.readVarint();
  return { fieldNumber: tag >>> 3, wireType: tag & 0x07 };
}

/** Assert we're looking at a length-delimited field for a message-typed decoder. */
function expectLengthDelimited(tag: Tag, tagName: string): void {
  if (tag.wireType !== 2) {
    throw new Error(
      `expected length-delimited field for ${tagName} (field ${tag.fieldNumber}), got wire type ${tag.wireType}`,
    );
  }
}

// ---- Internals: decode each proto shape -----------------------------------

// Field numbers pulled straight from google/protobuf/descriptor.proto.
// Only the ones the descriptor index actually reads are enumerated —
// everything else is skipped through `skipField`.

const FILE_FIELD_NAME = 1;
const FILE_FIELD_PACKAGE = 2;
const FILE_FIELD_MESSAGE_TYPE = 4;
const FILE_FIELD_SERVICE = 6;

const MESSAGE_FIELD_NAME = 1;
const MESSAGE_FIELD_NESTED_TYPE = 3;

const SERVICE_FIELD_NAME = 1;
const SERVICE_FIELD_METHOD = 2;
const SERVICE_FIELD_OPTIONS = 3;

const METHOD_FIELD_NAME = 1;
const METHOD_FIELD_INPUT_TYPE = 2;
const METHOD_FIELD_OUTPUT_TYPE = 3;
const METHOD_FIELD_OPTIONS = 4;
const METHOD_FIELD_CLIENT_STREAMING = 5;
const METHOD_FIELD_SERVER_STREAMING = 6;

/** `MethodOptions.deprecated` — same tag as `ServiceOptions.deprecated`. */
const OPTIONS_FIELD_DEPRECATED = 33;

interface RawFile {
  name: string;
  package: string;
  services: ServiceDescriptor[];
  messages: MessageDescriptor[];
}

function decodeFileDescriptorRaw(bytes: Uint8Array): RawFile {
  const reader = new WireReader(bytes);
  const out: RawFile = {
    name: '',
    package: '',
    services: [],
    messages: [],
  };

  while (!reader.eof) {
    const tag = readTag(reader);
    switch (tag.fieldNumber) {
      case FILE_FIELD_NAME:
        expectLengthDelimited(tag, 'FileDescriptorProto.name');
        out.name = reader.readString();
        break;
      case FILE_FIELD_PACKAGE:
        expectLengthDelimited(tag, 'FileDescriptorProto.package');
        out.package = reader.readString();
        break;
      case FILE_FIELD_MESSAGE_TYPE:
        expectLengthDelimited(tag, 'FileDescriptorProto.message_type');
        out.messages.push(decodeMessageDescriptor(reader.readBytes()));
        break;
      case FILE_FIELD_SERVICE:
        expectLengthDelimited(tag, 'FileDescriptorProto.service');
        out.services.push(decodeServiceDescriptor(reader.readBytes()));
        break;
      default:
        reader.skipField(tag.wireType);
    }
  }

  return out;
}

function decodeMessageDescriptor(bytes: Uint8Array): MessageDescriptor {
  const reader = new WireReader(bytes);
  let name = '';
  const nested: MessageDescriptor[] = [];

  while (!reader.eof) {
    const tag = readTag(reader);
    switch (tag.fieldNumber) {
      case MESSAGE_FIELD_NAME:
        expectLengthDelimited(tag, 'DescriptorProto.name');
        name = reader.readString();
        break;
      case MESSAGE_FIELD_NESTED_TYPE:
        expectLengthDelimited(tag, 'DescriptorProto.nested_type');
        nested.push(decodeMessageDescriptor(reader.readBytes()));
        break;
      default:
        reader.skipField(tag.wireType);
    }
  }

  const msg: MessageDescriptor = { name };
  if (nested.length > 0) msg.nested = nested;
  return msg;
}

function decodeServiceDescriptor(bytes: Uint8Array): ServiceDescriptor {
  const reader = new WireReader(bytes);
  let name = '';
  const methods: MethodDescriptor[] = [];
  let deprecated = false;

  while (!reader.eof) {
    const tag = readTag(reader);
    switch (tag.fieldNumber) {
      case SERVICE_FIELD_NAME:
        expectLengthDelimited(tag, 'ServiceDescriptorProto.name');
        name = reader.readString();
        break;
      case SERVICE_FIELD_METHOD:
        expectLengthDelimited(tag, 'ServiceDescriptorProto.method');
        methods.push(decodeMethodDescriptor(reader.readBytes()));
        break;
      case SERVICE_FIELD_OPTIONS:
        expectLengthDelimited(tag, 'ServiceDescriptorProto.options');
        deprecated = decodeOptionsDeprecated(reader.readBytes());
        break;
      default:
        reader.skipField(tag.wireType);
    }
  }

  return { name, methods, deprecated };
}

function decodeMethodDescriptor(bytes: Uint8Array): MethodDescriptor {
  const reader = new WireReader(bytes);
  let name = '';
  let inputType = '';
  let outputType = '';
  let clientStreaming = false;
  let serverStreaming = false;
  let deprecated = false;

  while (!reader.eof) {
    const tag = readTag(reader);
    switch (tag.fieldNumber) {
      case METHOD_FIELD_NAME:
        expectLengthDelimited(tag, 'MethodDescriptorProto.name');
        name = reader.readString();
        break;
      case METHOD_FIELD_INPUT_TYPE:
        expectLengthDelimited(tag, 'MethodDescriptorProto.input_type');
        inputType = reader.readString();
        break;
      case METHOD_FIELD_OUTPUT_TYPE:
        expectLengthDelimited(tag, 'MethodDescriptorProto.output_type');
        outputType = reader.readString();
        break;
      case METHOD_FIELD_OPTIONS:
        expectLengthDelimited(tag, 'MethodDescriptorProto.options');
        deprecated = decodeOptionsDeprecated(reader.readBytes());
        break;
      case METHOD_FIELD_CLIENT_STREAMING:
        if (tag.wireType !== 0) {
          throw new Error(
            `MethodDescriptorProto.client_streaming has unexpected wire type ${tag.wireType}`,
          );
        }
        clientStreaming = reader.readVarint() !== 0;
        break;
      case METHOD_FIELD_SERVER_STREAMING:
        if (tag.wireType !== 0) {
          throw new Error(
            `MethodDescriptorProto.server_streaming has unexpected wire type ${tag.wireType}`,
          );
        }
        serverStreaming = reader.readVarint() !== 0;
        break;
      default:
        reader.skipField(tag.wireType);
    }
  }

  return {
    name,
    inputType,
    outputType,
    clientStreaming,
    serverStreaming,
    deprecated,
  };
}

/**
 * Decode a `MethodOptions` or `ServiceOptions` sub-message, returning
 * just the `deprecated` flag. Both option messages carry `deprecated`
 * at field number 33 (see google/protobuf/descriptor.proto).
 */
function decodeOptionsDeprecated(bytes: Uint8Array): boolean {
  const reader = new WireReader(bytes);
  let deprecated = false;
  while (!reader.eof) {
    const tag = readTag(reader);
    if (tag.fieldNumber === OPTIONS_FIELD_DEPRECATED) {
      if (tag.wireType !== 0) {
        throw new Error(
          `options.deprecated has unexpected wire type ${tag.wireType}`,
        );
      }
      deprecated = reader.readVarint() !== 0;
    } else {
      reader.skipField(tag.wireType);
    }
  }
  return deprecated;
}
