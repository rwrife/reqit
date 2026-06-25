/**
 * Pure cURL → reqit importer. No VS Code, no IO. Unit-testable.
 *
 * Goal: take a shell `curl ...` command string (often with `\` line
 * continuations as pasted from docs) and produce a `.http`-formatted request
 * plus a structured summary of any auth bits that need a profile.
 *
 * In-scope flags (the common stuff people actually paste):
 *   -X / --request <method>
 *   -H / --header <name: value>      (repeatable)
 *   -d / --data / --data-raw / --data-ascii / --data-binary <body>
 *   --data-urlencode <key=value | @file>   (file refs are preserved verbatim)
 *   -u / --user <user[:pass]>        → Basic auth header (or auth note)
 *   --cert <path[:passphrase]>       → client-cert auth note
 *   --key <path>                     → client-cert auth note
 *   -A / --user-agent <ua>           → User-Agent header
 *   -e / --referer <url>             → Referer header
 *   -b / --cookie <cookie>           → Cookie header
 *   --url <url>                      (alternative to positional)
 *   Bare positional URL
 *
 * Out-of-scope (silently ignored, surfaced in `unsupported`):
 *   -F/--form, --location, --insecure, -o/--output, -i/-v flags, etc.
 *
 * Zod validates the final shape before it's handed back.
 */

import { z } from 'zod';

export interface ImportedAuthHint {
  /** Auth scheme we recognised in the cURL command. */
  kind: 'basic' | 'clientCert';
  /** Free-form details for the importer to surface to the user. */
  details: Record<string, string>;
}

export interface ImportedCurl {
  method: string;
  url: string;
  headers: Array<{ name: string; value: string }>;
  /** Raw body string, or undefined if no data flags were present. */
  body?: string;
  /** Flags we saw but chose not to model (e.g. `--insecure`). */
  unsupported: string[];
  /** Auth signals worth surfacing to the user as a profile suggestion. */
  authHints: ImportedAuthHint[];
}

const importedCurlSchema = z.object({
  method: z.enum(['GET', 'POST', 'PUT', 'DELETE', 'PATCH', 'HEAD', 'OPTIONS', 'TRACE']),
  url: z.string().min(1),
  headers: z.array(z.object({ name: z.string().min(1), value: z.string() })),
  body: z.string().optional(),
  unsupported: z.array(z.string()),
  authHints: z.array(
    z.object({
      kind: z.enum(['basic', 'clientCert']),
      details: z.record(z.string(), z.string()),
    }),
  ),
});

/**
 * Parse a `curl` command string into a structured request.
 *
 * Throws on empty input, missing URL, or anything zod refuses.
 */
export function parseCurl(input: string): ImportedCurl {
  const cleaned = stripContinuations(input).trim();
  if (cleaned.length === 0) throw new Error('empty curl command');
  const tokens = tokenize(cleaned);
  if (tokens.length === 0) throw new Error('empty curl command');
  // Allow but don't require a leading `curl` keyword.
  let i = 0;
  if (tokens[0]?.toLowerCase() === 'curl') i = 1;

  let method: string | undefined;
  let url: string | undefined;
  const headers: Array<{ name: string; value: string }> = [];
  const dataParts: string[] = [];
  let dataMode: 'raw' | 'urlencode' | undefined;
  const unsupported: string[] = [];
  const authHints: ImportedAuthHint[] = [];

  const need = (flag: string): string => {
    const v = tokens[++i];
    if (v === undefined) throw new Error(`flag ${flag} expects a value`);
    return v;
  };

  for (; i < tokens.length; i++) {
    const t = tokens[i]!;
    const [flag, inlineValue] = splitInlineValue(t);
    const arg = (full: string): string => (inlineValue !== undefined ? inlineValue : need(full));
    switch (flag) {
      case '-X':
      case '--request':
        method = arg(flag).toUpperCase();
        break;
      case '-H':
      case '--header': {
        const raw = arg(flag);
        const idx = raw.indexOf(':');
        if (idx === -1) {
          // curl treats `Header;` as "send this header empty"; we just skip the no-value form.
          unsupported.push(`header without value: ${raw}`);
          break;
        }
        const name = raw.slice(0, idx).trim();
        const value = raw.slice(idx + 1).trim();
        if (name.length > 0) headers.push({ name, value });
        break;
      }
      case '-d':
      case '--data':
      case '--data-raw':
      case '--data-ascii':
      case '--data-binary':
        dataParts.push(arg(flag));
        dataMode ??= 'raw';
        break;
      case '--data-urlencode':
        dataParts.push(arg(flag));
        dataMode = 'urlencode';
        break;
      case '-u':
      case '--user': {
        const v = arg(flag);
        const idx = v.indexOf(':');
        const user = idx === -1 ? v : v.slice(0, idx);
        const pass = idx === -1 ? '' : v.slice(idx + 1);
        const encoded = base64Utf8(`${user}:${pass}`);
        headers.push({ name: 'Authorization', value: `Basic ${encoded}` });
        authHints.push({ kind: 'basic', details: { user } });
        break;
      }
      case '--cert': {
        const v = arg(flag);
        const idx = v.indexOf(':');
        const cert = idx === -1 ? v : v.slice(0, idx);
        const passphrase = idx === -1 ? undefined : v.slice(idx + 1);
        const details: Record<string, string> = { cert };
        if (passphrase !== undefined) details.passphrase = passphrase;
        upsertClientCertHint(authHints, details);
        break;
      }
      case '--key':
        upsertClientCertHint(authHints, { key: arg(flag) });
        break;
      case '-A':
      case '--user-agent':
        headers.push({ name: 'User-Agent', value: arg(flag) });
        break;
      case '-e':
      case '--referer':
        headers.push({ name: 'Referer', value: arg(flag) });
        break;
      case '-b':
      case '--cookie':
        headers.push({ name: 'Cookie', value: arg(flag) });
        break;
      case '--url':
        url = arg(flag);
        break;
      // Common silent-ignore flags. Many take a value; consume it when present.
      case '-L':
      case '--location':
      case '-k':
      case '--insecure':
      case '-s':
      case '--silent':
      case '-S':
      case '--show-error':
      case '-v':
      case '--verbose':
      case '-i':
      case '--include':
      case '-I':
      case '--head':
        unsupported.push(flag);
        break;
      case '-o':
      case '--output':
      case '-O':
      case '--remote-name':
      case '--compressed':
        unsupported.push(flag);
        // -o/--output take a value; --remote-name and --compressed do not.
        if (flag === '-o' || flag === '--output') need(flag);
        break;
      case '-F':
      case '--form':
        unsupported.push(`${flag} ${arg(flag)}`);
        break;
      default:
        if (flag.startsWith('-')) {
          unsupported.push(flag);
          // Best-effort: if an inline = was supplied we already consumed it.
          // Otherwise we don't know if it takes a value, so we leave i alone.
        } else if (url === undefined) {
          url = t;
        } else {
          // Multiple positionals — curl supports several URLs, we keep the first
          // and surface the rest.
          unsupported.push(`extra positional: ${t}`);
        }
    }
  }

  if (url === undefined) throw new Error('no URL found in curl command');

  // urldecode form: each --data-urlencode value is appended joined by `&`,
  // and individual pieces of `-d` are also joined by `&` (matches curl behavior).
  const body =
    dataParts.length === 0
      ? undefined
      : dataMode === 'urlencode'
        ? dataParts.map(encodeUrlencodePart).join('&')
        : dataParts.join('&');

  // curl defaults to POST when data flags are used and no -X was given.
  if (method === undefined) method = body !== undefined ? 'POST' : 'GET';

  // Default Content-Type for body requests if user didn't supply one
  // (matches curl's behavior of sending application/x-www-form-urlencoded).
  if (body !== undefined && !hasHeader(headers, 'Content-Type')) {
    headers.push({ name: 'Content-Type', value: 'application/x-www-form-urlencoded' });
  }

  return importedCurlSchema.parse({
    method,
    url,
    headers,
    body,
    unsupported,
    authHints,
  });
}

/**
 * Render an `ImportedCurl` as a single-request `.http` file body.
 *
 * Auth hints become `# @auth <name>` directives at the top so the user knows
 * to wire up a profile in `.http-auth.json`.
 */
export function renderImportedCurlAsHttp(curl: ImportedCurl, name?: string): string {
  const lines: string[] = [];
  lines.push(`### ${name ?? 'imported'}`);
  for (const hint of curl.authHints) {
    if (hint.kind === 'basic') {
      lines.push(`# @auth basic (user: ${hint.details.user ?? ''})`);
    } else if (hint.kind === 'clientCert') {
      const bits = Object.entries(hint.details)
        .map(([k, v]) => `${k}=${v}`)
        .join(', ');
      lines.push(`# @auth clientCert (${bits})`);
    }
  }
  for (const u of curl.unsupported) lines.push(`# unsupported: ${u}`);
  lines.push(`${curl.method} ${curl.url}`);
  for (const h of curl.headers) lines.push(`${h.name}: ${h.value}`);
  if (curl.body !== undefined) {
    lines.push('');
    lines.push(curl.body);
  }
  lines.push('');
  return lines.join('\n');
}

// ---------- helpers ----------

function stripContinuations(input: string): string {
  // Bash: a backslash followed by a newline is line continuation.
  return input.replace(/\\\r?\n/g, ' ');
}

function splitInlineValue(token: string): [string, string | undefined] {
  // Support `--header=foo: bar`. Don't apply to single-letter flags or to
  // bare positionals.
  if (!token.startsWith('--')) return [token, undefined];
  const eq = token.indexOf('=');
  if (eq === -1) return [token, undefined];
  return [token.slice(0, eq), token.slice(eq + 1)];
}

function hasHeader(headers: Array<{ name: string }>, name: string): boolean {
  const lc = name.toLowerCase();
  return headers.some((h) => h.name.toLowerCase() === lc);
}

function upsertClientCertHint(
  hints: ImportedAuthHint[],
  extra: Record<string, string>,
): void {
  const existing = hints.find((h) => h.kind === 'clientCert');
  if (existing) Object.assign(existing.details, extra);
  else hints.push({ kind: 'clientCert', details: { ...extra } });
}

function encodeUrlencodePart(part: string): string {
  const eq = part.indexOf('=');
  if (eq === -1) return encodeURIComponent(part);
  const k = part.slice(0, eq);
  const v = part.slice(eq + 1);
  // `@file` style refs are preserved verbatim — we can't read the file here,
  // and round-tripping the literal is more useful than dropping it.
  if (v.startsWith('@')) return `${encodeURIComponent(k)}=${v}`;
  return `${encodeURIComponent(k)}=${encodeURIComponent(v)}`;
}

function base64Utf8(s: string): string {
  if (typeof Buffer !== 'undefined') return Buffer.from(s, 'utf8').toString('base64');
  // Browser/edge fallback — not used in extension host but keeps the module pure.
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const g: any = globalThis as any;
  if (typeof g.btoa === 'function') return g.btoa(unescape(encodeURIComponent(s)));
  throw new Error('no base64 encoder available');
}

/**
 * Shell tokenizer covering single-quote, double-quote and backslash escaping.
 * Not a full bash parser — no $var expansion, no $'…' ANSI-C quoting, no
 * heredocs. Matches what people actually paste from API docs.
 */
function tokenize(input: string): string[] {
  const out: string[] = [];
  let cur = '';
  let inSingle = false;
  let inDouble = false;
  let hasCur = false;

  const push = (): void => {
    if (hasCur) {
      out.push(cur);
      cur = '';
      hasCur = false;
    }
  };

  for (let i = 0; i < input.length; i++) {
    const c = input[i]!;
    if (inSingle) {
      if (c === "'") inSingle = false;
      else {
        cur += c;
        hasCur = true;
      }
      continue;
    }
    if (inDouble) {
      if (c === '"') inDouble = false;
      else if (c === '\\' && i + 1 < input.length) {
        const next = input[i + 1]!;
        // In double quotes, bash only escapes a small set; otherwise keep both chars.
        if (next === '"' || next === '\\' || next === '$' || next === '`' || next === '\n') {
          cur += next;
          i++;
        } else {
          cur += c;
        }
        hasCur = true;
      } else {
        cur += c;
        hasCur = true;
      }
      continue;
    }
    if (c === "'") {
      inSingle = true;
      hasCur = true;
      continue;
    }
    if (c === '"') {
      inDouble = true;
      hasCur = true;
      continue;
    }
    if (c === '\\' && i + 1 < input.length) {
      cur += input[i + 1]!;
      hasCur = true;
      i++;
      continue;
    }
    if (c === ' ' || c === '\t' || c === '\n' || c === '\r') {
      push();
      continue;
    }
    cur += c;
    hasCur = true;
  }
  if (inSingle || inDouble) throw new Error('unterminated quote in curl command');
  push();
  return out;
}
