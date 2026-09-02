import { type AppleHealthMetricKey } from "@shared/const";

/**
 * Aggregated health data for a time bucket (15-minute windows).
 *
 * Buckets are produced in the browser by client/src/workers/appleHealthWorker.ts
 * and persisted via the appleHealth.saveBucketBatch mutation. The server only
 * reads them back to compute correlations, so this type describes the stored
 * shape rather than anything the server builds itself.
 */
export interface AggregatedBucket {
  bucketStart: string; // ISO string
  bucketEnd: string;
  metrics: Partial<
    Record<
      AppleHealthMetricKey,
      { avg: number; min: number; max: number; sum: number; count: number }
    >
  >;
}

/**
 * Calculate Pearson correlation coefficient between two arrays.
 */
export function pearsonCorrelation(x: number[], y: number[]): number {
  const n = Math.min(x.length, y.length);
  if (n < 3) return 0;

  const xSlice = x.slice(0, n);
  const ySlice = y.slice(0, n);

  const xMean = xSlice.reduce((a, b) => a + b, 0) / n;
  const yMean = ySlice.reduce((a, b) => a + b, 0) / n;

  let numerator = 0;
  let xDenomSq = 0;
  let yDenomSq = 0;

  for (let i = 0; i < n; i++) {
    const xDiff = xSlice[i] - xMean;
    const yDiff = ySlice[i] - yMean;
    numerator += xDiff * yDiff;
    xDenomSq += xDiff * xDiff;
    yDenomSq += yDiff * yDiff;
  }

  const denominator = Math.sqrt(xDenomSq * yDenomSq);
  if (denominator === 0) return 0;

  return numerator / denominator;
}
