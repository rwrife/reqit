# Contributing to Reqit

Reqit is a local-first, near-Postman-complete API workbench delivered today as a VS Code extension with pure TypeScript core modules. Roadmap work will expose that same small core through a CLI and optional local MCP package. Read [ADR 0001](docs/adr/0001-local-first-postman-class-architecture.md), the [threat model](docs/security/local-data-and-threat-model.md), and the [performance budgets](docs/performance-budgets.md) before changing architecture or data flows.

## Product boundaries

Do not introduce:

- a Reqit account, first-party backend, hosted sync/collaboration/monitor/mock service, telemetry, or crash upload;
- a separate Electron shell or always-on daemon;
- an opaque database as the source of truth;
- Reqit-managed Git credentials;
- network MCP transport without a separate opt-in, authenticated, loopback-default design;
- a native/heavy runtime dependency without measurements and approval under the budget exception policy.

`.requests/` files remain canonical. Secret values belong in VS Code SecretStorage or an explicitly configured local provider and are omitted/redacted from workspace files, Git, logs, history, exports, clipboard, errors, fixtures, and MCP by default. The only storage exception is an explicitly selected user-managed mTLS private-key/PFX file accessed in place through the fail-closed read-only secret-file capability.

## Code boundaries

- Put pure parsing, serialization, execution policy, cancellation, redaction, runner, and report behavior in `src/core/`.
- Keep VS Code commands, views, webviews, workspace UI, and SecretStorage glue in `src/extension/`.
- CLI and MCP adapters call the same core contracts; do not fork request execution or redaction.
- Treat files, paths, symlinks, imports, webview/MCP messages, URLs, responses, scripts, Git output, and provider payloads as untrusted.
- Bound bytes before parsing and after normalization. Resolve real paths at I/O, keep mutations atomic, and ensure cancellation prevents later side effects.

## Development and verification

Use Node 20 or 22 and the checked-in lockfile:

```sh
npm ci
npm run lint
npm run typecheck
npm run test:unit
npm run build
```

Release preparation additionally runs `npm run preflight` after the release version and changelog entry are finalized; the development placeholder version intentionally fails that release-only gate.

For behavior changes, use strict red-green-refactor: add one focused failing test, confirm the expected failure, add the minimum implementation, then rerun focused and full gates. Documentation-only changes still require link/content review and `git diff --check`.

Before commit:

1. stage the complete intended snapshot;
2. run `git diff --cached --check` and review the staged diff;
3. run lint, typecheck, unit tests, build, and any focused security/integration/benchmark gate;
4. obtain independent review for substantial code, security, UI, or data-flow changes;
5. report runtime dependency and footprint deltas.

Never put real credentials, tokens, private keys, production responses, or identifying payloads in tests. Use synthetic values that cannot authenticate.

## Pull requests

Link the smallest issue that the change actually satisfies. Use `Closes #N` only when every acceptance criterion is met; otherwise use `Advances #N` and list remaining work. Include:

- acceptance mapping and user-visible behavior;
- privacy/data-flow and path-boundary impact;
- dependency, bundle, install, startup, and memory impact;
- exact local and CI verification evidence;
- compatibility basis and live versions actually tested (or `None`).
