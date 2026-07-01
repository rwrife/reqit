/**
 * In-memory reflection cache for gRPC server-reflection descriptors.
 *
 * Pure, VS Code-free, transport-free. The actual reflection RPC (the
 * `grpc.reflection.v1.ServerReflection/ServerReflectionInfo` streaming call)
 * lives in `src/extension/` alongside the `@grpc/grpc-js` wire-up — this
 * module only owns the *caching + lookup* logic so it can be unit-tested
 * without spinning up a real server.
 *
 * Scope for v1 (issue #24):
 *   - Cache key is the tuple `(host, port, plaintext)` — i.e. per target
 *     server, not per method. A single reflection round-trip returns the
 *     whole file-descriptor set, which we hold onto for the session.
 *   - Cache entries expire after a TTL (default 5 min) so long-lived
 *     editor sessions eventually pick up server-side proto changes without
 *     the user having to reload the window.
 *   - Concurrent lookups for the same key coalesce into a single fetch —
 *     if two codelens clicks hit `getFileDescriptors` at once we don't
 *     issue two reflection streams.
 *   - Failed fetches are NOT cached; the next call retries. (Reflection
 *     failures are usually "server doesn't support reflection", which is a
 *     permanent config problem, but we'd rather retry than lock the user
 *     out for the whole TTL.)
 */

import { z } from 'zod';

/** Opaque payload — the raw `FileDescriptorProto` bytes returned by reflection. */
export const FileDescriptorSchema = z.object({
  /** Fully-qualified proto file name, e.g. `google/protobuf/empty.proto`. */
  name: z.string().min(1),
  /** Raw serialized `FileDescriptorProto` bytes. */
  bytes: z.instanceof(Uint8Array),
});
export type FileDescriptor = z.infer<typeof FileDescriptorSchema>;

/** Cache key identifying a single reflection target. */
export interface ReflectionTarget {
  host: string;
  port: number;
  plaintext: boolean;
}

/** Function that actually performs the reflection round-trip. Injected. */
export type ReflectionFetcher = (
  target: ReflectionTarget,
) => Promise<FileDescriptor[]>;

export interface ReflectionCacheOptions {
  /** TTL in milliseconds. Defaults to 5 minutes. Zero disables the cache. */
  ttlMs?: number;
  /** Clock override for tests. Returns ms since epoch. */
  now?: () => number;
}

interface CacheEntry {
  descriptors: FileDescriptor[];
  expiresAt: number;
}

/**
 * Session-scoped reflection cache. Instantiate once per extension activation
 * and reuse across `.grpc` request sends.
 */
export class ReflectionCache {
  private readonly ttlMs: number;
  private readonly now: () => number;
  private readonly entries = new Map<string, CacheEntry>();
  private readonly inflight = new Map<string, Promise<FileDescriptor[]>>();

  constructor(opts: ReflectionCacheOptions = {}) {
    this.ttlMs = opts.ttlMs ?? 5 * 60 * 1000;
    this.now = opts.now ?? Date.now;
  }

  /**
   * Fetch descriptors for `target`, coalescing concurrent callers and
   * respecting the cache TTL. Failed fetches are propagated as rejections
   * and not cached.
   */
  async getFileDescriptors(
    target: ReflectionTarget,
    fetcher: ReflectionFetcher,
  ): Promise<FileDescriptor[]> {
    const key = cacheKey(target);
    const cached = this.entries.get(key);
    if (cached && cached.expiresAt > this.now()) {
      return cached.descriptors;
    }
    const existing = this.inflight.get(key);
    if (existing) return existing;

    const promise = (async (): Promise<FileDescriptor[]> => {
      try {
        const result = await fetcher(target);
        // Validate each descriptor — belt-and-suspenders since `fetcher` is
        // external, and we promised in AGENTS.md that HTTP-ish payloads get
        // zod-validated before flowing further.
        const parsed = result.map((d) => FileDescriptorSchema.parse(d));
        if (this.ttlMs > 0) {
          this.entries.set(key, {
            descriptors: parsed,
            expiresAt: this.now() + this.ttlMs,
          });
        }
        return parsed;
      } finally {
        this.inflight.delete(key);
      }
    })();
    this.inflight.set(key, promise);
    return promise;
  }

  /** Drop a specific target's cache entry. Useful for "reload reflection" UX. */
  invalidate(target: ReflectionTarget): void {
    this.entries.delete(cacheKey(target));
  }

  /** Nuke everything. Called on extension deactivate. */
  clear(): void {
    this.entries.clear();
    this.inflight.clear();
  }

  /** Test/introspection helper — returns the number of live cache entries. */
  size(): number {
    // Drop expired entries opportunistically so `size()` is honest.
    const now = this.now();
    for (const [k, v] of this.entries) {
      if (v.expiresAt <= now) this.entries.delete(k);
    }
    return this.entries.size;
  }
}

function cacheKey(target: ReflectionTarget): string {
  // Plaintext toggles a wildly different transport, so it's part of the key.
  return `${target.plaintext ? 'grpc' : 'grpcs'}://${target.host}:${target.port}`;
}
