import * as vscode from 'vscode';
import { RequestsTreeProvider } from './requestsTree.js';

/** Prepare local collection notes without writing through an unconfined URI. */
export async function createCollectionNotes(tree: RequestsTreeProvider, node?: unknown): Promise<void> {
  if (node === undefined || !tree.isFolderNode(node)) return;
  if (node.uri.scheme !== 'file' || !(vscode.workspace.workspaceFolders ?? []).some((folder) =>
    folder.uri.scheme === 'file' && folder.uri.authority === node.uri.authority &&
    node.uri.path.startsWith(`${folder.uri.path.replace(/\/$/, '')}/.requests/`))) return;
  // ponytail: users save an untitled buffer themselves; automate creation only after
  // the collection writer has handle-bound, no-follow final I/O (#56).
  try {
    const document = await vscode.workspace.openTextDocument({ language: 'markdown', content: '# Collection notes\n' });
    await vscode.window.showTextDocument(document);
    vscode.window.showInformationMessage('Reqit: Use Save As to place README.md inside the chosen collection folder. Inspect the destination before saving.');
  } catch {
    vscode.window.showWarningMessage('Reqit: could not open a collection notes template.');
  }
}
