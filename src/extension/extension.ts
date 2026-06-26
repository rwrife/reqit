import * as vscode from 'vscode';
import { parseHttpFile, type ParsedRequest } from '../core/parser.js';
import { toUndiciRequest } from '../core/request.js';
import { substituteRequest } from '../core/substitute.js';
import { renderResponse } from './responseView.js';
import { requestToCurl } from '../core/curl.js';
import { initWorkspace } from './initWorkspace.js';
import { importFromCurlCommand } from './importCurl.js';
import { importFromPostmanCommand } from './importPostman.js';
import { RequestsTreeProvider } from './requestsTree.js';
import { EnvManager } from './envManager.js';

export function activate(context: vscode.ExtensionContext): void {
  const treeProvider = new RequestsTreeProvider();
  const treeView = vscode.window.createTreeView('reqit.requests', {
    treeDataProvider: treeProvider,
    showCollapseAll: true,
  });
  context.subscriptions.push(treeView);

  const envManager = new EnvManager(context);
  context.subscriptions.push(envManager);
  void envManager.init();

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
    vscode.commands.registerCommand('reqit.initWorkspace', async () => {
      await initWorkspace();
      treeProvider.refresh();
    }),
    vscode.commands.registerCommand('reqit.importFromCurl', async () => {
      await importFromCurlCommand();
      treeProvider.refresh();
    }),
    vscode.commands.registerCommand('reqit.importFromPostman', async () => {
      await importFromPostmanCommand();
      treeProvider.refresh();
    }),
    vscode.commands.registerCommand('reqit.refreshRequests', () => treeProvider.refresh()),
    vscode.commands.registerCommand('reqit.selectEnv', () => envManager.pickEnv()),
    vscode.commands.registerCommand(
      'reqit.copyAsCurl',
      async (arg?: { documentUri: string; requestLineIndex: number; revealSecrets?: boolean }) => {
        if (!arg) {
          vscode.window.showWarningMessage('Reqit: use the Copy as curl codelens.');
          return;
        }
        const doc = await vscode.workspace.openTextDocument(vscode.Uri.parse(arg.documentUri));
        const parsed = parseHttpFile(doc.getText());
        const req = parsed.requests.find((r) => r.requestLineIndex === arg.requestLineIndex);
        if (!req) {
          vscode.window.showErrorMessage('Reqit: request not found at codelens position.');
          return;
        }
        const { resolve, secretValues } = await envManager.buildResolver();
        const substituted = substituteRequest(
          { url: req.url, headers: req.headers, body: req.body },
          { resolve },
        );
        if (substituted.diagnostics.length > 0) {
          const names = [...new Set(substituted.diagnostics.map((d) => d.variable))].join(', ');
          vscode.window.showErrorMessage(
            `Reqit: unresolved variables (${envManager.active}): ${names}`,
          );
          return;
        }
        let opts;
        try {
          opts = toUndiciRequest({
            ...req,
            url: substituted.url,
            headers: substituted.headers,
            body: substituted.body,
          });
        } catch (err) {
          vscode.window.showErrorMessage(`Reqit: invalid request — ${(err as Error).message}`);
          return;
        }
        const cmd = requestToCurl(opts, {
          redact: arg.revealSecrets ? [] : secretValues,
        });
        await vscode.env.clipboard.writeText(cmd);
        vscode.window.showInformationMessage(
          arg.revealSecrets
            ? 'Reqit: curl copied (with secrets — handle with care).'
            : 'Reqit: curl copied (secrets redacted).',
        );
      },
    ),
    vscode.commands.registerCommand('reqit.setSecret', async () => {
      const secrets = envManager.listSecrets();
      if (secrets.length === 0) {
        vscode.window.showInformationMessage(
          'Reqit: no secrets declared in .http-env.json (use { "$secret": true }).',
        );
        return;
      }
      const pick = await vscode.window.showQuickPick(
        secrets.map((s) => ({ label: `${s.env}.${s.name}`, env: s.env, name: s.name })),
        { placeHolder: 'Select secret to set' },
      );
      if (!pick) return;
      await envManager.setSecret(pick.env, pick.name);
    }),
    vscode.commands.registerCommand(
      'reqit.sendRequest',
      async (arg?: { documentUri: string; requestLineIndex: number }) => {
        if (!arg) {
          vscode.window.showWarningMessage('Reqit: use the Send Request codelens.');
          return;
        }
        const doc = await vscode.workspace.openTextDocument(vscode.Uri.parse(arg.documentUri));
        const parsed = parseHttpFile(doc.getText());
        const req = parsed.requests.find((r) => r.requestLineIndex === arg.requestLineIndex);
        if (!req) {
          vscode.window.showErrorMessage('Reqit: request not found at codelens position.');
          return;
        }
        await runRequest(context, req, envManager);
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
    const lenses: vscode.CodeLens[] = [];
    for (const r of requests) {
      const range = new vscode.Range(r.requestLineIndex, 0, r.requestLineIndex, 0);
      const args = [{ documentUri: document.uri.toString(), requestLineIndex: r.requestLineIndex }];
      lenses.push(
        new vscode.CodeLens(range, {
          title: '▶ Send Request',
          command: 'reqit.sendRequest',
          arguments: args,
        }),
        new vscode.CodeLens(range, {
          title: '$(clippy) Copy as curl',
          command: 'reqit.copyAsCurl',
          arguments: args,
        }),
      );
    }
    return lenses;
  }
}

async function runRequest(
  context: vscode.ExtensionContext,
  req: ParsedRequest,
  envManager: EnvManager,
): Promise<void> {
  const { resolve } = await envManager.buildResolver();
  const substituted = substituteRequest(
    { url: req.url, headers: req.headers, body: req.body },
    { resolve },
  );
  if (substituted.diagnostics.length > 0) {
    const names = [...new Set(substituted.diagnostics.map((d) => d.variable))].join(', ');
    vscode.window.showErrorMessage(
      `Reqit: unresolved variables (${envManager.active}): ${names}`,
    );
    return;
  }
  const requestForUndici: ParsedRequest = {
    ...req,
    url: substituted.url,
    headers: substituted.headers,
    body: substituted.body,
  };
  let opts;
  try {
    opts = toUndiciRequest(requestForUndici);
  } catch (err) {
    vscode.window.showErrorMessage(`Reqit: invalid request — ${(err as Error).message}`);
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
    vscode.window.showErrorMessage(`Reqit: request failed — ${(err as Error).message}`);
    renderResponse(context, {
      request: opts,
      status: 0,
      headers: {},
      body: `// Error after ${elapsedMs}ms\n${(err as Error).stack ?? (err as Error).message}`,
      elapsedMs,
    });
  }
}
