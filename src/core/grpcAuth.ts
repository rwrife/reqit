/**
 * Translate `.http-auth.json` auth profiles into the gRPC-native shape our
 * (upcoming) `@grpc/grpc-js` wire-up will consume.
 *
 * `applyAuth` (in `./auth.ts`) already knows how to turn an `AuthProfile`
 * into HTTP-flavoured pieces (`headers` + `query` + `tls`), which is what
 * the REST/undici code path expects. gRPC is close enough to reuse that,
 * but different enough to justify a small adapter:
 *
 *   - gRPC has no URL query string, so `apiKey in=query` profiles have to
 *     be flagged rather than silently dropped.
 *   - gRPC keys must be lowercased ASCII per HPACK / http/2 rules.
 *   - Several header names are reserved by the transport (`te`,
 *     `content-type`, `grpc-timeout`, `:authority`, ...) and get stripped
 *     with a warning so users don't spend an hour debugging a mystery
 *     `UNIMPLEMENTED`.
 *   - `clientCert` material rides at the *channel* layer via TLS, not as
 *     per-call metadata. We surface a channel-security verdict
 *     (`plaintext | tls | mtls`) so the extension layer knows whether to
 *     use `ChannelCredentials.createInsecure()`, `.createSsl()`, or
 *     `.createSsl(...) + createFromSecureContext(...)`.
 *   - Combining `grpc://` (plaintext) with a `clientCert` profile is a
 *     hard mismatch — the entire point of a client cert is TLS. We block
 *     the send instead of quietly stripping the cert.
 *
 * This module stays pure, VS Code-free, transport-free, and lives in
 * `src/core/` per AGENTS.md coding standards. It never touches
 * SecretStorage; secret resolution happens up in `applyAuth`.
 *
 * The output shape is deliberately a plain JSON-serializable object so
 * the extension layer can hand it directly to `@grpc/grpc-js` without
 * this file pulling `grpc-js` into its type graph.
 */

import type { ParsedGrpcRequest } from './grpc.js';
import type { ResolvedAuth, TlsMaterial } from './auth.js';

/**
 * Channel-level security posture derived from the target + auth profile.
 *
 *   - `plaintext`: `grpc://` scheme, no TLS at all. Only allowed when
 *     the user explicitly opts in via the scheme.
 *   - `tls`:       Standard TLS. No client cert. Server auth only.
 *   - `mtls`:      Mutual TLS via a `clientCert` auth profile.
 */
export type GrpcChannelSecurity = 'plaintext' | 'tls' | 'mtls';

export interface GrpcCallCredentials {
  /**
   * Metadata headers to send with the call, keys already lowercased and
   * ready to feed straight into `Metadata.add(key, value)`.
   */
  metadata: Record<string, string>;
  /**
   * TLS material for the channel. Present iff `channelSecurity === 'mtls'`.
   * Same shape `applyAuth` emits for the undici Agent — the extension
   * layer converts it into a Node `SecureContext` for `grpc-js`.
   */
  tls?: TlsMaterial;
  /** Derived channel security posture. Drives which `ChannelCredentials` to build. */
  channelSecurity: GrpcChannelSecurity;
  /**
   * Non-blocking translation notes (reserved header stripped, request
   * metadata shadowed by auth, etc.). The panel surfaces these as bullets
   * next to the preflight report.
   */
  warnings: string[];
  /**
   * Blocking translation errors (`apiKey in=query`, `grpc://` + client cert,
   * etc.). When this is non-empty the caller MUST refuse to dispatch —
   * the credentials object may still be partially populated for display.
   */
  errors: string[];
}

export interface BuildGrpcCredentialsInput {
  request: ParsedGrpcRequest;
  /**
   * Result of running `applyAuth` for the request's `@auth` profile.
   * Pass `undefined` for requests with no `# @auth` directive.
   */
  auth?: ResolvedAuth;
  /**
   * Profile name (as referenced in `# @auth <name>`). Only used to make
   * warnings/errors readable. Defaults to `'auth'` when omitted.
   */
  authName?: string;
}

/**
 * gRPC transport-reserved metadata keys we always strip from user-supplied
 * input, with a warning. Users occasionally set these by hand when
 * porting from an HTTP client, and gRPC either overrides them itself
 * (`content-type`, `te`) or rejects the call outright (`:authority`,
 * `grpc-timeout` as free-form text, etc.).
 */
const RESERVED_METADATA_KEYS: ReadonlySet<string> = new Set([
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
  // HTTP/1.1 hop-by-hop headers — meaningless / harmful over http/2 gRPC.
  'connection',
  'keep-alive',
  'transfer-encoding',
  'upgrade',
  'proxy-authenticate',
  'proxy-authorization',
  'trailer',
  // "Host" is expressed via `:authority` in http/2; passing it explicitly
  // creates the classic double-Host confusion.
  'host',
]);

/**
 * Translate a request + resolved auth into the gRPC-shaped credentials
 * bundle the send path needs. Never throws; blocking issues surface as
 * entries in the returned `errors` list so the response panel can render
 * them alongside the preflight report.
 */
export function buildGrpcCredentials(
  input: BuildGrpcCredentialsInput,
): GrpcCallCredentials {
  const { request, auth } = input;
  const authName = input.authName ?? 'auth';

  const warnings: string[] = [];
  const errors: string[] = [];

  // ---- 1. Merge & sanitize request-block metadata --------------------------
  const metadata: Record<string, string> = {};
  for (const [rawKey, value] of Object.entries(request.metadata)) {
    const key = rawKey.toLowerCase();
    if (RESERVED_METADATA_KEYS.has(key)) {
      warnings.push(
        `Dropped reserved gRPC metadata "${rawKey}" from request block — the transport manages this header.`,
      );
      continue;
    }
    if (!isValidMetadataKey(key)) {
      warnings.push(
        `Dropped invalid metadata key "${rawKey}" — gRPC metadata keys must match /^[a-z0-9._-]+$/ (see HPACK).`,
      );
      continue;
    }
    metadata[key] = value;
  }

  // ---- 2. Fold in auth-derived headers -------------------------------------
  if (auth) {
    for (const [rawKey, value] of Object.entries(auth.headers)) {
      const key = rawKey.toLowerCase();
      if (RESERVED_METADATA_KEYS.has(key)) {
        // An auth profile emitting `Content-Type` etc. is a bug — surface it
        // instead of silently mangling the request.
        warnings.push(
          `Auth profile "${authName}" tried to set reserved metadata "${rawKey}" — dropped.`,
        );
        continue;
      }
      if (!isValidMetadataKey(key)) {
        warnings.push(
          `Auth profile "${authName}" emitted invalid metadata key "${rawKey}" — dropped.`,
        );
        continue;
      }
      if (Object.prototype.hasOwnProperty.call(metadata, key)) {
        warnings.push(
          `Metadata "${key}" from the request block was overridden by auth profile "${authName}".`,
        );
      }
      metadata[key] = value;
    }

    // gRPC has no URL query string. `apiKey in=query` profiles produce a
    // `.query` map; there's nowhere sensible to put it. Block the send
    // with a clear message.
    if (auth.query && Object.keys(auth.query).length > 0) {
      const names = Object.keys(auth.query).join(', ');
      errors.push(
        `Auth profile "${authName}" adds query parameter(s) [${names}], but gRPC has no URL query string. Use "apiKey in=header" instead.`,
      );
    }
  }

  // ---- 3. Channel security verdict -----------------------------------------
  const { channelSecurity, tls } = resolveChannelSecurity(
    request.target.plaintext,
    auth?.tls,
    authName,
    errors,
  );

  const creds: GrpcCallCredentials = {
    metadata,
    channelSecurity,
    warnings,
    errors,
  };
  if (tls) creds.tls = tls;
  return creds;
}

/**
 * Metadata key validity per gRPC / HPACK (subset).
 * Allowed: lowercase ASCII letters, digits, `.`, `-`, `_`.
 * (Binary metadata is signalled by a `-bin` suffix; the key itself still
 * follows the same character rules.)
 */
function isValidMetadataKey(key: string): boolean {
  return /^[a-z0-9._-]+$/.test(key);
}

function resolveChannelSecurity(
  plaintext: boolean,
  tls: TlsMaterial | undefined,
  authName: string,
  errors: string[],
): { channelSecurity: GrpcChannelSecurity; tls?: TlsMaterial } {
  if (plaintext) {
    if (tls) {
      errors.push(
        `Auth profile "${authName}" is clientCert (mTLS), but the target uses grpc:// (plaintext). Switch the target to grpcs:// or remove the client cert.`,
      );
      // Still return `plaintext` so the panel can show what would happen
      // if the user fixes it. The `errors` list blocks dispatch anyway.
      return { channelSecurity: 'plaintext' };
    }
    return { channelSecurity: 'plaintext' };
  }
  if (tls) {
    return { channelSecurity: 'mtls', tls };
  }
  return { channelSecurity: 'tls' };
}
