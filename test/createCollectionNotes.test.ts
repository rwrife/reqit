import { beforeEach, describe, expect, it, vi } from 'vitest';

const host = vi.hoisted(() => ({
  roots: [] as { uri: { path: string; scheme: string; authority: string; toString(): string } }[],
  open: vi.fn(), show: vi.fn(), info: vi.fn(), warning: vi.fn(),
  apply: vi.fn(), writeFile: vi.fn(), refresh: vi.fn(),
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
    Uri,
    workspace: {
      get workspaceFolders() { return host.roots; },
      fs: { writeFile: host.writeFile },
      openTextDocument: host.open, applyEdit: host.apply,
    },
    window: { showTextDocument: host.show, showInformationMessage: host.info, showWarningMessage: host.warning },
  };
});
import { createCollectionNotes } from '../src/extension/createCollectionNotes.js';

const root = { uri: { path: '/workspace', scheme: 'file', authority: '', toString: () => 'file:///workspace' } };
const node = { uri: { path: '/workspace/.requests/api', scheme: 'file', authority: '', with: ({ path }: { path: string }) => ({ path, scheme: 'file', authority: '', with: node.uri.with }) } };
const tree = { isFolderNode: (value: unknown) => value === node, refresh: host.refresh };

beforeEach(() => {
  vi.resetAllMocks(); host.roots = [root];
  host.open.mockResolvedValue({ uri: { scheme: 'untitled' } });
  host.apply.mockImplementation(() => { throw new Error('unexpected write'); });
  host.writeFile.mockImplementation(() => { throw new Error('unexpected write'); });
});

describe('collection documentation', () => {
  it('opens a markdown template without an automatic filesystem write', async () => {
    await createCollectionNotes(tree as never, node);
    expect(host.open).toHaveBeenCalledWith({ language: 'markdown', content: '# Collection notes\n' });
    expect(host.show).toHaveBeenCalledWith({ uri: { scheme: 'untitled' } });
    expect(host.info).toHaveBeenCalledWith(expect.stringContaining('Save As'));
    expect(host.apply).not.toHaveBeenCalled();
    expect(host.writeFile).not.toHaveBeenCalled();
    expect(host.refresh).not.toHaveBeenCalled();
  });

  it('does not probe paths or write even if an ancestor is swapped', async () => {
    await createCollectionNotes(tree as never, node);
    expect(host.open).toHaveBeenCalledWith({ language: 'markdown', content: '# Collection notes\n' });
    expect(host.apply).not.toHaveBeenCalled();
    expect(host.writeFile).not.toHaveBeenCalled();
  });

  it('refuses unsupported providers and stale roots', async () => {
    host.roots = [{ uri: { ...root.uri, scheme: 'remote' } }];
    await createCollectionNotes(tree as never, node);
    expect(host.open).not.toHaveBeenCalled();
    host.roots = [];
    await createCollectionNotes(tree as never, node);
    expect(host.open).not.toHaveBeenCalled();
  });

  it('exposes folder action and rejects forged nodes', async () => {
    const fs = await import('node:fs/promises');
    const manifest = JSON.parse(await fs.readFile('package.json', 'utf8'));
    expect(manifest.contributes.commands.some((c: { command: string }) => c.command === 'reqit.createCollectionNotes')).toBe(true);
    expect(manifest.contributes.menus['view/item/context'].some((c: { command: string; when: string }) =>
      c.command === 'reqit.createCollectionNotes' && c.when.includes('reqit.folder'))).toBe(true);
    expect(await fs.readFile('src/extension/extension.ts', 'utf8')).toContain("registerCommand('reqit.createCollectionNotes'");
    await createCollectionNotes(tree as never, { uri: node.uri });
    expect(host.open).not.toHaveBeenCalled();
  });
});
