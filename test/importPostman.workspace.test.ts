import { beforeEach, describe, expect, it, vi } from 'vitest';

const host = vi.hoisted(() => ({
  folders: [] as { name: string; path: string }[],
  showQuickPick: vi.fn(),
  showOpenDialog: vi.fn(),
  showErrorMessage: vi.fn(),
  showWarningMessage: vi.fn(),
  showInformationMessage: vi.fn(),
  showInputBox: vi.fn(),
  createDirectory: vi.fn(),
  stat: vi.fn(),
  readFile: vi.fn(),
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
        readFile: host.readFile,
        writeFile: host.writeFile,
      },
      openTextDocument: host.openTextDocument,
    },
    window: {
      showQuickPick: host.showQuickPick,
      showOpenDialog: host.showOpenDialog,
      showErrorMessage: host.showErrorMessage,
      showWarningMessage: host.showWarningMessage,
      showInformationMessage: host.showInformationMessage,
      showInputBox: host.showInputBox,
      showTextDocument: host.showTextDocument,
    },
  };
});

import { importFromPostmanCommand } from '../src/extension/importPostman.js';

const collection = {
  info: {
    name: 'Example',
    schema: 'https://schema.getpostman.com/json/collection/v2.1.0/collection.json',
  },
  item: [
    {
      name: 'Items',
      item: [
        {
          name: 'List',
          request: {
            method: 'GET',
            url: {
              raw: 'https://example.test/items',
              host: ['example', 'test'],
              path: ['items'],
            },
          },
        },
      ],
    },
  ],
};

const writtenFiles = () =>
  host.writeFile.mock.calls.map(([uri]) => String(uri.fsPath).toLowerCase());

beforeEach(() => {
  vi.resetAllMocks();
  host.folders = [
    { name: 'alpha', path: '/alpha' },
    { name: 'beta', path: '/beta' },
  ];
  host.showOpenDialog.mockResolvedValue([{ fsPath: '/outside/example.postman_collection.json' }]);
  host.readFile.mockResolvedValue(Buffer.from(JSON.stringify(collection)));
  host.stat.mockRejectedValue(new Error('not found'));
  host.openTextDocument.mockResolvedValue({});
});

describe('Import Postman Collection in a multi-root window', () => {
  it('writes only to the destination chosen before selecting collection data', async () => {
    host.showQuickPick.mockImplementation(async (items: { label: string }[]) => items[1]);
    await importFromPostmanCommand();
    expect(host.showQuickPick.mock.calls[0][0].map((item: { label: string }) => item.label)).toEqual(
      ['alpha', 'beta'],
    );
    expect(host.showOpenDialog).toHaveBeenCalledTimes(1);
    expect(host.createDirectory).toHaveBeenCalledWith(
      expect.objectContaining({ fsPath: '/beta/.requests' }),
    );
    expect(writtenFiles()).toEqual(['/beta/.requests/items.http']);
  });

  it('does not prompt for source data or write when destination choice is cancelled', async () => {
    host.showQuickPick.mockResolvedValue(undefined);
    await importFromPostmanCommand();
    expect(host.showOpenDialog).not.toHaveBeenCalled();
    expect(host.createDirectory).not.toHaveBeenCalled();
    expect(host.writeFile).not.toHaveBeenCalled();
  });

  it('does not write if chosen root is removed while picker waits', async () => {
    host.showQuickPick.mockImplementation(async (items: { label: string }[]) => {
      host.folders = [{ name: 'alpha', path: '/alpha' }];
      return items[1];
    });
    await importFromPostmanCommand();
    expect(host.showOpenDialog).not.toHaveBeenCalled();
    expect(host.createDirectory).not.toHaveBeenCalled();
    expect(host.writeFile).not.toHaveBeenCalled();
  });

  it('keeps single-root behavior without a picker', async () => {
    host.folders = [{ name: 'alpha', path: '/alpha' }];
    await importFromPostmanCommand();
    expect(host.showQuickPick).not.toHaveBeenCalled();
    expect(writtenFiles()).toEqual(['/alpha/.requests/items.http']);
  });
});
