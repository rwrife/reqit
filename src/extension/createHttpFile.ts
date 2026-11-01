import * as vscode from 'vscode';
import { sanitizeNewHttpFileName, scaffoldNewHttpFileContent } from '../core/createFile.js';
import { chooseWorkspaceFolder } from './workspaceFolderChoice.js';
import { RequestsTreeProvider } from './requestsTree.js';

/** Create a portable source file as one undoable, non-overwriting editor edit. */
export async function createHttpFile(tree: RequestsTreeProvider, node?: unknown): Promise<void> {
  let folder: vscode.WorkspaceFolder | undefined;
  if (node !== undefined) {
    if (!tree.isFolderNode(node)) return;
    folder = (vscode.workspace.workspaceFolders ?? []).find((f) =>
      node.uri.scheme === f.uri.scheme && node.uri.authority === f.uri.authority &&
      node.uri.path.startsWith(`${f.uri.path.replace(/\/$/, '')}/.requests/`));
  } else {
    folder = await chooseWorkspaceFolder({ title: 'Reqit: choose request file destination' });
  }
  if (!folder) return;
  const root = vscode.Uri.joinPath(folder.uri, '.requests');
  const directory = node && tree.isFolderNode(node) ? node.uri : root;
  try {
    // Do not create .requests/ implicitly. Init Workspace owns that operation.
    let current = directory;
    while (current.path.length >= root.path.length) {
      const stat = await vscode.workspace.fs.stat(current);
      if ((stat.type & vscode.FileType.Directory) === 0 ||
          (stat.type & vscode.FileType.SymbolicLink) !== 0) return;
      if (current.path === root.path) break;
      current = current.with({ path: current.path.slice(0, current.path.lastIndexOf('/')) });
    }
    if (current.path !== root.path) return;
    const name = await vscode.window.showInputBox({
      title: 'Reqit: New Request File',
      prompt: 'Name for a new .http file',
      validateInput: (value) => sanitizeNewHttpFileName(value) ? null : 'Use 1–128 letters, digits, dots, _ or -; no paths',
    });
    if (name === undefined) return;
    const fileName = sanitizeNewHttpFileName(name);
    if (!fileName) return;
    if (!(vscode.workspace.workspaceFolders ?? []).some((f) => f.uri.toString() === folder.uri.toString())) return;
    // Recheck ancestors after input waits; VS Code's WorkspaceEdit rejects existing files.
    current = directory;
    while (current.path.length >= root.path.length) {
      const stat = await vscode.workspace.fs.stat(current);
      if ((stat.type & vscode.FileType.Directory) === 0 ||
          (stat.type & vscode.FileType.SymbolicLink) !== 0) return;
      if (current.path === root.path) break;
      current = current.with({ path: current.path.slice(0, current.path.lastIndexOf('/')) });
    }
    if (current.path !== root.path) return;
    const target = vscode.Uri.joinPath(directory, fileName);
    const edit = new vscode.WorkspaceEdit();
    edit.createFile(target, { overwrite: false, ignoreIfExists: false });
    edit.insert(target, new vscode.Position(0, 0), scaffoldNewHttpFileContent());
    if (!await vscode.workspace.applyEdit(edit)) {
      vscode.window.showWarningMessage('Reqit: file not created; destination may already exist or have changed.');
      return;
    }
    tree.refresh();
    const doc = await vscode.workspace.openTextDocument(target);
    await vscode.window.showTextDocument(doc);
  } catch {
    vscode.window.showWarningMessage('Reqit: request directory is not accessible.');
  }
  // ponytail: preflight rejects observed symlinks, not concurrent swaps at final I/O (#56).
}
