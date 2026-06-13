import * as vscode from 'vscode';

const SAMPLE_HTTP = `### hello
# Edit, then click "Send Request" above the request line.
GET https://httpbin.org/get
Accept: application/json

### post-json
POST https://httpbin.org/post
Content-Type: application/json

{
  "hello": "pokebot"
}
`;

const ENV_JSON = `{
  "default": {},
  "local": {
    "baseUrl": "http://localhost:3000"
  }
}
`;

const GITIGNORE = `.history/
`;

export async function initWorkspace(): Promise<void> {
  const folder = vscode.workspace.workspaceFolders?.[0];
  if (!folder) {
    vscode.window.showErrorMessage('PokeBot: open a workspace folder first.');
    return;
  }
  const root = vscode.Uri.joinPath(folder.uri, '.requests');
  await vscode.workspace.fs.createDirectory(root);
  await writeIfMissing(vscode.Uri.joinPath(root, 'hello.http'), SAMPLE_HTTP);
  await writeIfMissing(vscode.Uri.joinPath(root, '.http-env.json'), ENV_JSON);
  await writeIfMissing(vscode.Uri.joinPath(root, '.gitignore'), GITIGNORE);
  vscode.window.showInformationMessage('PokeBot: .requests/ scaffolded.');
  const doc = await vscode.workspace.openTextDocument(vscode.Uri.joinPath(root, 'hello.http'));
  await vscode.window.showTextDocument(doc);
}

async function writeIfMissing(uri: vscode.Uri, content: string): Promise<void> {
  try {
    await vscode.workspace.fs.stat(uri);
    return; // exists, leave alone
  } catch {
    await vscode.workspace.fs.writeFile(uri, Buffer.from(content, 'utf8'));
  }
}
