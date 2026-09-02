# Performance and footprint budgets

**Status:** Normative ceilings; enforcement tracked by [#62](https://github.com/rwrife/reqit/issues/62)

**Established:** 2026-09-02

**Related:** [ADR 0001](./adr/0001-local-first-postman-class-architecture.md), [foundation #54](https://github.com/rwrife/reqit/issues/54)

Reqit aims for Postman-class workflows without a second desktop shell, hosted service, always-on process, or heavyweight local database. These budgets are hard ceilings, not targets to consume.

## Reproducibility rules

- Size/dependency CI uses the lockfile, Node 22.11.0, and the container digest recorded in the baseline artifact. Node 20 remains a compatibility lane but does not publish size baselines.
- Timing/memory CI uses a non-burstable Linux x64 runner labeled `reqit-perf-linux-x64` with 4 dedicated vCPU, 16 GiB RAM, no concurrent jobs, and the CPU model/governor recorded in every result. The benchmark refuses to compare fingerprints that differ from the checked-in baseline environment.
- Extension benchmarks pin VS Code 1.85.2 (the minimum supported line) and the exact extension-host launch flags in the harness. A separate current-stable compatibility run may report data but does not update the reference baseline.
- Record commit SHA, OS/architecture, container/runner fingerprint, Node/npm/VS Code versions, commands, raw samples, p50/p95, and artifact SHA-256.
- Timing/memory benchmarks get 5 warm-up iterations and exactly 30 measured iterations. For paired controls, compute each iteration's `Reqit enabled - control` delta first. Sort the 30 deltas ascending and define p95 by nearest rank, sample `ceil(0.95 * 30) - 1` (zero-based); never subtract independently computed percentiles. Fail on that value and retain all control/enabled/delta triples as JSON.
- Activation and idle-memory measurements compare the same VS Code build and runner first without Reqit and then with Reqit in each pair. Report the distribution of paired deltas, not the host total.
- Dependency counting starts from `npm ci --omit=dev` for each release OS/architecture. Direct count is the number of names in that shipped package's `dependencies` plus installed `optionalDependencies`; `devDependencies` are excluded. Production-node count is distinct installed `name@version` reachable from those roots in `npm ls --omit=dev --all --json`: peer/bundled/workspace packages count when reachable, different installed versions count separately, and repeated locations of the same `name@version` count once. Platform-pruned optional nodes do not count on that target. Per-package gates use the maximum target count; aggregate gates use the union of `name@version` across every shipped package and release target, with workspace package roots themselves excluded.
- Artifact budgets include every production file actually shipped. Source maps are excluded only when the package manifest proves they are absent.
- Core, CLI, and MCP measurements start fresh processes. Advanced protocols must not be eagerly loaded by baseline HTTP or `--help` paths.

## Numeric ceilings

| Metric                            |                            Hard ceiling | Measurement definition                                                                                 |
| --------------------------------- | --------------------------------------: | ------------------------------------------------------------------------------------------------------ |
| Compressed VSIX                   |                                2.00 MiB | Bytes of the `.vsix` produced by the pinned `@vscode/vsce` packaging command                           |
| Installed VSIX contents           |                                6.00 MiB | Sum of uncompressed production files listed in the VSIX; excludes VS Code itself                       |
| Extension JavaScript              |                                2.00 MiB | Sum of shipped `.js` files, raw bytes, excluding source maps                                           |
| Source maps in release package    |                                 0 bytes | Inspect VSIX file list; maps may remain CI artifacts outside the shipped package                       |
| Core package tarball              | 1.00 MiB compressed / 3.00 MiB unpacked | `npm pack --dry-run --json` for future core package                                                    |
| CLI package tarball               | 1.50 MiB compressed / 5.00 MiB unpacked | Same, including executable JavaScript but no downloaded caches                                         |
| MCP package tarball               | 1.50 MiB compressed / 5.00 MiB unpacked | Same; stdio server and shared core only                                                                |
| Direct runtime dependencies       |      8 per package; 12 aggregate unique | Count `dependencies` for each shipped package and the deduplicated union across extension/core/CLI/MCP |
| Production dependency nodes       |     25 per package; 40 aggregate unique | Unique production lockfile nodes reachable per package and across all shipped packages                 |
| Native runtime dependencies       |                                       0 | Any exception requires measured ADR and cross-platform evidence                                        |
| Cold extension activation         |                           p95 <= 250 ms | Workspace with 25 request files; activation start to registered baseline commands/tree ready           |
| Warm extension activation         |                           p95 <= 100 ms | Same machine/process cache policy, new Extension Host                                                  |
| Idle memory delta                 |                           p95 <= 25 MiB | Extension Host RSS delta after activation and 30 seconds idle, no workbench panel                      |
| 1,000-request initial index       |                           p95 <= 750 ms | Cold discovery/parse of the checked-in deterministic fixture                                           |
| 1,000-request incremental refresh |                           p95 <= 100 ms | One file changed; watcher event to updated index                                                       |
| 1,000-request search              |                            p95 <= 50 ms | Query to complete result model, after initial index                                                    |
| Workbench first open              |                           p95 <= 500 ms | Command start to interactive method/URL UI with one request loaded                                     |
| CLI cold `--help`                 |                           p95 <= 250 ms | Fresh process to exit, shared core available, no workspace scan                                        |
| MCP cold initialize/list-tools    |                           p95 <= 400 ms | Fresh stdio process to valid initialize and tool-list responses                                        |
| Baseline background processes     |                                       0 | No Reqit process remains after VS Code/CLI/MCP client exits                                            |
| Baseline idle network requests    |                                       0 | No first-party, telemetry, update-check, or integration traffic without an explicit action             |

Tests should also enforce the security/resource defaults in the [threat model](./security/local-data-and-threat-model.md), including bounded imports, responses, scripts, logs, and MCP output.

## 2026-09-02 repository baseline

Measured from clean commit `6168569b514d93bc31695a713c7c9743c551d1b5` with `node:22.11.0-bookworm-slim`. Structured environment, command, artifact-hash, and measurement evidence is checked in at [`baselines/2026-09-02-footprint.json`](./baselines/2026-09-02-footprint.json).

```sh
npm ci --no-audit --no-fund
npm run build
wc -c dist/extension.js dist/extension.js.map
npm ls --omit=dev --all --json
npx --yes @vscode/vsce@3.6.0 package --no-dependencies --out /tmp/reqit-baseline.vsix
stat -c %s /tmp/reqit-baseline.vsix
sha256sum /tmp/reqit-baseline.vsix
unzip -l /tmp/reqit-baseline.vsix
```

The SHA-256 binds the captured artifact; ZIP timestamps mean it is not by itself a deterministic rebuild assertion. The retained entry manifest, uncompressed byte totals, dependency identities, source-file byte counts, and pinned environment are the reproducible comparisons. #62 must make the release archive itself byte-reproducible before treating equality of VSIX hashes as a gate.

| Baseline metric                        |             Result | Notes                                                                                                         |
| -------------------------------------- | -----------------: | ------------------------------------------------------------------------------------------------------------- |
| `dist/extension.js`                    |    1,272,780 bytes | esbuild production entry; currently not minified                                                              |
| `dist/extension.js.map`                |    2,308,781 bytes | development artifact; the measured VSIX unexpectedly included it, so #62 must enforce the 0-byte release rule |
| VSIX                                   |      791,596 bytes | SHA-256 and all 20 entries retained in the baseline JSON                                                      |
| Installed VSIX content                 |    3,641,676 bytes | Sum of the uncompressed `extension/` entries; excludes VSIX container manifests                               |
| Direct runtime dependencies            |                  5 | `ajv`, `ajv-formats`, `undici`, `yaml`, `zod`; names and versions retained                                    |
| Production dependency nodes            |                  9 | Excludes the package root; names and versions retained                                                        |
| Activation, memory, 1k indexing/search |         Unmeasured | #62 must add deterministic harnesses before claiming a baseline                                               |
| CLI/MCP artifacts and cold start       | Not applicable yet | Packages do not yet exist                                                                                     |

The final issue #54 candidate packages to 792,456 bytes compressed (860 bytes / 0.11% above baseline) and 3,643,832 installed-content bytes (2,156 bytes / 0.06% above baseline), with 20 entries and no dependency/node change. `docs/**` is excluded through `.vscodeignore`, so architecture/evidence documents do not become runtime payload. The candidate artifact hash, byte totals, and deltas are retained in the baseline JSON; its archive hash is evidence for that capture, subject to the timestamp caveat above.

The baseline is descriptive; the ceiling table is normative. Missing harnesses do not weaken a numeric limit.

## CI gate design for #62

1. Build/package once and emit a machine-readable `footprint.json` containing every metric, environment, and artifact hash.
2. Compare every lower-is-better size/count/time/memory metric to both its hard ceiling and a measured baseline on `main`. Any hard-ceiling breach fails. A >10% regression also fails. A measured zero baseline permits no positive value without an approved baseline-change PR; an `unmeasured`/not-applicable baseline skips only the relative comparison, never the hard ceiling. Functional throughput/correctness counters are not evaluated by this regression formula.
3. Run the 1,000-request fixture and timing harness without network. Store raw samples as CI artifacts.
4. Scan production dependency/license metadata, native binaries, install scripts, known telemetry SDKs, and unexpected outbound network capability.
5. Verify that importing core, invoking CLI `--help`, and MCP initialization do not load VS Code or webview bundles.
6. Package inspection must fail when source maps, tests, fixtures, caches, credentials, private keys, history, or response artifacts enter a release.

## Dependency and budget exception policy

A pull request adding a runtime dependency or increasing a baseline metric includes:

- before/after lockfile node counts, bundle/VSIX/package bytes, activation p95, and idle-memory p95 where relevant;
- license, native code, install-script, telemetry, and network behavior review;
- why a platform API or smaller implementation is insufficient;
- lazy-loading boundaries and removal/rollback plan.

Crossing a hard ceiling, adding a native runtime module, adding an always-on process, or introducing a heavyweight data store requires a new ADR and explicit maintainer approval before merge. Baselines are updated only by a focused PR with raw artifacts; never by silently raising thresholds in the feature PR.
