import { beforeEach, describe, expect, it, vi } from 'vitest';

const host = vi.hoisted(() => ({
  folders: [] as { name: string; path: string }[],
  showQuickPick: vi.fn(),
  showInputBox: vi.fn(),
  showOpenDialog: vi.fn(),
  showErrorMessage: vi.fn(),
  showWarningMessage: vi.fn(),
  showInformationMessage: vi.fn(),
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
      showInputBox: host.showInputBox,
      showOpenDialog: host.showOpenDialog,
      showErrorMessage: host.showErrorMessage,
      showWarningMessage: host.showWarningMessage,
      showInformationMessage: host.showInformationMessage,
      showTextDocument: host.showTextDocument,
    },
  };
});

import { importFromOpenApiCommand } from '../src/extension/importOpenapi.js';

const openApi = {
  openapi: '3.0.0',
  info: { title: 'Example', version: '1.0.0' },
  servers: [{ url: 'https://api.example.test' }],
  paths: {
    '/items': {
      get: {
        operationId: 'listItems',
        responses: { '200': { description: 'OK' } },
      },
    },
  },
};

beforeEach(() => {
  vi.resetAllMocks();
  host.folders = [
    { name: 'alpha', path: '/alpha' },
    { name: 'beta', path: '/beta' },
  ];
  host.showQuickPick.mockImplementation(async (items: { label?: string; value?: string }[]) => {
    const destination = items.find((item) => item.label === 'beta');
    if (destination) return destination;
    return items.find((item) => item.value === 'file');
  });
  host.showOpenDialog.mockResolvedValue([{ fsPath: '/outside/openapi.json' }]);
  host.readFile.mockImplementation(async (uri: { fsPath: string }) =>
    uri.fsPath === '/outside/openapi.json'
      ? Buffer.from(JSON.stringify(openApi))
      : Promise.reject(new Error('not found')),
  );
  host.stat.mockRejectedValue(new Error('not found'));
  host.showInputBox.mockResolvedValue(undefined);
  host.openTextDocument.mockResolvedValue({});
});

describe('Import OpenAPI in a multi-root window', () => {
  it('chooses destination before source and writes only the chosen root', async () => {
    await importFromOpenApiCommand();
    expect(host.showQuickPick.mock.calls[0][0].map((item: { label: string }) => item.label)).toEqual(
      ['alpha', 'beta'],
    );
    expect(host.showQuickPick.mock.calls[1][0].map((item: { value: string }) => item.value)).toEqual([
      'file',
      'url',
    ]);
    expect(host.createDirectory).toHaveBeenCalledWith(
      expect.objectContaining({ fsPath: '/beta/.requests' }),
    );
    expect(host.writeFile.mock.calls.map(([uri]) => uri.fsPath)).toEqual([
      '/beta/.requests/default.http',
    ]);
  });

  it('does not ask for source or write when destination is cancelled', async () => {
    host.showQuickPick.mockResolvedValueOnce(undefined);
    await importFromOpenApiCommand();
    expect(host.showQuickPick).toHaveBeenCalledOnce();
    expect(host.showOpenDialog).not.toHaveBeenCalled();
    expect(host.createDirectory).not.toHaveBeenCalled();
    expect(host.writeFile).not.toHaveBeenCalled();
  });

  it('does not write if destination is removed while picker waits', async () => {
    host.showQuickPick.mockImplementationOnce(async (items: { label: string }[]) => {
      host.folders = [{ name: 'alpha', path: '/alpha' }];
      return items[1];
    });
    await importFromOpenApiCommand();
    expect(host.showOpenDialog).not.toHaveBeenCalled();
    expect(host.createDirectory).not.toHaveBeenCalled();
    expect(host.writeFile).not.toHaveBeenCalled();
  });

  it('keeps single-root behavior without destination picker', async () => {
    host.folders = [{ name: 'alpha', path: '/alpha' }];
    await importFromOpenApiCommand();
    expect(host.showQuickPick.mock.calls[0][0].map((item: { value: string }) => item.value)).toEqual([
      'file',
      'url',
    ]);
    expect(host.writeFile.mock.calls.map(([uri]) => uri.fsPath)).toEqual([
      '/alpha/.requests/default.http',
    ]);
  });
});
