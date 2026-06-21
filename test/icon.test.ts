import { describe, it, expect } from 'vitest';
import { readFileSync, existsSync } from 'node:fs';
import { resolve } from 'node:path';

const repoRoot = resolve(__dirname, '..');

describe('marketplace icon', () => {
  it('media/icon.png exists', () => {
    expect(existsSync(resolve(repoRoot, 'media/icon.png'))).toBe(true);
  });

  it('media/icon.png is a 128x128 PNG', () => {
    const buf = readFileSync(resolve(repoRoot, 'media/icon.png'));
    // PNG signature
    expect(buf.slice(0, 8).equals(Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]))).toBe(true);
    // IHDR chunk starts at byte 8; width/height at offsets 16 and 20 (big-endian uint32)
    const width = buf.readUInt32BE(16);
    const height = buf.readUInt32BE(20);
    expect(width).toBe(128);
    expect(height).toBe(128);
  });

  it('package.json references media/icon.png', () => {
    const pkg = JSON.parse(readFileSync(resolve(repoRoot, 'package.json'), 'utf8'));
    expect(pkg.icon).toBe('media/icon.png');
  });
});
