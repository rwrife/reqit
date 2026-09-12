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
Authorization: Bearer {{login.r…}}
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

## JSONPath subset

Deliberately bounded so hostile imported data cannot cause unbounded scans:

- `$` — root
- `.key` — key of `[A-Za-z0-9_-]+`
- `['key']` / `["key"]` — quoted key (any inner characters)
- `[3]` — non-negative array index
- Composable: `$.a.b[0]['c-d']`

Wildcards, slices, filters, recursive descent, and functions are **not**
supported and are rejected at parse time. Resolution uses strict
own-property checks, so a path can never climb onto `Object.prototype`
(`constructor`, `toString`, …). Explicit `null` is a value; a missing key is
a `Path miss at $.…` diagnostic.

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
- Captures are **per-run, in-memory only** (`createChainStore`). Nothing is
  persisted to disk; there is no `@capture-persist` implementation yet.

## Module map

| File                      | Role                                                    |
| ------------------------- | ------------------------------------------------------- |
| `src/core/chain/jsonpath.ts` | Parser + evaluator for the bounded JSONPath subset.  |
| `src/core/chain/resolver.ts` | Reference parsing, chain store, text/request resolution, capture application, name validation. |
| `src/core/chain/index.ts` | Barrel of the pure surface.                             |

Tests: `test/chain.jsonpath.test.ts`, `test/chain.resolver.test.ts`.
No new runtime dependencies (zod is already a direct dependency).
