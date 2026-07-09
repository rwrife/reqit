/**
 * gRPC status-code taxonomy + actionable hint mapping.
 *
 * When the runner surfaces a gRPC failure the response panel needs two
 * things:
 *   1. A canonical name for the numeric `grpc-status` code the server
 *      (or the local `@grpc/grpc-js` client) returned.
 *   2. A short, actionable "here's what usually causes this" hint so the
 *      user can fix the request without hunting through the gRPC docs.
 *
 * That's exactly what this module does, and nothing more. It has zero
 * runtime dependencies on `@grpc/grpc-js` or VS Code — the status enum
 * is small, stable, and standardized in the gRPC status-code doc; we
 * ship it inline so the pure module can be unit-tested without pulling
 * the transport into `src/core/`.
 *
 * Reference:
 *   https://grpc.io/docs/guides/status-codes/
 *   https://github.com/grpc/grpc-node/blob/master/packages/grpc-js/src/constants.ts
 *
 * Issue #24 acceptance criteria call out UNAVAILABLE, UNAUTHENTICATED,
 * and "reflection-not-supported" as the failure modes users hit most —
 * this module gives each one a first-class hint. Unknown numeric codes
 * fall back to a generic hint with the code number, so a future protocol
 * addition never crashes the panel.
 */

/**
 * Canonical gRPC status codes. Values are the wire numbers the server
 * returns in the `grpc-status` trailer.
 */
export enum GrpcStatusCode {
  OK = 0,
  CANCELLED = 1,
  UNKNOWN = 2,
  INVALID_ARGUMENT = 3,
  DEADLINE_EXCEEDED = 4,
  NOT_FOUND = 5,
  ALREADY_EXISTS = 6,
  PERMISSION_DENIED = 7,
  RESOURCE_EXHAUSTED = 8,
  FAILED_PRECONDITION = 9,
  ABORTED = 10,
  OUT_OF_RANGE = 11,
  UNIMPLEMENTED = 12,
  INTERNAL = 13,
  UNAVAILABLE = 14,
  DATA_LOSS = 15,
  UNAUTHENTICATED = 16,
}

/**
 * A synthetic status we surface when the reflection round-trip fails
 * because the server doesn't implement the reflection service at all
 * (or has it disabled). Not part of the gRPC spec — negative to avoid
 * collision with any future numeric code addition.
 */
export const REFLECTION_UNSUPPORTED_CODE = -1 as const;

export interface GrpcErrorReport {
  /**
   * The numeric status code. Server-provided codes are non-negative;
   * `REFLECTION_UNSUPPORTED_CODE` is used for the client-synthesized
   * "reflection unsupported" case so the panel can render it consistently.
   */
  code: number;
  /** Canonical name (e.g. `"UNAVAILABLE"`) or `"UNKNOWN(42)"` for unrecognized codes. */
  name: string;
  /** Free-form description straight off the wire (`grpc-message` trailer), if any. */
  message?: string;
  /** Short, plain-English hint about what typically causes this failure. */
  hint: string;
}

/**
 * Build a `GrpcErrorReport` from a status code and optional server
 * message. Always returns a report — never throws — so the response
 * panel can render whatever the runner hands it.
 *
 * `code` is typed as `number` so callers can pass raw wire values
 * without narrowing. Unrecognized codes yield a `UNKNOWN(<code>)` name
 * with a generic hint that surfaces the raw number for support.
 */
export function reportForStatus(code: number, message?: string): GrpcErrorReport {
  const name = statusName(code);
  const hint = hintForCode(code);
  const trimmed = message?.trim();
  return {
    code,
    name,
    message: trimmed && trimmed.length > 0 ? trimmed : undefined,
    hint,
  };
}

/**
 * Convenience: build a report for the "server doesn't support server
 * reflection" case. The runner detects this on the reflection round-trip
 * (either an `UNIMPLEMENTED` from the reflection service itself, or a
 * transport-level failure that looks the same) and calls this helper
 * so the panel gets consistent copy.
 */
export function reflectionUnsupportedReport(detail?: string): GrpcErrorReport {
  return {
    code: REFLECTION_UNSUPPORTED_CODE,
    name: 'REFLECTION_UNSUPPORTED',
    message: detail?.trim() || undefined,
    hint:
      'Server does not expose gRPC server-reflection. ' +
      'Enable the reflection service on the server, or provide a local .proto file (planned).',
  };
}

/** True when the status is `OK` (0). Anything else is a failure. */
export function isOk(code: number): boolean {
  return code === GrpcStatusCode.OK;
}

// ---- Internals ------------------------------------------------------------

function statusName(code: number): string {
  const known = STATUS_NAMES[code];
  if (known !== undefined) return known;
  return `UNKNOWN(${code})`;
}

function hintForCode(code: number): string {
  const specific = HINTS[code];
  if (specific !== undefined) return specific;
  return (
    'gRPC returned an unexpected status code. ' +
    'Check the server logs or grpc-message trailer for details.'
  );
}

const STATUS_NAMES: Readonly<Record<number, string>> = {
  [GrpcStatusCode.OK]: 'OK',
  [GrpcStatusCode.CANCELLED]: 'CANCELLED',
  [GrpcStatusCode.UNKNOWN]: 'UNKNOWN',
  [GrpcStatusCode.INVALID_ARGUMENT]: 'INVALID_ARGUMENT',
  [GrpcStatusCode.DEADLINE_EXCEEDED]: 'DEADLINE_EXCEEDED',
  [GrpcStatusCode.NOT_FOUND]: 'NOT_FOUND',
  [GrpcStatusCode.ALREADY_EXISTS]: 'ALREADY_EXISTS',
  [GrpcStatusCode.PERMISSION_DENIED]: 'PERMISSION_DENIED',
  [GrpcStatusCode.RESOURCE_EXHAUSTED]: 'RESOURCE_EXHAUSTED',
  [GrpcStatusCode.FAILED_PRECONDITION]: 'FAILED_PRECONDITION',
  [GrpcStatusCode.ABORTED]: 'ABORTED',
  [GrpcStatusCode.OUT_OF_RANGE]: 'OUT_OF_RANGE',
  [GrpcStatusCode.UNIMPLEMENTED]: 'UNIMPLEMENTED',
  [GrpcStatusCode.INTERNAL]: 'INTERNAL',
  [GrpcStatusCode.UNAVAILABLE]: 'UNAVAILABLE',
  [GrpcStatusCode.DATA_LOSS]: 'DATA_LOSS',
  [GrpcStatusCode.UNAUTHENTICATED]: 'UNAUTHENTICATED',
  [REFLECTION_UNSUPPORTED_CODE]: 'REFLECTION_UNSUPPORTED',
};

const HINTS: Readonly<Record<number, string>> = {
  [GrpcStatusCode.OK]: 'Call succeeded.',
  [GrpcStatusCode.CANCELLED]:
    'The RPC was cancelled — usually the client hung up or the deadline was too tight.',
  [GrpcStatusCode.UNKNOWN]:
    'Server raised an unknown error. Check server logs and the grpc-message trailer.',
  [GrpcStatusCode.INVALID_ARGUMENT]:
    'Server rejected the request body — verify the JSON matches the method\u2019s input message schema.',
  [GrpcStatusCode.DEADLINE_EXCEEDED]:
    'RPC timed out. Increase grpc-timeout in the request block, or check server latency.',
  [GrpcStatusCode.NOT_FOUND]:
    'Server reports the requested resource does not exist.',
  [GrpcStatusCode.ALREADY_EXISTS]:
    'Server reports the resource already exists (idempotency conflict?).',
  [GrpcStatusCode.PERMISSION_DENIED]:
    'Authenticated but not authorized. Check the identity has permission for this method.',
  [GrpcStatusCode.RESOURCE_EXHAUSTED]:
    'Rate limited or quota exceeded. Back off before retrying.',
  [GrpcStatusCode.FAILED_PRECONDITION]:
    'Server state does not permit this operation right now. See grpc-message for the specific precondition.',
  [GrpcStatusCode.ABORTED]:
    'RPC aborted, typically due to a concurrency conflict. Safe to retry with fresh state.',
  [GrpcStatusCode.OUT_OF_RANGE]:
    'A field in the request is outside the valid range. Check pagination or numeric fields.',
  [GrpcStatusCode.UNIMPLEMENTED]:
    'Server does not implement this method. Verify the service/method name, or the server version.',
  [GrpcStatusCode.INTERNAL]:
    'Server-side internal error. Check server logs; this is not a client-fixable failure.',
  [GrpcStatusCode.UNAVAILABLE]:
    'Cannot reach the server. Check the host/port, TLS, network, and that the server is running.',
  [GrpcStatusCode.DATA_LOSS]:
    'Unrecoverable data loss reported by the server. Escalate to the service owner.',
  [GrpcStatusCode.UNAUTHENTICATED]:
    'Missing or invalid credentials. Verify the @auth profile: token expiry, wrong scheme, or misconfigured mTLS certs.',
};
