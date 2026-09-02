# Reqit — Build Plan

A VS Code extension for testing REST APIs with first-class auth support.

## Product Goal

Deliver near-Postman-complete local workflows for creating, organizing, editing, sending, inspecting, testing, importing/exporting, and automating API requests. Reqit is not a pixel-for-pixel clone: it stays inside VS Code, keeps `.requests/` files canonical, and will expose one small TypeScript core through planned CLI and optional local MCP adapters.

## Non-Goals and boundaries

- A separate Electron application or duplicated desktop shell.
- Reqit accounts, a first-party backend, hosted sync/collaboration/monitors/mocks, telemetry, crash upload, public workspaces, or opaque cloud storage.
- An always-on daemon, heavyweight native database, or large runtime dependency without measurements and an approved architecture exception.
- Storing Git credentials; optional backup uses the user's repository, installed Git, and credential helpers.
- Network MCP by default; the optional MCP server uses local stdio unless a separately secured transport is explicitly enabled.

The normative design is [ADR 0001](./docs/adr/0001-local-first-postman-class-architecture.md). Data classification and security requirements are in the [local data contract and threat model](./docs/security/local-data-and-threat-model.md); numeric ceilings are in the [performance and footprint budgets](./docs/performance-budgets.md).

## Workspace Layout (hard convention)

- Requests live in **`.requests/`** at the workspace root. The extension auto-discovers `.http` files in this folder (recursively).
- Environments: `.requests/.http-env.json`.
- Auth profiles: `.requests/.http-auth.json` (no secret values; SecretStorage/local-provider references plus sensitive paths to explicitly selected user-managed mTLS files).
- History: `.requests/.history/` (gitignored by default, retention-bounded, and written only after redaction).
- Rebuildable indexes and UI restore state are non-canonical adapter-local data; they may be deleted without losing a collection.
- Required destination: the extension and every adapter MUST NOT create or read request files outside an approved workspace root and MUST use handle-based/no-follow confinement at final I/O. [Known current gaps](./docs/security/local-data-and-threat-model.md#known-current-gaps) are not evidence of compliance.

## Local-Only Data Contract (non-negotiable)

- No network traffic to any first-party Reqit server. There is no such server.
- Outbound HTTP only happens as a direct result of a user-initiated request (`Send Request`, `Run file`, refresh-on-401, OAuth2 redemption) or an explicitly enabled local integration action.
- No telemetry, no crash reports, no "check for updates" pings. VS Code Marketplace handles updates.
- Secret values only via `SecretStorage` or an explicitly configured local provider, except that an explicitly selected user-managed mTLS private-key/PFX file may remain in place behind the fail-closed read-only secret-file capability; never otherwise written to disk in plaintext, logged, persisted to history, exported, staged in Git, returned by MCP, or copied to the clipboard except via a distinct explicit user command that warns first.
- CI includes an allow-list check that fails the build if the bundle imports known telemetry SDKs.
- Git backup, when enabled, invokes system Git and its credential helpers; Reqit stores no Git credentials.
- MCP defaults to local stdio and denies mutation, execution, and secret reveal until the relevant capability is explicitly enabled.

## Tech Stack

- TypeScript (strict), Node >= 20
- HTTP: `undici` (HTTP/2, easy `Agent` for client certs)
- Bundler: `esbuild`
- Tests: `@vscode/test-electron` (integration), `vitest` (unit)
- Lint: `eslint` + `@typescript-eslint`, `prettier`
- Webview: Preact + plain CSS
- CI: GitHub Actions (lint, typecheck, test, package `.vsix`)

## Milestones

### M1 — Scaffold + send a request

Acceptance:

- `npm install && npm run build && npm run test` work
- `F5` launches a dev VS Code with the extension loaded
- `reqit: Init Workspace` command scaffolds `.requests/` with a sample `hello.http`
- Tree view "Reqit Requests" lists `.http` files discovered under `.requests/`
- Open a `.http` file, see syntax highlighting for the basic format
- Codelens "Send Request" above a request → response shown in a webview panel
- Method + URL + headers + body all parsed
- Response panel shows status, headers, body (pretty JSON if applicable), timing

### M2 — Environments + variables

Acceptance:

- `.http-env.json` per workspace, with named environments
- Picker in status bar to switch active environment
- `{{var}}` substitution in URL, headers, body
- Built-in vars: `{{$guid}}`, `{{$timestamp}}`, `{{$randomInt min max}}`, `{{$datetime iso}}`
- Secrets marked `"$secret": true` resolved from VS Code SecretStorage with a prompt on first use

### M3 — Auth, the whole point

Acceptance:

- Per-request `# @auth <name>` directive that pulls from `.http-auth.json`
- Auth providers:
  - `basic` (user/pass, password from SecretStorage)
  - `bearer` (token from SecretStorage)
  - `jwt`:
    - paste-in: signed token from SecretStorage
    - generated: claims + alg + key/secret, signed at request time
    - "Decode JWT" command for inspecting any token
  - `clientCert` (mTLS): PEM (`cert` + `key` + optional `ca` paths) OR `pfx` path; passphrase prompt cached for session
  - `apiKey` (header or query parameter)
- Failing-auth surface: response panel shows decoded WWW-Authenticate / 401 body, with a "fix auth" quick action

### M4 — OAuth2

Acceptance:

- `oauth2` auth provider:
  - `clientCredentials` flow
  - `authorizationCode` w/ PKCE (uses VS Code's external browser + loopback redirect)
- Access tokens cached in SecretStorage with expiry tracking
- "Refresh now" command + automatic refresh on 401

### M5 — Response viewer polish + history

Acceptance:

- Pretty/raw/headers/timing tabs
- Save response to file
- "Diff vs previous response for this request"
- "Copy as curl" command (preserves auth where safe; redacts secrets)
- History view: list of past requests with status/timestamp, click to re-run
- Response history: bounded JSON-lines or another measured pure-TypeScript store; a native/heavy database requires an approved ADR and footprint evidence

### M6 — Run collections + tests

Acceptance:

- `# @test` blocks in `.http` files (small JS expression DSL against the response: `status === 200`, `json.id != null`, etc.)
- "Run file" command — executes all requests sequentially, shows pass/fail summary
- CLI mode: `npx reqit run requests/smoke.http --env staging` for CI usage

### M7 — Marketplace release

Acceptance:

- Icon + readme + GIF demos
- Publisher set up (`rwrife` or similar)
- v0.1.0 tagged + published
- License: MIT

## Coding Standards

- Strict TypeScript, no `any` without an explicit comment justifying it
- All HTTP options validated with `zod` before being passed to undici
- Pure parser/var-substitution code lives in `src/core/` and is testable without VS Code APIs
- VS Code-specific glue lives in `src/extension/`
- Webview code lives in `src/webview/` and is bundled separately
