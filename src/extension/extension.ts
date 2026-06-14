import * as vscode from 'vscode';
import { parseHttpFile, type ParsedRequest } from '../core/parser.js';
import { toUndiciRequest } from '../core/request.js';
import { renderResponse } from './responseView.js';
import { initWorkspace } from './initWorkspace.js';
import { RequestsTreeProvider } from './requestsTree.js';

export function activate(context: vscode.ExtensionContext): void {
  const treeProvider = new RequestsTreeProvider();
  const treeView = vscode.window.createTreeView('pokebot.requests', {
    treeDataProvider: treeProvider,
    showCollapseAll: true,
  });
  context.subscriptions.push(treeView);

  // Watch .requests/ for changes to keep the tree fresh, without polling.
  const folder = vscode.workspace.workspaceFolders?.[0];
  if (folder) {
    const watcher = vscode.workspace.createFileSystemWatcher(
      new vscode.RelativePattern(folder, '.requests/**/*.http'),
    );
    watcher.onDidCreate(() => treeProvider.refresh());
    watcher.onDidChange(() => treeProvider.refresh());
    watcher.onDidDelete(() => treeProvider.refresh());
    context.subscriptions.push(watcher);
  }

  context.subscriptions.push(
    vscode.commands.registerCommand('pokebot.initWorkspace', async () => {
      await initWorkspace();
      treeProvider.refresh();
    }),
    vscode.commands.registerCommand('pokebot.refreshRequests', () => treeProvider.refresh()),
    vscode.commands.registerCommand(
      'pokebot.sendRequest',
      async (arg?: { documentUri: string; requestLineIndex: number }) => {
        if (!arg) {
          vscode.window.showWarningMessage('PokeBot: use the Send Request codelens.');
          return;
        }
        const doc = await vscode.workspace.openTextDocument(vscode.Uri.parse(arg.documentUri));
        const parsed = parseHttpFile(doc.getText());
        const req = parsed.requests.find((r) => r.requestLineIndex === arg.requestLineIndex);
        if (!req) {
          vscode.window.showErrorMessage('PokeBot: request not found at codelens position.');
          return;
        }
        await runRequest(context, req);
      },
    ),
    vscode.languages.registerCodeLensProvider({ language: 'http' }, new HttpCodeLensProvider()),
  );
}

export function deactivate(): void {
  // no-op
}

class HttpCodeLensProvider implements vscode.CodeLensProvider {
  provideCodeLenses(document: vscode.TextDocument): vscode.CodeLens[] {
    const { requests } = parseHttpFile(document.getText());
    return requests.map((r) => {
      const range = new vscode.Range(r.requestLineIndex, 0, r.requestLineIndex, 0);
      return new vscode.CodeLens(range, {
        title: '▶ Send Request',
        command: 'pokebot.sendRequest',
        arguments: [{ documentUri: document.uri.toString(), requestLineIndex: r.requestLineIndex }],
      });
    });
  }
}

async function runRequest(
  context: vscode.ExtensionContext,
  req: ParsedRequest,
): Promise<void> {
  let opts;
  try {
    opts = toUndiciRequest(req);
  } catch (err) {
    vscode.window.showErrorMessage(`PokeBot: invalid request — ${(err as Error).message}`);
    return;
  }

  // Dynamic import — keeps activation cheap and avoids bundling undici into the activation path.
  const { request } = await import('undici');
  const started = Date.now();
  try {
    const res = await request(opts.url, {
      method: opts.method,
      headers: opts.headers,
      body: opts.body,
    });
    const bodyText = await res.body.text();
    const elapsedMs = Date.now() - started;
    renderResponse(context, {
      request: opts,
      status: res.statusCode,
      headers: Object.fromEntries(
        Object.entries(res.headers).map(([k, v]) => [k, Array.isArray(v) ? v.join(', ') : String(v ?? '')]),
      ),
      body: bodyText,
      elapsedMs,
    });
  } catch (err) {
    const elapsedMs = Date.now() - started;
    vscode.window.showErrorMessage(`PokeBot: request failed — ${(err as Error).message}`);
    renderResponse(context, {
      request: opts,
      status: 0,
      headers: {},
      body: `// Error after ${elapsedMs}ms\n${(err as Error).stack ?? (err as Error).message}`,
      elapsedMs,
    });
  }
}
