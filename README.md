# Reqit

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

## Develop

```
npm install
npm run build       # esbuild → dist/extension.js
npm run lint        # eslint
npm run typecheck   # tsc --noEmit
npm run test:unit   # vitest (pure parser tests)
```

Press `F5` in VS Code to launch the Extension Development Host.

## License

MIT
