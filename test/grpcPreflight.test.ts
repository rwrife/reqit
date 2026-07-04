import { describe, it, expect } from 'vitest';
import { DescriptorIndex } from '../src/core/grpcDescriptorIndex.js';
import type { ParsedGrpcRequest } from '../src/core/grpc.js';
import {
  preflightGrpcRequest,
  preflightBannerClass,
  type PreflightStatus,
} from '../src/core/grpcPreflight.js';

/**
 * Small builder for a fully-populated ParsedGrpcRequest — mirrors what
 * `parseGrpcBlock` would emit, without pulling the parser in for tests
 * whose focus is preflight logic.
 */
function request(
  overrides: Partial<ParsedGrpcRequest> & {
    service: string;
    method: string;
    host?: string;
    port?: number;
    plaintext?: boolean;
  },
): ParsedGrpcRequest {
  return {
    target: {
      host: overrides.host ?? 'grpc.example.com',
      port: overrides.port ?? 443,
      service: overrides.service,
      method: overrides.method,
      plaintext: overrides.plaintext ?? false,
    },
    authProfile: overrides.authProfile,
    body: overrides.body,
    metadata: overrides.metadata ?? {},
  };
}

/**
 * Build a minimal DescriptorIndex containing a single service with the
 * given methods. Keeps tests concise.
 */
function indexWith(
  pkg: string,
  serviceName: string,
  methods: Array<{
    name: string;
    inputType: string;
    outputType: string;
    clientStreaming?: boolean;
    serverStreaming?: boolean;
    deprecated?: boolean;
  }>,
  messages: Array<{ name: string }>,
  opts: { serviceDeprecated?: boolean } = {},
): DescriptorIndex {
  return DescriptorIndex.from([
    {
      name: `${pkg.replace(/\./g, '/') || 'root'}/${serviceName}.proto`,
      package: pkg,
      services: [
        {
          name: serviceName,
          methods,
          deprecated: opts.serviceDeprecated ?? false,
        },
      ],
      messages,
    },
  ]);
}

describe('preflightGrpcRequest', () => {
  it('returns `missing-descriptors` when no index is provided', () => {
    const report = preflightGrpcRequest(
      request({ service: 'users.v1.UserService', method: 'ListUsers' }),
    );
    expect(report.status).toBe('missing-descriptors');
    expect(report.summary).toMatch(/reflection/i);
    // The informational note about reflection should be present.
    expect(report.messages[0].level).toBe('info');
    expect(report.messages[0].text).toMatch(/issue #24/);
    expect(report.resolved).toBeUndefined();
  });

  it('still surfaces metadata warnings even without descriptors', () => {
    const report = preflightGrpcRequest(
      request({
        service: 'users.v1.UserService',
        method: 'ListUsers',
        metadata: { 'content-type': 'application/json' },
      }),
    );
    expect(report.status).toBe('missing-descriptors');
    // The metadata warning should be appended after the info note.
    expect(
      report.messages.some(
        (m) => m.level === 'warn' && m.text.includes('content-type'),
      ),
    ).toBe(true);
  });

  it('returns `ready` when method resolves cleanly and no warnings fire', () => {
    const idx = indexWith(
      'users.v1',
      'UserService',
      [
        {
          name: 'ListUsers',
          inputType: '.users.v1.ListUsersRequest',
          outputType: '.users.v1.ListUsersResponse',
        },
      ],
      [{ name: 'ListUsersRequest' }, { name: 'ListUsersResponse' }],
    );
    const report = preflightGrpcRequest(
      request({ service: 'users.v1.UserService', method: 'ListUsers' }),
      { descriptors: idx },
    );
    expect(report.status).toBe('ready');
    expect(report.summary).toContain('users.v1.UserService/ListUsers');
    expect(report.summary).toContain(
      'users.v1.ListUsersRequest → users.v1.ListUsersResponse',
    );
    expect(report.messages).toHaveLength(0);
    expect(report.resolved?.methodName).toBe('ListUsers');
  });

  it('flags unknown service with a helpful list of what IS available', () => {
    const idx = indexWith(
      'users.v1',
      'UserService',
      [
        {
          name: 'ListUsers',
          inputType: '.users.v1.ListUsersRequest',
          outputType: '.users.v1.ListUsersResponse',
        },
      ],
      [{ name: 'ListUsersRequest' }, { name: 'ListUsersResponse' }],
    );
    const report = preflightGrpcRequest(
      request({ service: 'unknown.pkg.OtherService', method: 'ListUsers' }),
      { descriptors: idx },
    );
    expect(report.status).toBe('unknown-service');
    expect(report.summary).toMatch(/not exposed/);
    // Available services list should include ours minus the leading dot.
    expect(report.messages[0].text).toContain('users.v1.UserService');
  });

  it('flags unknown method (but known service) separately from unknown service', () => {
    const idx = indexWith(
      'users.v1',
      'UserService',
      [
        {
          name: 'ListUsers',
          inputType: '.users.v1.ListUsersRequest',
          outputType: '.users.v1.ListUsersResponse',
        },
      ],
      [{ name: 'ListUsersRequest' }, { name: 'ListUsersResponse' }],
    );
    const report = preflightGrpcRequest(
      request({ service: 'users.v1.UserService', method: 'ListWidgets' }),
      { descriptors: idx },
    );
    expect(report.status).toBe('unknown-method');
    expect(report.summary).toMatch(/ListWidgets.*is not defined on.*UserService/);
    expect(report.messages[0].text).toMatch(/case-sensitive/);
  });

  it('flags server-streaming methods as unsupported in v1', () => {
    const idx = indexWith(
      'events.v1',
      'EventStream',
      [
        {
          name: 'Tail',
          inputType: '.events.v1.TailRequest',
          outputType: '.events.v1.Event',
          serverStreaming: true,
        },
      ],
      [{ name: 'TailRequest' }, { name: 'Event' }],
    );
    const report = preflightGrpcRequest(
      request({ service: 'events.v1.EventStream', method: 'Tail' }),
      { descriptors: idx },
    );
    expect(report.status).toBe('streaming-unsupported');
    expect(report.summary).toMatch(/server-streaming/);
    expect(report.resolved?.serverStreaming).toBe(true);
  });

  it('names bidirectional streaming when both flags are set', () => {
    const idx = indexWith(
      'chat.v1',
      'Chat',
      [
        {
          name: 'Session',
          inputType: '.chat.v1.Msg',
          outputType: '.chat.v1.Msg',
          clientStreaming: true,
          serverStreaming: true,
        },
      ],
      [{ name: 'Msg' }],
    );
    const report = preflightGrpcRequest(
      request({ service: 'chat.v1.Chat', method: 'Session' }),
      { descriptors: idx },
    );
    expect(report.status).toBe('streaming-unsupported');
    expect(report.summary).toMatch(/bidirectional-streaming/);
  });

  it('warns (not errors) on deprecated method but still reports ready-with-warnings', () => {
    const idx = indexWith(
      'legacy.v1',
      'LegacyService',
      [
        {
          name: 'OldCall',
          inputType: '.legacy.v1.Req',
          outputType: '.legacy.v1.Resp',
          deprecated: true,
        },
      ],
      [{ name: 'Req' }, { name: 'Resp' }],
    );
    const report = preflightGrpcRequest(
      request({ service: 'legacy.v1.LegacyService', method: 'OldCall' }),
      { descriptors: idx },
    );
    expect(report.status).toBe('ready-with-warnings');
    expect(report.summary).toContain('with warnings');
    expect(
      report.messages.some(
        (m) => m.level === 'warn' && m.text.match(/deprecated/i),
      ),
    ).toBe(true);
    // Deprecation shouldn't stop us from being ready.
    expect(report.resolved).toBeDefined();
  });

  it('inherits deprecation from the service, not just the method', () => {
    const idx = indexWith(
      'legacy.v1',
      'LegacyService',
      [
        {
          name: 'StillWorks',
          inputType: '.legacy.v1.Req',
          outputType: '.legacy.v1.Resp',
        },
      ],
      [{ name: 'Req' }, { name: 'Resp' }],
      { serviceDeprecated: true },
    );
    const report = preflightGrpcRequest(
      request({ service: 'legacy.v1.LegacyService', method: 'StillWorks' }),
      { descriptors: idx },
    );
    expect(report.status).toBe('ready-with-warnings');
  });

  it('surfaces broken descriptor sets as `descriptor-error` (no throw)', () => {
    // Method points at an input type that isn't declared anywhere.
    const idx = indexWith(
      'broken.v1',
      'BrokenService',
      [
        {
          name: 'Call',
          inputType: '.broken.v1.NopeMissing',
          outputType: '.broken.v1.Resp',
        },
      ],
      [{ name: 'Resp' }],
    );
    const report = preflightGrpcRequest(
      request({ service: 'broken.v1.BrokenService', method: 'Call' }),
      { descriptors: idx },
    );
    expect(report.status).toBe('descriptor-error');
    expect(report.messages[0].level).toBe('error');
    expect(report.messages[0].text).toMatch(/NopeMissing/);
  });

  it('warns when the user sets a reserved gRPC metadata header', () => {
    const idx = indexWith(
      'users.v1',
      'UserService',
      [
        {
          name: 'ListUsers',
          inputType: '.users.v1.Req',
          outputType: '.users.v1.Resp',
        },
      ],
      [{ name: 'Req' }, { name: 'Resp' }],
    );
    const report = preflightGrpcRequest(
      request({
        service: 'users.v1.UserService',
        method: 'ListUsers',
        metadata: { te: 'trailers', 'grpc-timeout': '10S' },
      }),
      { descriptors: idx },
    );
    expect(report.status).toBe('ready-with-warnings');
    // Two reserved header warnings.
    const warnTexts = report.messages
      .filter((m) => m.level === 'warn')
      .map((m) => m.text);
    expect(warnTexts.some((t) => t.includes('"te"'))).toBe(true);
    expect(warnTexts.some((t) => t.includes('"grpc-timeout"'))).toBe(true);
  });

  it('warns on non-reserved grpc-prefixed metadata', () => {
    const idx = indexWith(
      'users.v1',
      'UserService',
      [
        {
          name: 'ListUsers',
          inputType: '.users.v1.Req',
          outputType: '.users.v1.Resp',
        },
      ],
      [{ name: 'Req' }, { name: 'Resp' }],
    );
    const report = preflightGrpcRequest(
      request({
        service: 'users.v1.UserService',
        method: 'ListUsers',
        metadata: { 'grpc-custom-thing': 'x' },
      }),
      { descriptors: idx },
    );
    expect(report.status).toBe('ready-with-warnings');
    expect(
      report.messages.some(
        (m) => m.level === 'warn' && m.text.includes('grpc-custom-thing'),
      ),
    ).toBe(true);
  });

  it('emits an info note for -bin metadata (base64 expected)', () => {
    const idx = indexWith(
      'users.v1',
      'UserService',
      [
        {
          name: 'ListUsers',
          inputType: '.users.v1.Req',
          outputType: '.users.v1.Resp',
        },
      ],
      [{ name: 'Req' }, { name: 'Resp' }],
    );
    const report = preflightGrpcRequest(
      request({
        service: 'users.v1.UserService',
        method: 'ListUsers',
        metadata: { 'trace-id-bin': 'YWJjZA==' },
      }),
      { descriptors: idx },
    );
    // Info-only shouldn't downgrade to warnings.
    expect(report.status).toBe('ready');
    expect(
      report.messages.some(
        (m) => m.level === 'info' && m.text.includes('trace-id-bin'),
      ),
    ).toBe(true);
  });

  it('accepts service names with a leading dot in the parsed target', () => {
    // parseGrpcTarget would never emit this today, but the resolver
    // should still work if a caller supplies the leading-dot form.
    const idx = indexWith(
      'users.v1',
      'UserService',
      [
        {
          name: 'ListUsers',
          inputType: '.users.v1.Req',
          outputType: '.users.v1.Resp',
        },
      ],
      [{ name: 'Req' }, { name: 'Resp' }],
    );
    const report = preflightGrpcRequest(
      request({ service: '.users.v1.UserService', method: 'ListUsers' }),
      { descriptors: idx },
    );
    expect(report.status).toBe('ready');
  });
});

describe('preflightBannerClass', () => {
  it('maps each PreflightStatus to a stable CSS class', () => {
    const cases: Array<[PreflightStatus, string]> = [
      ['ready', 'preflight-ready'],
      ['ready-with-warnings', 'preflight-warn'],
      ['streaming-unsupported', 'preflight-error'],
      ['unknown-service', 'preflight-error'],
      ['unknown-method', 'preflight-error'],
      ['descriptor-error', 'preflight-error'],
      ['missing-descriptors', 'preflight-info'],
    ];
    for (const [status, expected] of cases) {
      expect(preflightBannerClass(status)).toBe(expected);
    }
  });
});
