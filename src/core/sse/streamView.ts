/**
 * Pure HTML builder for the live SSE stream view (response webview).
 *
 * Extracted from the extension layer so the exact markup the user sees —
 * including the dedicated "Stop stream" button from issue #46 — is unit
 * testable with no VS Code dependency.
 *
 * Security model (see docs/security/local-data-and-threat-model.md):
 *   - All dynamic values (request line, headers, event type/id/timestamp,
 *     event data, notes) are HTML-escaped. Response data is untrusted.
 *   - The page ships a strict CSP: `default-src 'none'`, styles inline,
 *     scripts restricted to a caller-provided per-render nonce. The only
 *     script is the click-to-postMessage shim for the stop button.
 *   - The inline shim posts a single fixed message shape
 *     (`{ type: SSE_STOP_MESSAGE_TYPE }`); the extension host validates
 *     it and aborts the owning session. No other message is ever sent.
 *
 * This module is pure: no VS Code, no network, no I/O.
 */

/** Message type posted by the stop button to the extension host. */
export const SSE_STOP_MESSAGE_TYPE = 'reqit-sse-stop' as const;

/**
 * Host-side validation for webview messages. Webview `postMessage` payloads
 * are untrusted input: accept ONLY a plain object whose own (not
 * prototype-inherited) `type` property is the stop constant and that has no
 * other properties. Anything else — including forged prototypes, arrays,
 * and smuggled extra fields — is rejected so a compromised/buggy view can
 * never smuggle consequential data through this channel.
 */
export function isSseStopMessage(message: unknown): message is { type: typeof SSE_STOP_MESSAGE_TYPE } {
  return (
    typeof message === 'object' &&
    message !== null &&
    !Array.isArray(message) &&
    Object.prototype.hasOwnProperty.call(message, 'type') &&
    Object.getOwnPropertyNames(message).length === 1 &&
    (message as { type: unknown }).type === SSE_STOP_MESSAGE_TYPE
  );
}

/** One rendered SSE event row. */
export interface SseStreamViewEvent {
  /** 0-based dispatch index. */
  index: number;
  /** Event type (`event:` field; `message` when defaulted). */
  type: string;
  /** Optional `id:` field. */
  lastEventId?: string;
  /** Milliseconds since the stream started when dispatched. */
  elapsedMs: number;
  /** Wall-clock ISO timestamp of dispatch. */
  timestamp: string;
  /** Raw event payload (escaped before render). */
  data: string;
}

/** View-model for the live stream panel. */
export interface SseStreamViewModel {
  method: string;
  url: string;
  /** HTTP status (0 renders as NETWORK ERROR). */
  status: number;
  headers: Record<string, string>;
  /** Milliseconds since start (final duration when not streaming). */
  elapsedMs: number;
  /** True while the transport driver is still running. */
  streaming: boolean;
  /** Terminal stop reason (only meaningful when `streaming` is false). */
  stopReason?: string;
  events: readonly SseStreamViewEvent[];
  /** Optional note (directive diagnostics, until-error, reconnect count). */
  note?: string;
}

export interface SseStreamViewOptions {
  /**
   * Per-render CSP nonce for the inline shim. Must be a token that is safe
   * inside both the CSP `script-src` directive and an HTML attribute
   * value; anything else is rejected loudly.
   */
  nonce: string;
}

const NONCE_RE = /^[A-Za-z0-9+/=_-]+$/;

function escape(s: string): string {
  return s
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
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

/**
 * Build the full HTML document for the live SSE stream panel.
 *
 * @throws When `nonce` could break the CSP directive or attribute context.
 */
export function buildSseStreamHtml(
  s: SseStreamViewModel,
  opts: SseStreamViewOptions,
): string {
  if (!NONCE_RE.test(opts.nonce)) {
    throw new Error('SSE stream view: nonce must be a CSP/attribute-safe token');
  }
  const nonce = opts.nonce;
  const headerLines = Object.entries(s.headers)
    .map(([k, v]) => `${escape(k)}: ${escape(v)}`)
    .join('\n');
  const statusLine = s.status === 0 ? 'NETWORK ERROR' : `HTTP ${s.status}`;
  const rows = s.events
    .map((e) => {
      const id = e.lastEventId ?? '';
      const body = prettyEventData(e.data);
      return `<div class="sse-event">
        <div class="sse-event-head">
          <span class="sse-index">#${e.index}</span>
          <span class="sse-kind">${escape(e.type)}</span>
          ${id ? `<span class="sse-id">id=${escape(id)}</span>` : ''}
          <span class="sse-elapsed">${e.elapsedMs}ms</span>
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
  // The stop button only exists while a live session can actually be
  // aborted — never render a control that cannot take effect.
  const stopButton = s.streaming
    ? `<button id="reqit-sse-stop" type="button" title="Stop the live SSE stream" aria-label="Stop the live SSE stream">\u25A0 Stop stream</button>`
    : '';
  // Inline shim: acquire the (once-per-session) VS Code API handle lazily
  // and post exactly one fixed message shape on click; disable the button
  // after first click so a double-click cannot send two stops.
  const stopScript = s.streaming
    ? `<script nonce="${nonce}">
(function () {
  var posted = false;
  var btn = document.getElementById('reqit-sse-stop');
  if (!btn) return;
  btn.addEventListener('click', function () {
    if (posted) return;
    posted = true;
    try {
      var api = (typeof acquireVsCodeApi === 'function') ? acquireVsCodeApi() : null;
      if (api && typeof api.postMessage === 'function') {
        api.postMessage({ type: '${SSE_STOP_MESSAGE_TYPE}' });
        btn.disabled = true;
        btn.textContent = '\\u25A0 stopping\\u2026';
      }
    } catch (e) {
      posted = false;
    }
  });
})();
</script>`
    : '';
  return `<!doctype html>
<html><head><meta charset="utf-8">
<meta http-equiv="Content-Security-Policy" content="default-src 'none'; style-src 'unsafe-inline'; script-src 'nonce-${nonce}';">
<style>
  body { font-family: var(--vscode-editor-font-family, monospace); padding: 12px; }
  h2 { margin: 0 0 4px 0; font-size: 14px; }
  h3 { margin: 8px 0 4px 0; font-size: 12px; color: var(--vscode-descriptionForeground); }
  pre { white-space: pre-wrap; word-break: break-word; background: var(--vscode-textBlockQuote-background); padding: 8px; border-radius: 4px; }
  .meta { color: var(--vscode-descriptionForeground); font-size: 12px; margin-bottom: 8px; }
  .sse-note { background: var(--vscode-inputValidation-warningBackground, #4d3800); color: var(--vscode-inputValidation-warningForeground, #fff); padding: 8px 10px; border-radius: 4px; margin: 8px 0; font-size: 12px; }
  .sse-state { display: inline-block; padding: 2px 8px; border-radius: 10px; font-size: 12px; margin-left: 8px; }
  .sse-live { background: var(--vscode-inputValidation-infoBackground, #062f4a); color: var(--vscode-inputValidation-infoForeground, #cfe8ff); }
  .sse-done { background: var(--vscode-textBlockQuote-background); color: var(--vscode-descriptionForeground); }
  .sse-toolbar { margin: 6px 0; }
  #reqit-sse-stop { font: inherit; padding: 3px 12px; border-radius: 4px; border: 1px solid var(--vscode-button-border, transparent); background: var(--vscode-button-background, #0e639c); color: var(--vscode-button-foreground, #fff); cursor: pointer; }
  #reqit-sse-stop:hover { background: var(--vscode-button-hoverBackground, #1177bb); }
  #reqit-sse-stop:disabled { opacity: 0.6; cursor: default; }
  .sse-event { border: 1px solid var(--vscode-panel-border, transparent); border-radius: 4px; margin: 6px 0; padding: 6px 8px; }
  .sse-event-head { font-size: 12px; color: var(--vscode-descriptionForeground); display: flex; gap: 10px; flex-wrap: wrap; }
  .sse-kind { color: var(--vscode-textLink-foreground); font-weight: bold; }
  .sse-data { margin: 4px 0 0 0; font-size: 12px; }
</style></head><body>
  <h2>${escape(s.method)} ${escape(s.url)} ${streamState}</h2>
  <div class="meta">${escape(statusLine)} \u00B7 ${s.elapsedMs}ms since start</div>
  ${noteBlock}
  ${stopButton ? `<div class="sse-toolbar">${stopButton}</div>` : ''}
  <h2>Headers</h2>
  <pre>${escape(headerLines)}</pre>
  <h2>Events</h2>
  ${rows || '<div class="meta">(no events yet)</div>'}
${stopScript}
</body></html>`;
}
