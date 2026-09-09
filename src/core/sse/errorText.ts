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
  /\b(authorization|proxy-authorization|x-api-key|api[-_]?key|apikey|access[-_]?token|token|secret|password|passwd)\b['"]?(\s*[:=]\s*)(?:"[^"]*"|'[^']*'|Bearer\s+\S+|Basic\s+\S+|Digest\s+\S+|[^\s,;}]+)/gi;

// Fetch/undici errors sometimes render URLs with backslash separators
// (WHATWG treats `\\` as `//` for special schemes), so both forms match
// and are normalized before parsing.
const URL_IN_TEXT = /https?:[\\/][\\/][^\s"'<>]+/gi;

function sanitizeUrl(raw: string): string {
  try {
    const parsed = new URL(raw.replace(/\\/g, '/'));
    // `origin` drops any embedded userinfo; pathname drops query/fragment.
    return `${parsed.origin}${parsed.pathname}`;
  } catch {
    return '[redacted-url]';
  }
}

/**
 * Render `text` for display: URLs keep scheme/host/port/path only, secret
 * assignments are masked, and the result is length-bounded.
 *
 * @param maxLength optional cap overriding {@link SSE_ERROR_TEXT_MAX} —
 *        callers that must keep more context (e.g. an error stack rendered
 *        in the response panel) may raise it; the sanitizer itself never
 *        returns an unbounded string.
 */
export function sanitizeSseErrorText(text: string, maxLength = SSE_ERROR_TEXT_MAX): string {
  const cap = Math.max(16, Math.trunc(maxLength));
  let out = text.replace(URL_IN_TEXT, (url) => sanitizeUrl(url));
  out = out.replace(SECRET_ASSIGNMENT, (_m, name: string, sep: string) => `${name}${sep}[redacted]`);
  if (out.length > cap) {
    out = `${out.slice(0, cap - 1)}…`;
  }
  return out;
}
