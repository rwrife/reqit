# PokeBoth

A VS Code extension for poking HTTP services from inside your editor.

> "It's like REST Client, but it actually cares about auth."

## Why

The existing landscape of VS Code REST extensions handles `GET /api/users` great and falls apart the moment you need:

- mTLS / client certificate auth
- JWT generation from claims + signing key (not just paste-in)
- OAuth2 with PKCE and token caching
- Per-environment secrets that aren't stored in plaintext on disk

PokeBoth fixes that.

## Status

🚧 Pre-alpha. Following the plan in [`PLAN.md`](./PLAN.md).

## License

MIT
