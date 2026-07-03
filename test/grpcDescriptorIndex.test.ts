import { describe, it, expect } from 'vitest';
import {
  DescriptorIndex,
  FileDescriptorProtoSchema,
} from '../src/core/grpcDescriptorIndex.js';

/**
 * Convenience: build a minimal file descriptor for tests.
 * Only the fields our zod schema requires — the rest default in.
 */
function file(
  name: string,
  pkg: string,
  services: Array<{
    name: string;
    methods: Array<{
      name: string;
      inputType: string;
      outputType: string;
      clientStreaming?: boolean;
      serverStreaming?: boolean;
      deprecated?: boolean;
    }>;
    deprecated?: boolean;
  }>,
  messages: Array<{ name: string; nested?: unknown[] }>,
): unknown {
  return { name, package: pkg, services, messages };
}

describe('DescriptorIndex', () => {
  it('resolves a package-qualified method with leading-dot type references', () => {
    const idx = DescriptorIndex.from([
      file(
        'users/v1/users.proto',
        'users.v1',
        [
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
        [{ name: 'ListUsersRequest' }, { name: 'ListUsersResponse' }],
      ),
    ]);

    const m = idx.findMethod('users.v1.UserService/ListUsers');
    expect(m).toEqual({
      serviceFqn: '.users.v1.UserService',
      methodName: 'ListUsers',
      inputTypeFqn: '.users.v1.ListUsersRequest',
      outputTypeFqn: '.users.v1.ListUsersResponse',
      clientStreaming: false,
      serverStreaming: false,
      deprecated: false,
    });
  });

  it('accepts leading-dot service FQN and split-argument form', () => {
    const idx = DescriptorIndex.from([
      file(
        'a.proto',
        'a',
        [{ name: 'S', methods: [{ name: 'M', inputType: '.a.Req', outputType: '.a.Res' }] }],
        [{ name: 'Req' }, { name: 'Res' }],
      ),
    ]);

    expect(idx.findMethod('.a.S', 'M')?.methodName).toBe('M');
    expect(idx.findMethod('.a.S/M')?.methodName).toBe('M');
    expect(idx.findMethod('a.S/M')?.methodName).toBe('M');
  });

  it('returns undefined for unknown services and unknown methods', () => {
    const idx = DescriptorIndex.from([
      file(
        'a.proto',
        'a',
        [{ name: 'S', methods: [{ name: 'M', inputType: '.a.Req', outputType: '.a.Res' }] }],
        [{ name: 'Req' }, { name: 'Res' }],
      ),
    ]);

    expect(idx.findMethod('a.Nope/M')).toBeUndefined();
    expect(idx.findMethod('a.S/Nope')).toBeUndefined();
    expect(idx.findMethod('malformed-no-slash')).toBeUndefined();
    expect(idx.findMethod('')).toBeUndefined();
  });

  it('resolves relative type references using protoc scope-walking rules', () => {
    // input_type = "Req" (bare) → must resolve to .foo.bar.Req via package scope.
    const idx = DescriptorIndex.from([
      file(
        'nested.proto',
        'foo.bar',
        [{ name: 'S', methods: [{ name: 'M', inputType: 'Req', outputType: 'Res' }] }],
        [{ name: 'Req' }, { name: 'Res' }],
      ),
    ]);

    const m = idx.findMethod('foo.bar.S/M');
    expect(m?.inputTypeFqn).toBe('.foo.bar.Req');
    expect(m?.outputTypeFqn).toBe('.foo.bar.Res');
  });

  it('walks parent scopes when a relative reference is not in the innermost package', () => {
    // Method in package `foo.bar` refers to bare "Root" which only exists in package `foo`.
    const idx = DescriptorIndex.from([
      file('root.proto', 'foo', [], [{ name: 'Root' }]),
      file(
        'inner.proto',
        'foo.bar',
        [{ name: 'S', methods: [{ name: 'M', inputType: 'Root', outputType: 'Root' }] }],
        [],
      ),
    ]);

    const m = idx.findMethod('foo.bar.S/M');
    expect(m?.inputTypeFqn).toBe('.foo.Root');
  });

  it('flattens nested message types into the FQN space', () => {
    const idx = DescriptorIndex.from([
      file(
        'nested.proto',
        'pkg',
        [
          {
            name: 'S',
            methods: [
              {
                name: 'M',
                inputType: '.pkg.Outer.Inner',
                outputType: '.pkg.Outer.Inner.Deep',
              },
            ],
          },
        ],
        [
          {
            name: 'Outer',
            nested: [{ name: 'Inner', nested: [{ name: 'Deep' }] }],
          },
        ],
      ),
    ]);

    expect(idx.hasType('.pkg.Outer')).toBe(true);
    expect(idx.hasType('pkg.Outer.Inner')).toBe(true);
    expect(idx.hasType('.pkg.Outer.Inner.Deep')).toBe(true);
    expect(idx.findMethod('pkg.S/M')?.outputTypeFqn).toBe('.pkg.Outer.Inner.Deep');
  });

  it('handles the empty-package case', () => {
    const idx = DescriptorIndex.from([
      file(
        'root.proto',
        '',
        [{ name: 'RootService', methods: [{ name: 'Ping', inputType: '.Ping', outputType: '.Pong' }] }],
        [{ name: 'Ping' }, { name: 'Pong' }],
      ),
    ]);

    const m = idx.findMethod('RootService/Ping');
    expect(m?.serviceFqn).toBe('.RootService');
    expect(m?.inputTypeFqn).toBe('.Ping');
  });

  it('throws when a method points at a type that isnt loaded', () => {
    const idx = DescriptorIndex.from([
      file(
        'a.proto',
        'a',
        [{ name: 'S', methods: [{ name: 'M', inputType: '.a.Missing', outputType: '.a.Res' }] }],
        [{ name: 'Res' }],
      ),
    ]);

    expect(() => idx.findMethod('a.S/M')).toThrowError(/unknown input type "\.a\.Missing"/);
  });

  it('propagates streaming and deprecated flags', () => {
    const idx = DescriptorIndex.from([
      file(
        'a.proto',
        'a',
        [
          {
            name: 'S',
            deprecated: true,
            methods: [
              {
                name: 'M',
                inputType: '.a.Req',
                outputType: '.a.Res',
                clientStreaming: true,
                serverStreaming: true,
              },
            ],
          },
          {
            name: 'T',
            methods: [
              {
                name: 'DeprecatedMethod',
                inputType: '.a.Req',
                outputType: '.a.Res',
                deprecated: true,
              },
              {
                name: 'FreshMethod',
                inputType: '.a.Req',
                outputType: '.a.Res',
              },
            ],
          },
        ],
        [{ name: 'Req' }, { name: 'Res' }],
      ),
    ]);

    const streaming = idx.findMethod('a.S/M');
    expect(streaming?.clientStreaming).toBe(true);
    expect(streaming?.serverStreaming).toBe(true);
    expect(streaming?.deprecated).toBe(true); // service deprecated

    expect(idx.findMethod('a.T/DeprecatedMethod')?.deprecated).toBe(true);
    expect(idx.findMethod('a.T/FreshMethod')?.deprecated).toBe(false);
  });

  it('replaces a file when addFile is called again with the same name', () => {
    const idx = new DescriptorIndex();
    idx.addFile(
      file(
        'a.proto',
        'a',
        [{ name: 'S', methods: [{ name: 'Old', inputType: '.a.Req', outputType: '.a.Res' }] }],
        [{ name: 'Req' }, { name: 'Res' }],
      ),
    );
    expect(idx.findMethod('a.S/Old')).toBeDefined();

    // Reload with a different method — old one should vanish.
    idx.addFile(
      file(
        'a.proto',
        'a',
        [{ name: 'S', methods: [{ name: 'New', inputType: '.a.Req', outputType: '.a.Res' }] }],
        [{ name: 'Req' }, { name: 'Res' }],
      ),
    );
    expect(idx.findMethod('a.S/Old')).toBeUndefined();
    expect(idx.findMethod('a.S/New')).toBeDefined();
    expect(idx.fileCount).toBe(1);
  });

  it('removeFile clears services and types from that file only', () => {
    const idx = DescriptorIndex.from([
      file(
        'a.proto',
        'a',
        [{ name: 'AS', methods: [{ name: 'M', inputType: '.a.Req', outputType: '.a.Res' }] }],
        [{ name: 'Req' }, { name: 'Res' }],
      ),
      file(
        'b.proto',
        'b',
        [{ name: 'BS', methods: [{ name: 'N', inputType: '.b.Req', outputType: '.b.Res' }] }],
        [{ name: 'Req' }, { name: 'Res' }],
      ),
    ]);

    idx.removeFile('a.proto');
    expect(idx.findMethod('a.AS/M')).toBeUndefined();
    expect(idx.hasType('.a.Req')).toBe(false);
    expect(idx.findMethod('b.BS/N')).toBeDefined();
    expect(idx.hasType('.b.Req')).toBe(true);
    expect(idx.fileCount).toBe(1);
  });

  it('listServices returns sorted FQNs', () => {
    const idx = DescriptorIndex.from([
      file(
        'z.proto',
        'z',
        [{ name: 'Z', methods: [] }],
        [],
      ),
      file(
        'a.proto',
        'a',
        [{ name: 'A', methods: [] }, { name: 'B', methods: [] }],
        [],
      ),
    ]);
    expect(idx.listServices()).toEqual(['.a.A', '.a.B', '.z.Z']);
  });

  it('rejects malformed descriptors at the boundary', () => {
    expect(() => new DescriptorIndex().addFile({})).toThrow();
    expect(() =>
      new DescriptorIndex().addFile({
        name: 'a.proto',
        package: 'a',
        services: [{ name: '', methods: [] }], // empty name violates .min(1)
        messages: [],
      }),
    ).toThrow();
    // Sanity: schema-parses a minimal shape.
    expect(() =>
      FileDescriptorProtoSchema.parse({ name: 'a.proto' }),
    ).not.toThrow();
  });

  it('clear() resets everything', () => {
    const idx = DescriptorIndex.from([
      file(
        'a.proto',
        'a',
        [{ name: 'S', methods: [{ name: 'M', inputType: '.a.Req', outputType: '.a.Res' }] }],
        [{ name: 'Req' }, { name: 'Res' }],
      ),
    ]);
    idx.clear();
    expect(idx.fileCount).toBe(0);
    expect(idx.findMethod('a.S/M')).toBeUndefined();
    expect(idx.listServices()).toEqual([]);
  });
});
