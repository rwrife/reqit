import { describe, it, expect, vi } from 'vitest';
import { ReflectionCache, type ReflectionTarget } from '../src/core/grpcReflection.js';

const target: ReflectionTarget = { host: 'grpc.example.com', port: 443, plaintext: false };

function fd(name: string, bytes = new Uint8Array([1, 2, 3])) {
  return { name, bytes };
}

describe('ReflectionCache', () => {
  it('caches within TTL and only calls the fetcher once', async () => {
    let clock = 1_000;
    const cache = new ReflectionCache({ ttlMs: 5_000, now: () => clock });
    const fetcher = vi.fn().mockResolvedValue([fd('a.proto')]);

    const first = await cache.getFileDescriptors(target, fetcher);
    const second = await cache.getFileDescriptors(target, fetcher);

    expect(first).toEqual([fd('a.proto')]);
    expect(second).toBe(first);
    expect(fetcher).toHaveBeenCalledTimes(1);
    expect(cache.size()).toBe(1);
  });

  it('refetches after TTL expiry', async () => {
    let clock = 1_000;
    const cache = new ReflectionCache({ ttlMs: 100, now: () => clock });
    const fetcher = vi.fn()
      .mockResolvedValueOnce([fd('a.proto')])
      .mockResolvedValueOnce([fd('b.proto')]);

    await cache.getFileDescriptors(target, fetcher);
    clock += 200;
    const second = await cache.getFileDescriptors(target, fetcher);

    expect(second).toEqual([fd('b.proto')]);
    expect(fetcher).toHaveBeenCalledTimes(2);
    expect(cache.size()).toBe(1);
  });

  it('coalesces concurrent lookups for the same target', async () => {
    const cache = new ReflectionCache();
    let resolve!: (v: Array<{ name: string; bytes: Uint8Array }>) => void;
    const pending = new Promise<Array<{ name: string; bytes: Uint8Array }>>((r) => {
      resolve = r;
    });
    const fetcher = vi.fn().mockReturnValue(pending);

    const p1 = cache.getFileDescriptors(target, fetcher);
    const p2 = cache.getFileDescriptors(target, fetcher);
    resolve([fd('a.proto')]);
    const [r1, r2] = await Promise.all([p1, p2]);

    expect(r1).toEqual([fd('a.proto')]);
    expect(r2).toEqual([fd('a.proto')]);
    expect(fetcher).toHaveBeenCalledTimes(1);
  });

  it('does not cache failed fetches and retries next call', async () => {
    const cache = new ReflectionCache();
    const fetcher = vi.fn()
      .mockRejectedValueOnce(new Error('reflection not supported'))
      .mockResolvedValueOnce([fd('a.proto')]);

    await expect(cache.getFileDescriptors(target, fetcher)).rejects.toThrow(/reflection/);
    const ok = await cache.getFileDescriptors(target, fetcher);

    expect(ok).toEqual([fd('a.proto')]);
    expect(fetcher).toHaveBeenCalledTimes(2);
  });

  it('keys plaintext separately from TLS', async () => {
    const cache = new ReflectionCache();
    const tls = { ...target };
    const plain: ReflectionTarget = { ...target, plaintext: true };
    const fetcher = vi.fn().mockResolvedValue([fd('a.proto')]);

    await cache.getFileDescriptors(tls, fetcher);
    await cache.getFileDescriptors(plain, fetcher);

    expect(fetcher).toHaveBeenCalledTimes(2);
    expect(cache.size()).toBe(2);
  });

  it('invalidate() drops a single entry', async () => {
    const cache = new ReflectionCache();
    const fetcher = vi.fn().mockResolvedValue([fd('a.proto')]);
    await cache.getFileDescriptors(target, fetcher);
    cache.invalidate(target);
    await cache.getFileDescriptors(target, fetcher);
    expect(fetcher).toHaveBeenCalledTimes(2);
  });

  it('clear() nukes everything', async () => {
    const cache = new ReflectionCache();
    const fetcher = vi.fn().mockResolvedValue([fd('a.proto')]);
    await cache.getFileDescriptors(target, fetcher);
    cache.clear();
    expect(cache.size()).toBe(0);
  });

  it('rejects malformed descriptors via zod', async () => {
    const cache = new ReflectionCache();
    const fetcher = vi.fn().mockResolvedValue([{ name: '', bytes: new Uint8Array() }]);
    await expect(cache.getFileDescriptors(target, fetcher)).rejects.toThrow();
  });

  it('ttlMs=0 disables the cache but still coalesces in-flight', async () => {
    const cache = new ReflectionCache({ ttlMs: 0 });
    const fetcher = vi.fn().mockResolvedValue([fd('a.proto')]);
    await cache.getFileDescriptors(target, fetcher);
    await cache.getFileDescriptors(target, fetcher);
    expect(fetcher).toHaveBeenCalledTimes(2);
    expect(cache.size()).toBe(0);
  });
});
