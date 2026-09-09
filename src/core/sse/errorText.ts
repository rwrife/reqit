/**
 * Bounded, privacy-safe rendering of transport error text for user-facing
 * surfaces (webview notes, VS Code notifications).
 *
 * Transport failures (undici fetch failures, socket errors, server-
 * reflected text) can embed the full request URL — including basic-auth
 * userinfo, ports, query-string tokens — or generic `key: value` secret
 * assignments. Reqit's privacy contract requires those values stay out of
 * logs, notifications, exports, and rendered state.
 *
 * This helper is intentionally lossy (host + path survive; credentials,
 * queries, fragments, and secret assignments do not) and length-bounded so
 * a hostile/reflected payload cannot flood a notification.
 */

/** Hard bound for sanitized user-facing error text. */
export const SSE_ERROR_TEXT_MAX = 300;

/**
 * Structured secret assignments. Runs BEFORE generic patterns so the full
 * value of `Authorization: Bearer VALUE` (not just the scheme) is dropped.
 */
const SECRET_ASSIGNMENT =
  /\b(authorization|proxy-authorization|x-api-key|api[-_]?key|apikey|access[-_]?token|token|secret|password|passwd)\b(\s*[:=]\s*)(?:Bearer\s+|Basic\s+|Digest\s+)?[^\s,;]*/gi;

const URL_IN_TEXT = /https?:\/\/[^\s"'<>]+/gi;

function sanitizeUrl(raw: string): string {
  try {
    const parsed = new URL(raw);
    // `origin` drops any embedded userinfo; pathname drops query/fragment.
    return `${parsed.origin}${parsed.pathname}`;
  } catch {
    return '[redacted-url]';
  }
}

/**
 * Render `text` for display: URLs keep scheme/host/port/path only, secret
 * assignments are masked, and the result is length-bounded.
 */
export function sanitizeSseErrorText(text: string): string {
  let out = text.replace(URL_IN_TEXT, (url) => sanitizeUrl(url));
  out = out.replace(SECRET_ASSIGNMENT, (_m, name: string, sep: string) => `${name}${sep}[redacted]`);
  if (out.length > SSE_ERROR_TEXT_MAX) {
    out = `${out.slice(0, SSE_ERROR_TEXT_MAX - 1)}…`;
  }
  return out;
}
