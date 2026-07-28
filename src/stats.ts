/**
 * Percentile / summary statistics over a set of latency-delta samples.
 *
 * No fabricated or example numbers live in this file — it only computes
 * whatever values a real run produced. Percentiles use linear interpolation
 * between closest ranks (the common "R-7" / Excel-style method), which is a
 * reasonable, widely understood default for latency reporting.
 */

export interface SummaryStats {
  count: number;
  min: number;
  max: number;
  mean: number;
  p50: number;
  p90: number;
  p95: number;
  p99: number;
  stddev: number;
}

/**
 * Linear-interpolation percentile over an already-sorted ascending array.
 * `p` is in the 0..100 range.
 */
export function percentile(sortedAsc: number[], p: number): number {
  if (sortedAsc.length === 0) {
    throw new Error("percentile() called on an empty sample set");
  }
  if (p <= 0) return sortedAsc[0]!;
  if (p >= 100) return sortedAsc[sortedAsc.length - 1]!;

  const rank = (p / 100) * (sortedAsc.length - 1);
  const lowerIndex = Math.floor(rank);
  const upperIndex = Math.ceil(rank);
  const lower = sortedAsc[lowerIndex]!;
  const upper = sortedAsc[upperIndex]!;
  if (lowerIndex === upperIndex) return lower;

  const fraction = rank - lowerIndex;
  return lower + (upper - lower) * fraction;
}

export function summarize(values: number[]): SummaryStats | null {
  if (values.length === 0) return null;

  const sorted = [...values].sort((a, b) => a - b);
  const count = sorted.length;
  const sum = sorted.reduce((acc, v) => acc + v, 0);
  const mean = sum / count;
  const variance =
    sorted.reduce((acc, v) => acc + (v - mean) ** 2, 0) / count;

  return {
    count,
    min: sorted[0]!,
    max: sorted[count - 1]!,
    mean,
    p50: percentile(sorted, 50),
    p90: percentile(sorted, 90),
    p95: percentile(sorted, 95),
    p99: percentile(sorted, 99),
    stddev: Math.sqrt(variance),
  };
}

export function formatMs(value: number): string {
  return `${value.toFixed(1)}ms`;
}
