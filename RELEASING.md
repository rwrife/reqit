# Releasing Reqit

This is the short version. The long version is `PLAN.md` (M7).

## TL;DR

```bash
# 1. Bump version in package.json (e.g. 0.0.1 -> 0.1.0)
# 2. Move [Unreleased] entries under a dated [x.y.z] section in CHANGELOG.md
# 3. Regenerate icon if it changed:  npm run icon
# 4. Preflight the release:
npm run preflight
# ...fix anything it flags, then:
git commit -am "chore(release): v0.1.0"
git tag v0.1.0
git push origin main --tags
```

That's it. The tag push triggers `.github/workflows/release.yml`, which:

- installs deps, lints, typechecks, runs unit tests, builds
- runs `vsce package` to produce `reqit-v0.1.0.vsix`
- if the `VSCE_PAT` repo secret is set, runs `vsce publish` to the VS Code Marketplace
- creates a GitHub Release with the `.vsix` attached and auto-generated notes

Do **not** run `vsce publish` from your laptop unless the CI path is broken and you know what you're doing. Publishing from CI keeps the audit trail clean and means the artifact the marketplace serves is bit-for-bit the artifact GitHub built.

## What preflight checks

The `npm run preflight` script (source: `scripts/preflight-release.mjs`, rules: `src/core/releasePreflight.ts`) refuses to green-light a release when any of these are wrong:

- `package.json`
  - version is valid semver
  - version isn't the `0.0.1` pre-release placeholder
  - `publisher`, `icon`, `license: "MIT"`, `engines.vscode`, `activationEvents` all present and sane
- `CHANGELOG.md`
  - a `## [<version>]` section exists for the version in `package.json`, and has a body
- `README.md`
  - non-trivial, and has Features / Install / Quick start sections (the marketplace listing template)
- `media/icon.png`
  - is a real 128×128 PNG (run `npm run icon` if this fails)
- `src/**/*.ts`
  - no known telemetry SDK imports (Application Insights, Sentry, PostHog, Amplitude, Mixpanel, Segment, `vscode-extension-telemetry`)

The rule set is covered by `test/releasePreflight.test.ts` — extend it there when we add a new guardrail.

Pass `--json` for a CI-friendly report:

```bash
npm run preflight -- --json
```

Exit codes: `0` = pass, `1` = at least one error-level rule, `2` = the script itself failed (unreadable JSON, missing esbuild, etc.).

## First-release checklist (v0.1.0)

The extension has never shipped, so before the very first tag Ryan needs to do these things once:

1. **Verify the `rwrife` publisher** — https://marketplace.visualstudio.com/manage. If it doesn't exist yet, create it. Publisher name must match `package.json` `publisher` exactly.
2. **Add `VSCE_PAT` to the repo secrets** — Azure DevOps PAT scoped to Marketplace / Manage. Without it, `release.yml` will still build + attach the `.vsix` to the GitHub Release, but the marketplace publish step is skipped.
3. **Capture screenshots / a demo GIF** for the README (see next section). Currently tracked in [#7](https://github.com/rwrife/reqit/issues/7).

## Screenshots + demo GIF

The marketplace renders `README.md` as-is, but only linked images (raw GitHub URLs) render on the marketplace page — relative paths break. Convention:

- Store screenshots in `media/screenshots/<slug>.png`
- Link with the raw URL: `https://raw.githubusercontent.com/rwrife/reqit/main/media/screenshots/<slug>.png`
- Keep the GIF under ~2MB — the marketplace will strip larger media

Suggested shots for v0.1.0:

- `send-request.png` — a `.http` file with the CodeLens visible, response panel to the right
- `env-picker.png` — status bar environment picker + a `{{var}}` substitution
- `auth-mtls.png` — `.http-auth.json` with a `clientCert` profile
- `run-file.gif` — running `# @test` blocks via `Run File`, pass/fail summary

Screenshot capture has to happen inside a real VS Code instance; the bot can't automate it. Once the files are in `media/screenshots/`, drop the raw URLs into README's "Screenshots" section.

## Rolling a patch release

For 0.1.x patch releases:

1. Merge fixes to `main` via normal PR flow
2. Bump `package.json` `version`
3. Move relevant `[Unreleased]` entries under a new `## [0.1.x] - YYYY-MM-DD` section
4. `npm run preflight`
5. Tag + push

The release workflow doesn't care about the version number's shape — it uses `${{ github.ref_name }}` — as long as the tag matches `v*.*.*` it will publish.

## When things go wrong

- **Preflight fails on `pkg.version.placeholder`** — you forgot step 1, bump the version.
- **Preflight fails on `changelog.version.missing`** — move `[Unreleased]` entries into a dated `[<version>]` section.
- **Release workflow fails at `vsce publish`** — check the PAT hasn't expired. Azure DevOps PATs default to 90 days.
- **Marketplace rejects the package** — most common reason is missing `icon` or invalid `engines.vscode`. Preflight catches both.
- **Bad release already shipped** — you can't unpublish a specific version from the marketplace via CLI, but you can `vsce unpublish rwrife.reqit` to yank the whole extension. Prefer shipping a fix release.

## Related

- [PLAN.md](./PLAN.md) — full milestone roadmap
- [Issue #7](https://github.com/rwrife/reqit/issues/7) — M7 marketplace release tracking issue
