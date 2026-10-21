import * as vscode from 'vscode';

/** User-facing options for choosing a workspace destination. */
export interface WorkspaceFolderChoiceOptions {
  title: string;
  placeHolder?: string;
}

/**
 * Choose the workspace folder that should own a workspace-local artifact.
 *
 * Single-root windows use that root without prompting. Multi-root windows ask
 * the user and re-check the live workspace after the picker resolves, so a root
 * removed while the prompt waits cannot receive writes.
 */
export async function chooseWorkspaceFolder(
  options: WorkspaceFolderChoiceOptions,
): Promise<vscode.WorkspaceFolder | undefined> {
  const folders = vscode.workspace.workspaceFolders ?? [];
  if (folders.length === 0) return undefined;
  if (folders.length === 1) return folders[0];

  const selected = await vscode.window.showQuickPick(
    folders.map((folder) => ({ label: folder.name, description: folder.uri.fsPath, folder })),
    { title: options.title, placeHolder: options.placeHolder ?? 'Select a workspace folder' },
  );
  if (!selected) return undefined;
  const liveFolders = vscode.workspace.workspaceFolders ?? [];
  return liveFolders.find(
    (folder) => folder.uri.toString() === selected.folder.uri.toString(),
  );
}
