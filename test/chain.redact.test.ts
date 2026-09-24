import { describe, expect, it } from 'vitest';
import { deriveSecretVariants, MAX_DERIVED_ADDITIONS, redactSecretText, scrubRecordedBody } from '../src/core/chain/redact.js';

/**
 * Shared redaction primitive (issue #47). These cases pin the masking
 * order across raw and JSON-escaped forms — the leak classes the review
 * rounds surfaced (prefix remnants and escaped-form misses).
 */
describe('redactSecretText', () => {
  it('masks every secret occurrence', () => {
    expect(redactSecretText('a=SECRET b=SECRET', ['SECRET'])).toBe(
      'a=[REDACTED] b=[REDACTED]',
    );
  });

  it('masks overlapping secrets longest-first with no prefix remnant', () => {
    const out = redactSecretText('x ovlap-longerval y ovlap z', ['ovlap', 'ovlap-longerval']);
    expect(out).not.toContain('longerval');
    expect(out).not.toContain('ovlap');
    expect(out).toContain('[REDACTED]');
  });

  it('masks the JSON-escaped form (graphql re-serialization)', () => {
    const SECRET = 'sek' + 'r"et';
    const escaped = JSON.stringify(SECRET).slice(1, -1); // sek\\"ret
    const out = redactSecretText(`{\\"token\\":\\"${escaped}\\"}`, [SECRET]);
    expect(out).not.toContain(escaped);
    expect(out).not.toContain(SECRET);
  });

  it('a raw form that prefixes another secret\'s escaped form leaves no remnant (G-R3)', () => {
    // SECRET_A raw is a prefix of SECRET_B's escaped form; masking A first
    // used to expose B's escaped tail.
    const A = 'shared';
    const B = 'shared"tail'; // escapes to shared\\"tail
    const out = redactSecretText(`pre ${JSON.stringify(B).slice(1, -1)} mid ${A} end`, [A, B]);
    expect(out).not.toContain('shared');
    expect(out).not.toContain('tail');
  });

  it('ignores empty secrets and returns input unchanged when none apply', () => {
    expect(redactSecretText('clean text', ['', 'absent'])).toBe('clean text');
  });
});

describe('deriveSecretVariants (issue #47 review S5)', () => {
  it('derives the complete post-substitution secret, not just components', () => {
    // Secret template whose embedded reference the env stage expanded.
    // Masking only the injected component left `prefix[REDACTED]suffix`;
    // the complete derived value must mask as a whole.
    const variants = deriveSecretVariants(['prefix{{inner}}suffix'], [
      { reference: '{{inner}}', value: 'IN' },
    ]);
    expect(variants).toContain('prefix{{inner}}suffix');
    expect(variants).toContain('prefixINsuffix');
    const out = redactSecretText('wire: prefixINsuffix end', variants);
    expect(out).not.toContain('prefixINsuffix');
    expect(out).toContain('[REDACTED]');
  });

  it('masks the full derived secret when an expansion is EMPTY', () => {
    // inner → '' collapses the template to `prefixsuffix`, which contains
    // neither the template nor any injected component as a substring.
    const variants = deriveSecretVariants(['prefix{{inner}}suffix'], [
      { reference: '{{inner}}', value: '' },
    ]);
    expect(variants).toContain('prefixsuffix');
    const out = redactSecretText('wire=prefixsuffix&x=1', variants);
    expect(out).not.toContain('prefixsuffix');
  });

  it('expands repeated references with distinct builtin values (per-occurrence)', () => {
    const variants = deriveSecretVariants(['{{$guid}}+{{$guid}}'], [
      { reference: '{{$guid}}', value: 'g1' },
      { reference: '{{$guid}}', value: 'g2' },
    ]);
    // Both orders are possible wire strings; the closure only needs to
    // cover each single expansion and the template itself.
    expect(variants).toContain('{{$guid}}+{{$guid}}');
    const out = redactSecretText('a=g1+g2', variants);
    expect(out).not.toContain('g1');
    expect(out).not.toContain('g2');
  });

  it('applies chained expansions (reference inside an expansion value)', () => {
    const variants = deriveSecretVariants(['k={{a}}'], [
      { reference: '{{a}}', value: 'z{{b}}z' },
      { reference: '{{b}}', value: 'Q' },
    ]);
    expect(variants).toContain('k=z{{b}}z');
    expect(variants).toContain('k=zQz');
    const out = redactSecretText('send k=zQz', variants);
    expect(out).not.toContain('zQz');
  });

  it('returns exactly the base list when nothing was injected into a secret', () => {
    expect(deriveSecretVariants(['abc'], [{ reference: '{{other}}', value: 'x' }])).toEqual([
      'abc',
    ]);
  });

  it('does not blow up on self-referencing expansions (bounded additions)', () => {
    const variants = deriveSecretVariants(['{{a}}'], [{ reference: '{{a}}', value: 'q{{a}}' }]);
    // Bounded growth; must terminate and still contain the base + first expansions.
    expect(variants).toContain('{{a}}');
    expect(variants).toContain('q{{a}}');
    expect(variants).toContain('qq{{a}}');
    expect(variants.length).toBeLessThanOrEqual(1 + MAX_DERIVED_ADDITIONS);
  });

  it('closes TWENTY-link chained expansions despite the derived cap (fixpoint, not 4 passes)', () => {
    // Reviewer round-7 LOGIC1: a fixed 4-pass loop (and an early return at
    // 32 total variants) silently stopped before the wire value on a
    // legitimate 20-link chain. The closure must run to its fixpoint —
    // the cap only bounds total DERIVED work, it must not strand a chain
    // that completes inside the bound.
    const injections = Array.from({ length: 20 }, (_, i) =>
      i === 19 ? { reference: `{{r19}}`, value: 'END' } : { reference: `{{r${i}}}`, value: `p{{r${i + 1}}` + '}' },
    );
    const variants = deriveSecretVariants(['V-{{r0}}'], injections);
    // 20 injections: links r0..r18 inject 'p{{r..}}' (19 p's), r19 -> END.
    const final = `V-${'p'.repeat(19)}END`;
    expect(variants).toContain(final);
    const out = redactSecretText(`send ${final} end`, variants);
    expect(out).not.toContain(final);
  });
});

describe('scrubRecordedBody (issue #47 review r7 LOGIC3)', () => {
  it('keeps a JSON recorded body parseable when a numeric secret sat unquoted', () => {
    const out = scrubRecordedBody('{"n":1234567890,"keep":"ok"}', ['1234567890']);
    const parsed = JSON.parse(out) as { n: unknown; keep: string };
    expect(parsed.n).toBe('[REDACTED]');
    expect(parsed.keep).toBe('ok');
  });

  it('masks boolean secrets as valid JSON string values', () => {
    const out = scrubRecordedBody('{"flag":true,"k":"v"}', ['true']);
    const parsed = JSON.parse(out) as { flag: unknown; k: string };
    expect(parsed.flag).toBe('[REDACTED]');
  });

  it('masks null secrets as valid JSON string values', () => {
    const out = scrubRecordedBody('{"x":null,"k":"v"}', ['null']);
    const parsed = JSON.parse(out) as { x: unknown };
    expect(parsed.x).toBe('[REDACTED]');
  });

  it('scrubs secret substrings inside JSON string leaves (unchanged semantics)', () => {
    const out = scrubRecordedBody('{"t":"tok-42-suffix","k":"v"}', ['tok-42']);
    expect(out).not.toContain('tok-42');
    expect(JSON.parse(out).t).toBe('[REDACTED]-suffix');
  });

  it('keeps textual fast-path output byte-identical when the scrub stays valid JSON', () => {
    const out = scrubRecordedBody('{"t":"sec-ret"}', ['sec-ret']);
    expect(out).toBe('{"t":"[REDACTED]"}');
  });

  it('exact-equality only for scalar leaves: unrelated numbers survive', () => {
    // Secret '123' must not shred the unrelated field 1234567890 into
    // invalid JSON; masking a substring of an unquoted scalar would break
    // every reference to the document, so the scalar is left intact and
    // the whole document stays referenceable.
    const out = scrubRecordedBody('{"n":1234567890}', ['123']);
    expect(JSON.parse(out).n).toBe(1234567890);
  });

  it('non-JSON text falls back to the textual scrub (unchanged semantics)', () => {
    const out = scrubRecordedBody('raw tok-42 text', ['tok-42']);
    expect(out).toBe('raw [REDACTED] text');
  });

  it('handles nested objects and arrays', () => {
    const out = scrubRecordedBody('{"a":[{"v":777}],"b":{"v":1}}', ['777']);
    const parsed = JSON.parse(out) as { a: { v: unknown }[]; b: { v: unknown } };
    expect(parsed.a[0].v).toBe('[REDACTED]');
    expect(parsed.b.v).toBe(1);
  });

  it('empty secrets list returns text unchanged', () => {
    expect(scrubRecordedBody('{"a":1}', [])).toBe('{"a":1}');
  });
});
