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

