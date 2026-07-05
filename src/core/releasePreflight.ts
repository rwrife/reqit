/**
 * Pure release preflight checks.
 *
 * Consumed by `scripts/preflight-release.mjs` (the CLI Ryan runs before
 * tagging) and by `test/releasePreflight.test.ts`. Keeping the rule set
 * here means:
 *
 *   - We can grow the rule set without touching the runner CLI.
 *   - Each rule has a name + severity so the CLI can render a stable
 *     report and CI can grep for failures.
 *   - Ryan can add rules without booting VS Code — just add a case here
 *     and cover it with vitest.
 *
 * Nothing in this file touches the filesystem, executes commands, or
 * imports VS Code. The runner is responsible for reading files and
 * handing us the strings; we just judge them.
 *
 * Rules currently enforced:
 *
 *   - `package.json` `version` is valid semver **and** not the pre-release
 *     `0.0.1` placeholder (M7 targets `0.1.0` or newer).
 *   - `package.json` declares `publisher`, `icon`, `license`, and MIT.
 *   - `CHANGELOG.md` contains a `## [<version>]` heading matching the
 *     package version (Keep-a-Changelog convention) with body content.
 *   - `README.md` exists, is non-trivial, and includes a Features + Install
 *     section that the marketplace listing will render.
 *   - Marketplace icon is a real 128×128 PNG (matches `test/icon.test.ts`).
 *   - No known telemetry SDKs referenced in `src/` (mirrors CI scan).
 *
 * Returning `pass` doesn't guarantee `vsce publish` will succeed (it can
 * still fail on network / PAT issues), but it guarantees Ryan won't ship
 * a broken listing.
 */

export type Severity = 'error' | 'warn' | 'info';

export interface PreflightIssue {
  /** Machine-readable rule id, stable across runs; used by CI + tests. */
  rule: string;
  severity: Severity;
  message: string;
}

export interface PreflightInputs {
  /** Parsed `package.json` object. */
  pkg: unknown;
  /** Raw text of `CHANGELOG.md`. */
  changelog: string;
  /** Raw text of `README.md`. */
  readme: string;
  /** Raw bytes of `media/icon.png` (or the path the CLI resolved). */
  iconBytes: Uint8Array | null;
  /** Concatenated text of all `src/**\/*.ts` files, for the telemetry scan. */
  srcText: string;
}

export interface PreflightResult {
  ok: boolean;
  version: string | null;
  issues: PreflightIssue[];
}

const TELEMETRY_PATTERNS: readonly RegExp[] = [
  /applicationinsights/i,
  /@sentry\//i,
  /mixpanel/i,
  /amplitude/i,
  /posthog/i,
  /segment-analytics/i,
  /vscode-extension-telemetry/i,
];

const SEMVER_RE = /^(\d+)\.(\d+)\.(\d+)(?:-[0-9A-Za-z.-]+)?(?:\+[0-9A-Za-z.-]+)?$/;

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function pushError(issues: PreflightIssue[], rule: string, message: string): void {
  issues.push({ rule, severity: 'error', message });
}

function pushWarn(issues: PreflightIssue[], rule: string, message: string): void {
  issues.push({ rule, severity: 'warn', message });
}

function checkPackageJson(pkg: unknown, issues: PreflightIssue[]): string | null {
  if (!isRecord(pkg)) {
    pushError(issues, 'pkg.shape', 'package.json is not a JSON object');
    return null;
  }

  const version = typeof pkg.version === 'string' ? pkg.version : null;
  if (!version) {
    pushError(issues, 'pkg.version.missing', 'package.json is missing a "version" field');
  } else if (!SEMVER_RE.test(version)) {
    pushError(
      issues,
      'pkg.version.semver',
      `package.json version "${version}" is not valid semver`,
    );
  } else if (version === '0.0.1' || version.startsWith('0.0.0')) {
    pushError(
      issues,
      'pkg.version.placeholder',
      `package.json version "${version}" is still the pre-release placeholder — bump to 0.1.0 or newer before tagging`,
    );
  }

  const publisher = typeof pkg.publisher === 'string' ? pkg.publisher : '';
  if (!publisher) {
    pushError(
      issues,
      'pkg.publisher',
      'package.json is missing a "publisher" — required by the VS Code Marketplace',
    );
  }

  const icon = typeof pkg.icon === 'string' ? pkg.icon : '';
  if (!icon) {
    pushError(
      issues,
      'pkg.icon',
      'package.json is missing an "icon" — required for a decent marketplace listing',
    );
  } else if (icon !== 'media/icon.png') {
    pushWarn(
      issues,
      'pkg.icon.path',
      `package.json "icon" is "${icon}" — expected "media/icon.png" to match the generator`,
    );
  }

  const license = typeof pkg.license === 'string' ? pkg.license : '';
  if (license !== 'MIT') {
    pushError(
      issues,
      'pkg.license',
      `package.json "license" is "${license || '<missing>'}" — expected "MIT"`,
    );
  }

  const repository = pkg.repository;
  if (
    !isRecord(repository) ||
    typeof repository.url !== 'string' ||
    !repository.url.includes('github.com')
  ) {
    pushWarn(
      issues,
      'pkg.repository',
      'package.json "repository.url" should point at the GitHub repo so the marketplace shows a source link',
    );
  }

  const engines = pkg.engines;
  if (!isRecord(engines) || typeof engines.vscode !== 'string' || !engines.vscode.trim()) {
    pushError(
      issues,
      'pkg.engines.vscode',
      'package.json is missing "engines.vscode" — required by the marketplace',
    );
  }

  const activationEvents = pkg.activationEvents;
  if (!Array.isArray(activationEvents) || activationEvents.length === 0) {
    pushWarn(
      issues,
      'pkg.activationEvents',
      'package.json has no "activationEvents" — extension will never activate',
    );
  }

  return version;
}

function findChangelogSection(
  changelog: string,
  version: string,
): { found: boolean; body: string } {
  // Match either "## [0.1.0]" or "## [0.1.0] - 2026-07-05" (Keep a Changelog).
  const escaped = version.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  const re = new RegExp(`^##\\s*\\[${escaped}\\][^\\n]*$`, 'im');
  const match = re.exec(changelog);
  if (!match) return { found: false, body: '' };

  const start = match.index + match[0].length;
  // Body runs until the next `## ` heading (or EOF).
  const rest = changelog.slice(start);
  const nextHeading = /\n##\s+/.exec(rest);
  const body = (nextHeading ? rest.slice(0, nextHeading.index) : rest).trim();
  return { found: true, body };
}

function checkChangelog(changelog: string, version: string | null, issues: PreflightIssue[]): void {
  if (!changelog.trim()) {
    pushError(issues, 'changelog.missing', 'CHANGELOG.md is empty or missing');
    return;
  }
  if (!version) {
    // Nothing to match against; caller already flagged the version issue.
    return;
  }

  const section = findChangelogSection(changelog, version);
  if (!section.found) {
    pushError(
      issues,
      'changelog.version.missing',
      `CHANGELOG.md has no "## [${version}]" section — move [Unreleased] entries under a dated ${version} heading before tagging`,
    );
    return;
  }
  if (section.body.length < 10) {
    pushError(
      issues,
      'changelog.version.empty',
      `CHANGELOG.md "## [${version}]" section has no body — describe what shipped in ${version} before tagging`,
    );
  }
}

function checkReadme(readme: string, issues: PreflightIssue[]): void {
  if (!readme.trim()) {
    pushError(issues, 'readme.missing', 'README.md is empty or missing');
    return;
  }
  if (readme.length < 500) {
    pushWarn(
      issues,
      'readme.short',
      `README.md is only ${readme.length} chars — marketplace listing will look thin`,
    );
  }

  const requiredSections: Array<{ rule: string; label: string; pattern: RegExp }> = [
    { rule: 'readme.features', label: '## Features', pattern: /^##\s+features/im },
    { rule: 'readme.install', label: '## Install', pattern: /^##\s+install/im },
    { rule: 'readme.quickstart', label: '## Quick start', pattern: /^##\s+quick\s*start/im },
  ];

  for (const section of requiredSections) {
    if (!section.pattern.test(readme)) {
      pushError(
        issues,
        section.rule,
        `README.md is missing a "${section.label}" section — marketplace users will bounce`,
      );
    }
  }
}

/**
 * Validate the marketplace icon buffer.
 *
 * Mirrors `test/icon.test.ts` so a broken icon fails preflight even if the
 * icon test somehow got skipped.
 */
export function validateIconBytes(bytes: Uint8Array | null): PreflightIssue[] {
  const issues: PreflightIssue[] = [];
  if (!bytes || bytes.length === 0) {
    pushError(issues, 'icon.missing', 'media/icon.png is missing or empty — run `npm run icon`');
    return issues;
  }
  const sig = [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a];
  const header = bytes.slice(0, 8);
  const okSig = sig.every((b, i) => header[i] === b);
  if (!okSig) {
    pushError(
      issues,
      'icon.format',
      'media/icon.png is not a valid PNG — regenerate via `npm run icon`',
    );
    return issues;
  }
  if (bytes.length < 24) {
    pushError(issues, 'icon.truncated', 'media/icon.png is truncated (no IHDR chunk)');
    return issues;
  }
  const width = readUInt32BE(bytes, 16);
  const height = readUInt32BE(bytes, 20);
  if (width !== 128 || height !== 128) {
    pushError(
      issues,
      'icon.size',
      `media/icon.png is ${width}×${height}; VS Code Marketplace expects 128×128 — run \`npm run icon\``,
    );
  }
  return issues;
}

function readUInt32BE(bytes: Uint8Array, offset: number): number {
  return (
    (((bytes[offset] ?? 0) << 24) |
      ((bytes[offset + 1] ?? 0) << 16) |
      ((bytes[offset + 2] ?? 0) << 8) |
      (bytes[offset + 3] ?? 0)) >>>
    0
  );
}

/**
 * Scan concatenated source text for known telemetry SDK imports.
 *
 * The CI job (`no-telemetry-check`) scans the built bundle; this scan
 * checks the source tree so preflight catches telemetry SDK drift before
 * a build even runs.
 */
export function scanTelemetryReferences(srcText: string): PreflightIssue[] {
  const issues: PreflightIssue[] = [];
  for (const pattern of TELEMETRY_PATTERNS) {
    if (pattern.test(srcText)) {
      pushError(
        issues,
        `telemetry.${pattern.source
          .replace(/[^a-z0-9]+/gi, '_')
          .toLowerCase()
          .replace(/^_|_$/g, '')}`,
        `src/ references telemetry SDK matching ${pattern} — Reqit is local-only, remove before shipping`,
      );
    }
  }
  return issues;
}

/**
 * Run every preflight rule against the provided inputs.
 *
 * The CLI passes real bytes from disk; tests pass fixtures.
 */
export function runReleasePreflight(inputs: PreflightInputs): PreflightResult {
  const issues: PreflightIssue[] = [];
  const version = checkPackageJson(inputs.pkg, issues);
  checkChangelog(inputs.changelog, version, issues);
  checkReadme(inputs.readme, issues);
  issues.push(...validateIconBytes(inputs.iconBytes));
  issues.push(...scanTelemetryReferences(inputs.srcText));
  const ok = !issues.some((issue) => issue.severity === 'error');
  return { ok, version, issues };
}
