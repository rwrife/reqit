import * as vscode from 'vscode';
import { tryParseGraphQLResponse } from '../core/graphql.js';
import type { UndiciRequestOptions } from '../core/request.js';
import type { ParsedGrpcRequest } from '../core/grpc.js';

export interface ResponseRender {
  request: UndiciRequestOptions;
  status: number;
  headers: Record<string, string>;
  body: string;
  elapsedMs: number;
}

export interface GrpcInfoRender {
  request: ParsedGrpcRequest;
  /** Optional human-readable note surfaced above the payload preview. */
  note?: string;
}

let panel: vscode.WebviewPanel | undefined;

export function renderResponse(context: vscode.ExtensionContext, r: ResponseRender): void {
  if (!panel) {
    panel = vscode.window.createWebviewPanel(
      'reqit.response',
      'Reqit Response',
      vscode.ViewColumn.Beside,
      { enableScripts: false, retainContextWhenHidden: true },
    );
    panel.onDidDispose(() => {
      panel = undefined;
    });
    context.subscriptions.push(panel);
  }
  panel.webview.html = html(r);
  panel.reveal(undefined, true);
}

function escape(s: string): string {
  return s
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;');
}

function prettyBody(body: string, contentType: string | undefined): string {
  if (!body) return '';
  if (contentType && /application\/(json|.*\+json)/i.test(contentType)) {
    try {
      return JSON.stringify(JSON.parse(body), null, 2);
    } catch {
      return body;
    }
  }
  return body;
}

function html(r: ResponseRender): string {
  const headerLines = Object.entries(r.headers)
    .map(([k, v]) => `${escape(k)}: ${escape(v)}`)
    .join('\n');
  const ct = r.headers['content-type'] ?? r.headers['Content-Type'];
  const body = prettyBody(r.body, ct);
  const statusLine = r.status === 0 ? 'NETWORK ERROR' : `HTTP ${r.status}`;
  const gql = tryParseGraphQLResponse(r.body, ct);
  const gqlBlock = gql
    ? `
  <h2>GraphQL</h2>
  ${
    'data' in gql
      ? `<h3>data</h3><pre>${escape(JSON.stringify(gql.data, null, 2))}</pre>`
      : ''
  }${
    'errors' in gql
      ? `<h3>errors</h3><pre>${escape(JSON.stringify(gql.errors, null, 2))}</pre>`
      : ''
  }`
    : '';
  return `<!doctype html>
<html><head><meta charset="utf-8"><style>
  body { font-family: var(--vscode-editor-font-family, monospace); padding: 12px; }
  h2 { margin: 0 0 4px 0; font-size: 14px; }
  h3 { margin: 8px 0 4px 0; font-size: 12px; color: var(--vscode-descriptionForeground); }
  pre { white-space: pre-wrap; word-break: break-word; background: var(--vscode-textBlockQuote-background); padding: 8px; border-radius: 4px; }
  .meta { color: var(--vscode-descriptionForeground); font-size: 12px; margin-bottom: 8px; }
</style></head><body>
  <h2>${escape(r.request.method)} ${escape(r.request.url)}</h2>
  <div class="meta">${escape(statusLine)} · ${r.elapsedMs}ms · ${r.body.length} bytes</div>
  <h2>Headers</h2>
  <pre>${escape(headerLines)}</pre>${gqlBlock}
  <h2>Body</h2>
  <pre>${escape(body)}</pre>
</body></html>`;
}

/**
 * Render a preview of a parsed gRPC request in the shared response webview.
 *
 * This is what users see today when they click ▶ Send Request on a `.grpc`
 * file: the parsed target, resolved auth profile, metadata, and body, plus a
 * clear “live wire-up shipping in a follow-up PR” notice tied to issue #24.
 * Once the reflection-backed runner lands this function will be replaced by
 * a proper decoded-response view; keeping it here means we can ship the
 * codelens today without the extension pretending a network call happened.
 */
export function renderGrpcInfo(
  context: vscode.ExtensionContext,
  r: GrpcInfoRender,
): void {
  if (!panel) {
    panel = vscode.window.createWebviewPanel(
      'reqit.response',
      'Reqit Response',
      vscode.ViewColumn.Beside,
      { enableScripts: false, retainContextWhenHidden: true },
    );
    panel.onDidDispose(() => {
      panel = undefined;
    });
    context.subscriptions.push(panel);
  }
  panel.webview.html = grpcHtml(r);
  panel.reveal(undefined, true);
}

function grpcHtml(r: GrpcInfoRender): string {
  const t = r.request.target;
  const scheme = t.plaintext ? 'grpc' : 'grpcs';
  const url = `${scheme}://${t.host}:${t.port}/${t.service}/${t.method}`;
  const meta = Object.entries(r.request.metadata)
    .map(([k, v]) => `${escape(k)}: ${escape(v)}`)
    .join('\n');
  const bodyPretty =
    r.request.body === undefined
      ? '(empty)'
      : JSON.stringify(r.request.body, null, 2);
  const note = r.note ?? 'Live gRPC dispatch ships in a follow-up PR (see issue #24).';
  const authLine = r.request.authProfile ?? '(none)';
  return `<!doctype html>
<html><head><meta charset="utf-8"><style>
  body { font-family: var(--vscode-editor-font-family, monospace); padding: 12px; }
  h2 { margin: 0 0 4px 0; font-size: 14px; }
  h3 { margin: 8px 0 4px 0; font-size: 12px; color: var(--vscode-descriptionForeground); }
  pre { white-space: pre-wrap; word-break: break-word; background: var(--vscode-textBlockQuote-background); padding: 8px; border-radius: 4px; }
  .meta { color: var(--vscode-descriptionForeground); font-size: 12px; margin-bottom: 8px; }
  .note { background: var(--vscode-inputValidation-warningBackground, #4d3800); color: var(--vscode-inputValidation-warningForeground, #fff); padding: 8px 10px; border-radius: 4px; margin: 8px 0; font-size: 12px; }
</style></head><body>
  <h2>GRPC ${escape(t.service)}/${escape(t.method)}</h2>
  <div class="meta">${escape(url)}</div>
  <div class="note">${escape(note)}</div>
  <h2>Auth profile</h2>
  <pre>${escape(authLine)}</pre>
  <h2>Metadata</h2>
  <pre>${escape(meta.length === 0 ? '(none)' : meta)}</pre>
  <h2>Request body</h2>
  <pre>${escape(bodyPretty)}</pre>
</body></html>`;
}
