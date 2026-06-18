/**
 * Pure assertion evaluator for `# @test` / `// @test` expressions in `.http`
 * files. No VS Code or network dependencies — unit-testable.
 *
 * Expressions are single-line JavaScript snippets evaluated against a frozen
 * response context. The intentional design constraints:
 *
 *   - We do NOT execute arbitrary user code with full Node powers. Each
 *     expression is compiled with `new Function(...)` and run in
 *     non-strict-but-isolated mode where:
 *       * `globalThis` access patterns commonly used to escape sandboxes are
 *         shadowed (`globalThis`, `global`, `process`, `require`, `module`,
 *         `__dirname`, `__filename`, `eval`, `Function`, `import`).
 *       * Only the response context bindings (`status`, `statusText`,
 *         `headers`, `body`, `json`, `text`, `durationMs`, `header`) and a
 *         small set of safe globals (`Math`, `Date`, `JSON`, `Number`,
 *         `String`, `Boolean`, `Array`, `Object`, `RegExp`, `parseInt`,
 *         `parseFloat`, `isNaN`, `isFinite`) are reachable.
 *
 *     This is "best-effort defense in depth" — `.http` files come from the
 *     user's own workspace, so the threat model is "don't let a typo nuke the
 *     machine", not "withstand a malicious adversary with arbitrary JS". A
 *     determined attacker with write access to your workspace already wins.
 *
 *   - Evaluation timeouts are NOT enforced here (Node has no synchronous
 *     timeout primitive without `vm.runInContext`'s timeout option). Callers
 *     running untrusted `.http` files should wrap evaluation in a worker.
 *     For our use case (the user's own files) this is acceptable.
 *
 *   - Truthiness of the result determines pass/fail. A returned `false`,
 *     `null`, `undefined`, `0`, or `''` is a failure. Any thrown error is
 *     also a failure (with the error message captured). Everything else
 *     passes.
 */
import { z } from 'zod';

export interface AssertionResponseContext {
  /** HTTP status code, e.g. `200`. */
  status: number;
  /** HTTP status text, e.g. `'OK'`. May be empty. */
  statusText: string;
  /**
   * Response headers as a case-insensitive map. Multi-valued headers are
   * joined with `, ` to match `fetch`-style behavior. Keys are lower-case.
   */
  headers: Readonly<Record<string, string>>;
  /** Raw response body as text (decoded with the negotiated charset). */
  body: string;
  /** Parsed JSON body if Content-Type is JSON-ish; otherwise `undefined`. */
  json?: unknown;
  /** Wall-clock duration of the request in milliseconds. */
  durationMs: number;
}

export interface AssertionResult {
  /** The original expression source, trimmed. */
  expression: string;
  passed: boolean;
  /** The raw value the expression evaluated to (only set if it didn't throw). */
  value?: unknown;
  /** Error message if the expression threw or compilation failed. */
  error?: string;
}

const responseContextSchema = z.object({
  status: z.number().int(),
  statusText: z.string(),
  headers: z.record(z.string()),
  body: z.string(),
  json: z.unknown().optional(),
  durationMs: z.number().nonnegative(),
});

/**
 * Build a normalized response context from raw response pieces.
 * Header keys are lower-cased; multi-valued headers are joined with `, `.
 */
export function buildResponseContext(input: {
  status: number;
  statusText: string;
  headers: Record<string, string | string[] | undefined>;
  body: string;
  durationMs: number;
}): AssertionResponseContext {
  const normalizedHeaders: Record<string, string> = {};
  for (const [k, v] of Object.entries(input.headers)) {
    if (v === undefined) continue;
    normalizedHeaders[k.toLowerCase()] = Array.isArray(v) ? v.join(', ') : v;
  }
  let json: unknown;
  const ct = normalizedHeaders['content-type'] ?? '';
  if (/\bjson\b/i.test(ct) && input.body.length > 0) {
    try {
      json = JSON.parse(input.body);
    } catch {
      // Leave json undefined on parse failure; tests that need it will fail.
    }
  }
  const ctx: AssertionResponseContext = {
    status: input.status,
    statusText: input.statusText,
    headers: Object.freeze(normalizedHeaders),
    body: input.body,
    durationMs: input.durationMs,
  };
  if (json !== undefined) ctx.json = json;
  // Validate shape (cheap and catches programmer mistakes during refactors).
  responseContextSchema.parse(ctx);
  return ctx;
}

/**
 * Bindings exposed to the assertion expression. Anything not listed here is
 * either shadowed to `undefined` or unreachable.
 */
const SAFE_GLOBAL_NAMES = [
  'Math',
  'Date',
  'JSON',
  'Number',
  'String',
  'Boolean',
  'Array',
  'Object',
  'RegExp',
  'parseInt',
  'parseFloat',
  'isNaN',
  'isFinite',
] as const;

const SHADOWED_NAMES = [
  'globalThis',
  'global',
  'self',
  'window',
  'process',
  'require',
  'module',
  'exports',
  '__dirname',
  '__filename',
  'eval',
  'Function',
  'fetch',
  'setTimeout',
  'setInterval',
  'setImmediate',
  'queueMicrotask',
] as const;

export function evaluateAssertion(
  expression: string,
  ctx: AssertionResponseContext,
): AssertionResult {
  const expr = expression.trim();
  if (expr === '') {
    return { expression: expr, passed: false, error: 'empty expression' };
  }

  // Build the function: shadowed names + ctx bindings + safe globals.
  // The body is `return (<expr>);` so users write expressions, not statements.
  const paramNames = [
    ...SHADOWED_NAMES,
    ...SAFE_GLOBAL_NAMES,
    'status',
    'statusText',
    'headers',
    'body',
    'json',
    'text',
    'durationMs',
    'header',
  ];

  let fn: (...args: unknown[]) => unknown;
  try {
    // eslint-disable-next-line @typescript-eslint/no-implied-eval
    // Note: not using "use strict" so we can declare params named `eval` /
    // `arguments` to shadow them. The function body is otherwise harmless.
    fn = new Function(...paramNames, `return (${expr});`) as (
      ...args: unknown[]
    ) => unknown;
  } catch (e) {
    return {
      expression: expr,
      passed: false,
      error: `compile error: ${(e as Error).message}`,
    };
  }

  const shadowed = SHADOWED_NAMES.map(() => undefined);
  const safeGlobals: unknown[] = [
    Math,
    Date,
    JSON,
    Number,
    String,
    Boolean,
    Array,
    Object,
    RegExp,
    parseInt,
    parseFloat,
    isNaN,
    isFinite,
  ];
  const header = (name: string): string | undefined =>
    ctx.headers[String(name).toLowerCase()];
  const ctxArgs: unknown[] = [
    ctx.status,
    ctx.statusText,
    ctx.headers,
    ctx.body,
    ctx.json,
    ctx.body, // `text` alias
    ctx.durationMs,
    header,
  ];

  try {
    const value = fn(...shadowed, ...safeGlobals, ...ctxArgs);
    return { expression: expr, passed: Boolean(value), value };
  } catch (e) {
    return {
      expression: expr,
      passed: false,
      error: (e as Error).message,
    };
  }
}

export interface AssertionRunSummary {
  total: number;
  passed: number;
  failed: number;
  results: AssertionResult[];
}

export function runAssertions(
  expressions: readonly string[],
  ctx: AssertionResponseContext,
): AssertionRunSummary {
  const results = expressions.map((e) => evaluateAssertion(e, ctx));
  const passed = results.filter((r) => r.passed).length;
  return {
    total: results.length,
    passed,
    failed: results.length - passed,
    results,
  };
}
