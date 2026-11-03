import { beforeEach, describe, expect, it, vi } from 'vitest';

const host = vi.hoisted(() => ({
  roots: [] as { uri: { path: string; scheme: string; authority: string; toString(): string } }[],
  stat: vi.fn(), input: vi.fn(), apply: vi.fn(), warning: vi.fn(), refresh: vi.fn(),
  creates: [] as { path: string; options: unknown }[],
  inserts: [] as { path: string; text: string }[],
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
    Uri, FileType: { Directory: 2, SymbolicLink: 64 }, Position: class { constructor(readonly line: number, readonly character: number) {} },
    WorkspaceEdit: class {
      createFile(uri: Uri, options: unknown) { host.creates.push({ path: uri.path, options }); }
      insert(uri: Uri, _position: unknown, text: string) { host.inserts.push({ path: uri.path, text }); }
    },
    workspace: { get workspaceFolders() { return host.roots; }, fs: { stat: host.stat }, applyEdit: host.apply },
    window: { showWarningMessage: host.warning },
  };
});
import { createCollectionNotes } from '../src/extension/createCollectionNotes.js';

const root = { uri: { path: '/workspace', scheme: 'file', authority: '', toString: () => 'file:///workspace' } };
const node = { uri: { path: '/workspace/.requests/api', scheme: 'file', authority: '', with: ({ path }: { path: string }) => ({ path, scheme: 'file', authority: '', with: node.uri.with }) } };
const tree = { isFolderNode: (value: unknown) => value === node, refresh: host.refresh };

beforeEach(() => {
  vi.resetAllMocks(); host.roots = [root]; host.creates.length = 0; host.inserts.length = 0;
  host.stat.mockImplementation(async (uri: { path: string }) => {
    if (uri.path === '/workspace/.requests/api/README.md') throw Object.assign(new Error('missing'), { code: 'FileNotFound' });
    return { type: 2 };
  });
  host.apply.mockResolvedValue(true);
});

describe('collection documentation', () => {
  it('creates an undoable non-overwriting README.md beside requests', async () => {
    await createCollectionNotes(tree as never, node);
    expect(host.creates).toEqual([{ path: '/workspace/.requests/api/README.md', options: { overwrite: false, ignoreIfExists: false } }]);
    expect(host.inserts).toEqual([{ path: '/workspace/.requests/api/README.md', text: '# Collection notes\n' }]);
    expect(host.apply).toHaveBeenCalledOnce();
    expect(host.refresh).toHaveBeenCalledOnce();
  });

  it('refuses existing notes without editing them', async () => {
    host.stat.mockResolvedValue({ type: 2 });
    await createCollectionNotes(tree as never, node);
    expect(host.apply).not.toHaveBeenCalled();
    expect(host.warning).toHaveBeenCalledOnce();
  });

  it('refuses unexpected stat errors instead of treating them as missing files', async () => {
    host.stat.mockImplementation(async (uri: { path: string }) => {
      if (uri.path.endsWith('/README.md')) throw new Error('permission denied');
      return { type: 2 };
    });
    await createCollectionNotes(tree as never, node);
    expect(host.apply).not.toHaveBeenCalled();
  });

  it('does not claim success when editor rejects the edit', async () => {
    host.apply.mockResolvedValue(false);
    await createCollectionNotes(tree as never, node);
    expect(host.refresh).not.toHaveBeenCalled();
    expect(host.warning).toHaveBeenCalledOnce();
  });

  it('exposes the folder action and activation wiring', async () => {
    const fs = await import('node:fs/promises');
    const manifest = JSON.parse(await fs.readFile('package.json', 'utf8'));
    expect(manifest.contributes.commands.some((c: { command: string }) => c.command === 'reqit.createCollectionNotes')).toBe(true);
    expect(manifest.contributes.menus['view/item/context'].some((c: { command: string; when: string }) =>
      c.command === 'reqit.createCollectionNotes' && c.when.includes('reqit.folder'))).toBe(true);
    expect(await fs.readFile('src/extension/extension.ts', 'utf8')).toContain("registerCommand('reqit.createCollectionNotes'");
  });

  it('refuses a symlink ancestor and stale roots after an asynchronous check', async () => {
    host.stat.mockResolvedValueOnce({ type: 2 }).mockResolvedValueOnce({ type: 66 });
    await createCollectionNotes(tree as never, node);
    expect(host.apply).not.toHaveBeenCalled();
    host.roots = [];
    await createCollectionNotes(tree as never, node);
    expect(host.apply).not.toHaveBeenCalled();
  });

  it('rejects forged or out-of-root folder nodes', async () => {
    await createCollectionNotes(tree as never, { uri: node.uri });
    expect(host.stat).not.toHaveBeenCalled();
  });
});
