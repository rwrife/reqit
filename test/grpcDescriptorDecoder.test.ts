import { describe, it, expect } from 'vitest';
import {
  decodeFileDescriptorProto,
  decodeFileDescriptorSet,
} from '../src/core/grpcDescriptorDecoder.js';

/**
 * Hand-built protobuf wire-format encoders — kept tiny + local so tests
 * exercise the decoder against payloads we fully control, instead of
 * pulling `protobufjs` in just to build a fixture.
 */

/** Encode a varint into `out`. */
function writeVarint(out: number[], value: number): void {
  let v = value >>> 0;
  while (v > 0x7f) {
    out.push((v & 0x7f) | 0x80);
    v >>>= 7;
  }
  out.push(v & 0x7f);
}

/** Tag = (fieldNumber << 3) | wireType, encoded as varint. */
function writeTag(out: number[], fieldNumber: number, wireType: number): void {
  writeVarint(out, (fieldNumber << 3) | wireType);
}

/** Length-delimited field: tag, length varint, then raw bytes. */
function writeLenDelim(out: number[], fieldNumber: number, payload: number[]): void {
  writeTag(out, fieldNumber, 2);
  writeVarint(out, payload.length);
  out.push(...payload);
}

/** String field: length-delimited UTF-8 bytes. */
function writeString(out: number[], fieldNumber: number, value: string): void {
  writeLenDelim(out, fieldNumber, [...new TextEncoder().encode(value)]);
}

/** Bool field: varint (0 or 1). */
function writeBool(out: number[], fieldNumber: number, value: boolean): void {
  writeTag(out, fieldNumber, 0);
  writeVarint(out, value ? 1 : 0);
}

function toBytes(buf: number[]): Uint8Array {
  return new Uint8Array(buf);
}

// ---- Field-number helpers, mirroring google/protobuf/descriptor.proto ------

const FILE = { name: 1, package: 2, messageType: 4, service: 6 };
const MESSAGE = { name: 1, nestedType: 3 };
const SERVICE = { name: 1, method: 2, options: 3 };
const METHOD = {
  name: 1,
  inputType: 2,
  outputType: 3,
  options: 4,
  clientStreaming: 5,
  serverStreaming: 6,
};
const OPTIONS_DEPRECATED = 33;

// ---- Fixture builders ------------------------------------------------------

function buildMessage(name: string, nested: number[][] = []): number[] {
  const buf: number[] = [];
  writeString(buf, MESSAGE.name, name);
  for (const n of nested) {
    writeLenDelim(buf, MESSAGE.nestedType, n);
  }
  return buf;
}

interface MethodInput {
  name: string;
  inputType: string;
  outputType: string;
  clientStreaming?: boolean;
  serverStreaming?: boolean;
  deprecated?: boolean;
}

function buildMethod(m: MethodInput): number[] {
  const buf: number[] = [];
  writeString(buf, METHOD.name, m.name);
  writeString(buf, METHOD.inputType, m.inputType);
  writeString(buf, METHOD.outputType, m.outputType);
  if (m.clientStreaming) writeBool(buf, METHOD.clientStreaming, true);
  if (m.serverStreaming) writeBool(buf, METHOD.serverStreaming, true);
  if (m.deprecated) {
    const opt: number[] = [];
    writeBool(opt, OPTIONS_DEPRECATED, true);
    writeLenDelim(buf, METHOD.options, opt);
  }
  return buf;
}

function buildService(
  name: string,
  methods: MethodInput[],
  opts: { deprecated?: boolean } = {},
): number[] {
  const buf: number[] = [];
  writeString(buf, SERVICE.name, name);
  for (const m of methods) {
    writeLenDelim(buf, SERVICE.method, buildMethod(m));
  }
  if (opts.deprecated) {
    const opt: number[] = [];
    writeBool(opt, OPTIONS_DEPRECATED, true);
    writeLenDelim(buf, SERVICE.options, opt);
  }
  return buf;
}

interface FileInput {
  name?: string;
  package?: string;
  messages?: Array<{ name: string; nested?: Array<{ name: string }> }>;
  services?: Array<{
    name: string;
    methods: MethodInput[];
    deprecated?: boolean;
  }>;
}

function buildFile(f: FileInput): Uint8Array {
  const buf: number[] = [];
  if (f.name !== undefined) writeString(buf, FILE.name, f.name);
  if (f.package !== undefined) writeString(buf, FILE.package, f.package);
  for (const m of f.messages ?? []) {
    const nested = (m.nested ?? []).map((n) => buildMessage(n.name));
    writeLenDelim(buf, FILE.messageType, buildMessage(m.name, nested));
  }
  for (const s of f.services ?? []) {
    writeLenDelim(
      buf,
      FILE.service,
      buildService(s.name, s.methods, { deprecated: s.deprecated }),
    );
  }
  return toBytes(buf);
}

// ---- Tests ----------------------------------------------------------------

describe('decodeFileDescriptorProto', () => {
  it('decodes a minimal file with just a name + package', () => {
    const bytes = buildFile({ name: 'users/v1/users.proto', package: 'users.v1' });
    const decoded = decodeFileDescriptorProto(bytes);
    expect(decoded).toEqual({
      name: 'users/v1/users.proto',
      package: 'users.v1',
      messages: [],
      services: [],
    });
  });

  it('decodes a single top-level message', () => {
    const bytes = buildFile({
      name: 'a.proto',
      package: 'pkg',
      messages: [{ name: 'User' }],
    });
    const decoded = decodeFileDescriptorProto(bytes);
    expect(decoded.messages).toEqual([{ name: 'User' }]);
  });

  it('decodes nested messages recursively', () => {
    const bytes = buildFile({
      name: 'a.proto',
      package: 'pkg',
      messages: [{ name: 'Outer', nested: [{ name: 'Inner' }] }],
    });
    const decoded = decodeFileDescriptorProto(bytes);
    expect(decoded.messages[0]).toEqual({
      name: 'Outer',
      nested: [{ name: 'Inner' }],
    });
  });

  it('decodes a service with a unary method', () => {
    const bytes = buildFile({
      name: 'users.proto',
      package: 'users.v1',
      messages: [{ name: 'ListUsersRequest' }, { name: 'ListUsersResponse' }],
      services: [
        {
          name: 'UserService',
          methods: [
            {
              name: 'ListUsers',
              inputType: '.users.v1.ListUsersRequest',
              outputType: '.users.v1.ListUsersResponse',
            },
          ],
        },
      ],
    });
    const decoded = decodeFileDescriptorProto(bytes);
    expect(decoded.services).toEqual([
      {
        name: 'UserService',
        methods: [
          {
            name: 'ListUsers',
            inputType: '.users.v1.ListUsersRequest',
            outputType: '.users.v1.ListUsersResponse',
            clientStreaming: false,
            serverStreaming: false,
            deprecated: false,
          },
        ],
        deprecated: false,
      },
    ]);
  });

  it('decodes streaming flags on methods', () => {
    const bytes = buildFile({
      name: 'chat.proto',
      package: 'chat.v1',
      services: [
        {
          name: 'Chat',
          methods: [
            {
              name: 'Send',
              inputType: '.chat.v1.Msg',
              outputType: '.chat.v1.Ack',
              clientStreaming: true,
            },
            {
              name: 'Stream',
              inputType: '.chat.v1.Req',
              outputType: '.chat.v1.Msg',
              serverStreaming: true,
            },
            {
              name: 'Bidi',
              inputType: '.chat.v1.Msg',
              outputType: '.chat.v1.Msg',
              clientStreaming: true,
              serverStreaming: true,
            },
          ],
        },
      ],
    });
    const decoded = decodeFileDescriptorProto(bytes);
    const [send, stream, bidi] = decoded.services[0].methods;
    expect([send.clientStreaming, send.serverStreaming]).toEqual([true, false]);
    expect([stream.clientStreaming, stream.serverStreaming]).toEqual([false, true]);
    expect([bidi.clientStreaming, bidi.serverStreaming]).toEqual([true, true]);
  });

  it('picks up deprecated flag on methods', () => {
    const bytes = buildFile({
      name: 'legacy.proto',
      package: 'legacy.v1',
      services: [
        {
          name: 'Old',
          methods: [
            {
              name: 'Gone',
              inputType: '.legacy.v1.Req',
              outputType: '.legacy.v1.Resp',
              deprecated: true,
            },
          ],
        },
      ],
    });
    const decoded = decodeFileDescriptorProto(bytes);
    expect(decoded.services[0].methods[0].deprecated).toBe(true);
  });

  it('picks up deprecated flag on services', () => {
    const bytes = buildFile({
      name: 'legacy.proto',
      package: 'legacy.v1',
      services: [
        {
          name: 'Old',
          methods: [
            {
              name: 'Still',
              inputType: '.legacy.v1.Req',
              outputType: '.legacy.v1.Resp',
            },
          ],
          deprecated: true,
        },
      ],
    });
    const decoded = decodeFileDescriptorProto(bytes);
    expect(decoded.services[0].deprecated).toBe(true);
    // Method itself is not marked deprecated.
    expect(decoded.services[0].methods[0].deprecated).toBe(false);
  });

  it('accepts an empty package', () => {
    const bytes = buildFile({ name: 'root.proto', messages: [{ name: 'Root' }] });
    const decoded = decodeFileDescriptorProto(bytes);
    expect(decoded.package).toBe('');
    expect(decoded.messages).toEqual([{ name: 'Root' }]);
  });

  it('skips unknown fields without failing', () => {
    // Build a file that has FILE.name and a bogus field number 99 (varint).
    const buf: number[] = [];
    writeString(buf, FILE.name, 'weird.proto');
    // Unknown field 99, wire type 0 (varint), value 42.
    writeTag(buf, 99, 0);
    writeVarint(buf, 42);
    // Then a real message afterwards to make sure we resumed decoding.
    writeLenDelim(buf, FILE.messageType, buildMessage('AfterUnknown'));

    const decoded = decodeFileDescriptorProto(toBytes(buf));
    expect(decoded.name).toBe('weird.proto');
    expect(decoded.messages).toEqual([{ name: 'AfterUnknown' }]);
  });

  it('skips length-delimited unknown fields', () => {
    const buf: number[] = [];
    writeString(buf, FILE.name, 'x.proto');
    writeLenDelim(buf, 55, [1, 2, 3, 4, 5]);
    writeString(buf, FILE.package, 'x');
    const decoded = decodeFileDescriptorProto(toBytes(buf));
    expect(decoded.name).toBe('x.proto');
    expect(decoded.package).toBe('x');
  });

  it('skips fixed32 + fixed64 unknown fields', () => {
    const buf: number[] = [];
    writeString(buf, FILE.name, 'fx.proto');
    // Unknown fixed32 in field 20 (4 bytes)
    writeTag(buf, 20, 5);
    buf.push(1, 2, 3, 4);
    // Unknown fixed64 in field 21 (8 bytes)
    writeTag(buf, 21, 1);
    buf.push(1, 2, 3, 4, 5, 6, 7, 8);
    writeString(buf, FILE.package, 'fx');
    const decoded = decodeFileDescriptorProto(toBytes(buf));
    expect(decoded).toEqual({
      name: 'fx.proto',
      package: 'fx',
      messages: [],
      services: [],
    });
  });

  it('throws on truncated varint', () => {
    // 0x80 with high bit set + no continuation byte.
    expect(() => decodeFileDescriptorProto(new Uint8Array([0x80]))).toThrow(
      /varint/,
    );
  });

  it('throws on truncated length-delimited field', () => {
    // tag = FILE.name (field 1, wire 2) = 0x0a. Length = 10 but no data.
    expect(() =>
      decodeFileDescriptorProto(new Uint8Array([0x0a, 10])),
    ).toThrow(/length-delimited/);
  });

  it('throws on group wire types (proto2 legacy)', () => {
    // tag = field 1, wire type 3 (start group).
    expect(() => decodeFileDescriptorProto(new Uint8Array([0x0b]))).toThrow(
      /wire type 3|unsupported/,
    );
  });

  it('decodes deeply nested messages', () => {
    const bytes = buildFile({
      name: 'nested.proto',
      package: 'pkg',
      messages: [
        {
          name: 'A',
          nested: [{ name: 'B' }],
        },
      ],
    });
    const decoded = decodeFileDescriptorProto(bytes);
    expect(decoded.messages).toEqual([
      { name: 'A', nested: [{ name: 'B' }] },
    ]);
  });

  it('decodes multiple services in one file', () => {
    const bytes = buildFile({
      name: 'multi.proto',
      package: 'multi.v1',
      messages: [{ name: 'Req' }, { name: 'Resp' }],
      services: [
        {
          name: 'A',
          methods: [
            { name: 'DoA', inputType: '.multi.v1.Req', outputType: '.multi.v1.Resp' },
          ],
        },
        {
          name: 'B',
          methods: [
            { name: 'DoB', inputType: '.multi.v1.Req', outputType: '.multi.v1.Resp' },
          ],
        },
      ],
    });
    const decoded = decodeFileDescriptorProto(bytes);
    expect(decoded.services.map((s) => s.name)).toEqual(['A', 'B']);
  });

  it('throws when the decoded name is empty and no fallback is provided', () => {
    // Empty payload decodes cleanly but fails schema validation because
    // `FileDescriptorProto.name` is required. This is the correct
    // behavior: an anonymous file has no key for `DescriptorIndex`.
    expect(() => decodeFileDescriptorProto(new Uint8Array())).toThrow(
      /schema validation/i,
    );
  });

  it('accepts an empty payload when a fallbackName is provided', () => {
    const decoded = decodeFileDescriptorProto(new Uint8Array(), 'x.proto');
    expect(decoded).toEqual({
      name: 'x.proto',
      package: '',
      messages: [],
      services: [],
    });
  });
});

describe('decodeFileDescriptorSet', () => {
  it('decodes a batch of files independently', () => {
    const a = buildFile({ name: 'a.proto', package: 'a' });
    const b = buildFile({ name: 'b.proto', package: 'b' });
    const result = decodeFileDescriptorSet([
      { name: 'a.proto', bytes: a },
      { name: 'b.proto', bytes: b },
    ]);
    expect(result.diagnostics).toEqual([]);
    expect(result.files.map((f) => f.package)).toEqual(['a', 'b']);
  });

  it('reports a per-file diagnostic without losing the rest of the batch', () => {
    const good = buildFile({ name: 'good.proto', package: 'g' });
    // Truncated payload — length says 10 bytes, buffer only has 2.
    const bad = new Uint8Array([0x0a, 10]);
    const result = decodeFileDescriptorSet([
      { name: 'bad.proto', bytes: bad },
      { name: 'good.proto', bytes: good },
    ]);
    expect(result.files.map((f) => f.name)).toEqual(['good.proto']);
    expect(result.diagnostics).toHaveLength(1);
    expect(result.diagnostics[0].name).toBe('bad.proto');
    expect(result.diagnostics[0].message).toMatch(/length-delimited/);
  });

  it('falls back to the transport-level name when the encoded name is empty', () => {
    const bytes = buildFile({ package: 'no.name' });
    const result = decodeFileDescriptorSet([
      { name: 'fallback.proto', bytes },
    ]);
    expect(result.files[0].name).toBe('fallback.proto');
    expect(result.files[0].package).toBe('no.name');
  });

  it('prefers the encoded name when both are present', () => {
    const bytes = buildFile({ name: 'encoded.proto', package: 'x' });
    const result = decodeFileDescriptorSet([
      { name: 'transport.proto', bytes },
    ]);
    expect(result.files[0].name).toBe('encoded.proto');
  });

  it('handles an empty batch', () => {
    const result = decodeFileDescriptorSet([]);
    expect(result).toEqual({ files: [], diagnostics: [] });
  });

  it('yields output compatible with DescriptorIndex.from', async () => {
    // End-to-end wiring check: decoder → DescriptorIndex → findMethod.
    const bytes = buildFile({
      name: 'orders.proto',
      package: 'orders.v1',
      messages: [{ name: 'GetReq' }, { name: 'GetResp' }],
      services: [
        {
          name: 'Orders',
          methods: [
            {
              name: 'Get',
              inputType: '.orders.v1.GetReq',
              outputType: '.orders.v1.GetResp',
            },
          ],
        },
      ],
    });
    const { files } = decodeFileDescriptorSet([{ name: 'orders.proto', bytes }]);
    const { DescriptorIndex } = await import(
      '../src/core/grpcDescriptorIndex.js'
    );
    const idx = DescriptorIndex.from(files);
    const resolved = idx.findMethod('orders.v1.Orders/Get');
    expect(resolved?.methodName).toBe('Get');
    expect(resolved?.inputTypeFqn).toBe('.orders.v1.GetReq');
    expect(resolved?.outputTypeFqn).toBe('.orders.v1.GetResp');
    expect(resolved?.clientStreaming).toBe(false);
    expect(resolved?.serverStreaming).toBe(false);
  });
});
