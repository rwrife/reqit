/**
 * Pure Server-Sent Events (SSE) frame parser. No VS Code, `undici`, or
 * network dependencies — this module only turns a byte/character stream
 * into structured, zod-validated events, so it can be unit-tested in
 * isolation.
 *
 * Conforms to the WHATWG HTML "Server-sent events" specification
 * (https://html.spec.whatwg.org/multipage/server-sent-events.html), which
 * is a strict superset of the classic W3C EventSource algorithm:
 *
 *   - Line terminators: CR, LF, or CRLF are all valid line breaks.
 *   - A leading UTF-8 BOM is stripped from the very first chunk.
 *   - Fields are `name: value` (a single leading SPACE after the colon is
 *     removed). A line with no colon is a field named by the whole line
 *     with an empty value. A line that starts with `:` is a comment and
 *     is ignored.
 *   - Recognized fields: `event`, `data`, `id`, `retry`. Others ignored.
 *   - `data:` accumulates: multiple `data:` lines within one event are
 *     joined with `\n` (no trailing newline).
 *   - `id:` sets the last event ID (used for `Last-Event-ID` on
 *     reconnect). A NUL byte in the value MUST cause the id to be
 *     ignored per spec.
 *   - `retry:` sets the reconnection interval (ms) only if the value is
 *     all ASCII digits; otherwise ignored.
 *   - A blank line dispatches an event. Events with zero `data:` lines
 *     do NOT dispatch (per spec) — `event`/`id` state still carries.
 *
 * The parser is streaming and stateful: feed arbitrary chunks via
 * {@link SseParser.push}; drain dispatched events via
 * {@link SseParser.drain}. Any bytes after the last line terminator are
 * held as a partial buffer until the next `push` or {@link SseParser.end}.
 */

import { z } from 'zod';

/** A dispatched SSE event, as delivered to a consumer. */
export interface SseEvent {
  /** The `event:` field value, or `'message'` per spec when absent. */
  type: string;
  /**
   * The `data:` field value (multi-`data:` lines joined with `\n`).
   * Never contains a trailing newline.
   */
  data: string;
  /**
   * Last non-NUL `id:` value seen up to and including this event's
   * dispatch. `undefined` if no id has been observed yet.
   */
  lastEventId?: string;
  /**
   * Reconnection interval hint in milliseconds, if this event's frame
   * set (or any earlier one) supplied a valid `retry:` value.
   */
  retry?: number;
}

/** Zod schema for a dispatched SSE event. Values are all validated. */
export const SseEventSchema = z
  .object({
    type: z.string().min(1),
    data: z.string(),
    lastEventId: z.string().optional(),
    retry: z.number().int().nonnegative().optional(),
  })
  .strict();

/**
 * Parse an entire SSE payload in one shot. Convenience wrapper around
 * {@link SseParser} for tests and non-streaming callers.
 */
export function parseSse(input: string): SseEvent[] {
  const p = new SseParser();
  p.push(input);
  p.end();
  return p.drain();
}

/**
 * Streaming SSE parser. Instances are stateful — one per connection.
 *
 * Usage:
 * ```ts
 * const p = new SseParser();
 * for await (const chunk of stream) p.push(chunk);
 * p.end();
 * for (const event of p.drain()) handle(event);
 * ```
 */
export class SseParser {
  /** Bytes/characters held between chunks until the next line terminator. */
  private buffer = '';
  /** Accumulated `data:` lines for the current (undispatched) event. */
  private data: string[] = [];
  /** Current event `type`, or empty string to mean the default `message`. */
  private eventType = '';
  /**
   * Sticky last event id. Per spec this survives across dispatches until
   * a new `id:` frame arrives. `undefined` means "not seen yet".
   */
  private lastEventId: string | undefined;
  /** Sticky reconnection interval in ms, if any `retry:` field was valid. */
  private retry: number | undefined;
  /** True after the first byte is consumed; used to strip a leading BOM. */
  private sawFirstByte = false;
  /** Dispatched events waiting to be drained by the consumer. */
  private dispatched: SseEvent[] = [];

  /** Feed a chunk of characters into the parser. */
  push(chunk: string): void {
    if (chunk.length === 0) {
      return;
    }
    let toAppend = chunk;
    if (!this.sawFirstByte) {
      this.sawFirstByte = true;
      if (toAppend.charCodeAt(0) === 0xfeff) {
        toAppend = toAppend.slice(1);
      }
    }
    this.buffer += toAppend;
    this.consumeLines(/*flush*/ false);
  }

  /**
   * Signal end-of-stream. Any trailing line without a terminator is
   * still processed as a line, and if a pending event has `data:`
   * lines, it is dispatched.
   */
  end(): void {
    // A held-back trailing CR is a full line terminator at end-of-stream.
    if (this.buffer.length > 0) {
      let tail = this.buffer;
      if (tail.charCodeAt(tail.length - 1) === 0x0d) {
        tail = tail.slice(0, -1);
      }
      if (tail.length > 0) {
        this.processLine(tail);
      } else if (this.buffer.length === 1 && this.buffer.charCodeAt(0) === 0x0d) {
        // Bare trailing CR terminates a (possibly empty) line -> blank
        // line dispatch semantics apply.
        this.processLine('');
      }
      this.buffer = '';
    }
    this.dispatchIfPending();
  }

  /** Return dispatched events and clear the internal queue. */
  drain(): SseEvent[] {
    const out = this.dispatched;
    this.dispatched = [];
    return out;
  }

  /** Current sticky last-event-id, for use in `Last-Event-ID` on reconnect. */
  getLastEventId(): string | undefined {
    return this.lastEventId;
  }

  /** Current sticky retry interval hint, in milliseconds. */
  getRetry(): number | undefined {
    return this.retry;
  }

  /**
   * Walk the buffer, extracting complete lines (terminated by CR, LF,
   * or CRLF). A trailing lone CR is preserved in the buffer so a
   * following chunk can decide whether it is part of a CRLF pair.
   */
  private consumeLines(_flush: boolean): void {
    let start = 0;
    const buf = this.buffer;
    let i = 0;
    while (i < buf.length) {
      const c = buf.charCodeAt(i);
      if (c === 0x0d /* CR */) {
        // If CR is at the very end of the current buffer, hold it back:
        // the next chunk may start with LF and complete a CRLF.
        if (i + 1 >= buf.length) {
          break;
        }
        const line = buf.slice(start, i);
        this.processLine(line);
        if (buf.charCodeAt(i + 1) === 0x0a) {
          i += 2;
        } else {
          i += 1;
        }
        start = i;
        continue;
      }
      if (c === 0x0a /* LF */) {
        const line = buf.slice(start, i);
        this.processLine(line);
        i += 1;
        start = i;
        continue;
      }
      i += 1;
    }
    // Anything after the last terminator (or the held-back CR) is partial.
    this.buffer = buf.slice(start);
  }

  private processLine(line: string): void {
    // Blank line -> dispatch.
    if (line.length === 0) {
      this.dispatchIfPending();
      return;
    }
    // Comment.
    if (line.charCodeAt(0) === 0x3a /* ':' */) {
      return;
    }

    let field: string;
    let value: string;
    const colon = line.indexOf(':');
    if (colon === -1) {
      // Whole line is field, value is empty string.
      field = line;
      value = '';
    } else {
      field = line.slice(0, colon);
      value = line.slice(colon + 1);
      // Strip a single leading SPACE (U+0020) from value per spec.
      if (value.length > 0 && value.charCodeAt(0) === 0x20) {
        value = value.slice(1);
      }
    }

    switch (field) {
      case 'event':
        this.eventType = value;
        return;
      case 'data':
        this.data.push(value);
        return;
      case 'id':
        // Ignore ids that contain a NUL byte, per spec.
        if (value.indexOf('\u0000') === -1) {
          this.lastEventId = value;
        }
        return;
      case 'retry':
        if (value.length > 0 && /^[0-9]+$/.test(value)) {
          this.retry = Number(value);
        }
        return;
      default:
        // Unknown fields are ignored.
        return;
    }
  }

  private dispatchIfPending(): void {
    if (this.data.length === 0) {
      // Spec: reset only the event-type buffer if no data lines.
      this.eventType = '';
      return;
    }
    const event: SseEvent = {
      type: this.eventType.length > 0 ? this.eventType : 'message',
      data: this.data.join('\n'),
    };
    if (this.lastEventId !== undefined) {
      event.lastEventId = this.lastEventId;
    }
    if (this.retry !== undefined) {
      event.retry = this.retry;
    }
    // Runtime validation to keep downstream code honest.
    SseEventSchema.parse(event);
    this.dispatched.push(event);
    // Reset per-event buffers; sticky state (id, retry) survives.
    this.data = [];
    this.eventType = '';
  }
}
