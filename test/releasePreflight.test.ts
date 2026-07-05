import { describe, it, expect } from 'vitest';
import {
  runReleasePreflight,
  scanTelemetryReferences,
  validateIconBytes,
} from '../src/core/releasePreflight.js';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';

/**
 * Fixture builders — start from something that *passes*, then mutate one
 * field per test to prove each rule is wired up.
 */

const GOOD_PKG = {
  name: 'reqit',
  version: '0.1.0',
  publisher: 'rwrife',
  icon: 'media/icon.png',
  license: 'MIT',
  engines: { vscode: '^1.85.0' },
  repository: { type: 'git', url: 'https://github.com/rwrife/reqit.git' },
  activationEvents: ['onLanguage:http'],
};

const GOOD_CHANGELOG = `# Changelog

## [Unreleased]

- (nothing yet)

## [0.1.0] - 2026-07-05

### Added

- First real release.

## [0.0.1] - Pre-release

- Scaffold.
`;

const GOOD_README = `# Reqit

Test it before you req it!

## Features

- HTTP client that respects your version-controlled workflow.

## Install

\`\`\`
code --install-extension reqit
\`\`\`

## Quick start

1. Open a workspace.
2. Run "Reqit: Init Workspace".
3. Send a request.
`;

const GOOD_SRC = `import { fetch } from 'undici';
export async function ping(url: string) {
  return fetch(url);
}`;

function goodIcon(): Uint8Array {
  // We reuse the checked-in icon so a broken icon doesn't fake-fail this suite.
  return new Uint8Array(readFileSync(resolve(__dirname, '..', 'media/icon.png')));
}

function goodInputs() {
  return {
    pkg: structuredClone(GOOD_PKG),
    changelog: GOOD_CHANGELOG,
    readme: GOOD_README,
    iconBytes: goodIcon(),
    srcText: GOOD_SRC,
  };
}

describe('release preflight — passes on a clean fixture', () => {
  it('reports ok=true with no error-level findings', () => {
    const report = runReleasePreflight(goodInputs());
    const errors = report.issues.filter((i) => i.severity === 'error');
    expect(errors, `unexpected errors:\n${JSON.stringify(errors, null, 2)}`).toEqual([]);
    expect(report.ok).toBe(true);
    expect(report.version).toBe('0.1.0');
  });
});

describe('release preflight — package.json rules', () => {
  it('flags placeholder 0.0.1 version', () => {
    const inputs = goodInputs();
    (inputs.pkg as any).version = '0.0.1';
    const report = runReleasePreflight(inputs);
    expect(report.ok).toBe(false);
    expect(report.issues.some((i) => i.rule === 'pkg.version.placeholder')).toBe(true);
  });

  it('flags a non-semver version', () => {
    const inputs = goodInputs();
    (inputs.pkg as any).version = '0.1';
    const report = runReleasePreflight(inputs);
    expect(report.issues.some((i) => i.rule === 'pkg.version.semver')).toBe(true);
  });

  it('accepts a valid pre-release semver like 0.1.0-beta.1', () => {
    const inputs = goodInputs();
    (inputs.pkg as any).version = '0.1.0-beta.1';
    // Also add a changelog section so we don't cross-fail on that rule.
    inputs.changelog = inputs.changelog.replace('[0.1.0]', '[0.1.0-beta.1]');
    const report = runReleasePreflight(inputs);
    const semverError = report.issues.find((i) => i.rule === 'pkg.version.semver');
    expect(semverError).toBeUndefined();
  });

  it('flags missing publisher', () => {
    const inputs = goodInputs();
    delete (inputs.pkg as any).publisher;
    const report = runReleasePreflight(inputs);
    expect(report.issues.some((i) => i.rule === 'pkg.publisher')).toBe(true);
  });

  it('flags missing icon', () => {
    const inputs = goodInputs();
    delete (inputs.pkg as any).icon;
    const report = runReleasePreflight(inputs);
    expect(report.issues.some((i) => i.rule === 'pkg.icon')).toBe(true);
  });

  it('flags non-MIT license', () => {
    const inputs = goodInputs();
    (inputs.pkg as any).license = 'Apache-2.0';
    const report = runReleasePreflight(inputs);
    expect(report.issues.some((i) => i.rule === 'pkg.license')).toBe(true);
  });

  it('flags missing engines.vscode', () => {
    const inputs = goodInputs();
    (inputs.pkg as any).engines = {};
    const report = runReleasePreflight(inputs);
    expect(report.issues.some((i) => i.rule === 'pkg.engines.vscode')).toBe(true);
  });

  it('warns (but does not fail) on a non-github repo URL', () => {
    const inputs = goodInputs();
    (inputs.pkg as any).repository = { url: 'https://gitlab.com/rwrife/reqit.git' };
    const report = runReleasePreflight(inputs);
    const issue = report.issues.find((i) => i.rule === 'pkg.repository');
    expect(issue?.severity).toBe('warn');
    expect(report.ok).toBe(true);
  });
});

describe('release preflight — CHANGELOG rules', () => {
  it('flags a missing version section', () => {
    const inputs = goodInputs();
    inputs.changelog = `# Changelog\n\n## [Unreleased]\n\n- pending\n`;
    const report = runReleasePreflight(inputs);
    expect(report.issues.some((i) => i.rule === 'changelog.version.missing')).toBe(true);
  });

  it('flags an empty version section', () => {
    const inputs = goodInputs();
    inputs.changelog = `# Changelog\n\n## [0.1.0]\n\n## [0.0.1]\n\n- scaffold\n`;
    const report = runReleasePreflight(inputs);
    expect(report.issues.some((i) => i.rule === 'changelog.version.empty')).toBe(true);
  });

  it('accepts a Keep-a-Changelog dated heading', () => {
    const inputs = goodInputs();
    inputs.changelog = `# Changelog\n\n## [0.1.0] - 2026-07-05\n\n### Added\n\n- Something.\n`;
    const report = runReleasePreflight(inputs);
    expect(report.issues.some((i) => i.rule.startsWith('changelog.'))).toBe(false);
  });
});

describe('release preflight — README rules', () => {
  it('flags missing Features section', () => {
    const inputs = goodInputs();
    inputs.readme = inputs.readme.replace('## Features', '## Highlights');
    const report = runReleasePreflight(inputs);
    expect(report.issues.some((i) => i.rule === 'readme.features')).toBe(true);
  });

  it('flags missing Install section', () => {
    const inputs = goodInputs();
    inputs.readme = inputs.readme.replace('## Install', '## Setup');
    const report = runReleasePreflight(inputs);
    expect(report.issues.some((i) => i.rule === 'readme.install')).toBe(true);
  });

  it('flags missing Quick start section', () => {
    const inputs = goodInputs();
    inputs.readme = inputs.readme.replace('## Quick start', '## Getting rolling');
    const report = runReleasePreflight(inputs);
    expect(report.issues.some((i) => i.rule === 'readme.quickstart')).toBe(true);
  });
});

describe('release preflight — icon rules', () => {
  it('flags a missing icon', () => {
    expect(validateIconBytes(null).some((i) => i.rule === 'icon.missing')).toBe(true);
  });

  it('flags a non-PNG buffer', () => {
    const issues = validateIconBytes(new Uint8Array([1, 2, 3, 4]));
    expect(issues.some((i) => i.rule === 'icon.format')).toBe(true);
  });

  it('flags a wrong-sized PNG (32x32 valid-signature buffer)', () => {
    // Craft an 8-byte PNG signature + fake IHDR with width=32, height=32
    // (padding the rest of IHDR with zeros; we only check the size fields).
    const buf = new Uint8Array(32);
    buf.set([137, 80, 78, 71, 13, 10, 26, 10], 0);
    // width = 32 (uint32 BE at offset 16)
    buf[16] = 0;
    buf[17] = 0;
    buf[18] = 0;
    buf[19] = 32;
    // height = 32 (offset 20)
    buf[20] = 0;
    buf[21] = 0;
    buf[22] = 0;
    buf[23] = 32;
    const issues = validateIconBytes(buf);
    expect(issues.some((i) => i.rule === 'icon.size')).toBe(true);
  });

  it('accepts the shipped icon', () => {
    expect(validateIconBytes(goodIcon())).toEqual([]);
  });
});

describe('release preflight — telemetry scan', () => {
  it('is silent on clean source', () => {
    expect(scanTelemetryReferences('import { fetch } from "undici";')).toEqual([]);
  });

  it('flags @sentry imports', () => {
    const issues = scanTelemetryReferences('import * as Sentry from "@sentry/node";');
    expect(issues.length).toBeGreaterThan(0);
    expect(issues[0].severity).toBe('error');
  });

  it('flags posthog references case-insensitively', () => {
    const issues = scanTelemetryReferences('const c = require("PostHog-Node");');
    expect(issues.length).toBeGreaterThan(0);
  });

  it('flags vscode-extension-telemetry', () => {
    const issues = scanTelemetryReferences(
      "import TelemetryReporter from 'vscode-extension-telemetry';",
    );
    expect(issues.length).toBeGreaterThan(0);
  });
});

describe('release preflight — against the checked-in repo', () => {
  it('flags the known M7 gap (placeholder version) on the current tree', () => {
    const repoRoot = resolve(__dirname, '..');
    const pkg = JSON.parse(readFileSync(resolve(repoRoot, 'package.json'), 'utf8'));
    const changelog = readFileSync(resolve(repoRoot, 'CHANGELOG.md'), 'utf8');
    const readme = readFileSync(resolve(repoRoot, 'README.md'), 'utf8');
    const iconBytes = new Uint8Array(readFileSync(resolve(repoRoot, 'media/icon.png')));

    const report = runReleasePreflight({
      pkg,
      changelog,
      readme,
      iconBytes,
      srcText: '',
    });

    // The one certainty right now: package.json still says 0.0.1, which the
    // M7 checklist explicitly wants bumped to 0.1.0 before tagging.
    // Once Ryan bumps the version + adds a matching CHANGELOG section this
    // test will fail and force us to revisit the guardrail — that's the point.
    const errorRules = report.issues.filter((i) => i.severity === 'error').map((i) => i.rule);
    expect(errorRules).toContain('pkg.version.placeholder');
  });
});
