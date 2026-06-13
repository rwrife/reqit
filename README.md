# PokeBot

A VS Code extension for poking HTTP services from inside your editor.

> "It's like REST Client, but it actually cares about auth."

## Why

The existing landscape of VS Code REST extensions handles `GET /api/users` great and falls apart the moment you need:

- mTLS / client certificate auth
- JWT generation from claims + signing key (not just paste-in)
- OAuth2 with PKCE and token caching
- Per-environment secrets that aren't stored in plaintext on disk

PokeBot fixes that.

## Status

🚧 Pre-alpha. Following the plan in [`PLAN.md`](./PLAN.md).

**M1 landed:** TypeScript + esbuild scaffold, `.http` parser, `PokeBot: Init Workspace` command, `Send Request` codelens that fires undici and renders the response in a webview.

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
