/**
 * Pure `.ws` file parser for WebSocket requests. Zero VS Code or `undici`
 * dependencies — this module only turns text into structured data so it
 * can be unit-tested without opening a real socket.
 *
 * The `.ws` format mirrors `.http`/`.grpc` conventions so users don't have
 * to learn a third dialect:
 *
 *   # Comment or directive
 *   # @auth my-bearer
 *   # @name subscribeToTicker
 *   wss://stream.example.com/v1/ticker?symbol=BTC
 *   Sec-WebSocket-Protocol: json
 *   Authorization: Bearer {{token}}
 *
 *   --- send
 *   {"op":"subscribe","channel":"trades"}
 *   --- recv
 *   {"op":"subscribed"}
 *   --- send
 *   {"op":"ping"}
 *
 * Rules:
 *   - Exactly one target line per file, method-less, `ws://` or `wss://`.
 *   - Header block follows the target line (RFC 7230-ish `Name: value`),
 *     terminated by a blank line or the first `---` frame separator.
 *   - Frame blocks are introduced by a line of the form `--- send` or
 *     `--- recv` (case-insensitive, trailing whitespace ignored). The
 *     block body runs until the next `---` line or EOF. Trailing blank
 *     lines are stripped from each frame.
 *   - Comment/directive lines (`#` or `//` at column 0) are allowed in
 *     the preamble (before the target line). Directives take the form
 *     `# @key value` — recognized keys are `auth` and `name`. Unknown
 *     directives are preserved for callers that want to extend later.
 *   - Wire-up to `undici`'s WS client happens elsewhere; this module
 *     just returns a structured, zod-validated `ParsedWebSocketRequest`.
 *
 * Follow-up work (webview, tree integration, transcript persistence) is
 * tracked under issue #40.
 */

import { z } from 'zod';

export type WsFrameDirection = 'send' | 'recv';

export interface WsFrame {
  direction: WsFrameDirection;
  /** Raw frame body as authored. `{{var}}` substitution happens later. */
  data: string;
  /** 1-based line number of the `--- send`/`--- recv` marker. */
  line: number;
}

export interface WsHeader {
  name: string;
  value: string;
}

export interface ParsedWebSocketRequest {
  /** Optional friendly name from `# @name` directive. */
  name?: string;
  /** Full target URL, e.g. `wss://host/path?x=1`. */
  url: string;
  /** `ws` (plaintext) or `wss` (TLS). */
  scheme: 'ws' | 'wss';
  headers: WsHeader[];
  /**
   * Directives parsed from `# @key value` / `// @key value` preamble
   * lines. Multi-occurrence keys keep the last value. Common keys:
   * `auth`, `name`.
   */
  directives: Record<string, string>;
  /** Optional initial send/recv script; empty means "interactive only". */
  frames: WsFrame[];
}

/** Zod schema mirroring `ParsedWebSocketRequest`, exported for callers. */
export const WsFrameSchema: z.ZodType<WsFrame> = z.object({
  direction: z.union([z.literal('send'), z.literal('recv')]),
  data: z.string(),
  line: z.number().int().positive(),
});

export const WsHeaderSchema: z.ZodType<WsHeader> = z.object({
  name: z.string().min(1),
  value: z.string(),
});

export const ParsedWebSocketRequestSchema: z.ZodType<ParsedWebSocketRequest> =
  z.object({
    name: z.string().min(1).optional(),
    url: z.string().min(1),
    scheme: z.union([z.literal('ws'), z.literal('wss')]),
    headers: z.array(WsHeaderSchema),
    directives: z.record(z.string()),
    frames: z.array(WsFrameSchema),
  });

const DIRECTIVE_RE = /^(?:#|\/\/)\s*@([A-Za-z][\w-]*)\s*(.*)$/;
const FRAME_MARKER_RE = /^---\s*(send|recv)\s*$/i;

/**
 * Parse a `.ws` file body. Throws `Error` with an actionable message on
 * malformed input (missing target, bad scheme, unterminated header block,
 * unknown frame marker) so the extension layer can surface it verbatim.
 */
export function parseWsRequest(source: string): ParsedWebSocketRequest {
  const rawLines = source.split(/\r?\n/);

  const directives: Record<string, string> = {};
  const headers: WsHeader[] = [];
  const frames: WsFrame[] = [];
  let url: string | undefined;

  let i = 0;

  // --- Preamble: comments/directives until the first non-comment line.
  while (i < rawLines.length) {
    const line = rawLines[i];
    const trimmed = line.trim();
    if (trimmed === '') {
      // Blank line in the preamble is allowed but not required.
      i++;
      continue;
    }
    if (line.startsWith('#') || line.startsWith('//')) {
      const dm = DIRECTIVE_RE.exec(line);
      if (dm) {
        const key = dm[1].toLowerCase();
        const value = dm[2].trim();
        directives[key] = value;
      }
      i++;
      continue;
    }
    // First non-blank, non-comment line is the target URL.
    url = trimmed;
    i++;
    break;
  }

  if (!url) {
    throw new Error(
      'WebSocket file has no target URL (expected `ws://…` or `wss://…`)',
    );
  }

  const schemeMatch = /^(wss?):\/\//i.exec(url);
  if (!schemeMatch) {
    throw new Error(
      `WebSocket target "${url}" must start with ws:// or wss://`,
    );
  }
  const scheme = schemeMatch[1].toLowerCase() as 'ws' | 'wss';

  // --- Header block: `Name: value` lines until blank line or frame marker.
  while (i < rawLines.length) {
    const line = rawLines[i];
    const trimmed = line.trim();
    if (trimmed === '') {
      i++;
      break;
    }
    if (FRAME_MARKER_RE.test(trimmed)) {
      // Header block ended without a blank line — allowed, frame block starts.
      break;
    }
    const colon = line.indexOf(':');
    if (colon <= 0) {
      throw new Error(
        `WebSocket header on line ${i + 1} is malformed (expected "Name: value"): ${line}`,
      );
    }
    const name = line.slice(0, colon).trim();
    const value = line.slice(colon + 1).trim();
    if (name === '') {
      throw new Error(
        `WebSocket header on line ${i + 1} has an empty name`,
      );
    }
    headers.push({ name, value });
    i++;
  }

  // --- Frame blocks.
  let currentDirection: WsFrameDirection | null = null;
  let currentStart = -1;
  let currentBuffer: string[] = [];

  const flushFrame = () => {
    if (currentDirection === null) return;
    // Strip trailing blank lines only; preserve internal newlines.
    while (
      currentBuffer.length > 0 &&
      currentBuffer[currentBuffer.length - 1].trim() === ''
    ) {
      currentBuffer.pop();
    }
    frames.push({
      direction: currentDirection,
      data: currentBuffer.join('\n'),
      line: currentStart,
    });
    currentDirection = null;
    currentBuffer = [];
    currentStart = -1;
  };

  while (i < rawLines.length) {
    const line = rawLines[i];
    const trimmed = line.trim();
    const marker = FRAME_MARKER_RE.exec(trimmed);
    if (marker) {
      flushFrame();
      currentDirection = marker[1].toLowerCase() as WsFrameDirection;
      currentStart = i + 1;
      i++;
      continue;
    }
    if (currentDirection === null) {
      // Non-marker content outside any frame block. Ignore blank lines
      // (common between the header block and the first `---`), but reject
      // stray text so users notice typos like `-- send`.
      if (trimmed === '') {
        i++;
        continue;
      }
      throw new Error(
        `Unexpected content on line ${i + 1} outside a frame block (did you mean \`--- send\`?): ${line}`,
      );
    }
    currentBuffer.push(line);
    i++;
  }
  flushFrame();

  const name = directives.name && directives.name.length > 0 ? directives.name : undefined;

  const parsed: ParsedWebSocketRequest = {
    name,
    url,
    scheme,
    headers,
    directives,
    frames,
  };

  // Validate the shape we're returning. This is cheap and guards against
  // future regressions in this parser.
  return ParsedWebSocketRequestSchema.parse(parsed);
}
