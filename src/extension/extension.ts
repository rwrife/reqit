import * as vscode from 'vscode';
import { parseHttpFile, type ParsedRequest } from '../core/parser.js';
import { toUndiciRequest } from '../core/request.js';
import { substituteRequest } from '../core/substitute.js';
import { renderResponse, renderGrpcInfo, renderSseResponse, type SseRenderEvent, type SseRenderState } from './responseView.js';
import {
  isSseResponse,
  runSseTransport,
  sseOptionsFromDirectives,
} from '../core/sse/index.js';
import { requestToCurl } from '../core/curl.js';
import { initWorkspace } from './initWorkspace.js';
import { importFromCurlCommand } from './importCurl.js';
import { importFromPostmanCommand } from './importPostman.js';
import { importFromOpenApiCommand } from './importOpenapi.js';
import { RequestsTreeProvider } from './requestsTree.js';
import { EnvManager } from './envManager.js';
import { buildGrpcCodeLenses, parseGrpcFile } from '../core/grpc.js';

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
      new vscode.RelativePattern(folder, '.requests/**/*.{http,grpc}'),
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
    vscode.commands.registerCommand('reqit.importFromOpenApi', async () => {
      await importFromOpenApiCommand();
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
    vscode.commands.registerCommand(
      'reqit.sendGrpcRequest',
      async (arg?: { documentUri: string; requestLineIndex: number }) => {
        if (!arg) {
          vscode.window.showWarningMessage('Reqit: use the Send Request codelens on a .grpc file.');
          return;
        }
        const doc = await vscode.workspace.openTextDocument(vscode.Uri.parse(arg.documentUri));
        const { requests, diagnostics } = parseGrpcFile(doc.getText());
        const req = requests.find((r) => r.requestLineIndex === arg.requestLineIndex);
        if (!req) {
          const diag = diagnostics.find((d) => d.line <= arg.requestLineIndex);
          const detail = diag ? ` (${diag.message})` : '';
          vscode.window.showErrorMessage(
            `Reqit: gRPC request not found at codelens position${detail}.`,
          );
          return;
        }
        // Wire runner (server-reflection + mTLS via @grpc/grpc-js) ships in a
        // follow-up PR under issue #24. Until then we render the parsed
        // request into the response panel so users can verify the parser did
        // the right thing and copy things by hand if they need to.
        renderGrpcInfo(context, { request: req });
      },
    ),
    vscode.languages.registerCodeLensProvider({ language: 'http' }, new HttpCodeLensProvider()),
    vscode.languages.registerCodeLensProvider({ language: 'grpc' }, new GrpcCodeLensProvider()),
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

class GrpcCodeLensProvider implements vscode.CodeLensProvider {
  provideCodeLenses(document: vscode.TextDocument): vscode.CodeLens[] {
    const parsed = parseGrpcFile(document.getText());
    const specs = buildGrpcCodeLenses(parsed, document.uri.toString());
    return specs.map(
      (s) =>
        new vscode.CodeLens(new vscode.Range(s.line, 0, s.line, 0), {
          title: s.title,
          command: s.command,
          arguments: [s.arg],
        }),
    );
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
    const responseHeaders: Record<string, string> = Object.fromEntries(
      Object.entries(res.headers).map(([k, v]) => [k, Array.isArray(v) ? v.join(', ') : String(v ?? '')]),
    );
    if (isSseResponse(res.headers)) {
      await streamSseResponse(context, req, opts, res, responseHeaders, started);
      return;
    }
    const bodyText = await res.body.text();
    const elapsedMs = Date.now() - started;
    renderResponse(context, {
      request: opts,
      status: res.statusCode,
      headers: responseHeaders,
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

/**
 * Drive an SSE response into the streaming response webview.
 *
 * Detection lives in the caller (`isSseResponse`). This helper owns:
 *   - decoding the undici body stream into UTF-8 text chunks,
 *   - handing them to the pure {@link runSseTransport} driver,
 *   - refreshing the webview after each event (throttled to a paint),
 *   - surfacing @sse-until compile errors as a warning note without
 *     killing the stream.
 *
 * Reconnect / `Last-Event-ID` is intentionally not wired in this first
 * slice; the transport already tracks state, so a follow-up PR can retry
 * on transport-level failure without touching the parser or the view.
 */
async function streamSseResponse(
  context: vscode.ExtensionContext,
  req: ParsedRequest,
  opts: { method: string; url: string; headers: Record<string, string>; body?: string },
  res: { statusCode: number; body: AsyncIterable<unknown> },
  responseHeaders: Record<string, string>,
  _started: number,
): Promise<void> {
  const requestForView = opts as unknown as import('../core/request.js').UndiciRequestOptions;
  const directives = sseOptionsFromDirectives(req.directives);
  const events: SseRenderEvent[] = [];
  const initialNote = directives.diagnostics.length > 0
    ? `SSE directives ignored: ${directives.diagnostics.map((d) => `${d.directive} (${d.message})`).join('; ')}`
    : undefined;
  const state: SseRenderState = {
    request: requestForView,
    status: res.statusCode,
    headers: responseHeaders,
    elapsedMs: 0,
    events,
    streaming: true,
    ...(initialNote !== undefined ? { note: initialNote } : {}),
  };
  const handle = renderSseResponse(context, state);
  const abort = new AbortController();
  context.subscriptions.push({ dispose: () => abort.abort() });

  // Decode the undici body into UTF-8 strings.
  const decoder = new TextDecoder('utf-8');
  const input: AsyncIterable<string> = (async function* (): AsyncGenerator<string> {
    for await (const chunk of res.body as AsyncIterable<Uint8Array | string>) {
      if (typeof chunk === 'string') {
        yield chunk;
      } else {
        yield decoder.decode(chunk, { stream: true });
      }
    }
    const tail = decoder.decode();
    if (tail.length > 0) yield tail;
  })();

  const options: Parameters<typeof runSseTransport>[0] = {
    input,
    signal: abort.signal,
    onEvent: (event, meta) => {
      events.push({ event, meta, timestamp: new Date().toISOString() });
      state.elapsedMs = meta.elapsedMs;
      handle.update({ ...state, events: [...events] });
    },
    ...(directives.options.until !== undefined ? { until: directives.options.until } : {}),
    ...(directives.options.maxEvents !== undefined ? { maxEvents: directives.options.maxEvents } : {}),
    ...(directives.options.maxDurationMs !== undefined
      ? { maxDurationMs: directives.options.maxDurationMs }
      : {}),
    ...(directives.options.idleMs !== undefined ? { idleMs: directives.options.idleMs } : {}),
  };

  try {
    const result = await runSseTransport(options);
    const parts: string[] = [];
    if (initialNote) parts.push(initialNote);
    if (result.untilError) parts.push(`@sse-until error: ${result.untilError}`);
    const finalNote = parts.length > 0 ? parts.join(' | ') : undefined;
    handle.update({
      ...state,
      streaming: false,
      stopReason: result.reason,
      elapsedMs: result.durationMs,
      events: [...events],
      ...(finalNote !== undefined ? { note: finalNote } : {}),
    });
  } catch (err) {
    const message = (err as Error).message ?? String(err);
    handle.update({
      ...state,
      streaming: false,
      stopReason: 'end-of-stream',
      events: [...events],
      note: `SSE transport failed: ${message}`,
    });
    vscode.window.showErrorMessage(`Reqit: SSE stream failed \u2014 ${message}`);
  }
}
