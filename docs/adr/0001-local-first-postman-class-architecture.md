# ADR 0001: Local-first Postman-class architecture

- **Status:** Accepted
- **Date:** 2026-09-02
- **Decision owners:** Reqit maintainers
- **Tracks:** [roadmap #53](https://github.com/rwrife/reqit/issues/53), [foundation #54](https://github.com/rwrife/reqit/issues/54)

## Context

Reqit is evolving from a capable `.http` client into a near-Postman-complete API workbench. “Postman-class” means workflow and capability parity for local request authoring, organization, execution, inspection, testing, import/export, and automation. It does not mean cloning Postman's UI or hosted services.

The repository already contains pure TypeScript support for HTTP parsing, environments, authentication, assertions, GraphQL, WebSocket, gRPC descriptors, SSE, schema validation, and import/export helpers in `src/core/`. The VS Code adapter in `src/extension/` currently owns activation, SecretStorage integration, filesystem/UI operations, and live HTTP dispatch. The visual workbench, complete runner/CLI, Git backup, and MCP package are roadmap work rather than current capabilities.

Without an explicit boundary, new adapters could fork parsing or execution, accidentally persist secrets, or pull VS Code/Electron into headless packages. This decision prevents that drift.

## Decision

### Deployment topology

Reqit has one reusable TypeScript domain and several thin local adapters:

```text
                 +-----------------------------+
                 |       VS Code extension     |
                 | commands, views, webviews,  |
                 | SecretStorage, workspace UI |
                 +--------------+--------------+
                                |
+---------------+      +--------v---------+      +----------------+
| local CLI     +------> shared core      <------+ local MCP      |
| argv/stdout   |      | model, runner,   |      | stdio default  |
| exit/report   |      | policy, redact   |      | bounded tools  |
+---------------+      +--------+---------+      +----------------+
                                |
                      explicit capability ports
                    filesystem / secrets / HTTP / Git
```

Dependency direction is inward:

1. `src/core/` (and a future independently published core package) imports no VS Code, webview, CLI, MCP, or provider SDK.
2. The canonical parser, serializer, variable resolver, secret classifier/redactor, request executor, cancellation contract, runner, and report model live in the core. An adapter must not implement a second request engine.
3. VS Code glue remains in `src/extension/`; webview code receives normalized view models and sends schema-validated intents, never raw filesystem or SecretStorage capabilities.
4. The CLI adapts argv/stdin/stdout and process exit codes to core operations. It must run without loading VS Code or a webview bundle.
5. MCP is an optional package and local stdio process by default. Its schemas map to the same core operations. Execution and mutation capabilities are disabled until explicitly enabled; secret reveal is denied by default.
6. System Git is an optional capability behind a narrow adapter. Its executable and credential helpers are authoritative; Reqit stores no Git credentials.
7. Network dispatch is a capability called only by an explicit user/CLI action or an explicitly enabled MCP tool. There is no first-party Reqit endpoint.

The current extension-local HTTP dispatch is transitional. Runner work must move transport orchestration behind a core-owned contract before CLI or MCP execution ships; adapters may provide the concrete transport but not execution semantics.

### Capability ports

Core operations accept narrow interfaces instead of ambient access:

- `WorkspaceStore`: approved roots, realpath-aware reads, atomic writes, and watched revisions.
- `SecretProvider`: opaque get/set/delete by scoped identifier; values are never enumerable or serializable.
- `SecretFileReader`: read-only access to one explicitly selected certificate/key/PFX path. It binds that exact grant to a non-following opened regular-file identity (POSIX device/inode or Windows file ID), rejects private-key/PFX files readable or writable by broader principals, and enforces 1 MiB per cert/key/PFX plus 4 MiB total CA-bundle limits. It returns bytes without copying them into Reqit storage and never grants directory enumeration/write access. If the adapter cannot provide `O_NOFOLLOW`-equivalent race-safe identity and permission checks, it denies access; platform support is not optional for this boundary.
- `HttpTransport`: validated request, abort signal, time/byte limits, and normalized response/stream events.
- `GitTransport`: preview and explicit mutation operations over an approved repository root.
- `Clock`/`RandomSource`: deterministic tests for timestamps, JWTs, retries, and reports.
- `EventSink`: already-redacted structured diagnostics; no raw payload logging.

Every adapter validates untrusted ingress before preprocessing, calls canonical core validation after normalization, and returns bounded, redacted results.

## Canonical local data model

`.requests/` at an approved workspace root is the portable source of truth. Files remain human-readable and reviewable.

| Path/data                                                          | Role                                                                       | Canonical and Git policy                                                                                                                                         |
| ------------------------------------------------------------------ | -------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `.requests/**/*.http` / `.rest`                                    | HTTP, GraphQL, SSE requests and directives                                 | Canonical; user chooses whether to commit                                                                                                                        |
| `.requests/**/*.grpc` / `.ws`                                      | gRPC and WebSocket requests                                                | Canonical; user chooses whether to commit                                                                                                                        |
| `.requests/.http-env.json`                                         | Environment names, non-secret values, and `{ "$secret": true }` markers    | Canonical; plaintext secrets forbidden                                                                                                                           |
| `.requests/.http-auth.json`                                        | Auth profile shape, non-secret metadata, and secret markers                | Canonical; tokens, passwords, keys, and passphrases forbidden                                                                                                    |
| `.requests/**/*.md` and examples/data explicitly added by the user | Collection documentation and bounded runner input                          | Canonical; secret scan before Git/export                                                                                                                         |
| `.requests/.snapshots/`                                            | Explicitly approved, sanitized response snapshots                          | Canonical only when snapshot support ships; temp files remain excluded                                                                                           |
| `.requests/.history/`, reports, transcripts, response bodies       | Derived local records                                                      | Non-canonical, retention-bounded, gitignored by default, redacted before persistence                                                                             |
| Indexes, thumbnails, UI restore state, caches                      | Rebuildable acceleration/presentation state                                | Non-canonical; stored in adapter-local storage and safe to delete                                                                                                |
| SecretStorage or an explicitly configured local secret provider    | Passwords, tokens, signing secrets, passphrases, and OAuth token state     | Never represented in workspace files, Git, exports, snapshots, or MCP resources                                                                                  |
| User-managed certificate/key/PFX files selected for mTLS           | Read-only external secret material referenced by path from an auth profile | Remain in place; accessed only through the explicit per-file `SecretFileReader` grant; bytes are never copied into Reqit persistence, logs, Git, exports, or MCP |

There is no hidden cloud workspace ID. If ordering, favorites, or other portable collection metadata requires a new file, it must be an optional, documented, versioned JSON file under `.requests/`; it may contain only stable relative paths and non-secret presentation metadata. Derived indexes must never become authoritative.

### Schema and migration rules

1. Existing unversioned request files remain readable until a documented major migration. Existing environment/auth parsers currently also accept literal secret values for compatibility; that is a legacy-read gap, not permission for new writes.
2. A conforming reader detects literal values in secret-designated environment/auth fields without echoing them, warns the user, and offers explicit per-value classification. For a classified secret it persists the value to SecretStorage/local provider first, atomically replaces the source with `{ "$secret": true }`, and leaves the original unchanged on provider/write/conflict failure. Existing request-file literals in credential headers, URL parameters, cookies, bodies, auth directives, and certificate passphrases receive the same value-free audit plus an explicit migration to a referenced secret variable; no automatic rewrite guesses which bytes are credentials. Execution/export/Git features must not treat an unmigrated literal as safe configuration. New writers/importers reject plaintext secret fields before any `.requests/` write.
3. OAuth extra maps are potentially secret-bearing and cannot override canonical protocol fields. Normalize each object key with Unicode NFKC, trim, and ASCII-lowercase before collision checks. Reject these exact reserved sets: `extraParams` — `grant_type`, `client_id`, `client_secret`, `scope`; `extraAuthParams` — `response_type`, `client_id`, `redirect_uri`, `scope`, `state`, `code_challenge`, `code_challenge_method`; `extraTokenParams` — `grant_type`, `code`, `redirect_uri`, `client_id`, `code_verifier`, `client_secret`. Only non-reserved typed values may proceed, and credential values require secret references.
4. New metadata formats carry an integer `schemaVersion`. Readers reject unsupported future major versions without writing.
5. Non-secret migrations may use a same-directory backup. A migration involving plaintext secrets must not create another plaintext workspace file: preview data contains paths/hashes only, and rollback bytes live in a restrictive encrypted adapter-local capsule whose key is held by the secret provider, excluded from Git/export/logs, and deleted after durable success. If that facility is unavailable, migrate one file at a time with explicit partial-progress reporting rather than promise multi-file atomicity.
6. For an atomic multi-file mutation, stage and validate all sibling replacements; flush them; write and flush a value-free durable journal with paths, original/replacement hashes, phases, and rollback-capsule references; rename each file and fsync each containing directory; then write/fsync a commit marker. Startup recovery acquires the same store gate and idempotently completes the commit or restores every original before accepting new mutations. An interrupted rollback resumes from the journal. If restore becomes impossible, return/retain an explicit non-success incident record listing committed/restored/unrestored paths and never claim atomic success. A failed single-file pre-rename validation/write leaves original bytes unchanged.
7. Adapter caches may be dropped and rebuilt across versions. They cannot be required to open a collection.
8. Downgrades never silently rewrite newer data. The user receives a compatibility report with exact affected paths and remediation.

## Capability inventory and roadmap gaps

| Workflow                                      | Current repository evidence                                                                | Remaining roadmap                                                                                                                                                                                                                                                                                                                                                                                                  |
| --------------------------------------------- | ------------------------------------------------------------------------------------------ | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| HTTP request lifecycle                        | `src/core/parser.ts`, `src/core/request.ts`, `src/extension/extension.ts`                  | Shared executor, cancellation, response bounds, workbench (#55/#58). Current extension failure notifications/panels can display raw transport/provider `Error.message`/`stack`; #57 must normalize these to payload-free codes before display                                                                                                                                                                      |
| Environments and auth                         | `src/core/env.ts`, `src/core/auth.ts`, `src/core/oauth2.ts`, `src/extension/envManager.ts` | Safe visual management, cookies, inheritance (#57). Current literal secret fields and OAuth extra-parameter reserved-key overrides require provider-first migration/rejection                                                                                                                                                                                                                                      |
| GraphQL, WebSocket, gRPC, SSE                 | `src/core/graphql.ts`, `ws.ts`, `grpc*.ts`, `sse/`                                         | Complete live workflows and retained advanced feature criteria (#46)                                                                                                                                                                                                                                                                                                                                               |
| Assertions and schema validation              | `src/core/assertions.ts`, `schemaValidator.ts`                                             | Runner/CLI/report integration (#58)                                                                                                                                                                                                                                                                                                                                                                                |
| cURL/Postman/OpenAPI import; cURL export core | `src/core/import/`, `src/core/export/curl.ts`                                              | Loss-reporting round-trip compatibility (#59). Current importers can write credential headers, cookies, bodies/URL values, auth fields, mTLS passphrases, and variables verbatim; they can overwrite environment keys and use workspace-root `.http-env.json`. #59 must detect before write, request value-free classification, migrate secrets to references/provider, and report conflicts/losses without values |
| Local explorer                                | `src/extension/requestsTree.ts`                                                            | Safe collection lifecycle, search, conflicts (#56). Current tree/environment/document reads do not enforce approved-root identity through a final no-follow handle and must not be treated as symlink-safe                                                                                                                                                                                                         |
| Chaining and snapshots                        | Not complete                                                                               | #47 and #48                                                                                                                                                                                                                                                                                                                                                                                                        |
| User-owned Git backup                         | Not present                                                                                | #60 after collection/secret contracts                                                                                                                                                                                                                                                                                                                                                                              |
| Local MCP                                     | Not present                                                                                | #61 after shared executor/runner and secret policy                                                                                                                                                                                                                                                                                                                                                                 |
| Enforced footprint/performance gates          | Build and telemetry scan exist                                                             | #62 implements [documented budgets](../performance-budgets.md)                                                                                                                                                                                                                                                                                                                                                     |

## Privacy and security consequences

The data classes, secret-bearing fields, trust boundaries, and required controls are normative in [the local data and threat model](../security/local-data-and-threat-model.md). Important consequences are:

- Omit sensitive categories before redaction; redact retained strings again as defense in depth.
- Request URLs, headers, bodies, imported files, responses, webview messages, Git output, and MCP input are untrusted and potentially secret-bearing.
- Workspace checks resolve symlinks/realpaths and enforce approved roots at the final I/O boundary.
- Bounded reads occur before parsing; normalized values and output are bounded again.
- Cancellation/timeouts prevent queued network or script work from executing later.
- Webviews use a restrictive CSP, schema-validated messages, and no direct secret access.
- Multi-record/state changes publish only after durable atomic commit.

## Footprint consequences

Numeric ceilings and reproducible measurement definitions are in [Performance and footprint budgets](../performance-budgets.md). New runtime dependencies require size/license/network/native-code review. Advanced protocol/UI code should be lazy-loaded when it is not needed for baseline HTTP use.

## Rejected alternatives

- **Separate Electron application:** duplicates VS Code's shell and violates the install/runtime budget.
- **Reqit-hosted sync, accounts, monitors, mocks, or telemetry:** violates local ownership and creates a service/security perimeter the product does not need.
- **Adapter-specific parsers/runners:** causes behavior, cancellation, and redaction drift.
- **Opaque database as source of truth:** harms portability, reviewability, Git workflows, and recovery.
- **Always-on local daemon:** unnecessary baseline resource use and a wider attack surface.
- **Forward raw provider payloads after generic redaction:** redaction is fallible; allowlisting normalized fields is safer.

## Follow-up

Roadmap issues #55–#63 and #46–#48 implement this decision. A change that reverses a non-negotiable boundary requires a new ADR and explicit maintainer approval; footprint increases also follow the budget exception process.
