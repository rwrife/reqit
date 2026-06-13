import { describe, it, expect } from 'vitest';
import * as path from 'node:path';
import { isInsideWorkspace, assertInsideWorkspace } from '../src/core/pathGuard.js';

const ROOT = path.resolve('/workspace/proj');

describe('isInsideWorkspace', () => {
  it('accepts a child path', () => {
    expect(isInsideWorkspace(ROOT, path.join(ROOT, '.requests/hello.http'))).toBe(true);
  });

  it('accepts the root itself', () => {
    expect(isInsideWorkspace(ROOT, ROOT)).toBe(true);
  });

  it('accepts a nested child path', () => {
    expect(isInsideWorkspace(ROOT, path.join(ROOT, 'a/b/c.txt'))).toBe(true);
  });

  it('rejects a parent escape via ..', () => {
    expect(isInsideWorkspace(ROOT, path.join(ROOT, '../evil.txt'))).toBe(false);
  });

  it('rejects an absolute path outside root', () => {
    expect(isInsideWorkspace(ROOT, '/etc/passwd')).toBe(false);
  });

  it('rejects a sibling directory', () => {
    expect(isInsideWorkspace(ROOT, '/workspace/other/file')).toBe(false);
  });

  it('accepts relative paths inside root', () => {
    expect(isInsideWorkspace(ROOT, '.requests/foo.http')).toBe(true);
  });

  it('rejects relative .. escape', () => {
    expect(isInsideWorkspace(ROOT, '../sneaky')).toBe(false);
  });

  it('rejects empty inputs', () => {
    expect(isInsideWorkspace('', '/a')).toBe(false);
    expect(isInsideWorkspace('/a', '')).toBe(false);
  });
});

describe('assertInsideWorkspace', () => {
  it('throws on escape', () => {
    expect(() => assertInsideWorkspace(ROOT, '/etc/passwd')).toThrow(/refusing to write/);
  });
  it('does not throw on valid child', () => {
    expect(() => assertInsideWorkspace(ROOT, path.join(ROOT, '.requests/x.http'))).not.toThrow();
  });
});
