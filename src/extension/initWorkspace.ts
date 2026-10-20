import * as vscode from 'vscode';
import { assertInsideWorkspace } from '../core/pathGuard.js';
import { SAMPLE_CHAIN_HTTP } from './sampleFiles.js';

const SAMPLE_HTTP = `### hello
# Edit, then click "Send Request" above the request line.
GET {{baseUrl}}/get
Accept: application/json

### post-json
POST {{baseUrl}}/post
Content-Type: application/json
X-Request-Id: {{$guid}}

{
  "hello": "reqit",
  "ts": {{$timestamp}}
}
`;

const ENV_JSON = `{
  "default": {
    "baseUrl": "https://httpbin.org",
    "user": "alice",
    "pass": { "$secret": true }
  },
  "local": {
    "baseUrl": "http://localhost:3000",
    "apiKey": { "$secret": true }
  }
}
`;

const GITIGNORE = `.history/
`;

export async function initWorkspace(): Promise<void> {
  const folder = await selectInitFolder();
  if (!folder) {
    if ((vscode.workspace.workspaceFolders?.length ?? 0) === 0) {
      vscode.window.showErrorMessage('Reqit: open a workspace folder first.');
    }
    return;
  }
  const root = vscode.Uri.joinPath(folder.uri, '.requests');
  // ponytail: lexical write guard only; race-safe final-I/O confinement belongs to #56.
  // Hard guard: every write must resolve inside the chosen workspace folder.
  const rootFsPath = folder.uri.fsPath;
  assertInsideWorkspace(rootFsPath, root.fsPath);
  await vscode.workspace.fs.createDirectory(root);
  for (const [name, body] of [
    ['hello.http', SAMPLE_HTTP],
    ['chain.http', SAMPLE_CHAIN_HTTP],
    ['.http-env.json', ENV_JSON],
    ['.gitignore', GITIGNORE],
  ] as const) {
    const target = vscode.Uri.joinPath(root, name);
    assertInsideWorkspace(rootFsPath, target.fsPath);
    await writeIfMissing(target, body);
  }
  vscode.window.showInformationMessage(`Reqit: ${folder.name}/.requests/ scaffolded.`);
  const doc = await vscode.workspace.openTextDocument(vscode.Uri.joinPath(root, 'hello.http'));
  await vscode.window.showTextDocument(doc);
}

/**
 * Re-check live workspace after picker resolves; removed roots must not receive writes.
 */
async function selectInitFolder(): Promise<vscode.WorkspaceFolder | undefined> {
  const folders = vscode.workspace.workspaceFolders ?? [];
  if (folders.length <= 1) return folders[0];
  const selected = await vscode.window.showQuickPick(
    folders.map((folder) => ({ label: folder.name, description: folder.uri.fsPath, folder })),
    { title: 'Choose Reqit workspace', placeHolder: 'Select a workspace folder for .requests/' },
  );
  if (!selected) return undefined;
  return (vscode.workspace.workspaceFolders ?? []).find(
    (folder) => folder.uri.toString() === selected.folder.uri.toString(),
  );
}

async function writeIfMissing(uri: vscode.Uri, content: string): Promise<void> {
  try {
    await vscode.workspace.fs.stat(uri);
    return; // exists, leave alone
  } catch {
    await vscode.workspace.fs.writeFile(uri, Buffer.from(content, 'utf8'));
  }
}
