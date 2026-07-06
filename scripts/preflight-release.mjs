#!/usr/bin/env node
/**
 * Release preflight CLI.
 *
 * Runs before `git tag v<x.y.z> && git push --tags` to catch mistakes
 * that would embarrass us on the VS Code Marketplace:
 *
 *   - stale placeholder version in package.json
 *   - missing CHANGELOG entry for the version we're about to tag
 *   - broken/missing marketplace icon
 *   - README missing Features / Install / Quick start
 *   - a stray telemetry SDK import that snuck in
 *
 * The rule set lives in `src/core/releasePreflight.ts` so it's covered by
 * vitest. This file only glues the CLI together (read files, print
 * report, exit non-zero on error).
 *
 * Usage:
 *   npm run preflight           # human-readable report
 *   npm run preflight -- --json # machine-readable report for CI
 *
 * The script transpiles the TypeScript rule set on the fly via a tiny
 * ESBuild transform so there's no extra build step. If ESBuild is not
 * installed (e.g. someone ran this before `npm install`) we fall back to
 * a clear error.
 */

import { readFileSync, existsSync, readdirSync, statSync } from 'node:fs';
import { dirname, resolve, join } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';

const __dirname = dirname(fileURLToPath(import.meta.url));
const repoRoot = resolve(__dirname, '..');

const args = new Set(process.argv.slice(2));
const asJson = args.has('--json');

async function loadRuleSet() {
  const source = readFileSync(resolve(repoRoot, 'src/core/releasePreflight.ts'), 'utf8');
  let esbuild;
  try {
    esbuild = await import('esbuild');
  } catch (err) {
    console.error('preflight-release: could not load esbuild — run `npm install` first');
    process.exit(2);
  }
  const { code } = await esbuild.transform(source, {
    loader: 'ts',
    format: 'esm',
    target: 'node20',
  });
  const dir = mkdtempSync(join(tmpdir(), 'reqit-preflight-'));
  const file = join(dir, 'releasePreflight.mjs');
  writeFileSync(file, code, 'utf8');
  return import(pathToFileURL(file).href);
}

function readIfExists(path) {
  try {
    return readFileSync(path, 'utf8');
  } catch {
    return '';
  }
}

function readBytesIfExists(path) {
  try {
    return readFileSync(path);
  } catch {
    return null;
  }
}

function walkTsFiles(dir) {
  const out = [];
  if (!existsSync(dir)) return out;
  const stack = [dir];
  while (stack.length) {
    const current = stack.pop();
    for (const entry of readdirSync(current)) {
      const full = join(current, entry);
      const st = statSync(full);
      if (st.isDirectory()) {
        stack.push(full);
      } else if (st.isFile() && (full.endsWith('.ts') || full.endsWith('.tsx'))) {
        // Skip the preflight rule set itself — it defines the telemetry
        // patterns and would trip its own scan otherwise.
        if (full.endsWith('releasePreflight.ts')) continue;
        out.push(full);
      }
    }
  }
  return out;
}

function readSrcConcat() {
  const chunks = [];
  for (const file of walkTsFiles(resolve(repoRoot, 'src'))) {
    chunks.push(readIfExists(file));
  }
  return chunks.join('\n');
}

function parsePackage() {
  const raw = readIfExists(resolve(repoRoot, 'package.json'));
  if (!raw) return null;
  try {
    return JSON.parse(raw);
  } catch (err) {
    console.error(
      'preflight-release: package.json is not valid JSON —',
      err instanceof Error ? err.message : err,
    );
    process.exit(2);
  }
}

function formatIssue(issue) {
  const badge =
    issue.severity === 'error'
      ? '\u001b[31mERROR\u001b[0m'
      : issue.severity === 'warn'
        ? '\u001b[33mWARN \u001b[0m'
        : '\u001b[36mINFO \u001b[0m';
  return `  ${badge} ${issue.rule.padEnd(28)} ${issue.message}`;
}

async function main() {
  const { runReleasePreflight } = await loadRuleSet();

  const pkg = parsePackage();
  const inputs = {
    pkg,
    changelog: readIfExists(resolve(repoRoot, 'CHANGELOG.md')),
    readme: readIfExists(resolve(repoRoot, 'README.md')),
    iconBytes: readBytesIfExists(resolve(repoRoot, 'media/icon.png')),
    srcText: readSrcConcat(),
  };

  const report = runReleasePreflight(inputs);

  if (asJson) {
    process.stdout.write(JSON.stringify(report, null, 2) + '\n');
    process.exit(report.ok ? 0 : 1);
  }

  const versionLabel = report.version ?? '(no version)';
  const banner = report.ok
    ? `\u001b[32mPreflight OK\u001b[0m — ready to tag v${versionLabel}`
    : `\u001b[31mPreflight FAILED\u001b[0m — fix issues before tagging v${versionLabel}`;
  process.stdout.write(`\nReqit release preflight (v${versionLabel})\n${'='.repeat(48)}\n`);
  if (report.issues.length === 0) {
    process.stdout.write('  (no findings)\n');
  } else {
    for (const issue of report.issues) {
      process.stdout.write(formatIssue(issue) + '\n');
    }
  }
  process.stdout.write(`\n${banner}\n\n`);
  process.exit(report.ok ? 0 : 1);
}

main().catch((err) => {
  console.error(
    'preflight-release: unexpected failure —',
    err instanceof Error ? (err.stack ?? err.message) : err,
  );
  process.exit(2);
});
