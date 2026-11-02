import { beforeEach, describe, expect, it, vi } from 'vitest';

const host = vi.hoisted(() => ({
  roots: [] as { name: string; uri: { path: string; scheme: string; authority: string; toString(): string } }[],
  stat: vi.fn(), input: vi.fn(), apply: vi.fn(), warning: vi.fn(), refresh: vi.fn(),
  creates: [] as { path: string; options: unknown }[],
}));
vi.mock('vscode', () => {
  class Uri {
    scheme = 'file'; authority = '';
    constructor(readonly path: string) {}
    toString() { return `file://${this.path}`; }
    with(value: { path: string }) { return new Uri(value.path); }
    static joinPath(base: Uri, ...parts: string[]) { return new Uri([base.path, ...parts].join('/')); }
  }
  return {
    Uri, FileType: { Directory: 2, SymbolicLink: 64 },
    WorkspaceEdit: class {
      createFile(uri: Uri, options: unknown) { host.creates.push({ path: uri.path, options }); }
    },
    workspace: { get workspaceFolders() { return host.roots; }, fs: { stat: host.stat }, applyEdit: host.apply },
    window: { showInputBox: host.input, showWarningMessage: host.warning },
  };
});
import { createRequestFolder } from '../src/extension/createRequestFolder.js';
import { sanitizeNewRequestFolderName } from '../src/core/createFolder.js';

const root = { name: 'local', uri: { path: '/workspace', scheme: 'file', authority: '', toString: () => 'file:///workspace' } };
const tree = { isFolderNode: (n: unknown) => n === folderNode, refresh: host.refresh };
const folderNode = { uri: { path: '/workspace/.requests/api', scheme: 'file', authority: '', toString: () => 'file:///workspace/.requests/api', with: ({ path }: { path: string }) => ({ path, scheme: 'file', authority: '', with: folderNode.uri.with }) } };

beforeEach(() => {
  vi.resetAllMocks(); host.creates.length = 0; host.roots = [root];
  host.stat.mockImplementation(async (uri: { path: string }) => {
    if (uri.path === '/workspace/.requests/nested') throw new Error('missing');
    return { type: 2 };
  });
  host.input.mockResolvedValue('nested'); host.apply.mockResolvedValue(true);
});

describe('create request folder', () => {
  it('rejects unsafe names including traversal, device names, trailing dots, and paths', () => {
    for (const name of ['', '.', '..', '../bad', 'foo/bar', 'foo\\bar', 'CON', 'nul.txt', 'a.', 'a '.repeat(65)])
      expect(sanitizeNewRequestFolderName(name)).toBeNull();
    expect(sanitizeNewRequestFolderName('API-v2')).toBe('API-v2');
  });

  it('creates folder as non-overwriting undoable workspace edit under selected root', async () => {
    await createRequestFolder(tree as never);
    expect(host.creates).toEqual([{ path: '/workspace/.requests/nested/.gitkeep', options: { overwrite: false, ignoreIfExists: false } }]);
    expect(host.stat).toHaveBeenCalledWith(expect.objectContaining({ path: '/workspace/.requests/nested' })); // refuse existing directory before edit, too
    expect(host.input).toHaveBeenCalledOnce();
    expect(host.apply).toHaveBeenCalledOnce();
    expect(host.refresh).toHaveBeenCalledOnce();
  });

  it('refuses symlink ancestors observed after input waits', async () => {
    host.stat.mockResolvedValueOnce({ type: 2 }).mockResolvedValueOnce({ type: 2 })
      .mockResolvedValueOnce({ type: 2 }).mockResolvedValueOnce({ type: 66 });
    await createRequestFolder(tree as never, folderNode as never);
    expect(host.apply).not.toHaveBeenCalled();
    expect(host.creates).toEqual([]);
  });

  it('refuses stale nodes, removed roots, and missing request roots', async () => {
    await createRequestFolder(tree as never, { uri: folderNode.uri } as never);
    expect(host.stat).not.toHaveBeenCalled();
    host.stat.mockRejectedValueOnce(new Error('missing'));
    await createRequestFolder(tree as never);
    expect(host.apply).not.toHaveBeenCalled();
    host.stat.mockResolvedValue({ type: 2 });
    host.input.mockImplementationOnce(async () => { host.roots = []; return 'new'; });
    await createRequestFolder(tree as never);
    expect(host.apply).not.toHaveBeenCalled();
  });

  it('refuses existing folders before creating marker', async () => {
    host.stat.mockResolvedValue({ type: 2 });
    await createRequestFolder(tree as never);
    expect(host.creates).toEqual([]);
    expect(host.apply).not.toHaveBeenCalled();
    expect(host.warning).toHaveBeenCalledOnce();
  });

  it('does not report success when editor refuses existing destination', async () => {
    host.apply.mockResolvedValue(false);
    await createRequestFolder(tree as never);
    expect(host.refresh).not.toHaveBeenCalled();
    expect(host.warning).toHaveBeenCalledOnce();
  });
});
