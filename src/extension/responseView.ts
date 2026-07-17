import * as vscode from 'vscode';
import { tryParseGraphQLResponse } from '../core/graphql.js';
import type { UndiciRequestOptions } from '../core/request.js';
import type { ParsedGrpcRequest } from '../core/grpc.js';
import type { SseEvent } from '../core/sse/index.js';
import type {
  SseEventMeta,
  SseStopReason,
} from '../core/sse/transport.js';
import {
  preflightGrpcRequest,
  preflightBannerClass,
  type PreflightReport,
} from '../core/grpcPreflight.js';
import type { DescriptorIndex } from '../core/grpcDescriptorIndex.js';

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
  /**
   * Optional descriptor index (built from the reflection cache) used to
   * compute a preflight report. When omitted, the preview shows a
   * "reflection not yet available" preflight banner so users know why the
   * method-shape section is missing.
   */
  descriptors?: DescriptorIndex;
}

let panel: vscode.WebviewPanel | undefined;

export interface SseRenderEvent {
  event: SseEvent;
  meta: SseEventMeta;
  /** Wall-clock ISO timestamp for when the event was dispatched. */
  timestamp: string;
}

export interface SseRenderState {
  request: UndiciRequestOptions;
  status: number;
  headers: Record<string, string>;
  elapsedMs: number;
  events: SseRenderEvent[];
  /** Undefined while streaming; set when the driver finishes. */
  stopReason?: SseStopReason;
  /** True while the driver is still running. */
  streaming: boolean;
  /** Optional message (e.g. transport error, until-error). */
  note?: string;
  /** Fired when the user clicks the “Stop stream” affordance. */
  onStop?: () => void;
}

export interface SseRenderHandle {
  update(state: SseRenderState): void;
  dispose(): void;
}

export function renderSseResponse(
  context: vscode.ExtensionContext,
  initial: SseRenderState,
): SseRenderHandle {
  if (!panel) {
    panel = vscode.window.createWebviewPanel(
      'reqit.response',
      'Reqit Response',
      vscode.ViewColumn.Beside,
      { enableScripts: false, retainContextWhenHidden: true },
    );
    const p = panel;
    p.onDidDispose(() => {
      panel = undefined;
    });
    context.subscriptions.push(p);
  }
  const p = panel;
  let current: SseRenderState = initial;
  const render = (): void => {
    if (!panel) return;
    p.webview.html = sseHtml(current);
  };
  render();
  p.reveal(undefined, true);
  return {
    update(next: SseRenderState): void {
      current = next;
      render();
    },
    dispose(): void {
      // Leave the panel visible so the user can read the final transcript.
    },
  };
}


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
  const preflight = preflightGrpcRequest(r.request, { descriptors: r.descriptors });
  return `<!doctype html>
<html><head><meta charset="utf-8"><style>
  body { font-family: var(--vscode-editor-font-family, monospace); padding: 12px; }
  h2 { margin: 0 0 4px 0; font-size: 14px; }
  h3 { margin: 8px 0 4px 0; font-size: 12px; color: var(--vscode-descriptionForeground); }
  pre { white-space: pre-wrap; word-break: break-word; background: var(--vscode-textBlockQuote-background); padding: 8px; border-radius: 4px; }
  .meta { color: var(--vscode-descriptionForeground); font-size: 12px; margin-bottom: 8px; }
  .note { background: var(--vscode-inputValidation-warningBackground, #4d3800); color: var(--vscode-inputValidation-warningForeground, #fff); padding: 8px 10px; border-radius: 4px; margin: 8px 0; font-size: 12px; }
  .preflight { padding: 8px 10px; border-radius: 4px; margin: 8px 0; font-size: 12px; border: 1px solid var(--vscode-panel-border, transparent); }
  .preflight-ready { background: var(--vscode-inputValidation-infoBackground, #062f4a); color: var(--vscode-inputValidation-infoForeground, #cfe8ff); }
  .preflight-warn { background: var(--vscode-inputValidation-warningBackground, #4d3800); color: var(--vscode-inputValidation-warningForeground, #fff); }
  .preflight-error { background: var(--vscode-inputValidation-errorBackground, #5a1d1d); color: var(--vscode-inputValidation-errorForeground, #fff); }
  .preflight-info { background: var(--vscode-textBlockQuote-background); color: var(--vscode-descriptionForeground); }
  .preflight ul { margin: 6px 0 0 16px; padding: 0; }
  .preflight li { margin: 2px 0; }
</style></head><body>
  <h2>GRPC ${escape(t.service)}/${escape(t.method)}</h2>
  <div class="meta">${escape(url)}</div>
  ${renderPreflight(preflight)}
  <div class="note">${escape(note)}</div>
  <h2>Auth profile</h2>
  <pre>${escape(authLine)}</pre>
  <h2>Metadata</h2>
  <pre>${escape(meta.length === 0 ? '(none)' : meta)}</pre>
  <h2>Request body</h2>
  <pre>${escape(bodyPretty)}</pre>
</body></html>`;
}

function renderPreflight(report: PreflightReport): string {
  const cls = preflightBannerClass(report.status);
  const items = report.messages
    .map((m) => `<li><strong>${escape(m.level)}:</strong> ${escape(m.text)}</li>`) 
    .join('');
  const list = items.length === 0 ? '' : `<ul>${items}</ul>`;
  return `<div class="preflight ${cls}"><strong>Preflight:</strong> ${escape(report.summary)}${list}</div>`;
}

function prettyEventData(data: string): string {
  const trimmed = data.trim();
  if (trimmed.startsWith('{') || trimmed.startsWith('[')) {
    try {
      return JSON.stringify(JSON.parse(trimmed), null, 2);
    } catch {
      return data;
    }
  }
  return data;
}

function sseHtml(s: SseRenderState): string {
  const headerLines = Object.entries(s.headers)
    .map(([k, v]) => `${escape(k)}: ${escape(v)}`)
    .join('\n');
  const statusLine = s.status === 0 ? 'NETWORK ERROR' : `HTTP ${s.status}`;
  const rows = s.events
    .map((e) => {
      const kind = e.event.type;
      const id = e.event.lastEventId ?? '';
      const body = prettyEventData(e.event.data);
      return `<div class="sse-event">
        <div class="sse-event-head">
          <span class="sse-index">#${e.meta.index}</span>
          <span class="sse-kind">${escape(kind)}</span>
          ${id ? `<span class="sse-id">id=${escape(id)}</span>` : ''}
          <span class="sse-elapsed">${e.meta.elapsedMs}ms</span>
          <span class="sse-ts">${escape(e.timestamp)}</span>
        </div>
        <pre class="sse-data">${escape(body)}</pre>
      </div>`;
    })
    .join('');
  const streamState = s.streaming
    ? `<span class="sse-state sse-live">\u25CF streaming (${s.events.length} events)</span>`
    : `<span class="sse-state sse-done">\u25A0 ${escape(s.stopReason ?? 'end-of-stream')} (${s.events.length} events)</span>`;
  const noteBlock = s.note ? `<div class="sse-note">${escape(s.note)}</div>` : '';
  return `<!doctype html>
<html><head><meta charset="utf-8"><style>
  body { font-family: var(--vscode-editor-font-family, monospace); padding: 12px; }
  h2 { margin: 0 0 4px 0; font-size: 14px; }
  h3 { margin: 8px 0 4px 0; font-size: 12px; color: var(--vscode-descriptionForeground); }
  pre { white-space: pre-wrap; word-break: break-word; background: var(--vscode-textBlockQuote-background); padding: 8px; border-radius: 4px; }
  .meta { color: var(--vscode-descriptionForeground); font-size: 12px; margin-bottom: 8px; }
  .sse-note { background: var(--vscode-inputValidation-warningBackground, #4d3800); color: var(--vscode-inputValidation-warningForeground, #fff); padding: 8px 10px; border-radius: 4px; margin: 8px 0; font-size: 12px; }
  .sse-state { display: inline-block; padding: 2px 8px; border-radius: 10px; font-size: 12px; margin-left: 8px; }
  .sse-live { background: var(--vscode-inputValidation-infoBackground, #062f4a); color: var(--vscode-inputValidation-infoForeground, #cfe8ff); }
  .sse-done { background: var(--vscode-textBlockQuote-background); color: var(--vscode-descriptionForeground); }
  .sse-event { border: 1px solid var(--vscode-panel-border, transparent); border-radius: 4px; margin: 6px 0; padding: 6px 8px; }
  .sse-event-head { font-size: 12px; color: var(--vscode-descriptionForeground); display: flex; gap: 10px; flex-wrap: wrap; }
  .sse-kind { color: var(--vscode-textLink-foreground); font-weight: bold; }
  .sse-data { margin: 4px 0 0 0; font-size: 12px; }
</style></head><body>
  <h2>${escape(s.request.method)} ${escape(s.request.url)} ${streamState}</h2>
  <div class="meta">${escape(statusLine)} \u00B7 ${s.elapsedMs}ms since start</div>
  ${noteBlock}
  <h2>Headers</h2>
  <pre>${escape(headerLines)}</pre>
  <h2>Events</h2>
  ${rows || '<div class="meta">(no events yet)</div>'}
</body></html>`;
}
