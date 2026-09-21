import { describe, expect, it } from 'vitest';
import { redactSecretText } from '../src/core/chain/redact.js';

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
