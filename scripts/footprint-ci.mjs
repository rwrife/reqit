#!/usr/bin/env node

import { spawnSync } from 'node:child_process';
import { mkdir, readFile, stat, writeFile } from 'node:fs/promises';
import path from 'node:path';
import process from 'node:process';
import { fileURLToPath } from 'node:url';

import { transform } from 'esbuild';

const VSCE_VERSION = '3.6.0';

async function main() {
  const args = parseArgs(process.argv.slice(2));
  const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
  process.chdir(repoRoot);

  const outputPath = path.resolve(repoRoot, args.output ?? 'artifacts/footprint.json');
  const baselinePath = path.resolve(repoRoot, args.baseline ?? 'docs/baselines/2026-09-02-footprint.json');
  const vsixPath = path.resolve(repoRoot, args.vsix ?? 'artifacts/reqit-footprint.vsix');

  await assertBuildArtifactExists(path.resolve(repoRoot, 'dist/extension.js'));
  await mkdir(path.dirname(vsixPath), { recursive: true });

  const packageCmd = ['--yes', `@vscode/vsce@${VSCE_VERSION}`, 'package', '--no-dependencies', '--out', vsixPath];
  run('npx', packageCmd);

  const vsixStat = await stat(vsixPath);
  const unzipListOutput = run('unzip', ['-l', vsixPath]);
  const vsixEntries = parseUnzipList(unzipListOutput);
  validateParsedVsixEntries(vsixEntries);

  const packageJson = JSON.parse(await readFile(path.resolve(repoRoot, 'package.json'), 'utf8'));
  const directRuntimeDependencies = countDirectRuntimeDependencies(packageJson);
  const productionTreeRaw = run('npm', ['ls', '--omit=dev', '--all', '--json']);
  const productionTree = JSON.parse(productionTreeRaw);
  const productionDependencyNodes = collectProductionNodes(productionTree).size;

  const measurements = {
    compressedVsixBytes: vsixStat.size,
    installedVsixContentBytes: sumEntryBytes(vsixEntries, (entry) => entry.path.startsWith('extension/')),
    extensionJsBytes: sumEntryBytes(
      vsixEntries,
      (entry) => entry.path.startsWith('extension/') && entry.path.endsWith('.js'),
    ),
    sourceMapsInReleaseBytes: sumEntryBytes(vsixEntries, (entry) => entry.path.endsWith('.map')),
    directRuntimeDependencies,
    productionDependencyNodes,
  };

  const baselineJson = JSON.parse(await readFile(baselinePath, 'utf8'));
  const baseline = toBaselineMeasurements(baselineJson);

  const gateModule = await loadFootprintGateModule(path.resolve(repoRoot, 'src/core/footprintGate.ts'));
  const report = gateModule.evaluateFootprintBudgets({
    current: measurements,
    baseline,
    budgets: gateModule.DEFAULT_FOOTPRINT_BUDGETS,
    regressionPercentLimit: 10,
  });

  const remoteUrl = runOptional('git', ['remote', 'get-url', 'origin'])?.trim() ?? null;
  const commitSha = runOptional('git', ['rev-parse', 'HEAD'])?.trim() ?? null;
  const dirtyStatus = runOptional('git', ['status', '--porcelain']);

  const relVsixPath = path.relative(repoRoot, vsixPath);

  const output = {
    schemaVersion: 1,
    measuredAtUtc: new Date().toISOString(),
    source: {
      repository: remoteUrl,
      commit: commitSha,
      dirty: dirtyStatus === null ? null : dirtyStatus.trim().length > 0,
    },
    environment: {
      os: process.platform,
      architecture: process.arch,
      nodeVersion: process.version,
      npmVersion: run('npm', ['--version']).trim(),
      vsceVersion: VSCE_VERSION,
    },
    commands: [
      'npm run build',
      `npx --yes @vscode/vsce@${VSCE_VERSION} package --no-dependencies --out ${relVsixPath}`,
      `unzip -l ${relVsixPath}`,
      'npm ls --omit=dev --all --json',
    ],
    baseline: {
      path: path.relative(repoRoot, baselinePath),
      commit: baselineJson?.source?.commit ?? null,
    },
    measurements,
    budgets: gateModule.DEFAULT_FOOTPRINT_BUDGETS,
    evaluation: report,
    rawEvidence: {
      runtimeDependencyNames: runtimeDependencyNames(packageJson),
      productionDependencyNodes: Array.from(collectProductionNodes(productionTree)).sort(),
      vsixEntries,
    },
  };

  await mkdir(path.dirname(outputPath), { recursive: true });
  await writeFile(outputPath, `${JSON.stringify(output, null, 2)}\n`, 'utf8');

  printSummary(report, outputPath);
  if (!report.ok) {
    process.exitCode = 1;
  }
}

function parseArgs(argv) {
  const args = {};
  for (let i = 0; i < argv.length; i += 1) {
    const token = argv[i];
    if (token === '--output') {
      args.output = argv[i + 1];
      i += 1;
    } else if (token === '--baseline') {
      args.baseline = argv[i + 1];
      i += 1;
    } else if (token === '--vsix') {
      args.vsix = argv[i + 1];
      i += 1;
    } else {
      throw new Error(`Unknown argument: ${token}`);
    }
  }
  return args;
}

async function loadFootprintGateModule(tsPath) {
  const source = await readFile(tsPath, 'utf8');
  const transformed = await transform(source, {
    loader: 'ts',
    format: 'esm',
    target: 'es2022',
    sourcefile: tsPath,
  });
  const url = `data:text/javascript;base64,${Buffer.from(transformed.code).toString('base64')}`;
  return import(url);
}

function runtimeDependencyNames(pkg) {
  const names = new Set([
    ...Object.keys(pkg.dependencies ?? {}),
    ...Object.keys(pkg.optionalDependencies ?? {}),
  ]);
  return Array.from(names).sort();
}

function countDirectRuntimeDependencies(pkg) {
  return runtimeDependencyNames(pkg).length;
}

function collectProductionNodes(tree) {
  const nodes = new Set();
  walkDependencies(tree?.dependencies ?? {}, nodes);
  return nodes;
}

function walkDependencies(dependencies, out) {
  for (const [name, dep] of Object.entries(dependencies ?? {})) {
    if (!dep || typeof dep !== 'object') {
      continue;
    }
    const version = typeof dep.version === 'string' ? dep.version : null;
    if (version) {
      out.add(`${name}@${version}`);
    }
    walkDependencies(dep.dependencies ?? {}, out);
  }
}

async function assertBuildArtifactExists(filePath) {
  try {
    await stat(filePath);
  } catch {
    throw new Error(`Missing build artifact at ${filePath}; run \"npm run build\" before footprint gating.`);
  }
}

function toBaselineMeasurements(baselineJson) {
  const measurements = baselineJson?.measurements ?? {};
  const sourceMapsFromEntries = Array.isArray(baselineJson?.rawEvidence?.vsixEntries)
    ? sumEntryBytes(baselineJson.rawEvidence.vsixEntries, (entry) =>
        typeof entry.path === 'string' && entry.path.endsWith('.map'),
      )
    : null;

  return {
    compressedVsixBytes: numberOrNull(measurements.vsixBytes),
    installedVsixContentBytes: numberOrNull(measurements.installedVsixContentBytes),
    extensionJsBytes: numberOrNull(measurements.extensionBundleBytes),
    sourceMapsInReleaseBytes:
      sourceMapsFromEntries ??
      (measurements.vsixContainsSourceMap === false ? 0 : numberOrNull(measurements.extensionSourceMapBytes)),
    directRuntimeDependencies: numberOrNull(measurements.directRuntimeDependencies),
    productionDependencyNodes: numberOrNull(measurements.productionDependencyNodesExcludingRoot),
  };
}

function numberOrNull(value) {
  return typeof value === 'number' && Number.isFinite(value) && value >= 0 ? value : null;
}

export function parseUnzipList(stdout) {
  const entries = [];
  for (const line of stdout.split(/\r?\n/)) {
    const match = line.match(
      /^\s*(\d+)\s+(?:\d{2}-\d{2}-\d{4}|\d{4}-\d{2}-\d{2})\s+\d{2}:\d{2}\s+(.+)$/,
    );
    if (!match) {
      continue;
    }
    entries.push({
      uncompressedBytes: Number(match[1]),
      path: match[2].trim(),
    });
  }
  return entries;
}

export function validateParsedVsixEntries(entries) {
  if (!Array.isArray(entries) || entries.length === 0) {
    throw new Error('Could not parse VSIX entries from unzip output; refusing to evaluate footprint budgets.');
  }

  const hasPackageJson = entries.some((entry) => entry.path === 'extension/package.json');
  const hasExtensionJs = entries.some(
    (entry) => entry.path === 'extension/dist/extension.js' || entry.path.endsWith('/dist/extension.js'),
  );

  if (!hasPackageJson || !hasExtensionJs) {
    throw new Error(
      'Parsed VSIX entries are missing required release files (extension/package.json and extension/dist/extension.js); refusing fail-open budget evaluation.',
    );
  }
}

function sumEntryBytes(entries, predicate) {
  return entries
    .filter(predicate)
    .reduce((total, entry) => total + Number(entry.uncompressedBytes ?? 0), 0);
}

function printSummary(report, outputPath) {
  console.log(`footprint report: ${outputPath}`);
  for (const result of report.results) {
    const baselineText = result.baseline === null ? 'unmeasured' : String(result.baseline);
    const regressionText =
      result.regressionPercent === null ? 'n/a' : `${result.regressionPercent.toFixed(2)}%`;
    console.log(
      `${result.status.toUpperCase()} ${result.metric}: current=${result.current} baseline=${baselineText} budget=${result.budget} regression=${regressionText}`,
    );
  }

  if (!report.ok) {
    console.error('footprint gate failed:');
    for (const failure of report.failures) {
      console.error(
        ` - ${failure.metric}: ${failure.reason} (current=${failure.current}, baseline=${failure.baseline ?? 'unmeasured'}, budget=${failure.budget})`,
      );
    }
  }
}

function runOptional(command, args) {
  const result = spawnSync(command, args, {
    encoding: 'utf8',
    stdio: ['ignore', 'pipe', 'pipe'],
    env: process.env,
  });

  if (result.status !== 0) {
    return null;
  }

  return result.stdout ?? '';
}

function run(command, args) {
  const result = spawnSync(command, args, {
    encoding: 'utf8',
    stdio: ['ignore', 'pipe', 'pipe'],
    env: process.env,
  });

  if (result.status !== 0) {
    const stderr = (result.stderr ?? '').trim();
    const stdout = (result.stdout ?? '').trim();
    throw new Error(
      `Command failed: ${command} ${args.join(' ')}\n${stderr || stdout || `exit ${String(result.status)}`}`,
    );
  }

  return result.stdout ?? '';
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  main().catch((error) => {
    const message = error instanceof Error ? error.stack ?? error.message : String(error);
    console.error(message);
    process.exit(1);
  });
}
