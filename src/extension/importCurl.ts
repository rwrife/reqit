import * as vscode from 'vscode';
import { parseCurl, renderImportedCurlAsHttp } from '../core/import/curl.js';
import { assertInsideWorkspace } from '../core/pathGuard.js';

/**
 * Command: `reqit: Import from cURL`.
 *
 * Prompts for a curl command, parses it (pure code in `src/core/import/curl.ts`),
 * suggests a filename, and writes the generated `.http` file into `.requests/`.
 * Never overwrites an existing file without confirmation.
 */
export async function importFromCurlCommand(): Promise<void> {
  const folder = vscode.workspace.workspaceFolders?.[0];
  if (!folder) {
    vscode.window.showErrorMessage('Reqit: open a workspace folder first.');
    return;
  }

  const raw = await vscode.window.showInputBox({
    title: 'Reqit: Import from cURL',
    prompt: 'Paste a curl command. Backslash line continuations are supported.',
    ignoreFocusOut: true,
    placeHolder: `curl -X POST https://api.example.com/v1/users -H 'Content-Type: application/json' -d '{"name":"alice"}'`,
  });
  if (!raw || raw.trim().length === 0) return;

  let parsed;
  try {
    parsed = parseCurl(raw);
  } catch (err) {
    vscode.window.showErrorMessage(`Reqit: cURL parse failed — ${(err as Error).message}`);
    return;
  }

  const suggested = suggestNameFromUrl(parsed.url);
  const name = await vscode.window.showInputBox({
    title: 'Reqit: file name',
    prompt: 'Name for the new .http file (without extension).',
    value: suggested,
    ignoreFocusOut: true,
    validateInput: (v) => (/^[A-Za-z0-9._-]+$/.test(v) ? null : 'letters, digits, . _ - only'),
  });
  if (!name) return;

  const root = vscode.Uri.joinPath(folder.uri, '.requests');
  const rootFsPath = folder.uri.fsPath;
  try {
    await vscode.workspace.fs.createDirectory(root);
  } catch {
    // already exists — fine.
  }
  const target = vscode.Uri.joinPath(root, `${name}.http`);
  assertInsideWorkspace(rootFsPath, target.fsPath);

  let exists = false;
  try {
    await vscode.workspace.fs.stat(target);
    exists = true;
  } catch {
    /* not found is the happy path */
  }
  if (exists) {
    const choice = await vscode.window.showWarningMessage(
      `Reqit: ${name}.http already exists. Overwrite?`,
      { modal: true },
      'Overwrite',
    );
    if (choice !== 'Overwrite') return;
  }

  const http = renderImportedCurlAsHttp(parsed, name);
  await vscode.workspace.fs.writeFile(target, Buffer.from(http, 'utf8'));

  if (parsed.unsupported.length > 0) {
    vscode.window.showWarningMessage(
      `Reqit: imported with ignored flags — ${parsed.unsupported.join(', ')}`,
    );
  }
  const doc = await vscode.workspace.openTextDocument(target);
  await vscode.window.showTextDocument(doc);
}

function suggestNameFromUrl(url: string): string {
  try {
    const u = new URL(url);
    const seg = u.pathname.split('/').filter((s) => s.length > 0);
    const tail = seg[seg.length - 1] ?? u.hostname;
    const cleaned = tail.replace(/[^A-Za-z0-9._-]+/g, '-').replace(/^-+|-+$/g, '');
    return cleaned.length > 0 ? cleaned : 'imported';
  } catch {
    return 'imported';
  }
}
