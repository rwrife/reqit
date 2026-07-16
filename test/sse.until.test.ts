import { describe, expect, it } from 'vitest';
import {
  evaluateSseUntil,
  SseUntilGate,
  type SseEvent,
} from '../src/core/sse/index.js';

const ev = (data: string, type = 'message', overrides: Partial<SseEvent> = {}): SseEvent => ({
  type,
  data,
  ...overrides,
});

const baseCtx = { index: 0, elapsedMs: 0, count: 1 } as const;

describe('evaluateSseUntil — happy path', () => {
  it('matches when the expression is truthy', () => {
    const r = evaluateSseUntil('true', ev(''), baseCtx);
    expect(r.matched).toBe(true);
    expect(r.value).toBe(true);
    expect(r.error).toBeUndefined();
  });

  it('does not match when the expression is falsy', () => {
    const r = evaluateSseUntil('false', ev(''), baseCtx);
    expect(r.matched).toBe(false);
    expect(r.value).toBe(false);
  });

  it('exposes `event.data` and `event.type`', () => {
    const r = evaluateSseUntil(
      'event.type === "done" && event.data === "bye"',
      ev('bye', 'done'),
      baseCtx,
    );
    expect(r.matched).toBe(true);
  });

  it('exposes `data` / `text` aliases for event.data', () => {
    const r1 = evaluateSseUntil('data === "hi"', ev('hi'), baseCtx);
    const r2 = evaluateSseUntil('text === "hi"', ev('hi'), baseCtx);
    expect(r1.matched).toBe(true);
    expect(r2.matched).toBe(true);
  });

  it('parses JSON payloads for the `json` binding (OpenAI-style)', () => {
    const r = evaluateSseUntil(
      'json.choices[0].finish_reason === "stop"',
      ev('{"choices":[{"finish_reason":"stop"}]}'),
      baseCtx,
    );
    expect(r.matched).toBe(true);
    expect(r.error).toBeUndefined();
  });

  it('also parses JSON via `event.json`', () => {
    const r = evaluateSseUntil(
      'event.json.done === true',
      ev('{"done":true}'),
      baseCtx,
    );
    expect(r.matched).toBe(true);
  });

  it('leaves `json` undefined for non-JSON payloads (e.g. `[DONE]` sentinel)', () => {
    const r = evaluateSseUntil('json === undefined', ev('[DONE]'), baseCtx);
    expect(r.matched).toBe(true);
  });

  it('leaves `json` undefined for empty data', () => {
    const r = evaluateSseUntil('json === undefined', ev(''), baseCtx);
    expect(r.matched).toBe(true);
  });

  it('exposes `count`, `index`, and `elapsedMs`', () => {
    const r = evaluateSseUntil('count >= 5 && index === 4 && elapsedMs >= 100', ev('x'), {
      index: 4,
      elapsedMs: 100,
      count: 5,
    });
    expect(r.matched).toBe(true);
  });

  it('exposes `id` and `retry` from the event', () => {
    const r = evaluateSseUntil(
      'id === "42" && retry === 3000',
      ev('x', 'message', { lastEventId: '42', retry: 3000 }),
      baseCtx,
    );
    expect(r.matched).toBe(true);
  });
});

describe('evaluateSseUntil — errors and edge cases', () => {
  it('rejects empty expressions with an error, not a match', () => {
    const r = evaluateSseUntil('   ', ev(''), baseCtx);
    expect(r.matched).toBe(false);
    expect(r.error).toBe('empty expression');
  });

  it('reports compile errors without matching', () => {
    const r = evaluateSseUntil('this is not valid js !!', ev(''), baseCtx);
    expect(r.matched).toBe(false);
    expect(r.error).toMatch(/compile error/);
  });

  it('reports runtime errors without matching', () => {
    const r = evaluateSseUntil('json.nope.deep', ev('null'), baseCtx);
    expect(r.matched).toBe(false);
    expect(r.error).toBeDefined();
    expect(r.value).toBeUndefined();
  });

  it('malformed JSON in event.data does not throw — `json` is undefined', () => {
    const r = evaluateSseUntil('json === undefined', ev('{not json'), baseCtx);
    expect(r.matched).toBe(true);
    expect(r.error).toBeUndefined();
  });
});

describe('evaluateSseUntil — sandboxing', () => {
  it('shadows `process` to undefined', () => {
    const r = evaluateSseUntil('typeof process === "undefined"', ev(''), baseCtx);
    expect(r.matched).toBe(true);
  });

  it('shadows `require` to undefined', () => {
    const r = evaluateSseUntil('typeof require === "undefined"', ev(''), baseCtx);
    expect(r.matched).toBe(true);
  });

  it('shadows `globalThis` to undefined', () => {
    const r = evaluateSseUntil('typeof globalThis === "undefined"', ev(''), baseCtx);
    expect(r.matched).toBe(true);
  });

  it('shadows `Function` constructor to undefined', () => {
    const r = evaluateSseUntil('typeof Function === "undefined"', ev(''), baseCtx);
    expect(r.matched).toBe(true);
  });

  it('shadows timers (setTimeout / setInterval / setImmediate / queueMicrotask)', () => {
    const r = evaluateSseUntil(
      'typeof setTimeout === "undefined" && typeof setInterval === "undefined" && typeof setImmediate === "undefined" && typeof queueMicrotask === "undefined"',
      ev(''),
      baseCtx,
    );
    expect(r.matched).toBe(true);
  });

  it('shadows `fetch`', () => {
    const r = evaluateSseUntil('typeof fetch === "undefined"', ev(''), baseCtx);
    expect(r.matched).toBe(true);
  });

  it('still exposes safe globals (`Math`, `JSON`, `Date`)', () => {
    const r = evaluateSseUntil(
      'Math.max(1,2) === 2 && typeof JSON.parse === "function" && typeof Date.now === "function"',
      ev(''),
      baseCtx,
    );
    expect(r.matched).toBe(true);
  });

  it('freezes the event view so predicates cannot mutate shared state', () => {
    // Two evaluations of the same event; first tries (and fails) to mutate,
    // second observes original values.
    const shared = ev('hello');
    const r1 = evaluateSseUntil(
      '(() => { try { event.data = "x"; } catch (_) {} return event.data === "hello"; })()',
      shared,
      baseCtx,
    );
    expect(r1.matched).toBe(true);
    expect(shared.data).toBe('hello');
  });
});

describe('SseUntilGate', () => {
  it('increments count and index across events', () => {
    const gate = new SseUntilGate('count === 3', { now: () => 0 });
    expect(gate.test(ev('a')).matched).toBe(false);
    expect(gate.test(ev('b')).matched).toBe(false);
    const third = gate.test(ev('c'));
    expect(third.matched).toBe(true);
    expect(gate.count).toBe(3);
    expect(gate.isStopped).toBe(true);
  });

  it('tracks elapsedMs via injectable clock', () => {
    let t = 1000;
    const gate = new SseUntilGate('elapsedMs >= 500', { now: () => t });
    // t starts at 1000 -> startedAt=1000. First event at t=1200: elapsed=200.
    t = 1200;
    expect(gate.test(ev('a')).matched).toBe(false);
    t = 1600;
    expect(gate.test(ev('b')).matched).toBe(true);
  });

  it('stays stopped once matched; subsequent tests report matched:true', () => {
    const gate = new SseUntilGate('true', { now: () => 0 });
    expect(gate.test(ev('a')).matched).toBe(true);
    // Even a would-be-falsy scenario short-circuits after stop:
    const again = gate.test(ev('b'));
    expect(again.matched).toBe(true);
    expect(gate.count).toBe(1); // no further increments after stop
  });

  it('does not stop on evaluator errors; captures last error', () => {
    const gate = new SseUntilGate('json.nope.deep', { now: () => 0 });
    const r = gate.test(ev('null'));
    expect(r.matched).toBe(false);
    expect(r.error).toBeDefined();
    expect(gate.isStopped).toBe(false);
    expect(gate.error).toBeDefined();
  });

  it('empty predicate never matches and reports the error', () => {
    const gate = new SseUntilGate('', { now: () => 0 });
    const r = gate.test(ev('anything'));
    expect(r.matched).toBe(false);
    expect(r.error).toBe('empty expression');
    expect(gate.isStopped).toBe(false);
  });
});
