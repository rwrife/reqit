import * as vscode from 'vscode';
import { randomBytes } from 'node:crypto';
import { tryParseGraphQLResponse } from '../core/graphql.js';
import {
  buildSseStreamHtml,
  isSseStopMessage,
  type SseStreamViewModel,
} from '../core/sse/streamView.js';
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
/** True when the current shared panel was created with `enableScripts: true` (SSE mode). */
let ssePanelScripts = false;
/** Opaque token identifying the SSE session currently allowed to own the panel. */
let ssePanelOwner: object | undefined;

/** Map the extension render-state to the pure stream-view model. */
function toStreamViewModel(s: SseRenderState): SseStreamViewModel {
  return {
    method: s.request.method,
    url: s.request.url,
    status: s.status,
    headers: s.headers,
    elapsedMs: s.elapsedMs,
    streaming: s.streaming,
    ...(s.stopReason !== undefined ? { stopReason: s.stopReason } : {}),
    events: s.events.map((e) => ({
      index: e.meta.index,
      type: e.event.type,
      ...(e.event.lastEventId !== undefined ? { lastEventId: e.event.lastEventId } : {}),
      elapsedMs: e.meta.elapsedMs,
      timestamp: e.timestamp,
      data: e.event.data,
    })),
    ...(s.note !== undefined ? { note: s.note } : {}),
  };
}

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

/** CSP nonce for one render: base64 of 12 random bytes is always token-safe. */
function makeSseNonce(): string {
  return randomBytes(12).toString('base64');
}

export function renderSseResponse(
  context: vscode.ExtensionContext,
  initial: SseRenderState,
): SseRenderHandle {
  // The SSE panel needs scripts (stop-button shim only, locked by CSP).
  // A panel created earlier for a plain response has enableScripts:false
  // and VS Code cannot toggle that after creation — recreate in that case.
  if (panel && !ssePanelScripts) {
    const stale = panel;
    panel = undefined;
    stale.dispose();
  }
  if (!panel) {
    panel = vscode.window.createWebviewPanel(
      'reqit.response',
      'Reqit Response',
      vscode.ViewColumn.Beside,
      { enableScripts: true, retainContextWhenHidden: true },
    );
    ssePanelScripts = true;
    const p = panel;
    p.onDidDispose(() => {
      // Only clear the shared slot if WE still own it — a replacement
      // (dispose during panel swap) must not clobber the new panel.
      if (panel === p) {
        panel = undefined;
        ssePanelScripts = false;
      }
    });
    context.subscriptions.push(p);
  }
  const p = panel;
  // Ownership token: the shared panel may host only ONE authoritative SSE
  // session at a time. The newest session takes ownership; superseded
  // sessions can neither repaint the panel nor act on stop messages
  // (otherwise one click on a shared panel would abort every live stream).
  const owner: object = {};
  ssePanelOwner = owner;
  let current: SseRenderState = initial;
  const render = (): void => {
    // Paint only while WE own the panel slot. If a newer SSE session or a
    // plain/gRPC view replaced us, painting stale SSE HTML (or hijacking
    // the newer session's view) would be wrong.
    if (panel !== p || ssePanelOwner !== owner) return;
    p.webview.html = buildSseStreamHtml(toStreamViewModel(current), {
      nonce: makeSseNonce(),
    });
  };
  render();
  p.reveal(undefined, true);
  // Message channel from the stop button. The payload is untrusted input:
  // accept only the exact validated stop shape, act only while THIS
  // session is both live and the panel owner, and route to the owning
  // session's onStop (never the shared registry), so a click can only
  // stop the stream it belongs to.
  const msgSub = p.webview.onDidReceiveMessage((message: unknown) => {
    if (!isSseStopMessage(message)) return;
    if (ssePanelOwner !== owner) return;
    if (!current.streaming) return;
    current.onStop?.();
  });
  return {
    update(next: SseRenderState): void {
      current = next;
      render();
    },
    dispose(): void {
      // Leave the panel visible so the user can read the final transcript,
      // but stop listening and give up ownership: a stale rendered button
      // can no longer act, and a session that ended on its own must not
      // block newer sessions from owning the panel.
      msgSub.dispose();
      if (ssePanelOwner === owner) ssePanelOwner = undefined;
    },
  };
}


export function renderResponse(context: vscode.ExtensionContext, r: ResponseRender): void {
  // Symmetric with renderSseResponse: plain responses never need scripts.
  // If the shared panel was created in SSE mode (enableScripts:true),
  // recreate it scripts-disabled so the smaller attack surface is kept.
  if (panel && ssePanelScripts) {
    const stale = panel;
    panel = undefined;
    ssePanelScripts = false;
    stale.dispose();
  }
  if (!panel) {
    panel = vscode.window.createWebviewPanel(
      'reqit.response',
      'Reqit Response',
      vscode.ViewColumn.Beside,
      { enableScripts: false, retainContextWhenHidden: true },
    );
    const created = panel;
    created.onDidDispose(() => {
      // Ownership guard: never clear a slot a newer panel already took.
      if (panel === created) panel = undefined;
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
  // Same scripts-disabled guarantee as renderResponse: recreate the shared
  // panel if it currently exists in SSE (scripts-enabled) mode.
  if (panel && ssePanelScripts) {
    const stale = panel;
    panel = undefined;
    ssePanelScripts = false;
    stale.dispose();
  }
  if (!panel) {
    panel = vscode.window.createWebviewPanel(
      'reqit.response',
      'Reqit Response',
      vscode.ViewColumn.Beside,
      { enableScripts: false, retainContextWhenHidden: true },
    );
    const created = panel;
    created.onDidDispose(() => {
      // Ownership guard: never clear a slot a newer panel already took.
      if (panel === created) panel = undefined;
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
