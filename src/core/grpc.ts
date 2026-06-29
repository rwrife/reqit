/**
 * Pure parsing utilities for gRPC requests in `.grpc` files.
 *
 * Intentionally has zero runtime dependencies on `@grpc/grpc-js` or VS Code —
 * this module only turns text into structured data so it can be unit-tested
 * without spinning up a real gRPC server.
 *
 * Wire-up to a live client (server reflection, mTLS, etc.) is tracked
 * separately under issue #24 and will live in `src/extension/`.
 */

import { z } from 'zod';

/** A parsed `GRPC` target line, e.g. `host:port/package.Service/Method`. */
export interface GrpcTarget {
  /** Host portion, e.g. `grpc.example.com`. */
  host: string;
  /** Port portion as a number. Defaults to 443. */
  port: number;
  /** Fully-qualified service name, e.g. `users.UserService`. */
  service: string;
  /** Method name, e.g. `ListUsers`. */
  method: string;
  /** Whether the user explicitly opted into plaintext via `grpc://`. */
  plaintext: boolean;
}

/**
 * Parse a gRPC target string of the form:
 *
 *   `host:port/package.Service/Method`
 *   `grpc://host:port/package.Service/Method`   (plaintext)
 *   `grpcs://host:port/package.Service/Method`  (TLS, default)
 *
 * The port is optional and defaults to 443. The service must contain at
 * least one dot (gRPC services are always package-qualified in practice,
 * and reflection lookups need the FQN).
 *
 * Throws `Error` with an actionable message on malformed input — callers
 * surface the message verbatim in the response viewer.
 */
export function parseGrpcTarget(input: string): GrpcTarget {
  const raw = input.trim();
  if (raw.length === 0) {
    throw new Error('gRPC target is empty');
  }

  let plaintext = false;
  let rest = raw;

  const schemeMatch = /^(grpcs?):\/\//i.exec(rest);
  if (schemeMatch) {
    plaintext = schemeMatch[1].toLowerCase() === 'grpc';
    rest = rest.slice(schemeMatch[0].length);
  }

  // Split off the path segment(s) — must have exactly /Service/Method.
  const firstSlash = rest.indexOf('/');
  if (firstSlash < 0) {
    throw new Error(
      `gRPC target "${raw}" is missing /Service/Method (expected host[:port]/package.Service/Method)`,
    );
  }
  const authority = rest.slice(0, firstSlash);
  const path = rest.slice(firstSlash + 1);

  if (authority.length === 0) {
    throw new Error(`gRPC target "${raw}" is missing host`);
  }

  // Host + port. IPv6 not supported in v1 (bracketed form) — reflection
  // servers are addressed by name in 99% of cases; we can add it later.
  if (authority.includes('[') || authority.includes(']')) {
    throw new Error(
      `gRPC target "${raw}" uses bracketed IPv6 which is not yet supported`,
    );
  }

  let host: string;
  let port: number;
  const colonIdx = authority.indexOf(':');
  if (colonIdx < 0) {
    host = authority;
    port = 443;
  } else {
    host = authority.slice(0, colonIdx);
    const portStr = authority.slice(colonIdx + 1);
    if (!/^\d+$/.test(portStr)) {
      throw new Error(`gRPC target "${raw}" has non-numeric port "${portStr}"`);
    }
    port = Number.parseInt(portStr, 10);
    if (port < 1 || port > 65_535) {
      throw new Error(`gRPC target "${raw}" port ${port} is out of range`);
    }
  }
  if (host.length === 0) {
    throw new Error(`gRPC target "${raw}" is missing host`);
  }

  // Path must be exactly `Service/Method`.
  const parts = path.split('/');
  if (parts.length !== 2) {
    throw new Error(
      `gRPC target "${raw}" path must be exactly /package.Service/Method`,
    );
  }
  const [service, method] = parts;
  if (service.length === 0 || method.length === 0) {
    throw new Error(
      `gRPC target "${raw}" path must be exactly /package.Service/Method`,
    );
  }
  if (!service.includes('.')) {
    throw new Error(
      `gRPC service "${service}" must be fully-qualified (e.g. package.Service)`,
    );
  }
  // Identifier-ish check — keep loose, just bar whitespace + obvious junk.
  if (!/^[A-Za-z_][A-Za-z0-9_.]*$/.test(service)) {
    throw new Error(`gRPC service "${service}" contains invalid characters`);
  }
  if (!/^[A-Za-z_][A-Za-z0-9_]*$/.test(method)) {
    throw new Error(`gRPC method "${method}" contains invalid characters`);
  }

  return { host, port, service, method, plaintext };
}

/** Zod-validated JSON body for a unary call. We accept any JSON value. */
export const GrpcBodySchema: z.ZodType<unknown> = z.lazy(() =>
  z.union([
    z.string(),
    z.number(),
    z.boolean(),
    z.null(),
    z.array(GrpcBodySchema),
    z.record(GrpcBodySchema),
  ]),
);

export interface ParsedGrpcRequest {
  target: GrpcTarget;
  /** `@auth <name>` directive, if any. */
  authProfile: string | undefined;
  /** Parsed JSON request body, or `undefined` for a no-arg call. */
  body: unknown;
  /** Metadata headers (lowercased keys), e.g. for `Authorization` overrides. */
  metadata: Record<string, string>;
}

/**
 * Parse a single `.grpc` request block. Format mirrors `.http`:
 *
 *   GRPC host:port/Service/Method
 *   # @auth my-profile
 *   x-correlation-id: 1234
 *
 *   { "page_size": 10 }
 *
 * The `### header` separator is handled by the file-level splitter (same
 * one `.http` uses); this function takes a single block at a time.
 */
export function parseGrpcBlock(block: string): ParsedGrpcRequest {
  const lines = block.split(/\r?\n/);
  let i = 0;

  // Skip blank lines + `###` separators before the request line.
  while (
    i < lines.length &&
    (lines[i].trim() === '' || lines[i].trim().startsWith('###'))
  ) {
    i++;
  }
  if (i >= lines.length) {
    throw new Error('gRPC block is empty');
  }

  const requestLine = lines[i].trim();
  i++;
  const m = /^GRPC\s+(.+)$/i.exec(requestLine);
  if (!m) {
    throw new Error(
      `gRPC block must start with \`GRPC <target>\`, got: ${requestLine}`,
    );
  }
  const target = parseGrpcTarget(m[1]);

  let authProfile: string | undefined;
  const metadata: Record<string, string> = {};

  // Header / directive section ends at the first blank line.
  while (i < lines.length) {
    const line = lines[i];
    if (line.trim() === '') {
      i++;
      break;
    }
    const directive = /^#\s*@auth\s+(\S+)\s*$/.exec(line);
    if (directive) {
      authProfile = directive[1];
      i++;
      continue;
    }
    if (line.trimStart().startsWith('#')) {
      i++;
      continue;
    }
    const headerMatch = /^([A-Za-z0-9_-]+)\s*:\s*(.*)$/.exec(line);
    if (!headerMatch) {
      throw new Error(`Invalid gRPC header line: ${line}`);
    }
    metadata[headerMatch[1].toLowerCase()] = headerMatch[2].trim();
    i++;
  }

  // Body is everything that's left, trimmed.
  const bodyText = lines.slice(i).join('\n').trim();
  let body: unknown;
  if (bodyText.length === 0) {
    body = undefined;
  } else {
    let parsed: unknown;
    try {
      parsed = JSON.parse(bodyText);
    } catch (err) {
      throw new Error(
        `gRPC request body must be JSON: ${(err as Error).message}`,
      );
    }
    const result = GrpcBodySchema.safeParse(parsed);
    if (!result.success) {
      throw new Error(
        `gRPC request body failed validation: ${result.error.message}`,
      );
    }
    body = result.data;
  }

  return { target, authProfile, body, metadata };
}
