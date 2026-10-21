import { describe, beforeEach, expect, it, vi } from 'vitest';

const host = vi.hoisted(() => ({
  folders: [] as { name: string; path: string }[],
  showQuickPick: vi.fn(),
}));

vi.mock('vscode', () => {
  class Uri {
    constructor(readonly fsPath: string) {}
    toString() {
      return `file://${this.fsPath}`;
    }
  }
  return {
    Uri,
    workspace: {
      get workspaceFolders() {
        return host.folders.map(({ name, path }) => ({ name, uri: new Uri(path) }));
      },
    },
    window: { showQuickPick: host.showQuickPick },
  };
});

import { chooseWorkspaceFolder } from '../src/extension/workspaceFolderChoice.js';

beforeEach(() => {
  vi.resetAllMocks();
  host.folders = [];
});

describe('workspace folder choice', () => {
  it('uses the only root without prompting', async () => {
    host.folders = [{ name: 'alpha', path: '/alpha' }];
    await expect(chooseWorkspaceFolder({ title: 'Choose Reqit workspace' })).resolves.toMatchObject({
      name: 'alpha',
    });
    expect(host.showQuickPick).not.toHaveBeenCalled();
  });

  it('lets the user choose among multiple roots', async () => {
    host.folders = [
      { name: 'alpha', path: '/alpha' },
      { name: 'beta', path: '/beta' },
    ];
    host.showQuickPick.mockImplementation(async (items: { label: string }[]) => items[1]);
    await expect(chooseWorkspaceFolder({ title: 'Choose Reqit workspace' })).resolves.toMatchObject({
      name: 'beta',
    });
    expect(host.showQuickPick.mock.calls[0][0].map((item: { label: string }) => item.label)).toEqual([
      'alpha',
      'beta',
    ]);
  });

  it('returns undefined when the choice is cancelled', async () => {
    host.folders = [
      { name: 'alpha', path: '/alpha' },
      { name: 'beta', path: '/beta' },
    ];
    host.showQuickPick.mockResolvedValue(undefined);
    await expect(chooseWorkspaceFolder({ title: 'Choose Reqit workspace' })).resolves.toBeUndefined();
  });

  it('ignores a picked root removed while the picker waits', async () => {
    host.folders = [
      { name: 'alpha', path: '/alpha' },
      { name: 'beta', path: '/beta' },
    ];
    host.showQuickPick.mockImplementation(async (items: { label: string }[]) => {
      host.folders = [{ name: 'alpha', path: '/alpha' }];
      return items[1];
    });
    await expect(chooseWorkspaceFolder({ title: 'Choose Reqit workspace' })).resolves.toBeUndefined();
  });

  it('returns undefined when no workspace folder is open', async () => {
    await expect(chooseWorkspaceFolder({ title: 'Choose Reqit workspace' })).resolves.toBeUndefined();
    expect(host.showQuickPick).not.toHaveBeenCalled();
  });
});
