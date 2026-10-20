import { beforeEach, describe, expect, it, vi } from 'vitest';

const host = vi.hoisted(() => ({
  folders: [
    { name: 'alpha', path: '/alpha' },
    { name: 'beta', path: '/beta' },
  ],
  showQuickPick: vi.fn(),
  showErrorMessage: vi.fn(),
  showInformationMessage: vi.fn(),
  openTextDocument: vi.fn(),
  showTextDocument: vi.fn(),
  createDirectory: vi.fn(),
  stat: vi.fn(),
  writeFile: vi.fn(),
}));

vi.mock('vscode', () => {
  class Uri {
    constructor(readonly fsPath: string) {}
    toString() {
      return `file://${this.fsPath}`;
    }
    static joinPath(base: Uri, ...parts: string[]) {
      return new Uri([base.fsPath, ...parts].join('/'));
    }
  }
  return {
    Uri,
    workspace: {
      get workspaceFolders() {
        return host.folders.map(({ name, path }) => ({ name, uri: new Uri(path) }));
      },
      fs: { createDirectory: host.createDirectory, stat: host.stat, writeFile: host.writeFile },
      openTextDocument: host.openTextDocument,
    },
    window: {
      showQuickPick: host.showQuickPick,
      showErrorMessage: host.showErrorMessage,
      showInformationMessage: host.showInformationMessage,
      showTextDocument: host.showTextDocument,
    },
  };
});

import { initWorkspace } from '../src/extension/initWorkspace.js';

beforeEach(() => {
  vi.resetAllMocks();
  host.folders = [
    { name: 'alpha', path: '/alpha' },
    { name: 'beta', path: '/beta' },
  ];
  host.stat.mockResolvedValue({});
});

describe('Init Workspace in a multi-root window', () => {
  it('scaffolds only the root explicitly chosen by the user', async () => {
    host.showQuickPick.mockImplementation(async (items: { label: string }[]) => items[1]);
    await initWorkspace();
    expect(
      host.showQuickPick.mock.calls[0][0].map((item: { label: string }) => item.label),
    ).toEqual(['alpha', 'beta']);
    expect(host.createDirectory).toHaveBeenCalledWith(
      expect.objectContaining({ fsPath: '/beta/.requests' }),
    );
    expect(host.stat.mock.calls.map(([uri]) => uri.fsPath)).toEqual([
      '/beta/.requests/hello.http',
      '/beta/.requests/chain.http',
      '/beta/.requests/.http-env.json',
      '/beta/.requests/.gitignore',
    ]);
    expect(host.openTextDocument).toHaveBeenCalledWith(
      expect.objectContaining({ fsPath: '/beta/.requests/hello.http' }),
    );
  });

  it('does not write when selection is cancelled', async () => {
    host.showQuickPick.mockResolvedValue(undefined);
    await initWorkspace();
    expect(host.createDirectory).not.toHaveBeenCalled();
    expect(host.stat).not.toHaveBeenCalled();
  });

  it('does not write if selected root is removed while picker waits', async () => {
    host.showQuickPick.mockImplementation(async (items: { label: string }[]) => {
      host.folders = [{ name: 'alpha', path: '/alpha' }];
      return items[1];
    });
    await initWorkspace();
    expect(host.createDirectory).not.toHaveBeenCalled();
    expect(host.stat).not.toHaveBeenCalled();
  });

  it('keeps single-root behavior without a picker', async () => {
    host.folders = [{ name: 'alpha', path: '/alpha' }];
    await initWorkspace();
    expect(host.showQuickPick).not.toHaveBeenCalled();
    expect(host.createDirectory).toHaveBeenCalledWith(
      expect.objectContaining({ fsPath: '/alpha/.requests' }),
    );
  });
});
