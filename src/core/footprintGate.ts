export interface FootprintMeasurements {
  compressedVsixBytes: number;
  installedVsixContentBytes: number;
  extensionJsBytes: number;
  sourceMapsInReleaseBytes: number;
  directRuntimeDependencies: number;
  productionDependencyNodes: number;
}

export type FootprintMetric = keyof FootprintMeasurements;

export const DEFAULT_FOOTPRINT_BUDGETS: Readonly<Record<FootprintMetric, number>> = {
  compressedVsixBytes: 2 * 1024 * 1024,
  installedVsixContentBytes: 6 * 1024 * 1024,
  extensionJsBytes: 2 * 1024 * 1024,
  sourceMapsInReleaseBytes: 0,
  directRuntimeDependencies: 8,
  productionDependencyNodes: 25,
};

export type FootprintFailureReason =
  | 'hard-ceiling'
  | 'baseline-regression'
  | 'baseline-zero-regression';

export interface FootprintFailure {
  metric: FootprintMetric;
  reason: FootprintFailureReason;
  current: number;
  baseline: number | null;
  budget: number;
  regressionPercent: number | null;
  regressionPercentLimit: number;
}

export interface FootprintMetricResult {
  metric: FootprintMetric;
  current: number;
  baseline: number | null;
  budget: number;
  regressionPercent: number | null;
  status: 'pass' | 'fail' | 'baseline-unmeasured';
  reason: FootprintFailureReason | null;
}

export interface FootprintBudgetReport {
  ok: boolean;
  results: FootprintMetricResult[];
  failures: FootprintFailure[];
}

export interface EvaluateFootprintBudgetsOptions {
  current: FootprintMeasurements;
  baseline?: Partial<Record<FootprintMetric, number | null>>;
  budgets?: Partial<Record<FootprintMetric, number>>;
  regressionPercentLimit?: number;
}

const METRICS: readonly FootprintMetric[] = [
  'compressedVsixBytes',
  'installedVsixContentBytes',
  'extensionJsBytes',
  'sourceMapsInReleaseBytes',
  'directRuntimeDependencies',
  'productionDependencyNodes',
];

export function evaluateFootprintBudgets(opts: EvaluateFootprintBudgetsOptions): FootprintBudgetReport {
  const budgets: Record<FootprintMetric, number> = {
    ...DEFAULT_FOOTPRINT_BUDGETS,
    ...(opts.budgets ?? {}),
  };
  const baseline = opts.baseline ?? {};
  const regressionPercentLimit = opts.regressionPercentLimit ?? 10;

  const results: FootprintMetricResult[] = [];
  const failures: FootprintFailure[] = [];

  for (const metric of METRICS) {
    const current = toSafeMetricValue(opts.current[metric], metric);
    const budget = toSafeMetricValue(budgets[metric], metric);
    const rawBaseline = baseline[metric];
    const baselineValue = rawBaseline === null || rawBaseline === undefined ? null : toSafeMetricValue(rawBaseline, metric);

    if (current > budget) {
      const failure: FootprintFailure = {
        metric,
        reason: 'hard-ceiling',
        current,
        baseline: baselineValue,
        budget,
        regressionPercent: baselineValue && baselineValue > 0 ? pct(current, baselineValue) : null,
        regressionPercentLimit,
      };
      failures.push(failure);
      results.push({
        metric,
        current,
        baseline: baselineValue,
        budget,
        regressionPercent: failure.regressionPercent,
        status: 'fail',
        reason: failure.reason,
      });
      continue;
    }

    if (baselineValue === null) {
      results.push({
        metric,
        current,
        baseline: null,
        budget,
        regressionPercent: null,
        status: 'baseline-unmeasured',
        reason: null,
      });
      continue;
    }

    if (baselineValue === 0) {
      if (current > 0) {
        const failure: FootprintFailure = {
          metric,
          reason: 'baseline-zero-regression',
          current,
          baseline: baselineValue,
          budget,
          regressionPercent: null,
          regressionPercentLimit,
        };
        failures.push(failure);
        results.push({
          metric,
          current,
          baseline: baselineValue,
          budget,
          regressionPercent: null,
          status: 'fail',
          reason: failure.reason,
        });
      } else {
        results.push({
          metric,
          current,
          baseline: baselineValue,
          budget,
          regressionPercent: 0,
          status: 'pass',
          reason: null,
        });
      }
      continue;
    }

    const regressionPercent = pct(current, baselineValue);
    if (regressionPercent > regressionPercentLimit) {
      const failure: FootprintFailure = {
        metric,
        reason: 'baseline-regression',
        current,
        baseline: baselineValue,
        budget,
        regressionPercent,
        regressionPercentLimit,
      };
      failures.push(failure);
      results.push({
        metric,
        current,
        baseline: baselineValue,
        budget,
        regressionPercent,
        status: 'fail',
        reason: failure.reason,
      });
      continue;
    }

    results.push({
      metric,
      current,
      baseline: baselineValue,
      budget,
      regressionPercent,
      status: 'pass',
      reason: null,
    });
  }

  return {
    ok: failures.length === 0,
    results,
    failures,
  };
}

function toSafeMetricValue(value: number, metric: string): number {
  if (!Number.isFinite(value) || value < 0) {
    throw new Error(`Metric ${metric} must be a finite non-negative number; got ${value}`);
  }
  return value;
}

function pct(current: number, baseline: number): number {
  return ((current - baseline) / baseline) * 100;
}
