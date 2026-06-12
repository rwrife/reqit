import * as vscode from 'vscode';
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
      'pokebot.response',
      'PokeBot Response',
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
  return `<!doctype html>
<html><head><meta charset="utf-8"><style>
  body { font-family: var(--vscode-editor-font-family, monospace); padding: 12px; }
  h2 { margin: 0 0 4px 0; font-size: 14px; }
  pre { white-space: pre-wrap; word-break: break-word; background: var(--vscode-textBlockQuote-background); padding: 8px; border-radius: 4px; }
  .meta { color: var(--vscode-descriptionForeground); font-size: 12px; margin-bottom: 8px; }
</style></head><body>
  <h2>${escape(r.request.method)} ${escape(r.request.url)}</h2>
  <div class="meta">${escape(statusLine)} · ${r.elapsedMs}ms · ${r.body.length} bytes</div>
  <h2>Headers</h2>
  <pre>${escape(headerLines)}</pre>
  <h2>Body</h2>
  <pre>${escape(body)}</pre>
</body></html>`;
}
