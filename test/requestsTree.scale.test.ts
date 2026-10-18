import { describe, expect, it, vi } from 'vitest';

// Only the VS Code host boundary is simulated; provider, parsers and filters
// are production code. Guards the #56 "1,000-request collection" budget
// (docs/performance-budgets.md: initial index p95 <= 750 ms, search p95 <= 50 ms).
const host = vi.hoisted(() => ({
  readFile: vi.fn(),
  readDirectory: vi.fn(),
  stat: vi.fn(),
}));
vi.mock('vscode', () => {
  class Uri {
    readonly scheme = 'file';
    readonly authority = '';
    constructor(readonly path: string) {}
    toString() {
      return `file://${this.path}`;
    }
    static joinPath(base: Uri, ...parts: string[]) {
      return new Uri([base.path, ...parts].join('/'));
    }
  }
  return {
    Uri,
    ThemeIcon: class {
      static Folder = 'folder';
      static File = 'file';
    },
    TreeItem: class {
      constructor(
        public label: string,
        public collapsibleState: number,
      ) {}
    },
    TreeItemCollapsibleState: { None: 0, Collapsed: 1 },
    FileType: { File: 1, Directory: 2, SymbolicLink: 64 },
    EventEmitter: class {
      event = vi.fn();
      fire = vi.fn();
    },
    RelativePattern: class {},
    workspace: {
      textDocuments: [],
      workspaceFolders: [{ uri: new Uri('/workspace') }],
      createFileSystemWatcher: () => ({ onDidCreate() {}, onDidChange() {}, onDidDelete() {} }),
      fs: { readFile: host.readFile, readDirectory: host.readDirectory, stat: host.stat },
    },
  };
});

import { RequestsTreeProvider, type RequestsNode } from '../src/extension/requestsTree.js';

const FILES = 50;
const PER_FILE = 20;
const ROOT = '/workspace/.requests/';

const sources = new Map<string, string>();
for (let f = 0; f < FILES; f++) {
  let text = '';
  for (let i = 0; i < PER_FILE; i++) {
    text += `### f${f} item ${i}\nGET https://example.test/f${f}/${i}\n\n{"n":${f * PER_FILE + i}}\n\n`;
  }
  sources.set(`file${f}.http`, text);
}

host.stat.mockResolvedValue({ type: 2 });
host.readDirectory.mockResolvedValue([...sources.keys()].map((n) => [n, 1]));
host.readFile.mockImplementation(async (uri: { path: string }) =>
  new TextEncoder().encode(sources.get(uri.path.slice(ROOT.length)) ?? ''),
);

async function expandAll(provider: RequestsTreeProvider): Promise<RequestsNode[]> {
  const out: RequestsNode[] = [];
  for (const file of await provider.getChildren()) out.push(...(await provider.getChildren(file)));
  return out;
}

describe('request explorer 1,000-request collection', () => {
  it('indexes every request and searches within budget', async () => {
    const provider = new RequestsTreeProvider();

    const t0 = performance.now();
    const all = await expandAll(provider);
    const indexMs = performance.now() - t0;
    expect(all).toHaveLength(FILES * PER_FILE);

    provider.setNameFilter('f49 item 19');
    const t1 = performance.now();
    const hits = await expandAll(provider);
    const searchMs = performance.now() - t1;
    expect(hits.filter((n) => n.kind === 'request').map((n) => n.label)).toEqual(['f49 item 19']);

    // Ceilings are 4x the documented p95 budgets (docs/performance-budgets.md:
    // initial index p95 <= 750 ms, search p95 <= 50 ms) to tolerate single-sample
    // CI noise while still catching regressions of an order of magnitude.
    expect(indexMs).toBeLessThan(750 * 4);
    expect(searchMs).toBeLessThan(50 * 4);
    console.log(`explorer-1000 index=${indexMs.toFixed(1)}ms search=${searchMs.toFixed(1)}ms`);
  });
});
