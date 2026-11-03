import * as vscode from 'vscode';
import { RequestsTreeProvider } from './requestsTree.js';

/** Create a markdown documentation sidecar beside requests in a collection folder. */
export async function createCollectionNotes(tree: RequestsTreeProvider, node?: unknown): Promise<void> {
  if (node === undefined || !tree.isFolderNode(node)) return;
  const folder = (vscode.workspace.workspaceFolders ?? []).find((f) =>
    node.uri.scheme === f.uri.scheme && node.uri.authority === f.uri.authority &&
    node.uri.path.startsWith(`${f.uri.path.replace(/\/$/, '')}/.requests/`));
  if (!folder) return;
  const root = vscode.Uri.joinPath(folder.uri, '.requests');
  const directory = node.uri;
  const checkAncestors = async (): Promise<boolean> => {
    let current = directory;
    while (current.path.length >= root.path.length) {
      const stat = await vscode.workspace.fs.stat(current);
      if ((stat.type & vscode.FileType.Directory) === 0 ||
          (stat.type & vscode.FileType.SymbolicLink) !== 0) return false;
      if (current.path === root.path) return true;
      current = current.with({ path: current.path.slice(0, current.path.lastIndexOf('/')) });
    }
    return false;
  };
  try {
    if (!await checkAncestors()) return;
    if (!(vscode.workspace.workspaceFolders ?? []).some((f) => f.uri.toString() === folder.uri.toString())) return;
    if (!await checkAncestors()) return;
    const target = vscode.Uri.joinPath(directory, 'README.md');
    try {
      await vscode.workspace.fs.stat(target);
      vscode.window.showWarningMessage('Reqit: collection notes already exist.');
      return;
    } catch (error) {
      if (!(error && typeof error === 'object' && 'code' in error && error.code === 'FileNotFound')) throw error;
    }
    const edit = new vscode.WorkspaceEdit();
    edit.createFile(target, { overwrite: false, ignoreIfExists: false });
    edit.insert(target, new vscode.Position(0, 0), '# Collection notes\n');
    if (!await vscode.workspace.applyEdit(edit)) {
      vscode.window.showWarningMessage('Reqit: collection notes not created; destination may already exist or have changed.');
      return;
    }
    tree.refresh();
  } catch {
    vscode.window.showWarningMessage('Reqit: request directory is not accessible.');
  }
  // ponytail: README.md stores folder docs locally in text; final-I/O race confinement is #56.
}
