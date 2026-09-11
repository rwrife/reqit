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
 *     (`{ type: SSE_STOP_MESSAGE_TYPE, token: <per-session> }`); the
 *     extension host validates it against the owning session's token and
 *     aborts that session. No other message is ever sent.
 *
 * This module is pure: no VS Code, no network, no I/O.
 */

/** Message type posted by the stop button to the extension host. */
export const SSE_STOP_MESSAGE_TYPE = 'reqit-sse-stop' as const;

/**
 * Token charset the host generates per session (base64url) — restricted so
 * the token is safe inside the shim's single-quoted JS string literal and
 * cannot break the script context.
 */
const STOP_TOKEN_RE = /^[A-Za-z0-9_-]{8,64}$/;

/** Length-bounded constant-time string equality (no timing oracle on the token). */
function tokenEquals(a: string, b: string): boolean {
  if (a.length !== b.length) return false;
  let diff = 0;
  for (let i = 0; i < a.length; i++) {
    diff |= a.charCodeAt(i) ^ b.charCodeAt(i);
  }
  return diff === 0;
}

/**
 * Host-side validation for webview messages. Webview `postMessage` payloads
 * are untrusted input. Accept ONLY a plain-prototype object with exactly the
 * two own keys `type` (the stop constant) and `token` (matching this
 * session's unguessable per-session token) — arrays, primitives,
 * prototype-forged objects, symbol-keyed extras, foreign/missing tokens and
 * smuggled extra fields are all rejected. Token binding is what makes a
 * QUEUED click from a superseded session harmless: even if its message is
 * delivered after a newer session took ownership, the token will not match
 * the newer session and the host ignores it.
 */
export function isSseStopMessage(
  message: unknown,
  expectedToken: string,
): message is { type: typeof SSE_STOP_MESSAGE_TYPE; token: string } {
  if (typeof message !== 'object' || message === null || Array.isArray(message)) return false;
  if (Object.getPrototypeOf(message) !== Object.prototype) return false;
  if (Reflect.ownKeys(message).length !== 2) return false;
  const record = message as { type?: unknown; token?: unknown };
  if (record.type !== SSE_STOP_MESSAGE_TYPE) return false;
  if (typeof record.token !== 'string') return false;
  return tokenEquals(record.token, expectedToken);
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
   * Per-render CSP nonce for the inline shim. Must be canonical base64
   * that is safe inside both the CSP `script-src` directive and an HTML
   * attribute value; anything else is rejected loudly.
   */
  nonce: string;
  /**
   * Unguessable per-session token (base64url, 8-64 chars) embedded in the
   * posted stop message. The host re-checks it against the SAME session
   * that owns the panel, so a queued click from a superseded session can
   * never abort the current owner.
   */
  stopToken: string;
}

const NONCE_RE = /^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=|[A-Za-z0-9+/]{2,4})$/;

/**
 * Canonical-form check: syntax-valid base64 can still carry nonzero
 * "unused" pad bits (`AB==` decodes to a byte whose low 4 bits are junk and
 * re-encodes differently). Strict CSP nonces should be canonical, so decode
 * and re-encode and require byte-exact round-trip.
 */
function isCanonicalBase64(value: string): boolean {
  if (!NONCE_RE.test(value)) return false;
  const raw = Buffer.from(value, 'base64').toString('base64');
  // Buffer tolerates missing padding; compare against the padded canon of
  // our (already syntax-valid) input and allow the unpadded presentation.
  const padded = raw.replace(/=+$/, '');
  return raw === value || padded === value;
}

/** Fail-closed numeric coercion: only finite-number text reaches markup. */
function num(v: number): string {
  return Number.isFinite(v) ? String(v) : '0';
}

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
  if (!isCanonicalBase64(opts.nonce)) {
    throw new Error('SSE stream view: nonce must be canonical, CSP/attribute-safe base64');
  }
  if (typeof opts.stopToken !== 'string' || !STOP_TOKEN_RE.test(opts.stopToken)) {
    throw new Error('SSE stream view: stopToken must be an 8-64 char base64url token');
  }
  const nonce = opts.nonce;
  const headerLines = Object.entries(s.headers)
    .map(([k, v]) => `${k}: ${v}`)
    .join('\n');
  // Only an exact 0 means the network-error convention; other non-finite
  // values coerce to "HTTP 0" so garbage can never render as-is.
  const statusLine = s.status === 0 ? 'NETWORK ERROR' : `HTTP ${num(s.status)}`;
  const rows = s.events
    .map((e) => {
      const id = e.lastEventId ?? '';
      const body = prettyEventData(e.data);
      return `<div class="sse-event">
        <div class="sse-event-head">
          <span class="sse-index">#${escape(num(e.index))}</span>
          <span class="sse-kind">${escape(e.type)}</span>
          ${id ? `<span class="sse-id">id=${escape(id)}</span>` : ''}
          <span class="sse-elapsed">${escape(num(e.elapsedMs))}ms</span>
          <span class="sse-ts">${escape(e.timestamp)}</span>
        </div>
        <pre class="sse-data">${escape(body)}</pre>
      </div>`;
    })
    .join('');
  const streamState = s.streaming
    ? `<span class="sse-state sse-live">\u25CF streaming (${num(s.events.length)} events)</span>`
    : `<span class="sse-state sse-done">\u25A0 ${escape(s.stopReason ?? 'end-of-stream')} (${num(s.events.length)} events)</span>`;
  const noteBlock = s.note ? `<div class="sse-note">${escape(s.note)}</div>` : '';
  // The stop button only exists while a live session can actually be
  // aborted — never render a control that cannot take effect.
  const stopButton = s.streaming
    ? `<button id="reqit-sse-stop" type="button" title="Stop the live SSE stream" aria-label="Stop the live SSE stream">\u25A0 Stop stream</button>`
    : '';
  // Inline shim: acquire the (once-per-session) VS Code API handle lazily
  // and post exactly one fixed message shape on click. The one-shot latch
  // is set and the button disabled BEFORE the post attempt, so a failed or
  // exception-throwing post can never re-arm the control — an at-most-once
  // channel beats a retry that could double-fire after a partial success.
  const stopScript = s.streaming
    ? `<script nonce="${nonce}">
(function () {
  var posted = false;
  var btn = document.getElementById('reqit-sse-stop');
  if (!btn) return;
  btn.addEventListener('click', function () {
    if (posted) return;
    posted = true;
    btn.disabled = true;
    btn.textContent = '\\u25A0 stopping\\u2026';
    try {
      var api = (typeof acquireVsCodeApi === 'function') ? acquireVsCodeApi() : null;
      if (api && typeof api.postMessage === 'function') {
        api.postMessage({ type: '${SSE_STOP_MESSAGE_TYPE}', token: '${opts.stopToken}' });
      }
    } catch (e) {
      // Stay latched and disabled; the host treats a missing stop as
      // "user can retry via the palette command", never double-post here.
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
  <div class="meta">${escape(statusLine)} \u00B7 ${escape(num(s.elapsedMs))}ms since start</div>
  ${noteBlock}
  ${stopButton ? `<div class="sse-toolbar">${stopButton}</div>` : ''}
  <h2>Headers</h2>
  <pre>${escape(headerLines)}</pre>
  <h2>Events</h2>
  ${rows || '<div class="meta">(no events yet)</div>'}
${stopScript}
</body></html>`;
}
