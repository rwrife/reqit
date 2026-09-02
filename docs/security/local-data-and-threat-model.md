# Local data contract and threat model

**Status:** Normative architecture policy

**Last reviewed:** 2026-09-02

**Related:** [ADR 0001](../adr/0001-local-first-postman-class-architecture.md), [roadmap #53](https://github.com/rwrife/reqit/issues/53), [foundation #54](https://github.com/rwrife/reqit/issues/54)

## Security goals

Reqit enables powerful local API workflows without transferring ownership of user data. It must:

1. keep canonical collections under user-approved `.requests/` roots;
2. keep secrets out of workspace files and durable/output surfaces by default;
3. ensure every read, write, process, and network action is explicit, bounded, cancellable, and scoped;
4. make imported/provider data pass through a narrow validated core model;
5. fail closed without echoing secret-bearing input when a format or capability is unsupported.

Reqit does not defend a user from an already-compromised operating-system account or malicious VS Code host with equivalent access. It does reduce accidental disclosure, confused-deputy behavior, path escape, replay, and unsafe defaults.

## Data classification

Classification follows content, not filename or source.

| Class                | Examples                                                                                                                                                                                                              | Default handling                                                                                                                                                                                                                          |
| -------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Public/configuration | Methods; non-sensitive URLs; request names; schema; non-secret environment values; auth type names; docs                                                                                                              | May be stored in `.requests/` and exported after validation                                                                                                                                                                               |
| Sensitive            | Request/response bodies; endpoint paths and query values; cookies; history; scripts; runner data; local paths; certificates; reports; import diagnostics                                                              | Local only, least retention, omitted from logs/MCP unless needed and explicitly bounded                                                                                                                                                   |
| Secret               | Passwords; bearer/API tokens; JWT signing material; OAuth client secrets, access/refresh/ID tokens, authorization codes, PKCE verifiers and state; private keys/PFX and passphrases; session cookies; Git credentials | SecretStorage or an explicit local provider. User-managed mTLS key/PFX files may remain at an explicitly selected local path behind the read-only secret-file capability. Never workspace/Git/log/history/export/clipboard/MCP by default |

### Secret-bearing fields and surfaces

The following are always treated as secret-bearing or potentially secret-bearing:

- `.http-env.json` values marked `{ "$secret": true }`; their resolved values never replace the marker on disk.
- `.http-auth.json`: `basic.password`, `bearer.token`, `apiKey.value`, pasted JWT `token`, generated JWT `secret`, OAuth `clientSecret`, client-certificate `passphrase`, and every value in OAuth `extraParams`, `extraAuthParams`, or `extraTokenParams` because those maps can carry or override credential fields.
- OAuth access, refresh, and ID tokens; authorization codes; PKCE verifier/state; and cached expiry metadata that could aid replay.
- PEM private-key content, PFX bytes, key passphrases, and Git credential-helper input/output. User-managed key/PFX files may remain outside SecretStorage only through the explicit read-only secret-file capability; Reqit neither copies nor persists their bytes. Public certificates and all certificate/key paths remain sensitive metadata.
- `Authorization`, `Proxy-Authorization`, `Cookie`, `Set-Cookie`, provider/API-key headers, and URL userinfo/query parameters.
- Request bodies, multipart/file contents, scripts, iteration data, response headers/bodies, SSE/WebSocket/gRPC frames, captures, snapshots, history, reports, errors, stack traces, and import fixtures because users can place credentials in any of them.
- Clipboard text, output channels, webview state/messages, diagnostics, Git diffs/commit output, process argv/environment, MCP requests/responses/errors, and test fixtures.

Names such as `token`, `secret`, `password`, `passwd`, `api_key`, `client_secret`, `private_key`, and provider token shapes are defense-in-depth signals, not the primary classification mechanism.

## Trust boundaries

| Boundary                        | Untrusted ingress                                                                       | Required controls                                                                                                                                                                                                                            |
| ------------------------------- | --------------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Workspace filesystem            | Request/config/docs/data files, filenames, symlinks, watcher events, external Git edits | Approved roots; handle-based/no-follow confinement at I/O; traversal/device-file rejection; byte limits before parsing; schema validation; atomic writes and conflict checks                                                                 |
| User-selected mTLS files        | Certificate, PEM key, PFX, and path/permission metadata outside the workspace           | Separate per-file read grant; no directory capability; race-safe no-follow opened-file identity/type/permission checks; deny when the adapter cannot prove equivalent binding; bytes kept in memory only as long as transport setup requires |
| Imported collections/specs/cURL | JSON/YAML/text, remote specs, nested objects, file references                           | Bounded fetch/read; one expected top-level shape; depth/count limits; allowlist mapping; conversion report; no overwrite without confirmation; never log raw rejection payload                                                               |
| Webview                         | Every message and persisted UI state                                                    | Restrictive CSP/nonces; schema and revision validation before preprocessing; intent-only messages; no filesystem/secret handles; escaped output; bounded body rendering                                                                      |
| Network targets/responses       | URLs, redirects, DNS, TLS data, response headers/bodies/streams                         | User initiation; validated protocols/options; redirect policy; abort/deadline; connect/body/event limits; stream backpressure; no ambient retry after cancellation                                                                           |
| Scripts/tests                   | Pre-request/post-response/test expressions and data                                     | Documented minimal sandbox API; no ambient Node/VS Code/filesystem/process/network; CPU/time/memory/output limits; terminate on cancel                                                                                                       |
| Git executable/repository       | Paths, refs, filenames, status/diff output, hooks, credential prompts, remote content   | User-selected root; argv arrays (no shell); preview/dry-run; allowlisted paths; secret scan; system credentials only; backups/conflict preservation; bounded/redacted output                                                                 |
| MCP/CLI/provider hooks          | argv/stdin JSON, tool schemas, local client identity, requested paths/hosts             | Explicit provider/capability enablement; stdio default; byte limit before parse; allowlist normalization; canonical validation; bounded redacted responses; replay/conflict policy for mutations                                             |
| Local persistence               | History, reports, snapshots, cookies, UI restore metadata                               | Per-workspace scope; minimal fields; retention/clear controls; atomic commit; publish after persistence; no secret values by default                                                                                                         |

Loopback is not a trust grant: other local processes can send hostile input. Any future network MCP transport must be opt-in, authenticated, and restricted to literal loopback by default; URLs with credentials, unexpected path/query/fragment, or non-loopback resolution are rejected.

## Required controls

### Data minimization and redaction

1. Normalize with an allowlist. Raw payloads, prompts, transcripts, tool arguments/results, environments, and provider-specific unknown fields are not forwarded.
2. Omit secret/sensitive categories that the destination does not require, then redact the retained strings.
3. Apply structured authorization/header redaction before bearer/basic patterns, generic credential assignments, provider-token shapes, and the final length bound. This avoids exposing a token tail.
4. Redact URL userinfo and configured secret values in URLs, headers, bodies, labels, errors, and serialized output. Never include plaintext material in a “redaction failed” error.
5. Secret reveal/copy/plaintext export is a separate explicit command with a warning and narrow destination. It does not change safe defaults.
6. Test combined realistic strings and assert original secret bytes are absent from normalized objects and serialized output.

Current evidence includes SecretStorage markers in `src/core/env.ts` and `src/core/auth.ts`, limited SecretStorage-reference redaction in Copy as cURL, disabled response-webview scripts plus HTML escaping in `src/extension/responseView.ts`, and a no-telemetry bundle scan in `.github/workflows/ci.yml`. These controls are incomplete: Copy as cURL does not redact literal credentials or arbitrary sensitive request content, and none of this proves all current or future output surfaces safe.

### Known current gaps

The contract above is the required destination, not a claim that current main already complies everywhere:

- `src/core/oauth2.ts` currently includes up to 200 raw token-endpoint response characters in non-JSON/unrecognized-error exceptions, forwards recognized token/redirect `error` and `error_description`, and lets malformed redirect strings escape through `URL` errors that retain the raw `input`. Every provider-controlled field can contain credentials or identifying payloads. #57 must catch every path at the trust boundary, return only bounded payload-free internal codes, and add absence tests for malformed bodies, recognized errors, redirects, and malformed redirect URLs.
- OAuth extra maps are applied after canonical fields. Before preprocessing, normalize keys with Unicode NFKC, trim, and ASCII-lowercase; reject these exact collisions: `extraParams` — `grant_type`, `client_id`, `client_secret`, `scope`; `extraAuthParams` — `response_type`, `client_id`, `redirect_uri`, `scope`, `state`, `code_challenge`, `code_challenge_method`; `extraTokenParams` — `grant_type`, `code`, `redirect_uri`, `client_id`, `code_verifier`, `client_secret`. #57 owns per-map positive/negative fixtures.
- `src/core/env.ts`, `src/core/auth.ts`, and `src/core/oauth2.ts` currently accept literal strings in secret-designated environment/auth fields; OAuth extra maps accept arbitrary plaintext. #57 must implement explicit value-free classification plus provider-first migration for environment and auth literals, reject new plaintext writes, and leave original bytes unchanged on provider/write/conflict failure.
- Current cURL, Postman, and OpenAPI import paths can write credential headers, URL parameters, cookies, bodies/examples, auth values, and mTLS passphrases verbatim into generated request files; unsupported cURL notes can also echo secret-bearing raw fragments. Local/remote inputs are not bounded before parse, nesting/count/normalized output are unbounded, remote OpenAPI fetch lacks deadline/cancellation/redirect policy, request writes are sequential, overwrite confirmation races the final write, explicit request-file overwrite is possible, and Postman/OpenAPI environment merge treats read/parse failure as empty before replacing keys in workspace-root `.http-env.json`. #59 must bound before/after normalization, make fetch cancellable/deadline/redirect-safe, scan all generated content before write, request explicit value-free classification, migrate secrets to references/provider, use handle-confined transaction/recovery, preserve existing bytes/keys on read/parse/conflict, target canonical `.requests/.http-env.json`, and report unsupported/conflict/loss metadata without source values.
- Copy as cURL currently redacts only values resolved through `EnvManager` SecretStorage references. Literal authorization/cookie/API-key headers, URL/body values, and imported credentials can reach the clipboard; configured `.http-auth.json` profiles are not applied by this command. In addition, command arguments can set `revealSecrets: true`, copy unredacted output, and show a warning only after the copy rather than using a separate pre-confirmed reveal command. #57/#59 must remove that bypass and apply the canonical all-field redaction/absence tests before claiming safe export.
- Generic request failures in `src/extension/extension.ts` and `src/extension/responseView.ts` can display raw transport/provider `Error.message` and `Error.stack`, which may contain URLs or sensitive request/provider data. #57 must normalize these at the core boundary to payload-free codes and bounded, redacted metadata before notification, panel, log, or clipboard use.
- Ordinary HTTP dispatch currently has no `AbortSignal`, finite connect/overall deadline, explicit redirect/retry policy, or response-body byte limit. SSE defaults are unlimited unless directives are supplied, retains events in memory, checks idle/duration only when chunks arrive, and panel closure does not cancel the socket. #55/#58 must add bounded transport and temporal-cancellation tests proving cancelled/timed-out work cannot execute or emit later.
- `src/core/pathGuard.ts` is lexical only. Existing init/import writes lack handle-based/no-follow confinement; `src/extension/requestsTree.ts` traversal/read, `src/extension/envManager.ts` environment reads, and extension command-supplied document URIs also lack final-handle approved-root enforcement. #56/#57 must close both read and write boundaries before claiming traversal/symlink-safe workspace access.

Until each owner issue lands, adapters must not describe the affected behavior as compliant, and new surfaces must not copy these legacy patterns.

### Filesystem and state integrity

- Resolve and validate the approved root and parent, then open through a confined directory handle or a platform-equivalent no-follow primitive. Validate the opened handle with `fstat` (regular file/directory, expected identity and permissions) and perform reads/writes through that handle. A pre-open `realpath` check alone is advisory because an attacker can replace a path between check and use.
- For new files, create an exclusive temporary sibling through the verified parent handle, validate/flush it, and rename within that same parent. If the platform or VS Code filesystem provider cannot prove equivalent confinement, deny the operation rather than fall back to lexical-only checks.
- `src/core/pathGuard.ts` currently provides lexical containment and explicitly does not resolve symlinks. Existing init/import writers and tree/environment/document readers therefore do not yet satisfy this final-I/O contract; work under #56/#57 must replace both boundaries before claiming path-safe collection management.
- Optimistic concurrency uses the bytes/revision the user viewed. External edits or Git pulls cause a conflict prompt; they are not overwritten.
- A plaintext-secret migration never creates another plaintext workspace backup. It uses a value-free preview and, only when atomic rollback is required, a restrictive encrypted adapter-local rollback capsule keyed through the secret provider and excluded from Git/export/logs; delete it after durable commit. Without that facility, migrate one file at a time and report partial progress.
- Multi-file atomic work uses flushed staged siblings plus a flushed value-free journal (paths, original/replacement hashes, phase, rollback-capsule references), directory fsync after every rename, and a flushed commit marker. Startup recovery holds the store gate and idempotently finishes or restores before new work; interrupted rollback resumes. Publish records only after the durable commit marker. If recovery cannot restore every path, retain a non-success incident with committed/restored/unrestored paths and never report atomic success.
- Exact mutation retries use a stable operation ID and semantic fingerprint; exact replay returns the recorded result, while ID reuse with changed content is a conflict.

### Bounded execution

These are architecture limits until #62 turns them into measured gates; a feature may choose a lower default:

- local import/runner-data file: 10 MiB before parse;
- user-selected mTLS certificate/key/PFX file: 1 MiB each; CA bundle: 4 MiB total; regular files only, with the opened file ID matching the explicit grant and private-key/PFX permissions excluding broader principals;
- normalized request body: 10 MiB by default, with an explicit per-request override bounded by policy;
- buffered response body: 10 MiB default; larger/binary content streams to an approved local artifact or is truncated with an explicit diagnostic;
- MCP structured response: 1 MiB and 1,000 collection entries per result, with pagination/artifact handles;
- diagnostics/log field: 4 KiB; collection: 100 entries per operation;
- script execution: 5 seconds, 64 MiB isolated heap where the runtime can enforce it, and 1 MiB output;
- redirects: 10; retries: 5; every transport has a finite connect deadline, overall deadline, and `AbortSignal`.

Read at most `limit + 1` bytes before parsing so oversize input is distinguishable without loading the remainder. Bound again after normalization because compact inputs can expand.

Cancellation is temporal: cancellation/timed-out queued work is removed and can never run later. Retries replay complete validated initialization and inherit the remaining deadline. Overlapping writes to the same workspace serialize through a store-level gate.

### Network and execution policy

- Baseline extension network traffic happens only for user-initiated requests, OAuth redemption/refresh, or an explicitly enabled integration action. Marketplace update behavior belongs to VS Code, not Reqit.
- A normal user-authored request may intentionally target private addresses. MCP and imported automation are a different trust tier: execution is disabled by default and may require a host allowlist, resolved-address checks, and redirect revalidation to mitigate SSRF/DNS rebinding.
- Secret reveal and execution are separate capabilities. Permission UI must describe the backend actually shipped.
- Unknown event/action/provider types, malformed input, disconnects, ambiguity, and timeouts produce deny/no-op for consequential actions.
- No adapter reports success until the core transition is durable. A UI tap is not authoritative completion.

### Output and retention

- History is opt-in or clearly disclosed, local, retention-bounded, and clearable per workspace. Persist metadata by default; response bodies/cookies require explicit policy and redaction.
- Snapshots, transcripts, data-run reports, and examples are secret-scanned before creation/export and carry provenance without raw credentials.
- Git preview uses the exact allowlisted set that commit will stage. Certificates, keys, SecretStorage data, history, responses, reports, temp files, and bulky generated data are denied by default.
- MCP resources expose definitions and summaries with secrets redacted; large/binary bodies use scoped local artifact handles. Errors do not echo rejected input.
- Logs are structured and bounded. No raw request/response, environment, process environment, provider payload, or Git credential output is logged.

## Threats and verification obligations

| Threat                                                                       | Required verification                                                                                                             |
| ---------------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------- |
| Traversal/symlink escapes an approved root                                   | Lexical + symlink + missing-leaf + race-oriented tests on reads and writes                                                        |
| Imported object causes memory/CPU exhaustion or prototype/depth abuse        | Over-limit bytes/depth/count tests before preprocessing and after normalization                                                   |
| Secret leaks through combined auth strings, labels, errors, or serialization | Combined-header redaction regressions and serialized-output absence assertions                                                    |
| Webview injects commands or response HTML executes                           | Malformed/oversize message tests, capability allowlist, CSP/escaping tests, disabled child semantics/action review where relevant |
| Cancellation returns but queued network/script work later executes           | Deterministic cancel/deadline race tests and no-late-side-effect assertion                                                        |
| Multi-file operation partially commits or reports false success              | Injected validation/persistence failure tests with byte-for-byte rollback and explicit partial-success semantics                  |
| Replay executes a mutation twice or changed content reuses an ID             | Exact replay before/after restart plus semantic-conflict tests                                                                    |
| Git backup stages a key/token/history file                                   | Secret fixtures and denied-path tests before any staging subprocess                                                               |
| MCP/CLI bypasses extension security                                          | Contract tests proving all adapters call the same canonical validator, redactor, runner, and path policy                          |
| Dependency adds telemetry/native weight                                      | Lockfile/license/network/native scan plus footprint delta and maintainer approval                                                 |

Fixtures are synthetic/recorded-shape evidence, not proof of live-provider compatibility. Compatibility docs state the authoritative contract/version basis, retrieval date, live versions actually tested (or `None`), and fail-closed behavior on drift.

## Privacy review checklist

Before merging a feature that touches data or execution, reviewers must answer:

- What new ingress, persistence, egress, and deletion surfaces exist?
- Which fields can contain secrets, and are they omitted before redaction?
- Are reads bounded before parsing and outputs bounded after normalization?
- Are workspace realpath/symlink checks performed at the final I/O boundary?
- Does cancel/timeout prevent later side effects?
- Are multi-record/file changes atomic or explicitly partial?
- Do CLI, VS Code, and MCP share the same core behavior?
- Are runtime dependency, install, bundle, startup, and idle-memory deltas measured?
- Is every compatibility claim tied to real evidence rather than inferred fixtures?
