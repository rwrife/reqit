import * as vscode from 'vscode';
import { sanitizeNewRequestFolderName } from '../core/createFolder.js';
import { chooseWorkspaceFolder } from './workspaceFolderChoice.js';
import { RequestsTreeProvider } from './requestsTree.js';

/** Add a portable collection folder through an undoable editor operation. */
export async function createRequestFolder(tree: RequestsTreeProvider, node?: unknown): Promise<void> {
  let folder: vscode.WorkspaceFolder | undefined;
  if (node !== undefined) {
    if (!tree.isFolderNode(node)) return;
    folder = (vscode.workspace.workspaceFolders ?? []).find((f) =>
      node.uri.scheme === f.uri.scheme && node.uri.authority === f.uri.authority &&
      node.uri.path.startsWith(`${f.uri.path.replace(/\/$/, '')}/.requests/`));
  } else {
    folder = await chooseWorkspaceFolder({ title: 'Reqit: choose collection folder destination' });
  }
  if (!folder) return;
  const root = vscode.Uri.joinPath(folder.uri, '.requests');
  const directory = node && tree.isFolderNode(node) ? node.uri : root;
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
    const name = await vscode.window.showInputBox({
      title: 'Reqit: New Collection Folder',
      prompt: 'Name for a new folder under .requests/',
      validateInput: (value) => sanitizeNewRequestFolderName(value) ? null : 'Use 1–128 letters, digits, dots, _ or -; no paths',
    });
    if (name === undefined) return;
    const safeName = sanitizeNewRequestFolderName(name);
    if (!safeName) return;
    if (!(vscode.workspace.workspaceFolders ?? []).some((f) => f.uri.toString() === folder.uri.toString())) return;
    if (!await checkAncestors()) return;
    const targetDir = vscode.Uri.joinPath(directory, safeName);
    try {
      await vscode.workspace.fs.stat(targetDir);
      vscode.window.showWarningMessage('Reqit: folder not created; destination already exists.');
      return;
    } catch {
      // missing as expected
    }
    const edit = new vscode.WorkspaceEdit();
    edit.createFile(vscode.Uri.joinPath(targetDir, '.gitkeep'), { overwrite: false, ignoreIfExists: false });
    if (!await vscode.workspace.applyEdit(edit)) {
      vscode.window.showWarningMessage('Reqit: folder not created; destination may already exist or have changed.');
      return;
    }
    tree.refresh();
  } catch {
    vscode.window.showWarningMessage('Reqit: request directory is not accessible.');
  }
  // ponytail: .gitkeep makes empty folders portable; final-I/O race-safe confinement remains #56.
}
