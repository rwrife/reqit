import { describe, expect, it } from 'vitest';
import {
  buildResponseContext,
  evaluateAssertion,
  runAssertions,
} from '../src/core/assertions.js';

const ctx = buildResponseContext({
  status: 200,
  statusText: 'OK',
  headers: {
    'Content-Type': 'application/json; charset=utf-8',
    'X-Multi': ['a', 'b'],
    'X-Trace': 'abc-123',
  },
  body: '{"id":42,"name":"reqit","tags":["http","auth"]}',
  durationMs: 87,
});

describe('buildResponseContext', () => {
  it('lower-cases header names and joins multi-values', () => {
    expect(ctx.headers['content-type']).toBe('application/json; charset=utf-8');
    expect(ctx.headers['x-multi']).toBe('a, b');
    expect(ctx.headers['x-trace']).toBe('abc-123');
  });

  it('parses JSON body when content-type is JSON-ish', () => {
    expect(ctx.json).toEqual({ id: 42, name: 'reqit', tags: ['http', 'auth'] });
  });

  it('leaves json undefined for non-JSON bodies', () => {
    const c = buildResponseContext({
      status: 200,
      statusText: 'OK',
      headers: { 'Content-Type': 'text/plain' },
      body: 'hi',
      durationMs: 1,
    });
    expect(c.json).toBeUndefined();
  });

  it('survives malformed JSON without throwing', () => {
    const c = buildResponseContext({
      status: 200,
      statusText: 'OK',
      headers: { 'Content-Type': 'application/json' },
      body: '{not json',
      durationMs: 1,
    });
    expect(c.json).toBeUndefined();
    expect(c.body).toBe('{not json');
  });
});

describe('evaluateAssertion', () => {
  it('passes truthy expressions', () => {
    const r = evaluateAssertion('status === 200', ctx);
    expect(r.passed).toBe(true);
    expect(r.value).toBe(true);
  });

  it('fails falsy expressions', () => {
    const r = evaluateAssertion('status === 404', ctx);
    expect(r.passed).toBe(false);
    expect(r.error).toBeUndefined();
  });

  it('exposes json bindings for deep access', () => {
    expect(evaluateAssertion('json.id === 42', ctx).passed).toBe(true);
    expect(evaluateAssertion('json.tags.includes("auth")', ctx).passed).toBe(true);
    expect(evaluateAssertion('json.tags.length === 2', ctx).passed).toBe(true);
  });

  it('exposes a case-insensitive header() helper', () => {
    expect(evaluateAssertion('header("Content-Type").includes("json")', ctx).passed).toBe(
      true,
    );
    expect(evaluateAssertion('header("X-MULTI") === "a, b"', ctx).passed).toBe(true);
    expect(evaluateAssertion('header("missing") === undefined', ctx).passed).toBe(true);
  });

  it('exposes durationMs and text alias', () => {
    expect(evaluateAssertion('durationMs < 1000', ctx).passed).toBe(true);
    expect(evaluateAssertion('text === body', ctx).passed).toBe(true);
  });

  it('captures thrown errors as failures', () => {
    const r = evaluateAssertion('json.nope.deep', ctx);
    expect(r.passed).toBe(false);
    expect(r.error).toMatch(/undefined/);
  });

  it('flags compile errors', () => {
    const r = evaluateAssertion('status ===', ctx);
    expect(r.passed).toBe(false);
    expect(r.error).toMatch(/compile error/);
  });

  it('rejects empty expressions', () => {
    const r = evaluateAssertion('   ', ctx);
    expect(r.passed).toBe(false);
    expect(r.error).toBe('empty expression');
  });

  it('shadows dangerous globals so escape attempts return undefined', () => {
    expect(evaluateAssertion('typeof process === "undefined"', ctx).passed).toBe(true);
    expect(evaluateAssertion('typeof require === "undefined"', ctx).passed).toBe(true);
    expect(evaluateAssertion('typeof globalThis === "undefined"', ctx).passed).toBe(true);
    expect(evaluateAssertion('typeof Function === "undefined"', ctx).passed).toBe(true);
    expect(evaluateAssertion('typeof eval === "undefined"', ctx).passed).toBe(true);
  });

  it('still exposes safe globals like Math/JSON', () => {
    expect(evaluateAssertion('Math.max(1,2,3) === 3', ctx).passed).toBe(true);
    expect(evaluateAssertion('JSON.stringify(json).includes("reqit")', ctx).passed).toBe(
      true,
    );
  });
});

describe('runAssertions', () => {
  it('aggregates totals correctly', () => {
    const summary = runAssertions(
      ['status === 200', 'json.id === 42', 'status === 500', 'json.missing.x'],
      ctx,
    );
    expect(summary.total).toBe(4);
    expect(summary.passed).toBe(2);
    expect(summary.failed).toBe(2);
    expect(summary.results.map((r) => r.passed)).toEqual([true, true, false, false]);
  });
});
