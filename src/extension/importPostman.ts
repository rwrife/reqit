import * as vscode from 'vscode';
import { importPostmanCollection, type ImportedHttpFile } from '../core/import/postman.js';
import { assertInsideWorkspace } from '../core/pathGuard.js';

/**
 * Command: `reqit: Import Postman Collection`.
 *
 * Prompts for a Postman v2.1 collection JSON file, parses it (pure code in
 * `src/core/import/postman.ts`), and writes one `.http` per top-level folder
 * into `.requests/`. Extracted collection variables are offered for merging
 * into `.http-env.json` under a user-chosen env name.
 *
 * Never overwrites an existing file without explicit confirmation.
 */
export async function importFromPostmanCommand(): Promise<void> {
  const folder = vscode.workspace.workspaceFolders?.[0];
  if (!folder) {
    vscode.window.showErrorMessage('Reqit: open a workspace folder first.');
    return;
  }

  const picked = await vscode.window.showOpenDialog({
    canSelectFiles: true,
    canSelectFolders: false,
    canSelectMany: false,
    openLabel: 'Import',
    filters: { 'Postman Collection': ['json'], 'All files': ['*'] },
    title: 'Reqit: Import Postman Collection',
  });
  if (!picked || picked.length === 0) return;
  const source = picked[0]!;

  let raw: string;
  try {
    raw = Buffer.from(await vscode.workspace.fs.readFile(source)).toString('utf8');
  } catch (err) {
    vscode.window.showErrorMessage(`Reqit: failed to read file — ${(err as Error).message}`);
    return;
  }

  let json: unknown;
  try {
    json = JSON.parse(raw);
  } catch (err) {
    vscode.window.showErrorMessage(`Reqit: not valid JSON — ${(err as Error).message}`);
    return;
  }

  let imported;
  try {
    imported = importPostmanCollection(json);
  } catch (err) {
    vscode.window.showErrorMessage(
      `Reqit: not a Postman v2.1 collection — ${(err as Error).message}`,
    );
    return;
  }

  if (imported.files.length === 0) {
    vscode.window.showWarningMessage('Reqit: nothing to import (no requests found).');
    return;
  }

  const root = vscode.Uri.joinPath(folder.uri, '.requests');
  const rootFsPath = folder.uri.fsPath;
  try {
    await vscode.workspace.fs.createDirectory(root);
  } catch {
    /* exists */
  }

  // Write each file (with overwrite confirmation).
  const written: vscode.Uri[] = [];
  for (const file of imported.files) {
    const target = vscode.Uri.joinPath(root, file.filename);
    assertInsideWorkspace(rootFsPath, target.fsPath);

    if (await exists(target)) {
      const choice = await vscode.window.showWarningMessage(
        `Reqit: ${file.filename} already exists. Overwrite?`,
        { modal: true },
        'Overwrite',
        'Skip',
      );
      if (choice !== 'Overwrite') continue;
    }
    await vscode.workspace.fs.writeFile(target, Buffer.from(file.contents, 'utf8'));
    written.push(target);
  }

  // Offer to merge collection variables into .http-env.json.
  const varCount = Object.keys(imported.envVariables).length;
  if (varCount > 0) {
    const envName = await vscode.window.showInputBox({
      title: 'Reqit: env name for imported variables',
      prompt: `Merge ${varCount} collection variable(s) into .http-env.json under which env? Leave blank to skip.`,
      value: 'imported',
      ignoreFocusOut: true,
      validateInput: (v) =>
        v.length === 0 || /^[A-Za-z0-9._-]+$/.test(v) ? null : 'letters, digits, . _ - only',
    });
    if (envName && envName.length > 0) {
      await mergeEnvFile(folder.uri, envName, imported.envVariables);
    }
  }

  for (const w of imported.warnings) vscode.window.showWarningMessage(`Reqit: ${w}`);
  vscode.window.showInformationMessage(
    `Reqit: imported ${written.length} file(s) from Postman collection.`,
  );

  if (written.length > 0) {
    const doc = await vscode.workspace.openTextDocument(written[0]!);
    await vscode.window.showTextDocument(doc);
  }
}

async function exists(uri: vscode.Uri): Promise<boolean> {
  try {
    await vscode.workspace.fs.stat(uri);
    return true;
  } catch {
    return false;
  }
}

async function mergeEnvFile(
  folderUri: vscode.Uri,
  envName: string,
  vars: Record<string, string>,
): Promise<void> {
  const envUri = vscode.Uri.joinPath(folderUri, '.http-env.json');
  let current: Record<string, Record<string, unknown>> = {};
  try {
    const buf = await vscode.workspace.fs.readFile(envUri);
    const parsed = JSON.parse(Buffer.from(buf).toString('utf8'));
    if (parsed && typeof parsed === 'object') {
      current = parsed as Record<string, Record<string, unknown>>;
    }
  } catch {
    // no existing file — that's fine.
  }

  const existing =
    typeof current[envName] === 'object' && current[envName] !== null ? current[envName] : {};
  current[envName] = { ...existing, ...vars };
  const next = JSON.stringify(current, null, 2) + '\n';
  await vscode.workspace.fs.writeFile(envUri, Buffer.from(next, 'utf8'));
}

// Re-export for testability symmetry with curl command (none needed here yet).
export type { ImportedHttpFile };
