/**
 * Shared secret-text redaction primitive (issue #47).
 *
 * One implementation for every derived surface: the VS Code render echo,
 * the recorded chain request body, clipboard/cURL output, and future CLI
 * reports. Adapters must not fork this behavior.
 */

/**
 * Replace every occurrence of each provided secret value in `text` with a
 * fixed marker.
 *
 * - Every secret contributes two candidate forms: the raw value and its
 *   JSON-escaped form (`# @graphql` bodies are re-serialized as JSON, so a
 *   secret containing `"`/newlines crosses derived surfaces escaped as
 *   `sec\"ret`; issue #47 review F1).
 * - ALL forms across ALL secrets are masked longest-first: if any form is a
 *   prefix of another form (raw-vs-raw, raw-vs-escaped, escaped-vs-escaped),
 *   masking the shorter first would expose the longer one's tail as a
 *   remnant (issue #47 review F1 + round-3 suggestion).
 * - Empty values are ignored; order within equal lengths is stable.
 */
/**
 * Build a reusable masking function over a fixed secret set (issue #47
 * review S2): the cURL renderer and every other derived-surface adapter must
 * share these exact semantics — raw + JSON-escaped forms, longest form first
 * — so no surface can mask weaker than the canonical render echo. Only the
 * placeholder token differs per surface.
 */
export function secretRedactor(
  secrets: readonly string[],
  placeholder = '[REDACTED]',
): (text: string) => string {
  const forms = new Set<string>();
  for (const secret of secrets) {
    if (secret.length === 0) continue;
    forms.add(secret);
    const escaped = JSON.stringify(secret).slice(1, -1);
    if (escaped !== secret) forms.add(escaped);
  }
  const ordered = [...forms].sort((a, b) => b.length - a.length);
  return (text: string): string => {
    let out = text;
    for (const form of ordered) {
      out = out.split(form).join(placeholder);
    }
    return out;
  };
}

export function redactSecretText(text: string, secrets: readonly string[]): string {
  return secretRedactor(secrets)(text);
}

/** Hard bound on DERIVED variants added per call (hostile self-referencing
 * templates). Applies to ADDITIONS only — the caller's own secret set is
 * always returned in full (issue #47 review r7 LOGIC1). */
export const MAX_DERIVED_ADDITIONS = 256;

/**
 * Expand a set of known-secret strings through the substitutions the env
 * stage actually performed (issue #47 review S5 + r7 LOGIC1).
 *
 * A secret may itself be a template (`prefix{{inner}}suffix`) whose embedded
 * reference the env stage expanded — what reached the wire is the FULL
 * derived value, and masking only the injected component left
 * `prefix[REDACTED]suffix` (or, for an empty expansion, the entire secret
 * unmasked). For every base secret this closure returns the base itself,
 * each injected VALUE whose reference text appears inside a known variant
 * (empty expansions contribute nothing), and every expansion variant.
 *
 * Round-7 LOGIC1 fix: expansion runs as a FIFO of one-PASS substitutions —
 * each queued variant has ALL currently-available substitutions applied at
 * once, mirroring how `substitute()` produces the wire text, then the
 * result is re-queued so chained expansions (`{{a}}` → `z{{b}}z` → `zQz`,
 * any length) reach their final wire form. A fixed four-pass loop silently
 * stranded legitimate chains mid-expansion. Total derived variants are
 * bounded (MAX_DERIVED_ADDITIONS) so a hostile self-referencing template
 * terminates deterministically and cannot starve other secrets beyond the
 * global cap; the caller's own secret set is ALWAYS returned in full.
 */
export function deriveSecretVariants(
  secrets: readonly string[],
  injected: ReadonlyArray<{ reference: string; value: string }>,
): string[] {
  const out = new Set<string>(secrets.filter((s) => s.length > 0));
  const queue = [...out];
  while (queue.length > 0 && out.size - secrets.length < MAX_DERIVED_ADDITIONS) {
    let variant = queue.shift()!;
    let changed = false;
    // References present in THIS variant's text before substitution; every
    // injected value for a participating reference reached the wire for
    // some ordering of repeated references and joins the set (empty
    // expansions contribute nothing).
    const participating = injected
      .map((inj) => inj.reference)
      .filter((ref) => ref !== '' && variant.includes(ref));
    for (const inj of injected) {
      if (!participating.includes(inj.reference)) continue;
      if (inj.value !== '' && !out.has(inj.value)) {
        out.add(inj.value);
        queue.push(inj.value);
      }
      if (variant.includes(inj.reference)) {
        variant = variant.split(inj.reference).join(inj.value);
        changed = true;
      }
    }
    if (changed && !out.has(variant)) {
      out.add(variant);
      queue.push(variant);
    }
  }
  return [...out];
}

/**
 * Scrub secret values from a body the chain store is about to RECORD
 * (issue #47 review r7 LOGIC3).
 *
 * The plain-text scrub (`redactSecretText`) can invalidate a JSON body: an
 * unquoted numeric/boolean/null secret becomes a bare `[REDACTED]` token and
 * breaks parsing of the WHOLE document, so every later
 * `{{name.request.body.$…}}` reference to an unrelated field would fail.
 * This helper keeps a JSON document valid:
 *
 *  - It parses the text; when parsing fails the textual scrub is used
 *    (non-JSON bodies have no referenceability to protect).
 *  - Inside a parsed document, string leaves get the textual scrub (their
 *    substrings may carry secrets).
 *  - Non-string scalar leaves (numbers/booleans/null) are replaced with the
 *    marker ONLY on exact serialized equality with a secret — masking a
 *    substring of `1234567890` because `'123'` is a secret would corrupt
 *    the value and re-introduce the invalidation this helper exists to
 *    avoid. (The residual: an exact-equality unquoted scalar secret is
 *    masked; a substring of one survives in the store copy, and this is
 *    documented in the chain grammar.)
 *  - If the re-serialize is NOT re-parseable (should be unreachable — every
 *    value substituted is string-or-original), the helper falls back to the
 *    textual scrub of the ORIGINAL only when that keeps the document
 *    parseable; otherwise the JSON-scrubbed serialization is still returned
 *    since it is strictly more referenceable.
 */
export function scrubRecordedBody(text: string, secrets: readonly string[]): string {
  const active = secrets.filter((s) => s.length > 0);
  if (active.length === 0) return text;

  let doc: unknown;
  try {
    doc = JSON.parse(text);
  } catch {
    return redactSecretText(text, active);
  }
  // Skip the round-trip when the textual scrub already keeps the document
  // parseable — the fast path preserves byte layout for the common case.
  const textual = redactSecretText(text, active);
  if (textual !== text) {
    try {
      JSON.parse(textual);
      return textual;
    } catch {
      // textual scrub broke JSON validity: do the structured pass below.
    }
  } else {
    return textual;
  }

  const redact = secretRedactor(active);
  const maskScalar = (value: unknown): unknown => {
    const serialized = typeof value === 'string' ? value : JSON.stringify(value);
    if (serialized !== undefined && active.includes(serialized)) return '[REDACTED]';
    return value;
  };
  const walk = (node: unknown): unknown => {
    if (typeof node === 'string') return redact(node);
    if (Array.isArray(node)) return node.map(walk);
    if (node !== null && typeof node === 'object') {
      const out: Record<string, unknown> = {};
      for (const [k, v] of Object.entries(node)) out[k] = walk(v);
      return out;
    }
    return maskScalar(node);
  };
  const scrubbed = walk(doc);
  try {
    const serialized = JSON.stringify(scrubbed);
    // A non-string value replaced into the tree is only ever a string
    // literal ('[REDACTED]') or the original scalar, so re-parse always
    // succeeds; the guard documents that and keeps the fallback honest.
    JSON.parse(serialized);
    return serialized;
  } catch {
    return textual;
  }
}
