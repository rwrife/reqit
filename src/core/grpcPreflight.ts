/**
 * Preflight report for a parsed `.grpc` request.
 *
 * The `reqit.sendGrpcRequest` command currently short-circuits into a
 * preview panel because the live wire dispatch (@grpc/grpc-js + reflection
 * + mTLS) hasn't landed yet. Users staring at that preview panel deserve
 * something more actionable than "we parsed your request, byeee!" — hence
 * this module.
 *
 * Given a parsed request and (optionally) a `DescriptorIndex` — the shape
 * the reflection cache already produces — we compute:
 *
 *   1. Whether the target `Service/Method` is defined in the loaded
 *      descriptors, and if so what its input/output types + streaming
 *      flags look like.
 *   2. A single-line banner status the response panel can show up top.
 *   3. Zero or more diagnostic messages the panel can render as a bullet
 *      list under the banner (unknown method, deprecated method, streaming
 *      not yet supported, metadata warnings, etc.).
 *
 * This module is pure, VS Code-free, transport-free, and lives in
 * `src/core/` so it stays unit-testable per AGENTS.md coding standards.
 *
 * Wire-up path once live dispatch lands:
 *   - reflection cache → `DescriptorIndex` (already implemented)
 *   - `preflightGrpcRequest(request, { descriptors })` before invoking
 *     `@grpc/grpc-js`; short-circuit with an error banner if the report
 *     says `unknown-method` or `missing-descriptors`.
 */

import type { DescriptorIndex, ResolvedMethod } from './grpcDescriptorIndex.js';
import type { ParsedGrpcRequest } from './grpc.js';

/**
 * High-level preflight verdict. Ordered from "ready to send" toward
 * "definitely cannot send yet"; the panel banner picks colour based on
 * this alone.
 */
export type PreflightStatus =
  | 'ready'
  | 'ready-with-warnings'
  | 'streaming-unsupported'
  | 'missing-descriptors'
  | 'unknown-service'
  | 'unknown-method'
  | 'descriptor-error';

export interface PreflightMessage {
  level: 'info' | 'warn' | 'error';
  text: string;
}

export interface PreflightReport {
  status: PreflightStatus;
  /** One-line status suitable for the panel banner. */
  summary: string;
  /** Actionable details, in the order they should be shown. */
  messages: PreflightMessage[];
  /** Populated when the method resolved cleanly (status starts with `ready`). */
  resolved?: ResolvedMethod;
}

export interface PreflightOptions {
  /**
   * Descriptor index built from the reflection cache. Optional — when
   * absent the report tells the user we couldn't verify the method
   * against a proto schema yet.
   */
  descriptors?: DescriptorIndex;
}

/**
 * CSS class used by the response webview banner. Kept string-only so the
 * extension layer can drop it straight into a `class` attribute without
 * pulling any part of this module into a VS Code-typed API.
 */
export type PreflightBannerClass =
  | 'preflight-ready'
  | 'preflight-warn'
  | 'preflight-error'
  | 'preflight-info';

/**
 * Map a preflight status to a webview banner class. Pure lookup — kept in
 * `src/core/` so the extension-layer HTML template stays a trivial shim.
 */
export function preflightBannerClass(
  status: PreflightStatus,
): PreflightBannerClass {
  switch (status) {
    case 'ready':
      return 'preflight-ready';
    case 'ready-with-warnings':
      return 'preflight-warn';
    case 'streaming-unsupported':
    case 'unknown-service':
    case 'unknown-method':
    case 'descriptor-error':
      return 'preflight-error';
    case 'missing-descriptors':
      return 'preflight-info';
  }
}

/**
 * Compute a preflight report for a single parsed `.grpc` request.
 *
 * Never throws. Broken descriptors surface as `descriptor-error` in the
 * report so the response panel can render them like any other diagnostic
 * instead of blowing up the whole preview.
 */
export function preflightGrpcRequest(
  request: ParsedGrpcRequest,
  opts: PreflightOptions = {},
): PreflightReport {
  const messages: PreflightMessage[] = [];

  // Cheap, always-on checks that don't need descriptors.
  collectMetadataWarnings(request, messages);

  const { descriptors } = opts;
  if (!descriptors) {
    // No reflection data yet — say so, but still surface any metadata
    // warnings we found above so the user gets *some* feedback.
    return {
      status: 'missing-descriptors',
      summary:
        'No reflection data loaded — cannot verify method against a proto schema yet.',
      messages: [
        {
          level: 'info',
          text: 'Live dispatch will pull descriptors via server-reflection (issue #24). Preflight will then verify the request type and streaming shape.',
        },
        ...messages,
      ],
    };
  }

  const serviceFqn = ensureLeadingDot(request.target.service);

  let resolved: ResolvedMethod | undefined;
  try {
    resolved = descriptors.findMethod(serviceFqn, request.target.method);
  } catch (err) {
    // findMethod throws on broken descriptor sets (missing input/output
    // types). Surface it verbatim rather than pretending the method is
    // fine — the user needs to fix the server's proto set.
    return {
      status: 'descriptor-error',
      summary: `Descriptor set for ${request.target.service}/${request.target.method} is broken.`,
      messages: [
        { level: 'error', text: (err as Error).message },
        ...messages,
      ],
    };
  }

  if (!resolved) {
    // Distinguish "service unknown" from "method not on service" so the
    // panel can offer a smarter hint (typo in service name vs. method).
    const services = descriptors.listServices();
    const serviceKnown = services.includes(serviceFqn);
    if (!serviceKnown) {
      return {
        status: 'unknown-service',
        summary: `Service ${request.target.service} is not exposed by this server's reflection set.`,
        messages: [
          {
            level: 'error',
            text: `Service "${request.target.service}" not found. Known services: ${
              services.length === 0
                ? '(none advertised via reflection)'
                : services.map(stripLeadingDot).join(', ')
            }`,
          },
          ...messages,
        ],
      };
    }
    return {
      status: 'unknown-method',
      summary: `Method ${request.target.method} is not defined on ${request.target.service}.`,
      messages: [
        {
          level: 'error',
          text: `Method "${request.target.method}" not found on "${request.target.service}". Double-check casing (proto methods are case-sensitive).`,
        },
        ...messages,
      ],
    };
  }

  // Method resolved. Look at streaming + deprecation.
  const streaming = resolved.clientStreaming || resolved.serverStreaming;
  if (streaming) {
    const kind = resolveStreamingKind(resolved);
    return {
      status: 'streaming-unsupported',
      summary: `${request.target.service}/${request.target.method} is a ${kind} call — Reqit only supports unary calls in v1.`,
      messages: [
        {
          level: 'error',
          text: `${kind} calls are out of scope for the v1 gRPC support (issue #24 acceptance criteria). Fall back to a unary method for now.`,
        },
        ...messages,
      ],
      resolved,
    };
  }

  if (resolved.deprecated) {
    messages.push({
      level: 'warn',
      text: `Method is marked deprecated in the proto schema. It will still be called but consider migrating.`,
    });
  }

  const hasWarnings = messages.some((m) => m.level === 'warn');
  const summary = hasWarnings
    ? `Ready to send (with warnings): ${request.target.service}/${request.target.method} (${stripLeadingDot(resolved.inputTypeFqn)} → ${stripLeadingDot(resolved.outputTypeFqn)}).`
    : `Ready to send: ${request.target.service}/${request.target.method} (${stripLeadingDot(resolved.inputTypeFqn)} → ${stripLeadingDot(resolved.outputTypeFqn)}).`;

  return {
    status: hasWarnings ? 'ready-with-warnings' : 'ready',
    summary,
    messages,
    resolved,
  };
}

// ---- helpers ---------------------------------------------------------------

/**
 * Warn on metadata headers that gRPC treats specially. This runs even
 * without descriptors — it only depends on the parsed request.
 */
function collectMetadataWarnings(
  request: ParsedGrpcRequest,
  out: PreflightMessage[],
): void {
  const meta = request.metadata;
  // Reserved / auto-managed gRPC headers users occasionally set by hand.
  const reserved = new Set([
    'te',
    'content-type',
    ':authority',
    ':method',
    ':path',
    ':scheme',
    ':status',
    'grpc-encoding',
    'grpc-accept-encoding',
    'grpc-timeout',
    'user-agent',
  ]);
  for (const key of Object.keys(meta)) {
    if (reserved.has(key)) {
      out.push({
        level: 'warn',
        text: `Metadata header "${key}" is reserved by the gRPC transport — Reqit will strip or override it at send time.`,
      });
    }
    if (key.startsWith('grpc-') && !reserved.has(key)) {
      out.push({
        level: 'warn',
        text: `Metadata header "${key}" uses the reserved "grpc-" prefix; some servers will reject it.`,
      });
    }
    // Binary metadata must be base64 in gRPC. We surface a note so users
    // know Reqit will pass their value through untouched.
    if (key.endsWith('-bin')) {
      out.push({
        level: 'info',
        text: `Metadata "${key}" ends in "-bin"; gRPC treats this as binary and the value must already be base64-encoded.`,
      });
    }
  }
}

function resolveStreamingKind(m: ResolvedMethod): string {
  if (m.clientStreaming && m.serverStreaming) return 'bidirectional-streaming';
  if (m.clientStreaming) return 'client-streaming';
  return 'server-streaming';
}

function ensureLeadingDot(fqn: string): string {
  return fqn.startsWith('.') ? fqn : `.${fqn}`;
}

function stripLeadingDot(fqn: string): string {
  return fqn.startsWith('.') ? fqn.slice(1) : fqn;
}
