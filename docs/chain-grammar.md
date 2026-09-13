# Request chaining grammar (core contract)

**Status:** Implemented as the pure core module `src/core/chain/` (issue
[#47](https://github.com/rwrife/reqit/issues/47)). The VS Code send-path
wiring, `Run file` orchestration, codelens previews, and CLI `reqit run`
integration are the remaining slices of #47; until they land, this grammar is
the validated core contract, not a shipped user feature.

Reqit chaining lets one named request feed another:

```http
# @name login
POST {{host}}/auth/login
Content-Type: application/json

{ "user": "{{user}}", "pass": "{{pass}}" }

###

# @name me
GET {{host}}/me
Authorization: Bearer {{login.response.body.$.access_token}}
```

## Chain references

Inside `{{ ... }}`, a reference is treated as a chain reference only when it
matches one of these shapes; anything else falls through to ordinary
environment/built-in substitution untouched:

| Reference                                   | Resolves to                                        |
| ------------------------------------------- | -------------------------------------------------- |
| `{{name.response.status}}`                  | numeric status of the recorded response (as text)  |
| `{{name.response.headers.<Header-Name>}}`   | header value; lookup is case-insensitive           |
| `{{name.response.body.$.path}}`             | JSONPath subset into the recorded JSON body        |
| `{{name.request.body.$.path}}`              | JSONPath subset into the body that was actually sent |

Names follow the `# @name` identifier rules: `[A-Za-z_][A-Za-z0-9_]*`, unique
per file (`validateRequestNames`). A name with no recorded entry produces an
actionable diagnostic (`no recorded response for 'login' …`) and the literal
`{{...}}` stays in place so the request fails loudly rather than sending a
raw placeholder.

A **malformed** chain-shaped reference bound to a **recorded** name is
reported with an actionable diagnostic and left literal — it never silently
passes through to env substitution. Chain intent is recognized by exact
namespace segments: anything under `login.response.…` or `login.request.…`
once `login` has run (including incomplete or irregular shapes such as
`{{login.response}}`, `{{login.response.}}`, `{{login.response..status}}`,
`{{login.response.1bad}}`) produces a diagnostic; same-prefix names that are
not exact namespaces (`login.responseX`) and references to names that were
**never recorded** stay silent so ordinary dotted env-var names keep working.

Placeholder scanning is quote-aware in a bracket-scoped way: a body path may
contain a quoted key with `]`, `}`, or even `}}` inside it
(`{{login.response.body.$['a}}b']}` resolves — only the matching quote closes
a bracket-opened quoted span), while an apostrophe in an ordinary env/header
name (`X-O'Brien`) does NOT start a quoted span. A malformed candidate — a
lone `}` inside `{{ … }}`, or an unterminated bracket-quoted span — is
abandoned as a whole region: scanning resumes only after that region's `}}`
terminator (or at end of input for an unterminated span), so a placeholder
nested inside abandoned text can never resolve and the region passes through
byte-identically.

## JSONPath subset

Deliberately bounded so hostile imported data cannot cause unbounded scans:

- `$` — root
- `.key` — key of `[A-Za-z0-9_-]+`
- `['key']` / `["key"]` — quoted key (any inner characters except the quote;
  `]` and `}` are fine)
- `[3]` — non-negative array index
- Composable: `$.a.b[0]['c-d']`

Wildcards, slices, filters, recursive descent, and functions are **not**
supported and are rejected at parse time. Hard bounds: at most
`MAX_JSONPATH_DEPTH` (64) segments per path (enforced at both parse and
evaluate time), and reserved prototype names — `__proto__`, `constructor`,
`prototype` — are rejected as segment names at **both** parse and evaluate
time, so a path can never traverse them even when hostile JSON contains them
as own keys. Resolution otherwise uses strict own-property checks, so a path
can never climb onto `Object.prototype` (`toString`, …). Explicit `null` is a
value; a missing key or an `undefined`-valued own property is a
`Path miss at $.…` diagnostic; sparse-array holes resolve like JSON
serialization (`null`).

## Resolution bounds

A single resolution pass (`resolveChainText` / `resolveChainRequest`) acts on
at most `MAX_CHAIN_REFS_PER_PASS` (100) chain references; the overflow is left
literal with one `Too many chain references` diagnostic. Recorded JSON bodies
are parsed at most once per pass (parse cache), so many references into one
body cannot amplify work to O(references × body size).

## Capture directives

`# @capture` records a value from a response into the run store:

```http
# @capture token = $.access_token
# @capture count: number = $.meta.count
# @capture tok: string secret = $.auth.token
```

- Type suffix (`: string | number | boolean`) validates the captured value
  with a zod schema; mismatches are errors, not silent coercions.
- `secret` requires a declared type. Secret-marked captures must never be
  surfaced by callers in codelens hovers, history, exports, or clipboard
  output (the redaction boundary itself is part of the pending extension
  slice).
- Captures are **per-run, in-memory only**. `applyCapture` evaluates a
  directive against a recorded response; `store.recordCaptures()` stores the
  results and returns diagnostics for invalid or duplicate names (captures
  must be unique per run; the first occurrence wins). `store.getCapture()` /
  `captureNames()` retrieve them, and `store.clear()` wipes them. Nothing is
  persisted to disk; there is no `@capture-persist` implementation yet.

Store getters (`getRequest` / `getResponse` / `getCapture`) return defensive
copies — a caller mutating a returned record can never rewrite stored
history.

## Module map

| File                      | Role                                                    |
| ------------------------- | ------------------------------------------------------- |
| `src/core/chain/jsonpath.ts` | Parser + evaluator for the bounded JSONPath subset.  |
| `src/core/chain/resolver.ts` | Reference parsing/classification, chain store (records + captures), text/request resolution, capture application, name validation. |
| `src/core/chain/index.ts` | Barrel of the pure surface.                             |

Tests: `test/chain.jsonpath.test.ts`, `test/chain.resolver.test.ts`.
No new runtime dependencies (zod, already a direct dependency, is used for
capture type validation).
