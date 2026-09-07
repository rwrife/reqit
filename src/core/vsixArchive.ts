export interface VsixEntry {
  path: string;
  uncompressedBytes: number;
}

export function parseVsixUnzipList(stdout: string): VsixEntry[] {
  const entries: VsixEntry[] = [];
  for (const line of stdout.split(/\r?\n/)) {
    const match = line.match(
      /^\s*(\d+)\s+(?:\d{2}-\d{2}-\d{4}|\d{4}-\d{2}-\d{2})\s+\d{2}:\d{2}\s+(.+)$/,
    );
    if (!match) {
      continue;
    }
    entries.push({
      uncompressedBytes: Number(match[1]),
      path: match[2].trim(),
    });
  }
  return entries;
}

export function validateVsixEntries(entries: VsixEntry[]): void {
  if (!Array.isArray(entries) || entries.length === 0) {
    throw new Error('Could not parse VSIX entries from unzip output; refusing to evaluate footprint budgets.');
  }

  const hasPackageJson = entries.some((entry) => entry.path === 'extension/package.json');
  const hasExtensionJs = entries.some(
    (entry) => entry.path === 'extension/dist/extension.js' || entry.path.endsWith('/dist/extension.js'),
  );

  if (!hasPackageJson || !hasExtensionJs) {
    throw new Error(
      'Parsed VSIX entries are missing required release files (extension/package.json and extension/dist/extension.js); refusing fail-open budget evaluation.',
    );
  }
}

export function sumVsixEntryBytes(entries: VsixEntry[], predicate: (entry: VsixEntry) => boolean): number {
  return entries
    .filter(predicate)
    .reduce((total, entry) => total + Number(entry.uncompressedBytes ?? 0), 0);
}
