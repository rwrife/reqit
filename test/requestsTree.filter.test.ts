import { beforeEach, describe, expect, it, vi } from 'vitest';

// Only the VS Code host boundary is simulated; provider, parsers, nodes and
// command arguments below are production code.
const host = vi.hoisted(() => ({
  readFile: vi.fn(),
  readDirectory: vi.fn(),
  stat: vi.fn(),
  fire: vi.fn(),
  showQuickPick: vi.fn(),
  showInputBox: vi.fn(),
  registerCommand: vi.fn(),
  createTreeView: vi.fn(),
  createFileSystemWatcher: vi.fn(() => ({ onDidCreate() {}, onDidChange() {}, onDidDelete() {} })),
  onDidChangeTextDocument: vi.fn(),
  onDidCloseTextDocument: vi.fn(),
  onDidChangeWorkspaceFolders: vi.fn(),
  textDocuments: [] as { uri: { toString(): string }; getText(): string }[],
  workspaceFolders: [{ name: 'first', path: '/workspace' }] as { name: string; path: string }[],
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
  class ThemeIcon {
    static Folder = 'folder';
    static File = 'file';
    constructor(readonly id: string) {}
  }
  return {
    Uri,
    ThemeIcon,
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
      fire = host.fire;
    },
    RelativePattern: class {
      readonly base: string;
      constructor(folder: { uri: { path: string } }) {
        this.base = folder.uri.path;
      }
    },
    commands: { registerCommand: host.registerCommand },
    window: {
      showQuickPick: host.showQuickPick,
      showInputBox: host.showInputBox,
      createTreeView: host.createTreeView,
    },
    languages: { registerCodeLensProvider: vi.fn() },
    workspace: {
      get textDocuments() {
        return host.textDocuments;
      },
      onDidChangeTextDocument: host.onDidChangeTextDocument,
      onDidCloseTextDocument: host.onDidCloseTextDocument,
      onDidChangeWorkspaceFolders: host.onDidChangeWorkspaceFolders,
      createFileSystemWatcher: host.createFileSystemWatcher,
      get workspaceFolders() {
        return host.workspaceFolders.map(({ name, path }) => ({ name, uri: new Uri(path) }));
      },
      fs: { readFile: host.readFile, readDirectory: host.readDirectory, stat: host.stat },
    },
  };
});

vi.mock('../src/extension/envManager.js', () => ({
  EnvManager: class {
    async init() {}
  },
}));

// Spy (pass-through) on the HTTP parser so tests can prove oversized sources
// are refused BEFORE any parsing work happens.
const parserSpy = vi.hoisted(() => ({ parseHttpFile: vi.fn() }));
vi.mock('../src/core/parser.js', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../src/core/parser.js')>();
  const wrapped = (...args: Parameters<typeof actual.parseHttpFile>) => {
    parserSpy.parseHttpFile();
    return actual.parseHttpFile(...args);
  };
  return { ...actual, parseHttpFile: wrapped };
});

import {
  REQUEST_NAME_SEARCH_MAX_LENGTH,
  RequestsTreeProvider,
} from '../src/extension/requestsTree.js';
import { activate } from '../src/extension/extension.js';
import type { ExtensionContext } from 'vscode';
import manifest from '../package.json';

const source =
  '### List\nGET https://example.test/items\n\n### Create\nPOST https://example.test/items\n\n{}\n';

beforeEach(() => {
  vi.resetAllMocks();
  host.workspaceFolders = [{ name: 'first', path: '/workspace' }];
  host.createFileSystemWatcher.mockImplementation(() => ({
    onDidCreate() {}, onDidChange() {}, onDidDelete() {},
  }));
  host.stat.mockResolvedValue({ type: 2 });
  host.readDirectory.mockResolvedValue([['items.http', 1]]);
  host.readFile.mockResolvedValue(new TextEncoder().encode(source));
  host.textDocuments = [];
});

describe('request explorer open editor consistency', () => {
  it('uses the unsaved editor text for explorer children and preserves send anchors', async () => {
    const provider = new RequestsTreeProvider();
    const [file] = await provider.getChildren();
    const uri = file.kind === 'file' ? file.uri : undefined;
    expect(uri).toBeDefined();
    host.textDocuments = [
      {
        uri: uri!,
        getText: () => '### Draft\nPATCH https://example.test/edited\n',
      },
    ];
    const children = await provider.getChildren(file);
    expect(children.map((node) => node.label)).toEqual(['Draft']);
    expect(children[0].toTreeItem().command).toMatchObject({
      command: 'reqit.sendRequest',
      arguments: [{ documentUri: uri!.toString(), requestLineIndex: 1 }],
    });
    expect(host.readFile).not.toHaveBeenCalled();
  });

  it('prefers an editor opened during a pending disk read', async () => {
    const provider = new RequestsTreeProvider();
    const [file] = await provider.getChildren();
    let complete!: (value: Uint8Array) => void;
    host.readFile.mockImplementationOnce(
      () =>
        new Promise<Uint8Array>((resolve) => {
          complete = resolve;
        }),
    );
    const reading = provider.getChildren(file);
    host.textDocuments = [
      {
        uri: file.kind === 'file' ? file.uri : { toString: () => '' },
        getText: () => '### New\nPOST https://example.test/new\n',
      },
    ];
    complete(new TextEncoder().encode(source));
    expect((await reading).map((node) => node.label)).toEqual(['New']);
  });

  it('ignores an unrelated open editor and reads only the selected file', async () => {
    const provider = new RequestsTreeProvider();
    const [file] = await provider.getChildren();
    host.textDocuments = [
      {
        uri: { toString: () => 'file:///workspace/.requests/other.http' },
        getText: () => '### Outside\nDELETE https://example.test/outside',
      },
    ];
    expect((await provider.getChildren(file)).map((node) => node.label)).toEqual([
      'List',
      'Create',
    ]);
    expect(host.readFile).toHaveBeenCalledOnce();
  });

  it('uses open gRPC editor text without reading a stale file', async () => {
    host.readDirectory.mockResolvedValue([['test.grpc', 1]]);
    const provider = new RequestsTreeProvider();
    const [file] = await provider.getChildren();
    host.textDocuments = [
      {
        uri: file.kind === 'file' ? file.uri : { toString: () => '' },
        getText: () => '### Unsaved\nGRPC localhost:50051/example.Echo/Say\n\n{}',
      },
    ];
    const [child] = await provider.getChildren(file);
    expect(child.label).toBe('Unsaved');
    expect(child.toTreeItem().command).toMatchObject({ command: 'reqit.sendGrpcRequest' });
    expect(host.readFile).not.toHaveBeenCalled();
  });

  it('refreshes on document edits and close so disk and editor views do not diverge', () => {
    host.onDidChangeTextDocument.mockReturnValue({ dispose() {} });
    host.onDidCloseTextDocument.mockReturnValue({ dispose() {} });
    host.createTreeView.mockReturnValue({});
    const subscriptions: { dispose(): void }[] = [];
    activate({ subscriptions } as unknown as ExtensionContext);
    const onChange = host.onDidChangeTextDocument.mock.calls[0]?.[0];
    const onClose = host.onDidCloseTextDocument.mock.calls[0]?.[0];
    expect(onChange).toBeTypeOf('function');
    expect(onClose).toBeTypeOf('function');
    const uri = { path: '/workspace/.requests/items.http', scheme: 'file', authority: '' };
    host.fire.mockClear();
    onChange({ document: { uri }, contentChanges: [{}] });
    onClose({ uri });
    expect(host.fire).toHaveBeenCalledTimes(2);
    host.fire.mockClear();
    onChange({ document: { uri }, contentChanges: [] });
    for (const path of [
      '/workspace/other.http',
      '/workspace/.requests-other/items.http',
      '/workspace/.requests/notes.txt',
      '/other/.requests/items.http',
    ]) {
      onChange({ document: { uri: { ...uri, path } }, contentChanges: [{}] });
      onClose({ uri: { ...uri, path } });
    }
    onClose({ uri: { ...uri, scheme: 'other' } });
    onClose({ uri: { ...uri, authority: 'other' } });
    expect(host.fire).not.toHaveBeenCalled();
    expect(subscriptions).toContain(host.onDidChangeTextDocument.mock.results[0].value);
    expect(subscriptions).toContain(host.onDidCloseTextDocument.mock.results[0].value);
  });
});

describe('request explorer symlink discovery', () => {
  it('does not discover symlinked file and folder entries', async () => {
    host.readDirectory.mockResolvedValue([
      ['link.http', 1 | 64],
      ['link-folder', 2 | 64],
      ['real.http', 1],
    ]);
    const provider = new RequestsTreeProvider();
    expect((await provider.getChildren()).map((node) => node.label)).toEqual(['real.http']);
    expect(host.readFile).not.toHaveBeenCalled();
  });
});

describe('request explorer multi-workspace roots', () => {
  const multiSource = ['### Other', 'PUT https://example.test/other', ''].join(String.fromCharCode(10));

  beforeEach(() => {
    host.workspaceFolders = [
      { name: 'first', path: '/workspace' },
      { name: 'second', path: '/other' },
    ];
    host.readDirectory.mockImplementation(async (uri: { path: string }) =>
      uri.path === '/other/.requests' ? [['other.http', 1]] : [['items.http', 1]],
    );
    host.readFile.mockImplementation(async (uri: { path: string }) =>
      new TextEncoder().encode(
        uri.path === '/other/.requests/other.http' ? multiSource : source,
      ),
    );
  });

  it('groups requests under one user-selected workspace node per root instead of hiding roots', async () => {
    const provider = new RequestsTreeProvider();
    const roots = await provider.getChildren();
    expect(roots.map((node) => node.label)).toEqual(['first', 'second']);

    const firstChildren = await provider.getChildren(roots[0]);
    expect(firstChildren.map((node) => node.label)).toEqual(['items.http']);
    const [firstFile] = firstChildren;
    expect((await provider.getChildren(firstFile)).map((node) => node.label)).toEqual([
      'List',
      'Create',
    ]);

    const secondChildren = await provider.getChildren(roots[1]);
    expect(secondChildren.map((node) => node.label)).toEqual(['other.http']);
    const [secondFile] = secondChildren;
    expect((await provider.getChildren(secondFile)).map((node) => node.label)).toEqual(['Other']);
  });

  it('keeps single-root trees flat so existing root behavior is unchanged', async () => {
    host.workspaceFolders = [{ name: 'first', path: '/workspace' }];
    const provider = new RequestsTreeProvider();
    const children = await provider.getChildren();
    expect(children.map((node) => node.label)).toEqual(['items.http']);
  });

  it('shows every root guidance without listing any unapproved path', async () => {
    host.workspaceFolders = [];
    const provider = new RequestsTreeProvider();
    const children = await provider.getChildren();
    expect(children.map((node) => node.label)).toEqual([
      'Open a workspace folder, then run "Reqit: Init Workspace"',
    ]);
    expect(host.readDirectory).not.toHaveBeenCalled();
  });

  it('rejects stale tree nodes when their workspace root is removed', async () => {
    const provider = new RequestsTreeProvider();
    const roots = await provider.getChildren();
    const files = await provider.getChildren(roots[1]);
    host.workspaceFolders = [{ name: 'first', path: '/workspace' }];
    host.readDirectory.mockClear();
    host.readFile.mockClear();
    expect(await provider.getChildren(roots[1])).toEqual([]);
    expect(await provider.getChildren(files[0])).toEqual([]);
    expect(host.readDirectory).not.toHaveBeenCalled();
    expect(host.readFile).not.toHaveBeenCalled();
  });

  it('starts watching roots added after activation and stops watching removed roots', () => {
    host.onDidChangeWorkspaceFolders.mockReturnValue({ dispose() {} });
    host.createTreeView.mockReturnValue({});
    const watchers: { dispose: ReturnType<typeof vi.fn> }[] = [];
    host.createFileSystemWatcher.mockImplementation(() => {
      const watcher = {
        onDidCreate() {}, onDidChange() {}, onDidDelete() {}, dispose: vi.fn(),
      };
      watchers.push(watcher);
      return watcher;
    });
    activate({ subscriptions: [] } as unknown as ExtensionContext);
    expect(host.createFileSystemWatcher).toHaveBeenCalledTimes(2);
    const onFolders = host.onDidChangeWorkspaceFolders.mock.calls[0]?.[0];
    host.workspaceFolders = [{ name: 'second', path: '/other' }, { name: 'third', path: '/third' }];
    onFolders();
    expect(watchers[0].dispose).toHaveBeenCalledOnce();
    expect(watchers[1].dispose).not.toHaveBeenCalled();
    expect(host.createFileSystemWatcher.mock.calls.map(([pattern]) => pattern.base)).toEqual([
      '/workspace', '/other', '/third',
    ]);
  });

  it('refreshes the tree when any approved root changes on disk', () => {
    host.createFileSystemWatcher.mockClear();
    host.onDidChangeTextDocument.mockReturnValue({ dispose() {} });
    host.onDidCloseTextDocument.mockReturnValue({ dispose() {} });
    host.createTreeView.mockReturnValue({});
    activate({ subscriptions: [] } as unknown as ExtensionContext);
    // One watcher per approved workspace root, never for unapproved paths.
    const watched = host.createFileSystemWatcher.mock.calls.map(
      ([pattern]) => pattern.base,
    );
    expect(watched).toEqual(['/workspace', '/other']);
    const onChange = host.onDidChangeTextDocument.mock.calls[0]?.[0];
    host.fire.mockClear();
    onChange({
      document: { uri: { path: '/other/.requests/other.http', scheme: 'file', authority: '' } },
      contentChanges: [{}],
    });
    expect(host.fire).toHaveBeenCalledTimes(1);
    host.fire.mockClear();
    onChange({
      document: { uri: { path: '/outside/.requests/x.http', scheme: 'file', authority: '' } },
      contentChanges: [{}],
    });
    expect(host.fire).not.toHaveBeenCalled();
  });
});

describe('request explorer text search', () => {
  it('matches literal text only in its own request section and composes with method and tag', async () => {
    host.readFile.mockResolvedValue(new TextEncoder().encode([
      '### A', '# @tag smoke', 'GET https://example.test/a', 'X-Note: needle', '',
      '### B', '# @tag smoke', 'POST https://example.test/b', 'X-Note: other', '',
      '### C', '# @tag regression', 'POST https://example.test/c', '', 'needle', '',
      '### D', 'GET https://example.test/d', 'X-Note: other', '',
    ].join('\n')));
    const provider = new RequestsTreeProvider();
    const [file] = await provider.getChildren();
    const all = await provider.getChildren(file);
    provider.setTextFilter('NeEdLe');
    expect((await provider.getChildren(file)).map((node) => node.label)).toEqual(['A', 'C']);
    provider.setMethodFilter('POST');
    expect((await provider.getChildren(file)).map((node) => node.label)).toEqual(['C']);
    provider.setTagFilter('smoke');
    expect((await provider.getChildren(file)).map((node) => node.label)).toEqual(['No requests match current filters']);
    provider.setTagFilter('');
    expect((await provider.getChildren(file))[0].toTreeItem().command).toEqual(all[2].toTreeItem().command);
    expect(host.readDirectory).toHaveBeenCalledTimes(1);
  });

  it('matches gRPC section text without crossing into adjacent requests', async () => {
    host.readDirectory.mockResolvedValue([['echo.grpc', 1]]);
    host.readFile.mockResolvedValue(new TextEncoder().encode([
      '### First', 'GRPC localhost:50051/echo.Service/Say', '', '{"message":"needle"}',
      '### Second', 'GRPC localhost:50051/echo.Service/Ping', '', '{"message":"other"}',
    ].join('\n')));
    const provider = new RequestsTreeProvider();
    const [file] = await provider.getChildren();
    provider.setTextFilter('needle');
    expect((await provider.getChildren(file)).map((node) => node.label)).toEqual(['First']);
    provider.setTextFilter('absent');
    expect((await provider.getChildren(file)).map((node) => node.label)).toEqual(['No requests match the active text search']);
  });

  it('rejects invalid and oversized input without clearing an active filter', async () => {
    const provider = new RequestsTreeProvider();
    const [file] = await provider.getChildren();
    provider.setTextFilter('items');
    host.fire.mockClear();
    for (const input of [null, 1, {}, ['items'], 'x'.repeat(129)]) {
      expect(provider.setTextFilter(input)).toBe(false);
    }
    expect(host.fire).not.toHaveBeenCalled();
    expect((await provider.getChildren(file)).map((node) => node.label)).toEqual(['List', 'Create']);
  });

  it('keeps folder discovery lazy and reads current selection after a pending file read', async () => {
    const provider = new RequestsTreeProvider();
    const [file] = await provider.getChildren();
    provider.setTextFilter('list');
    expect(host.readFile).not.toHaveBeenCalled();
    let finish!: (value: Uint8Array) => void;
    host.readFile.mockImplementationOnce(() => new Promise((resolve) => { finish = resolve; }));
    const reading = provider.getChildren(file);
    provider.setTextFilter('post');
    finish(new TextEncoder().encode(source));
    // The search targets section text, not the preceding ### name line.
    expect((await reading).map((node) => node.label)).toEqual(['Create']);
  });

  it('refuses oversized source text instead of scanning it or claiming no matches', async () => {
    host.readFile.mockResolvedValue(new TextEncoder().encode(
      `### Large\nPOST https://example.test/a\n\n${'x'.repeat(1_048_577)}needle`,
    ));
    const provider = new RequestsTreeProvider();
    const [file] = await provider.getChildren();
    provider.setTextFilter('needle');
    expect((await provider.getChildren(file)).map((node) => node.label)).toEqual([
      'File too large for text search',
    ]);
    // Rejection must happen before any parse, not merely before the scan.
    expect(parserSpy.parseHttpFile).not.toHaveBeenCalled();
  });

  it('accepts text search at the exact source-length bound', async () => {
    const prefix = '### Exact\nPOST https://example.test/a\n\nneedle';
    const atBound = prefix + 'x'.repeat(1_048_576 - prefix.length);
    expect(atBound.length).toBe(1_048_576);
    host.readFile.mockResolvedValue(new TextEncoder().encode(atBound));
    const provider = new RequestsTreeProvider();
    const [file] = await provider.getChildren();
    provider.setTextFilter('needle');
    expect((await provider.getChildren(file)).map((node) => node.label)).toEqual(['Exact']);
    expect(parserSpy.parseHttpFile).toHaveBeenCalledTimes(1);
  });

  it('ignores a stale text-search prompt completion after a newer prompt', async () => {
    const view = { description: undefined as string | undefined };
    host.createTreeView.mockReturnValue(view);
    activate({ subscriptions: [] } as unknown as ExtensionContext);
    const run: () => Promise<void> = host.registerCommand.mock.calls.find(
      ([name]) => name === 'reqit.searchRequestsByText',
    )![1];
    let first!: (value: string | undefined) => void;
    host.showInputBox.mockImplementationOnce(() => new Promise((resolve) => { first = resolve; }));
    const firstRun = run();
    host.showInputBox.mockResolvedValueOnce('newest');
    await run();
    first('stale');
    await firstRun;
    expect(view.description).toBe('Text search active');
    // Newest query remains active: re-entering it does not fire a refresh.
    host.fire.mockClear();
    host.showInputBox.mockResolvedValueOnce('newest');
    await run();
    expect(host.fire).not.toHaveBeenCalled();
  });

  it('uses masked input, never echoes query, and preserves filter on Escape', async () => {
    const view = { description: undefined as string | undefined };
    host.createTreeView.mockReturnValue(view);
    activate({ subscriptions: [] } as unknown as ExtensionContext);
    const command = host.registerCommand.mock.calls.find(([name]) => name === 'reqit.searchRequestsByText');
    expect(command).toBeDefined();
    expect(manifest.contributes.menus['view/title']).toContainEqual({
      command: 'reqit.searchRequestsByText', when: 'view == reqit.requests', group: 'navigation',
    });
    const run: () => Promise<void> = command![1];
    host.showInputBox.mockImplementationOnce(async (options: {
      password: boolean; validateInput: (s: string) => string | undefined;
    }) => {
      expect(options.password).toBe(true);
      expect(options.validateInput('x'.repeat(129))).toBeDefined();
      return 'private-key-needle';
    });
    await run();
    expect(view.description).toBe('Text search active');
    expect(view.description).not.toContain('private-key-needle');
    host.showInputBox.mockResolvedValueOnce(undefined);
    await run();
    expect(view.description).toBe('Text search active');
    host.showInputBox.mockResolvedValueOnce('');
    await run();
    expect(view.description).toBeUndefined();
  });
});

describe('request explorer tag filter', () => {
  it('filters parsed HTTP requests by exact tag token while preserving original send anchors', async () => {
    host.readFile.mockResolvedValue(new TextEncoder().encode([
      '### A', '# @tag smoke, regression', 'GET https://example.test/a', '',
      '### B', '# @tag smoketest', 'POST https://example.test/b', '',
      '### C', '# @tag SMOKE', 'POST https://example.test/c', '',
      '### D', 'GET https://example.test/smoke', '',
    ].join('\n')));
    const provider = new RequestsTreeProvider();
    const [file] = await provider.getChildren();
    const all = await provider.getChildren(file);
    provider.setTagFilter(' SmOkE ');
    const matches = await provider.getChildren(file);
    expect(matches.map((node) => node.label)).toEqual(['A', 'C']);
    expect(matches.map((node) => node.toTreeItem().command)).toEqual([
      all[0].toTreeItem().command, all[2].toTreeItem().command,
    ]);
    provider.setMethodFilter('POST');
    expect((await provider.getChildren(file)).map((node) => node.label)).toEqual(['C']);
    provider.setNameFilter('a');
    expect((await provider.getChildren(file)).map((node) => node.label)).toEqual(['No requests match current filters']);
    provider.setNameFilter('');
    provider.setTagFilter('');
    expect((await provider.getChildren(file)).map((node) => node.label)).toEqual(['B', 'C']);
  });

  it('ignores invalid and oversized tag filters before preprocessing', async () => {
    const provider = new RequestsTreeProvider();
    const [file] = await provider.getChildren();
    provider.setTagFilter('smoke');
    host.fire.mockClear();
    for (const input of [null, 1, {}, ['smoke'], 'x'.repeat(129), 'bad,tag']) {
      expect(provider.setTagFilter(input)).toBe(false);
    }
    expect(host.fire).not.toHaveBeenCalled();
    expect((await provider.getChildren(file))[0].kind).toBe('message');
  });

  it('does not match gRPC targets or private headers and leaves files lazy', async () => {
    host.readDirectory.mockResolvedValue([['echo.grpc', 1], ['a.http', 1]]);
    host.readFile.mockImplementation(async (uri: { path: string }) => new TextEncoder().encode(
      uri.path.endsWith('.grpc')
        ? 'GRPC smoke.example:50051/echo.Service/Smoke\n\n{}'
        : '### A\nGET https://example.test/smoke\nX-Tag: smoke\n\nsmoke',
    ));
    const provider = new RequestsTreeProvider();
    provider.setTagFilter('smoke');
    const [http, grpc] = await provider.getChildren();
    expect(host.readFile).not.toHaveBeenCalled();
    expect((await provider.getChildren(http))[0].kind).toBe('message');
    expect((await provider.getChildren(grpc))[0].kind).toBe('message');
  });

  it('activates a bounded private tag prompt and never displays search text', async () => {
    const view = { description: undefined as string | undefined };
    host.createTreeView.mockReturnValue(view);
    activate({ subscriptions: [] } as unknown as ExtensionContext);
    const command = host.registerCommand.mock.calls.find(([name]) => name === 'reqit.searchRequestsByTag');
    expect(command).toBeDefined();
    expect(manifest.contributes.menus['view/title']).toContainEqual({
      command: 'reqit.searchRequestsByTag', when: 'view == reqit.requests', group: 'navigation',
    });
    const run: () => Promise<void> = command![1];
    host.showInputBox.mockImplementationOnce(async (options: {
      password: boolean; validateInput: (s: string) => string | undefined;
    }) => {
      expect(options.password).toBe(true);
      expect(options.validateInput('x'.repeat(129))).toBeDefined();
      expect(options.validateInput('bad,tag')).toBeDefined();
      return 'smoke';
    });
    await run();
    expect(view.description).toBe('Tag search active');
    expect(view.description).not.toContain('smoke');
    host.showInputBox.mockResolvedValueOnce(undefined);
    await run();
    expect(view.description).toBe('Tag search active');
    host.showInputBox.mockResolvedValueOnce('');
    await run();
    expect(view.description).toBeUndefined();
  });
});

describe('request explorer method filter', () => {
  it('All methods restores request order and removes the filter indicator; Escape keeps it', async () => {
    const view = { description: undefined };
    host.createTreeView.mockReturnValue(view);
    activate({ subscriptions: [] } as unknown as ExtensionContext);
    const run: () => Promise<void> = host.registerCommand.mock.calls.find(
      ([name]) => name === 'reqit.filterRequests',
    )![1];
    const provider: RequestsTreeProvider = host.createTreeView.mock.calls[0][1].treeDataProvider;
    const [file] = await provider.getChildren();
    const original = (await provider.getChildren(file)).map((node) => node.toTreeItem().command);
    host.showQuickPick.mockImplementationOnce(async (items: { label: string }[]) =>
      items.find((item) => item.label === 'POST'),
    );
    await run();
    host.fire.mockClear();
    host.showQuickPick.mockResolvedValueOnce(undefined);
    await run();
    expect(host.fire).not.toHaveBeenCalled();
    expect(view.description).toBe('Method: POST');
    expect((await provider.getChildren(file)).map((node) => node.label)).toEqual(['Create']);
    host.showQuickPick.mockImplementationOnce(async (items: { label: string }[]) => items[0]);
    await run();
    expect(view.description).toBeUndefined();
    expect((await provider.getChildren(file)).map((node) => node.toTreeItem().command)).toEqual(
      original,
    );
    expect(
      host.showQuickPick.mock.calls[0][0].map((item: { label: string }) => item.label),
    ).toEqual([
      'All methods',
      'GET',
      'POST',
      'PUT',
      'DELETE',
      'PATCH',
      'HEAD',
      'OPTIONS',
      'TRACE',
      'GRPC',
    ]);
  });

  it('keeps folders and files visible without eagerly reading any file', async () => {
    host.readDirectory.mockResolvedValue([
      ['nested', 2],
      ['items.http', 1],
      ['echo.grpc', 1],
    ]);
    const provider = new RequestsTreeProvider();
    const original = await provider.getChildren();
    provider.setMethodFilter('POST');
    const filtered = await provider.getChildren();
    expect(filtered.map((node) => node.label)).toEqual(original.map((node) => node.label));
    const nested = await provider.getChildren(filtered[0]);
    expect(nested.map((node) => node.label)).toEqual(['nested', 'echo.grpc', 'items.http']);
    expect(host.readFile).not.toHaveBeenCalled();
  });

  it('preserves GRPC send targets when selected and excludes them for HTTP filters', async () => {
    host.readDirectory.mockResolvedValue([['echo.grpc', 1]]);
    host.readFile.mockResolvedValue(
      new TextEncoder().encode('GRPC localhost:50051/echo.v1.Echo/Say\n\n{}'),
    );
    const provider = new RequestsTreeProvider();
    const [file] = await provider.getChildren();
    const original = await provider.getChildren(file);
    provider.setMethodFilter('GET');
    expect((await provider.getChildren(file))[0].kind).toBe('message');
    provider.setMethodFilter('GRPC');
    const filtered = await provider.getChildren(file);
    expect(filtered.map((node) => node.toTreeItem().command)).toEqual(
      original.map((node) => node.toTreeItem().command),
    );
    expect(filtered[0].toTreeItem().command).toMatchObject({ command: 'reqit.sendGrpcRequest' });
  });

  it('does not display HTTP requests when GRPC is selected', async () => {
    const provider = new RequestsTreeProvider();
    const [file] = await provider.getChildren();
    provider.setMethodFilter('GRPC');
    expect((await provider.getChildren(file))[0].kind).toBe('message');
  });

  it('uses the latest method selection when a file read finishes late', async () => {
    const provider = new RequestsTreeProvider();
    const [file] = await provider.getChildren();
    let finish!: (bytes: Uint8Array) => void;
    host.readFile.mockImplementationOnce(
      () =>
        new Promise((resolve) => {
          finish = resolve;
        }),
    );
    provider.setMethodFilter('GET');
    const reading = provider.getChildren(file);
    provider.setMethodFilter('POST');
    finish(new TextEncoder().encode(source));
    expect((await reading).map((node) => node.label)).toEqual(['Create']);
  });

  it('refresh retains the filter and reparses changed source without caching bodies', async () => {
    const provider = new RequestsTreeProvider();
    const [file] = await provider.getChildren();
    provider.setMethodFilter('POST');
    expect((await provider.getChildren(file)).map((node) => node.label)).toEqual(['Create']);
    host.readFile.mockResolvedValue(
      new TextEncoder().encode('### Replacement\nPOST https://example.test/new'),
    );
    provider.refresh();
    expect((await provider.getChildren(file)).map((node) => node.label)).toEqual(['Replacement']);
  });

  it('does not misreport failed or empty file reads as a filter mismatch', async () => {
    const provider = new RequestsTreeProvider();
    const [file] = await provider.getChildren();
    provider.setMethodFilter('GET');
    host.readFile.mockRejectedValueOnce(new Error('private path must not be reflected'));
    expect(await provider.getChildren(file)).toEqual([]);
    host.readFile.mockResolvedValueOnce(new Uint8Array());
    expect(await provider.getChildren(file)).toEqual([]);
  });

  it('does not let an older picker completion overwrite a newer selection', async () => {
    host.createTreeView.mockReturnValue({});
    activate({ subscriptions: [] } as unknown as ExtensionContext);
    const run: () => Promise<void> = host.registerCommand.mock.calls.find(
      ([name]) => name === 'reqit.filterRequests',
    )![1];
    let finishOld!: () => void;
    host.showQuickPick.mockImplementationOnce(
      (items: { label: string }[]) =>
        new Promise((resolve) => {
          finishOld = () => resolve(items.find((item) => item.label === 'POST'));
        }),
    );
    const oldRun = run();
    host.showQuickPick.mockImplementationOnce(async (items: { label: string }[]) =>
      items.find((item) => item.label === 'GET'),
    );
    await run();
    finishOld();
    await oldRun;
    const provider: RequestsTreeProvider = host.createTreeView.mock.calls[0][1].treeDataProvider;
    const [file] = await provider.getChildren();
    expect((await provider.getChildren(file)).map((node) => node.label)).toEqual(['List']);
    expect(host.createTreeView.mock.results[0].value.description).toBe('Method: GET');
  });

  it('explains when a parsed file contains no matching requests', async () => {
    const provider = new RequestsTreeProvider();
    const [file] = await provider.getChildren();
    provider.setMethodFilter('DELETE');
    const nodes = await provider.getChildren(file);
    expect(nodes.map((node) => node.label)).toEqual(['No requests match the method filter']);
    expect(nodes[0].kind).toBe('message');
    expect(nodes[0].toTreeItem().command).toBeUndefined();
  });

  it('exposes the filter in both the command palette and request-view toolbar', () => {
    expect(manifest.contributes.commands).toContainEqual({
      command: 'reqit.filterRequests',
      title: 'Reqit: Filter Requests by Method',
      category: 'Reqit',
      icon: '$(filter)',
    });
    expect(manifest.contributes.menus['view/title']).toContainEqual({
      command: 'reqit.filterRequests',
      when: 'view == reqit.requests',
      group: 'navigation',
    });
  });

  it('activation registers a picker that filters the live explorer provider', async () => {
    const view = { description: undefined };
    host.createTreeView.mockReturnValue(view);
    host.showQuickPick.mockImplementation(async (items) =>
      items.find((item: { label: string }) => item.label === 'POST'),
    );
    activate({ subscriptions: [] } as unknown as ExtensionContext);
    const command = host.registerCommand.mock.calls.find(
      ([name]) => name === 'reqit.filterRequests',
    );
    expect(command).toBeDefined();
    await command![1]();
    const provider: RequestsTreeProvider = host.createTreeView.mock.calls[0][1].treeDataProvider;
    const [file] = await provider.getChildren();
    expect((await provider.getChildren(file)).map((node) => node.label)).toEqual(['Create']);
    expect(view.description).toBe('Method: POST');
    expect(host.showQuickPick.mock.calls[0][1]).toMatchObject({
      title: 'Filter requests by method',
      canPickMany: false,
    });
  });

  it('ignores invalid boundary values rather than hiding every request', async () => {
    const provider = new RequestsTreeProvider();
    const [file] = await provider.getChildren();
    provider.setMethodFilter('GET');
    host.fire.mockClear();
    for (const input of ['get', 'ALL', 'secret-value', '', null, {}, ['POST'], 1]) {
      provider.setMethodFilter(input);
      expect((await provider.getChildren(file)).map((node) => node.label)).toEqual(['List']);
    }
    expect(host.fire).not.toHaveBeenCalled();
  });

  it('filters parsed children without changing the surviving send target', async () => {
    const provider = new RequestsTreeProvider();
    const [file] = await provider.getChildren();
    const all = await provider.getChildren(file);
    const original = all[1].toTreeItem().command;

    provider.setMethodFilter('POST');
    const filtered = await provider.getChildren(file);

    expect(filtered.map((node) => node.label)).toEqual(['Create']);
    expect(filtered[0].toTreeItem().command).toEqual(original);
    expect(original).toMatchObject({
      command: 'reqit.sendRequest',
      arguments: [{ documentUri: 'file:///workspace/.requests/items.http', requestLineIndex: 4 }],
    });
    expect(host.fire).toHaveBeenCalledWith(undefined);
  });

  it('searches literal case-insensitive substrings over explicit names only', async () => {
    host.readFile.mockResolvedValue(
      new TextEncoder().encode(
        'GET https://example.test/list\n\n### [Prod].*? Ping+\nPOST https://example.test/items\n\n{}\n',
      ),
    );
    const provider = new RequestsTreeProvider();
    const [file] = await provider.getChildren();
    provider.setNameFilter('.*? ping+');
    const nodes = await provider.getChildren(file);
    expect(nodes.map((node) => node.label)).toEqual(['[Prod].*? Ping+']);
  });

  it('does not match URL/body/header sentinels on explicitly named HTTP/GRPC requests', async () => {
    const sentinel = 'nameonlysentinel';
    const httpSource = [
      '### Named Alpha',
      `POST https://example.test/items/${sentinel}`,
      `x-sentinel: ${sentinel}`,
      '',
      `{"token":"${sentinel}"}`,
      '',
    ].join('\n');
    const grpcSource = [
      '### Named Beta',
      `GRPC localhost:50051/echo.v1.Echo/Method${sentinel}`,
      `x-sentinel: ${sentinel}`,
      '',
      `{"token":"${sentinel}"}`,
      '',
    ].join('\n');
    expect(httpSource).toContain(sentinel);
    expect(grpcSource).toContain(sentinel);

    host.readDirectory.mockResolvedValue([
      ['named.http', 1],
      ['named.grpc', 1],
    ]);
    host.readFile.mockImplementation(async (uri: { path: string }) => {
      if (uri.path.endsWith('/named.http')) {
        return new TextEncoder().encode(httpSource);
      }
      return new TextEncoder().encode(grpcSource);
    });

    const provider = new RequestsTreeProvider();
    const [grpcFile, httpFile] = await provider.getChildren();
    provider.setNameFilter(sentinel);
    const grpcNodes = await provider.getChildren(grpcFile);
    const httpNodes = await provider.getChildren(httpFile);
    expect(grpcNodes.map((node) => node.label)).toEqual([
      'No requests match the active name search',
    ]);
    expect(grpcNodes[0].kind).toBe('message');
    expect(httpNodes.map((node) => node.label)).toEqual([
      'No requests match the active name search',
    ]);
    expect(httpNodes[0].kind).toBe('message');
  });

  it('excludes unnamed HTTP/GRPC fallback labels from name search results', async () => {
    host.readDirectory.mockResolvedValue([
      ['named.http', 1],
      ['named.grpc', 1],
    ]);
    host.readFile.mockImplementation(async (uri: { path: string }) => {
      if (uri.path.endsWith('/named.http')) {
        return new TextEncoder().encode(
          'GET https://example.test/echo\n\n### Named Create\nPOST https://example.test/items\n\n{}\n',
        );
      }
      return new TextEncoder().encode(
        'GRPC localhost:50051/echo.v1.Echo/Say\n\n{}\n\n### Echo Named\nGRPC localhost:50051/echo.v1.Echo/Ping\n\n{}\n',
      );
    });
    const provider = new RequestsTreeProvider();
    const [grpcFile, httpFile] = await provider.getChildren();
    provider.setNameFilter('echo');
    const grpcNodes = await provider.getChildren(grpcFile);
    const httpNodes = await provider.getChildren(httpFile);
    expect(grpcNodes.map((node) => node.label)).toEqual(['Echo Named']);
    expect(httpNodes[0].kind).toBe('message');
  });

  it('applies name and method filters together and keeps send anchors stable', async () => {
    const provider = new RequestsTreeProvider();
    const [file] = await provider.getChildren();
    const original = (await provider.getChildren(file))[1].toTreeItem().command;

    provider.setNameFilter('cre');
    provider.setMethodFilter('POST');
    const intersecting = await provider.getChildren(file);
    expect(intersecting.map((node) => node.label)).toEqual(['Create']);
    expect(intersecting[0].toTreeItem().command).toEqual(original);

    provider.setMethodFilter('GET');
    const disjoint = await provider.getChildren(file);
    expect(disjoint.map((node) => node.label)).toEqual(['No requests match current filters']);
    expect(disjoint[0].kind).toBe('message');
    expect(disjoint[0].toTreeItem().command).toBeUndefined();
  });

  it('uses the latest name filter when a file read finishes late', async () => {
    const provider = new RequestsTreeProvider();
    const [file] = await provider.getChildren();
    let finish!: (bytes: Uint8Array) => void;
    host.readFile.mockImplementationOnce(
      () =>
        new Promise((resolve) => {
          finish = resolve;
        }),
    );
    provider.setNameFilter('list');
    const reading = provider.getChildren(file);
    provider.setNameFilter('create');
    finish(new TextEncoder().encode(source));
    expect((await reading).map((node) => node.label)).toEqual(['Create']);
  });

  it('ignores invalid name-filter boundary values before preprocessing', async () => {
    const provider = new RequestsTreeProvider();
    const [file] = await provider.getChildren();
    provider.setNameFilter('list');
    host.fire.mockClear();
    for (const input of [
      null,
      {},
      ['list'],
      1,
      true,
      'x'.repeat(REQUEST_NAME_SEARCH_MAX_LENGTH + 1),
    ]) {
      provider.setNameFilter(input);
      expect((await provider.getChildren(file)).map((node) => node.label)).toEqual(['List']);
    }
    expect(host.fire).not.toHaveBeenCalled();
  });

  it('exposes the name search command in both command palette and request-view toolbar', () => {
    expect(manifest.contributes.commands).toContainEqual({
      command: 'reqit.searchRequestsByName',
      title: 'Reqit: Search Requests by Name',
      category: 'Reqit',
      icon: '$(search)',
    });
    expect(manifest.contributes.menus['view/title']).toContainEqual({
      command: 'reqit.searchRequestsByName',
      when: 'view == reqit.requests',
      group: 'navigation',
    });
  });

  it('activation wires native input -> parser-backed name search with bounded validation', async () => {
    const view = { description: undefined as string | undefined };
    host.createTreeView.mockReturnValue(view);
    host.showInputBox.mockImplementationOnce(
      async (options: { validateInput?: (value: string) => string | undefined }) => {
        expect(options.title).toBe('Search requests by name');
        expect(options.placeHolder).toBe(
          'Case-insensitive literal match on ### request names (empty clears)',
        );
        expect(await options.validateInput?.('ok')).toBeUndefined();
        expect(await options.validateInput?.('x'.repeat(REQUEST_NAME_SEARCH_MAX_LENGTH + 1))).toBe(
          `Name search must be ${REQUEST_NAME_SEARCH_MAX_LENGTH} characters or fewer.`,
        );
        return 'cre';
      },
    );
    activate({ subscriptions: [] } as unknown as ExtensionContext);
    const run: () => Promise<void> = host.registerCommand.mock.calls.find(
      ([name]) => name === 'reqit.searchRequestsByName',
    )![1];
    await run();
    const provider: RequestsTreeProvider = host.createTreeView.mock.calls[0][1].treeDataProvider;
    const [file] = await provider.getChildren();
    expect((await provider.getChildren(file)).map((node) => node.label)).toEqual(['Create']);
    expect(view.description).toBe('Name search active');
    expect(view.description).not.toContain('cre');
  });

  it('empty search clears while Escape preserves the existing name filter', async () => {
    const view = { description: undefined as string | undefined };
    host.createTreeView.mockReturnValue(view);
    activate({ subscriptions: [] } as unknown as ExtensionContext);
    const run: () => Promise<void> = host.registerCommand.mock.calls.find(
      ([name]) => name === 'reqit.searchRequestsByName',
    )![1];
    const provider: RequestsTreeProvider = host.createTreeView.mock.calls[0][1].treeDataProvider;
    const [file] = await provider.getChildren();
    host.showInputBox.mockResolvedValueOnce('list');
    await run();
    host.fire.mockClear();
    host.showInputBox.mockResolvedValueOnce(undefined);
    await run();
    expect(host.fire).not.toHaveBeenCalled();
    expect(view.description).toBe('Name search active');
    expect((await provider.getChildren(file)).map((node) => node.label)).toEqual(['List']);
    host.showInputBox.mockResolvedValueOnce('');
    await run();
    expect(view.description).toBeUndefined();
    expect((await provider.getChildren(file)).map((node) => node.label)).toEqual([
      'List',
      'Create',
    ]);
  });

  it('does not let an older search prompt completion overwrite a newer one', async () => {
    const view = { description: undefined as string | undefined };
    host.createTreeView.mockReturnValue(view);
    activate({ subscriptions: [] } as unknown as ExtensionContext);
    const run: () => Promise<void> = host.registerCommand.mock.calls.find(
      ([name]) => name === 'reqit.searchRequestsByName',
    )![1];
    let finishOld!: () => void;
    host.showInputBox.mockImplementationOnce(
      () =>
        new Promise((resolve) => {
          finishOld = () => resolve('list');
        }),
    );
    const oldRun = run();
    host.showInputBox.mockResolvedValueOnce('cre');
    await run();
    finishOld();
    await oldRun;
    const provider: RequestsTreeProvider = host.createTreeView.mock.calls[0][1].treeDataProvider;
    const [file] = await provider.getChildren();
    expect((await provider.getChildren(file)).map((node) => node.label)).toEqual(['Create']);
    expect(view.description).toBe('Name search active');
  });

  it('keeps credential-bearing URLs out of request labels and tooltips while retaining send anchors', async () => {
    const sentinel = 'sensitive-url-secret';
    const raw = [
      `GET https://user:${sentinel}@example.test/items?token=${sentinel}`,
      '',
      '### Named',
      `POST https://example.test/items?key=${sentinel}`,
    ].join('\n');
    expect(raw).toContain(sentinel);
    host.readFile.mockResolvedValue(new TextEncoder().encode(raw));
    const provider = new RequestsTreeProvider();
    const [file] = await provider.getChildren();
    const nodes = await provider.getChildren(file);
    expect(nodes).toHaveLength(2);
    for (const node of nodes) {
      const item = node.toTreeItem();
      expect(`${item.label} ${item.tooltip ?? ''} ${item.description ?? ''}`).not.toContain(
        sentinel,
      );
      expect(item.command).toMatchObject({ command: 'reqit.sendRequest' });
      expect(item.command?.arguments?.[0]).toMatchObject({
        requestLineIndex: node.kind === 'request' ? node.request.requestLineIndex : undefined,
      });
    }
    expect(nodes.map((node) => node.label)).toEqual(['GET request', 'Named']);
    expect(nodes[0].kind === 'request' && nodes[0].request.url).toBe(
      `https://user:${sentinel}@example.test/items?token=${sentinel}`,
    );
    provider.setUrlFilter('items');
    expect((await provider.getChildren(file)).map((node) => node.label)).toEqual([
      'GET request',
      'Named',
    ]);
  });

  it('filters by literal URL text and composes with name and method without changing send targets', async () => {
    host.readFile.mockResolvedValue(
      new TextEncoder().encode(
        [
          '### Alpha',
          'GET https://example.test/sentinel?token=private',
          '',
          '### Beta sentinel',
          'POST https://example.test/other',
          '',
          '### Gamma',
          'POST https://example.test/SENTINEL',
          '',
        ].join('\n'),
      ),
    );
    const provider = new RequestsTreeProvider();
    const [file] = await provider.getChildren();
    const all = await provider.getChildren(file);
    provider.setUrlFilter('sentinel');
    expect((await provider.getChildren(file)).map((node) => node.label)).toEqual([
      'Alpha',
      'Gamma',
    ]);
    provider.setMethodFilter('POST');
    expect((await provider.getChildren(file)).map((node) => node.toTreeItem().command)).toEqual([
      all[2].toTreeItem().command,
    ]);
    provider.setNameFilter('alpha');
    const disjoint = await provider.getChildren(file);
    expect(disjoint.map((node) => node.label)).toEqual(['No requests match current filters']);
    expect(disjoint[0].toTreeItem().command).toBeUndefined();
    provider.setMethodFilter(undefined);
    expect((await provider.getChildren(file)).map((node) => node.label)).toEqual(['Alpha']);
    provider.setUrlFilter('');
    expect((await provider.getChildren(file)).map((node) => node.label)).toEqual(['Alpha']);
  });

  it('searches only literal URLs, not names, headers, bodies or expanded variables', async () => {
    const sentinel = 'urlonlysentinel';
    const raw = `### ${sentinel}\nPOST https://example.test/{{endpoint}}\nx-search: ${sentinel}\n\n{"search":"${sentinel}"}`;
    expect(raw).toContain(sentinel);
    host.readFile.mockResolvedValue(new TextEncoder().encode(raw));
    const provider = new RequestsTreeProvider();
    const [file] = await provider.getChildren();
    provider.setUrlFilter(sentinel);
    expect((await provider.getChildren(file))[0].kind).toBe('message');
    provider.setUrlFilter('{{endpoint}}');
    expect((await provider.getChildren(file)).map((node) => node.label)).toEqual([sentinel]);
  });

  it('keeps URL search HTTP-only and ignores invalid or oversized input without reflecting it', async () => {
    host.readDirectory.mockResolvedValue([
      ['echo.grpc', 1],
      ['items.http', 1],
    ]);
    host.readFile.mockImplementation(async (uri: { path: string }) =>
      new TextEncoder().encode(
        uri.path.endsWith('.grpc') ? 'GRPC example.test:50051/echo.Echo/Say\n\n{}' : source,
      ),
    );
    const provider = new RequestsTreeProvider();
    const [grpc, http] = await provider.getChildren();
    provider.setUrlFilter('example.test');
    expect((await provider.getChildren(grpc)).map((node) => node.label)).toEqual([
      'No requests match the active URL search',
    ]);
    expect((await provider.getChildren(http)).map((node) => node.label)).toEqual([
      'List',
      'Create',
    ]);
    host.fire.mockClear();
    for (const invalid of [null, {}, 10, 'x'.repeat(129)]) provider.setUrlFilter(invalid);
    expect(host.fire).not.toHaveBeenCalled();
    expect((await provider.getChildren(http)).map((node) => node.label)).toEqual([
      'List',
      'Create',
    ]);
  });

  it('activation exposes bounded ephemeral URL search in the request explorer', async () => {
    const view = { description: undefined as string | undefined };
    host.createTreeView.mockReturnValue(view);
    activate({ subscriptions: [] } as unknown as ExtensionContext);
    const command = host.registerCommand.mock.calls.find(
      ([name]) => name === 'reqit.searchRequestsByUrl',
    );
    expect(command).toBeDefined();
    expect(manifest.contributes.menus['view/title']).toContainEqual({
      command: 'reqit.searchRequestsByUrl',
      when: 'view == reqit.requests',
      group: 'navigation',
    });
    const run: () => Promise<void> = command![1];
    host.showInputBox.mockImplementationOnce(
      async (options: { validateInput: (s: string) => string | undefined; password: boolean }) => {
        expect(options.password).toBe(true);
        expect(options.validateInput('x'.repeat(129))).toBeDefined();
        return 'items';
      },
    );
    await run();
    const provider: RequestsTreeProvider = host.createTreeView.mock.calls[0][1].treeDataProvider;
    const [file] = await provider.getChildren();
    expect((await provider.getChildren(file)).map((node) => node.label)).toEqual([
      'List',
      'Create',
    ]);
    expect(view.description).toBe('URL search active');
    expect(view.description).not.toContain('items');
    host.showInputBox.mockResolvedValueOnce(undefined);
    await run();
    expect(view.description).toBe('URL search active');
    host.showInputBox.mockResolvedValueOnce('');
    await run();
    expect(view.description).toBeUndefined();
  });

  it('keeps method and name-search indicators accurate as each filter changes', async () => {
    const view = { description: undefined as string | undefined };
    host.createTreeView.mockReturnValue(view);
    activate({ subscriptions: [] } as unknown as ExtensionContext);
    const runMethod: () => Promise<void> = host.registerCommand.mock.calls.find(
      ([name]) => name === 'reqit.filterRequests',
    )![1];
    const runSearch: () => Promise<void> = host.registerCommand.mock.calls.find(
      ([name]) => name === 'reqit.searchRequestsByName',
    )![1];
    host.showQuickPick.mockImplementationOnce(async (items: { label: string }[]) =>
      items.find((item) => item.label === 'POST'),
    );
    await runMethod();
    expect(view.description).toBe('Method: POST');
    host.showInputBox.mockResolvedValueOnce('cre');
    await runSearch();
    expect(view.description).toBe('Method: POST • Name search active');
    host.showInputBox.mockResolvedValueOnce('');
    await runSearch();
    expect(view.description).toBe('Method: POST');
    host.showQuickPick.mockImplementationOnce(async (items: { label: string }[]) => items[0]);
    await runMethod();
    expect(view.description).toBeUndefined();
  });
});
