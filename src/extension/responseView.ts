import * as vscode from 'vscode';
import { tryParseGraphQLResponse } from '../core/graphql.js';
import type { UndiciRequestOptions } from '../core/request.js';

export interface ResponseRender {
  request: UndiciRequestOptions;
  status: number;
  headers: Record<string, string>;
  body: string;
  elapsedMs: number;
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
