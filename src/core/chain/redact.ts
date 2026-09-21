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
export function redactSecretText(text: string, secrets: readonly string[]): string {
  const forms = new Set<string>();
  for (const secret of secrets) {
    if (secret.length === 0) continue;
    forms.add(secret);
    const escaped = JSON.stringify(secret).slice(1, -1);
    if (escaped !== secret) forms.add(escaped);
  }
  const ordered = [...forms].sort((a, b) => b.length - a.length);
  let out = text;
  for (const form of ordered) {
    out = out.split(form).join('[REDACTED]');
  }
  return out;
}
