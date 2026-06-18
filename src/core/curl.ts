import type { UndiciRequestOptions } from './request.js';

export interface CurlOptions {
  /** Secret values to replace with the placeholder before emitting curl text. */
  redact?: string[];
  /** Defaults to `***REDACTED***`. */
  redactPlaceholder?: string;
}

/**
 * Render a validated request as a copy-pasteable `curl` command.
 *
 * Pure function — no VS Code APIs. Always single-quotes header values, the body
 * and the URL so embedded shell metacharacters are safe to paste into bash/zsh.
 *
 * Any `redact` strings (non-empty) found anywhere in the rendered command are
 * replaced with `redactPlaceholder` BEFORE quoting boundaries are computed,
 * so secrets cannot leak through partial-token reassembly.
 */
export function requestToCurl(opts: UndiciRequestOptions, options: CurlOptions = {}): string {
  const placeholder = options.redactPlaceholder ?? '***REDACTED***';
  const redact = (options.redact ?? []).filter((s) => s.length > 0);
  const apply = (s: string): string =>
    redact.reduce((acc, secret) => acc.split(secret).join(placeholder), s);

  const parts: string[] = ['curl'];
  // Always be explicit about the method except for the implicit GET case
  // without a body. Keeps copied commands self-describing.
  const hasBody = opts.body !== undefined && opts.body.length > 0;
  if (opts.method !== 'GET' || hasBody) {
    parts.push('-X', opts.method);
  }
  for (const [k, v] of Object.entries(opts.headers)) {
    parts.push('-H', shellQuote(apply(`${k}: ${v}`)));
  }
  if (hasBody) {
    parts.push('--data-raw', shellQuote(apply(opts.body!)));
  }
  parts.push(shellQuote(apply(opts.url)));
  return parts.join(' ');
}

/** POSIX-safe single-quote shell escape: closes/escapes any embedded `'`. */
function shellQuote(s: string): string {
  return `'${s.replace(/'/g, `'\\''`)}'`;
}
