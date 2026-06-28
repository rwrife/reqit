import * as vscode from 'vscode';
import { parse as parseYaml } from 'yaml';
import { importOpenApi, type ImportedHttpFile } from '../core/import/openapi.js';
import { assertInsideWorkspace } from '../core/pathGuard.js';

/**
 * Command: `reqit: Import OpenAPI`.
 *
 * Prompts for a local file (yaml or json) or a URL, parses it into an
 * OpenAPI 3.x document, runs the pure importer in `src/core/import/openapi.ts`,
 * and writes one `.http` file per tag into `.requests/`. The first
 * `servers[]` entry becomes `baseUrl` in `.http-env.json` under a
 * user-chosen env name.
 *
 * Never silently overwrites; warnings from the importer are surfaced.
 */
export async function importFromOpenApiCommand(): Promise<void> {
  const folder = vscode.workspace.workspaceFolders?.[0];
  if (!folder) {
    vscode.window.showErrorMessage('Reqit: open a workspace folder first.');
    return;
  }

  const source = await vscode.window.showQuickPick(
    [
      { label: '$(file) Local file…', value: 'file' as const },
      { label: '$(globe) Fetch from URL…', value: 'url' as const },
    ],
    { title: 'Reqit: Import OpenAPI', placeHolder: 'Pick a source' },
  );
  if (!source) return;

  let text: string;
  let originHint: string;
  try {
    if (source.value === 'file') {
      const picked = await vscode.window.showOpenDialog({
        canSelectFiles: true,
        canSelectFolders: false,
        canSelectMany: false,
        openLabel: 'Import',
        filters: { 'OpenAPI Spec': ['yaml', 'yml', 'json'], 'All files': ['*'] },
        title: 'Reqit: Import OpenAPI',
      });
      if (!picked || picked.length === 0) return;
      text = Buffer.from(await vscode.workspace.fs.readFile(picked[0]!)).toString('utf8');
      originHint = picked[0]!.fsPath;
    } else {
      const url = await vscode.window.showInputBox({
        title: 'Reqit: OpenAPI URL',
        prompt: 'http(s) URL of a yaml or json OpenAPI 3.x document',
        ignoreFocusOut: true,
        validateInput: (v) =>
          /^https?:\/\//i.test(v.trim()) ? null : 'must be an http(s) URL',
      });
      if (!url) return;
      const res = await fetch(url.trim());
      if (!res.ok) {
        vscode.window.showErrorMessage(`Reqit: fetch failed — HTTP ${res.status}`);
        return;
      }
      text = await res.text();
      originHint = url.trim();
    }
  } catch (err) {
    vscode.window.showErrorMessage(`Reqit: failed to load spec — ${(err as Error).message}`);
    return;
  }

  let doc: unknown;
  try {
    doc = parseSpec(text, originHint);
  } catch (err) {
    vscode.window.showErrorMessage(`Reqit: not valid YAML/JSON — ${(err as Error).message}`);
    return;
  }

  let imported;
  try {
    imported = importOpenApi(doc);
  } catch (err) {
    vscode.window.showErrorMessage(`Reqit: not an OpenAPI 3.x doc — ${(err as Error).message}`);
    return;
  }

  if (imported.files.length === 0) {
    vscode.window.showWarningMessage('Reqit: nothing to import (no operations found).');
    return;
  }

  const root = vscode.Uri.joinPath(folder.uri, '.requests');
  const rootFsPath = folder.uri.fsPath;
  try {
    await vscode.workspace.fs.createDirectory(root);
  } catch {
    /* exists */
  }

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

  // Offer to merge {{baseUrl}} into .http-env.json.
  const varCount = Object.keys(imported.envVariables).length;
  if (varCount > 0) {
    const envName = await vscode.window.showInputBox({
      title: 'Reqit: env name for OpenAPI variables',
      prompt: `Merge ${varCount} variable(s) (incl. {{baseUrl}}) into .http-env.json under which env? Leave blank to skip.`,
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
    `Reqit: imported ${written.length} file(s) from OpenAPI.`,
  );

  if (written.length > 0) {
    const doc = await vscode.workspace.openTextDocument(written[0]!);
    await vscode.window.showTextDocument(doc);
  }
}

function parseSpec(text: string, hint: string): unknown {
  const trimmed = text.trimStart();
  // JSON path: starts with { or [, OR file extension says so.
  if (trimmed.startsWith('{') || trimmed.startsWith('[') || /\.json($|\?)/i.test(hint)) {
    try {
      return JSON.parse(text);
    } catch {
      // fall through to YAML — some YAML happens to start with {.
    }
  }
  return parseYaml(text);
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
    /* no existing file */
  }
  const existing =
    typeof current[envName] === 'object' && current[envName] !== null ? current[envName] : {};
  current[envName] = { ...existing, ...vars };
  const next = JSON.stringify(current, null, 2) + '\n';
  await vscode.workspace.fs.writeFile(envUri, Buffer.from(next, 'utf8'));
}

export type { ImportedHttpFile };
