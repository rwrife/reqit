# Reqit

[![CI](https://github.com/rwrife/reqit/actions/workflows/ci.yml/badge.svg)](https://github.com/rwrife/reqit/actions/workflows/ci.yml)
[![License: MIT](https://img.shields.io/badge/License-MIT-yellow.svg)](./LICENSE)
[![VS Code](https://img.shields.io/badge/VS%20Code-%5E1.85-007ACC?logo=visualstudiocode)](https://code.visualstudio.com/)

**Test it before you req it!**

A VS Code extension for testing HTTP services from inside your editor — with first-class auth (mTLS, JWT, OAuth2).

## Why

The existing landscape of VS Code REST extensions handles `GET /api/users` great and falls apart the moment you need:

- mTLS / client certificate auth
- JWT generation from claims + signing key (not just paste-in)
- OAuth2 with PKCE and token caching
- Per-environment secrets that aren't stored in plaintext on disk

Reqit fixes that.

## Features

- **`.http` request files** — plain-text, version-controllable, REST Client–compatible syntax (`### request separators`, method/URL line, headers, blank line, body).
- **Environments + variables** — `.requests/.http-env.json` with per-environment values, `{{var}}` substitution everywhere, and built-ins (`{{$guid}}`, `{{$timestamp}}`, `{{$randomInt min max}}`, `{{$datetime iso|rfc1123}}`).
- **Secrets done right** — per-environment values flagged `{ "$secret": true }` are stored in VS Code `SecretStorage`. Never written to disk in plaintext, never logged.
- **First-class auth** — `@auth <name>` directive resolves a profile from `.requests/.http-auth.json`:
  - `basic`, `bearer`, `apiKey` (header or query)
  - `jwt` — paste-in OR generated from claims (HS256/HS384/HS512)
  - `clientCert` (mTLS) — PEM (`cert` + `key` + optional `ca`) or PFX with passphrase
  - `oauth2` — `clientCredentials` and `authorizationCode` w/ PKCE; tokens cached in `SecretStorage`
- **Send Request codelens** — one-click execution backed by [`undici`](https://github.com/nodejs/undici); response opens in a side panel.
- **Copy as curl** — POSIX-safe, secrets redacted by default. Opt in to `revealSecrets: true` when you really need it.
- **Inline assertions** — `# @test status === 200`, `# @test json.id != null`, etc. (M6, runner UI shipping in follow-up).
- **GraphQL** — mark a request with `# @graphql` or `X-Request-Kind: graphql` and write the query naturally; Reqit serializes `{ query, variables, operationName }` and pretty-prints `data` / `errors` separately. See `### GraphQL` below.
- **Local-only, zero telemetry** — no first-party server, no "check for updates" pings. CI enforces a no-telemetry import scan on every build.

## Install

Reqit isn't published to the Marketplace yet (M7 in progress — see [#7](https://github.com/rwrife/reqit/issues/7)). To try it now:

```bash
git clone https://github.com/rwrife/reqit.git
cd reqit
npm install && npm run build
```

Then press `F5` in VS Code to launch an Extension Development Host with Reqit loaded, or run `npx vsce package` to build a `.vsix` you can `code --install-extension reqit-0.0.1.vsix`.

## Quick start

1. Open a workspace and run **Reqit: Init Workspace** — scaffolds `.requests/` with a sample `hello.http` and an empty `.http-env.json`.
2. Open the sample file. Click **Send Request** above any request.
3. Pick an environment from the status-bar item.

## Auth examples

`.requests/.http-auth.json`:

```json
{
  "prod-mtls": {
    "type": "clientCert",
    "cert": "./certs/client.pem",
    "key": "./certs/client.key",
    "ca": "./certs/ca.pem"
  },
  "signed-jwt": {
    "type": "jwt",
    "alg": "HS256",
    "secret": { "$secret": true },
    "claims": { "sub": "svc-account", "aud": "https://api.example.com" },
    "ttlSeconds": 300
  },
  "github": {
    "type": "oauth2",
    "flow": "authorizationCode",
    "clientId": "...",
    "authorizationUrl": "https://github.com/login/oauth/authorize",
    "tokenUrl": "https://github.com/login/oauth/access_token",
    "scopes": ["repo", "read:user"]
  }
}
```

```http
# @auth prod-mtls
GET https://api.example.com/me

###

# @auth signed-jwt
POST https://api.example.com/events
Content-Type: application/json

{ "kind": "ping" }
```

## Importing from other tools

Reqit can convert requests from formats you've already got lying around.

- **`Reqit: Import from cURL`** — paste any `curl ...` command (multi-line with `\` continuations is fine). Reqit writes a new file under `.requests/` with the URL, method, headers and body filled in. `-u` becomes a Basic `Authorization` header, `--cert` / `--key` become a `# @auth clientCert (...)` directive so you know to wire up an mTLS profile in `.http-auth.json`.
- **`Reqit: Import Postman Collection`** — point at a Postman v2.1 `.json` export. Reqit writes one `.http` file per top-level folder under `.requests/` (nested folders are flattened into prefixed request names like `### Admin / Users / invite`). Supported bodies: `raw` (Content-Type inferred from `options.raw.language`), `urlencoded`, `graphql`. Supported auth: basic, bearer, apikey (header), oauth2 (token attached if present). Multipart/file bodies and `apikey` in query are surfaced as `# unsupported:` notes so you can finish them by hand. Collection-level variables are offered for merge into `.http-env.json` under an env name of your choice; `{{var}}` tokens are preserved verbatim since reqit uses the same syntax.
- **`Reqit: Import OpenAPI`** — pick a local `.yaml` / `.yml` / `.json` spec or paste an http(s) URL. Reqit writes one `.http` per `tags[0]` (untagged operations land in `default.http`), with `{pathParams}` rewritten to `{{pathParams}}` and query/header params surfaced as `{{var}}` placeholders. Request bodies prefer `application/json` (then form-urlencoded, then anything else) and are filled with the spec's `example` / `examples` value, falling back to a schema-derived sample (`$ref`s resolved within the same doc, cycles are handled). `servers[0].url` becomes `{{baseUrl}}` in `.http-env.json`. `securitySchemes` map to `Authorization` headers where possible — bearer/basic/apiKey-header are auto-wired; oauth2 / mTLS produce a warning so you can finish them in `.http-auth.json`.

Imports never silently overwrite an existing file — you'll be asked to confirm.

## Exporting to other tools

Going the other way — sharing `.http` files with teammates on Postman/Insomnia/Bruno, or with a CI job that only speaks `curl` — is being landed in slices tracked under [#42](https://github.com/rwrife/reqit/issues/42):

- **cURL bundle** — pure exporter in [`src/core/export/curl.ts`](./src/core/export/curl.ts) turns a set of parsed `.http` files into a single runnable bash script (one `curl` per request, grouped by source file). Secret redaction is first-class: values you pass in `redact` are replaced with `***REDACTED***` (or a caller-supplied placeholder) in every URL, header, body **and** in the request-label comment above each command — no partial-token reassembly. `.grpc` and `.ws` inputs in a mixed tree are skipped with a warning rather than failing the export. The `Reqit: Export to cURL bundle…` command that wires this into VS Code is the next slice.
- **Postman v2.1 collection** — coming next.
- **OpenAPI 3.x stub from history** — coming after that.

## Status

🚧 Pre-alpha. Following the plan in [`PLAN.md`](./PLAN.md).

**M1 landed:** TypeScript + esbuild scaffold, `.http` parser, `Reqit: Init Workspace` command, `Send Request` codelens that fires undici and renders the response in a webview.

**M2 in progress:** `.requests/.http-env.json` with named environments, status-bar env picker, `{{var}}` substitution (URL + headers + body), built-ins `{{$guid}}` / `{{$timestamp}}` / `{{$datetime iso|rfc1123}}` / `{{$randomInt min max}}`, and per-secret values via VS Code `SecretStorage` (`{ "$secret": true }`).

### Environments

Define `.requests/.http-env.json`:

```json
{
  "default": { "baseUrl": "https://api.example.com" },
  "staging": {
    "baseUrl": "https://staging.example.com",
    "apiKey": { "$secret": true }
  }
}
```

- Switch the active env from the status-bar item (`Reqit: <env>`).
- Reference vars anywhere with `{{baseUrl}}`, `{{apiKey}}`, etc.
- Secrets are prompted on first use and stored in VS Code `SecretStorage` — never written to disk in plaintext. Re-prompt with **Reqit: Set Secret**.

### Copy as curl

Every request gets a **Copy as curl** codelens next to **Send Request**. The generated command is POSIX-safe (single-quoted) and any resolved secret values for the active environment are replaced with `***REDACTED***` before it hits the clipboard. Run the `reqit.copyAsCurl` command with `revealSecrets: true` if you explicitly need the unredacted version.

### Test assertions (M6, in progress)

You can attach inline assertions to a request with `# @test <expr>` (or `// @test <expr>`). The expression is evaluated against the response and pass/fail is reported by the runner (M6 — runner UI + CLI ship in follow-up PRs).

Available bindings: `status`, `statusText`, `headers` (lower-cased), `header(name)`, `body`, `text` (alias of `body`), `json` (parsed when content-type is JSON), `durationMs`. Safe globals: `Math`, `Date`, `JSON`, `Number`, `String`, `Boolean`, `Array`, `Object`, `RegExp`, `parseInt`, `parseFloat`, `isNaN`, `isFinite`. Things like `process`, `require`, and `globalThis` are deliberately shadowed.

```http
# @test status === 200
# @test json.id != null
# @test header("content-type").includes("json")
# @test durationMs < 1000
GET https://example.com/api/me
```

### Schema validation (in progress)

Attach a JSON Schema to a request with `# @schema <ref>` and Reqit will validate the response body against it. Three ref forms are supported:

- **Inline JSON** — `# @schema { "type": "object", "required": ["id"] }`
- **OpenAPI pointer** — `# @schema openapi:./api.yaml#/components/schemas/User` (walks `$ref`s inside the same doc)
- **File** — `# @schema file:./user.schema.json[#/definitions/User]`

Failures are reported with a JSON Pointer path (e.g. `/id`), the failing rule (`required`, `type`, `format`…), and a plain-English message. Non-JSON responses are skipped with a warning, not treated as failures. The response-panel **Schema** tab and CLI exit-code wiring land in follow-up PRs — this PR ships the pure core (`src/core/schemaValidator.ts` + `src/core/schemaRef.ts`) so the parser, importer, and future runner all share the same validation path.

```http
### get user
# @schema { "type": "object", "required": ["id", "name"], "properties": { "id": { "type": "integer" }, "name": { "type": "string" } } }
GET https://example.com/api/users/1
```

### GraphQL

Mark a request as GraphQL with either a `# @graphql` directive **or** an `X-Request-Kind: graphql` header. The body is the GraphQL document, optionally followed by a blank line and a JSON variables block:

```http
### Get user
POST https://api.example.com/graphql
X-Request-Kind: graphql

query GetUser($id: ID!) {
  user(id: $id) { id name email }
}

{ "id": "{{userId}}" }
```

Reqit serializes the outgoing body as `{ query, variables, operationName? }` (defaulting variables to `{}`), auto-detects `operationName` from the first named `query|mutation|subscription`, strips the `X-Request-Kind` marker, sets `Content-Type: application/json` if you didn't, and runs `{{var}}` substitution across both the query and the variables block. The response viewer pretty-prints `data` and `errors` separately when the response looks like GraphQL.


## Develop

```
npm install
npm run build       # esbuild → dist/extension.js
npm run lint        # eslint
npm run typecheck   # tsc --noEmit
npm run test:unit   # vitest (pure parser tests)
```

Press `F5` in VS Code to launch the Extension Development Host.

## Changelog

See [`CHANGELOG.md`](./CHANGELOG.md).

## License

MIT — see [`LICENSE`](./LICENSE).

