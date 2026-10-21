import { beforeEach, describe, expect, it, vi } from 'vitest';

const host = vi.hoisted(() => ({
  folders: [] as { name: string; path: string }[],
  showQuickPick: vi.fn(),
  showInputBox: vi.fn(),
  showErrorMessage: vi.fn(),
  showWarningMessage: vi.fn(),
  showInformationMessage: vi.fn(),
  createDirectory: vi.fn(),
  stat: vi.fn(),
  writeFile: vi.fn(),
  openTextDocument: vi.fn(),
  showTextDocument: vi.fn(),
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
      fs: {
        createDirectory: host.createDirectory,
        stat: host.stat,
        writeFile: host.writeFile,
      },
      openTextDocument: host.openTextDocument,
    },
    window: {
      showQuickPick: host.showQuickPick,
      showInputBox: host.showInputBox,
      showErrorMessage: host.showErrorMessage,
      showWarningMessage: host.showWarningMessage,
      showInformationMessage: host.showInformationMessage,
      showTextDocument: host.showTextDocument,
    },
  };
});

import { importFromCurlCommand } from '../src/extension/importCurl.js';

beforeEach(() => {
  vi.resetAllMocks();
  host.folders = [
    { name: 'alpha', path: '/alpha' },
    { name: 'beta', path: '/beta' },
  ];
  host.showInputBox
    .mockResolvedValueOnce('curl https://api.example.test/items')
    .mockResolvedValueOnce('items');
  host.stat.mockRejectedValue(new Error('not found'));
  host.openTextDocument.mockResolvedValue({});
});

describe('Import from cURL in a multi-root window', () => {
  it('writes only to the root chosen before prompting for request data', async () => {
    host.showQuickPick.mockImplementation(async (items: { label: string }[]) => items[1]);
    await importFromCurlCommand();
    expect(host.showQuickPick.mock.calls[0][0].map((item: { label: string }) => item.label)).toEqual([
      'alpha',
      'beta',
    ]);
    expect(host.showInputBox.mock.calls[0][0]).toMatchObject({
      title: 'Reqit: Import from cURL',
    });
    expect(host.createDirectory).toHaveBeenCalledWith(
      expect.objectContaining({ fsPath: '/beta/.requests' }),
    );
    expect(host.writeFile).toHaveBeenCalledWith(
      expect.objectContaining({ fsPath: '/beta/.requests/items.http' }),
      expect.any(Buffer),
    );
  });

  it('does not prompt for request data or write when destination choice is cancelled', async () => {
    host.showQuickPick.mockResolvedValue(undefined);
    await importFromCurlCommand();
    expect(host.showInputBox).not.toHaveBeenCalled();
    expect(host.createDirectory).not.toHaveBeenCalled();
    expect(host.writeFile).not.toHaveBeenCalled();
  });

  it('does not write if chosen root is removed while picker waits', async () => {
    host.showQuickPick.mockImplementation(async (items: { label: string }[]) => {
      host.folders = [{ name: 'alpha', path: '/alpha' }];
      return items[1];
    });
    await importFromCurlCommand();
    expect(host.showInputBox).not.toHaveBeenCalled();
    expect(host.createDirectory).not.toHaveBeenCalled();
    expect(host.writeFile).not.toHaveBeenCalled();
  });

  it('keeps single-root behavior without a picker', async () => {
    host.folders = [{ name: 'alpha', path: '/alpha' }];
    await importFromCurlCommand();
    expect(host.showQuickPick).not.toHaveBeenCalled();
    expect(host.writeFile).toHaveBeenCalledWith(
      expect.objectContaining({ fsPath: '/alpha/.requests/items.http' }),
      expect.any(Buffer),
    );
  });
});
