import { describe, expect, it } from 'vitest';

import { parseVsixUnzipList, validateVsixEntries } from '../src/core/vsixArchive';

describe('footprint-ci unzip parsing', () => {
  it('parses unzip -l output that uses YYYY-MM-DD dates', () => {
    const stdout = [
      'Archive:  reqit.vsix',
      '  Length      Date    Time    Name',
      '---------  ---------- -----   ----',
      '     5397  2026-09-07 15:46   extension/package.json',
      '  1280748  2026-09-07 15:47   extension/dist/extension.js',
      '---------                     -------',
      '  1286145                     2 files',
      '',
    ].join('\n');

    const entries = parseVsixUnzipList(stdout);
    expect(entries).toEqual([
      { uncompressedBytes: 5397, path: 'extension/package.json' },
      { uncompressedBytes: 1280748, path: 'extension/dist/extension.js' },
    ]);
  });

  it('rejects empty parsed entries to avoid fail-open checks', () => {
    expect(() => validateVsixEntries([])).toThrow(/Could not parse VSIX entries/);
  });

  it('rejects parsed entries that miss required release files', () => {
    expect(() =>
      validateVsixEntries([{ uncompressedBytes: 5397, path: 'extension/package.json' }]),
    ).toThrow(/missing required release files/);
  });

  it('accepts parsed entries that include required release files', () => {
    expect(() =>
      validateVsixEntries([
        { uncompressedBytes: 5397, path: 'extension/package.json' },
        { uncompressedBytes: 1280748, path: 'extension/dist/extension.js' },
      ]),
    ).not.toThrow();
  });
});
