import { describe, expect, it } from 'vitest';

import {
  DEFAULT_FOOTPRINT_BUDGETS,
  evaluateFootprintBudgets,
  type FootprintMeasurements,
} from '../src/core/footprintGate';

describe('evaluateFootprintBudgets', () => {
  it('passes when metrics are under hard ceilings and baseline regression thresholds', () => {
    const current: FootprintMeasurements = {
      compressedVsixBytes: 900_000,
      installedVsixContentBytes: 3_700_000,
      extensionJsBytes: 1_300_000,
      sourceMapsInReleaseBytes: 0,
      directRuntimeDependencies: 5,
      productionDependencyNodes: 9,
    };

    const baseline: FootprintMeasurements = {
      compressedVsixBytes: 950_000,
      installedVsixContentBytes: 3_800_000,
      extensionJsBytes: 1_320_000,
      sourceMapsInReleaseBytes: 0,
      directRuntimeDependencies: 5,
      productionDependencyNodes: 10,
    };

    const report = evaluateFootprintBudgets({
      current,
      baseline,
      budgets: DEFAULT_FOOTPRINT_BUDGETS,
      regressionPercentLimit: 10,
    });

    expect(report.ok).toBe(true);
    expect(report.failures).toEqual([]);
  });

  it('fails when release source maps are present because the hard ceiling is zero bytes', () => {
    const current: FootprintMeasurements = {
      compressedVsixBytes: 900_000,
      installedVsixContentBytes: 3_700_000,
      extensionJsBytes: 1_300_000,
      sourceMapsInReleaseBytes: 1,
      directRuntimeDependencies: 5,
      productionDependencyNodes: 9,
    };

    const baseline: FootprintMeasurements = {
      compressedVsixBytes: 900_000,
      installedVsixContentBytes: 3_700_000,
      extensionJsBytes: 1_300_000,
      sourceMapsInReleaseBytes: 0,
      directRuntimeDependencies: 5,
      productionDependencyNodes: 9,
    };

    const report = evaluateFootprintBudgets({
      current,
      baseline,
      budgets: DEFAULT_FOOTPRINT_BUDGETS,
      regressionPercentLimit: 10,
    });

    expect(report.ok).toBe(false);
    expect(report.failures.some((f) => f.metric === 'sourceMapsInReleaseBytes')).toBe(true);
    expect(report.failures.some((f) => f.reason === 'hard-ceiling')).toBe(true);
  });

  it('fails when a metric grows by more than the configured regression threshold', () => {
    const current: FootprintMeasurements = {
      compressedVsixBytes: 1_200_000,
      installedVsixContentBytes: 3_700_000,
      extensionJsBytes: 1_300_000,
      sourceMapsInReleaseBytes: 0,
      directRuntimeDependencies: 5,
      productionDependencyNodes: 9,
    };

    const baseline: FootprintMeasurements = {
      compressedVsixBytes: 1_000_000,
      installedVsixContentBytes: 3_700_000,
      extensionJsBytes: 1_300_000,
      sourceMapsInReleaseBytes: 0,
      directRuntimeDependencies: 5,
      productionDependencyNodes: 9,
    };

    const report = evaluateFootprintBudgets({
      current,
      baseline,
      budgets: DEFAULT_FOOTPRINT_BUDGETS,
      regressionPercentLimit: 10,
    });

    expect(report.ok).toBe(false);
    expect(report.failures.some((f) => f.metric === 'compressedVsixBytes' && f.reason === 'baseline-regression')).toBe(true);
  });
});
