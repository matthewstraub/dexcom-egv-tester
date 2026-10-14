/**
 * Layout helpers for the EGV chart: its vertical range and tick labels, and
 * how its two series animate in.
 */

export interface ChartRange {
  min: number;
  max: number;
}

/**
 * The configured range, widened to fit any reading outside it. A reading is
 * never clipped just because an admin chose a tight range.
 */
export function yAxisDomain(range: ChartRange, values: number[]): [number, number] {
  let lo = range.min;
  let hi = range.max;
  for (const v of values) {
    if (v < lo) lo = v;
    if (v > hi) hi = v;
  }
  return [lo, hi];
}

/** Round-number ticks inside [lo, hi]: every 25, 50 or 100 mg/dL depending on the span. */
export function yAxisTicks(lo: number, hi: number): number[] {
  const span = hi - lo;
  const step = span <= 150 ? 25 : span <= 400 ? 50 : 100;
  const ticks: number[] = [];
  for (let t = Math.ceil(lo / step) * step; t <= hi; t += step) ticks.push(t);
  return ticks;
}

/** How long the chart takes to draw in, end to end. */
export const DRAW_MS = 1500;

export interface SeriesAnimation {
  begin: number;
  duration: number;
  easing: "ease" | "linear";
}

/**
 * Animate the solid official line and the dashed live tail as one stroke,
 * left to right. Recharts animates each series along its own path at the same
 * time, so left alone the short live tail at the right edge finishes drawing
 * while the official line is still crossing the chart. Instead the official
 * line takes its share of the time, and the live tail starts where it ends.
 */
export function drawTimings(
  points: Array<{ time: number; value: number | null; liveValue: number | null }>
): { official: SeriesAnimation; live: SeriesAnimation } {
  const whole: SeriesAnimation = { begin: 0, duration: DRAW_MS, easing: "ease" };
  const official = points.filter((p) => p.value !== null);
  const live = points.filter((p) => p.liveValue !== null);
  if (official.length === 0 || live.length === 0) return { official: whole, live: whole };

  const first = points[0]!.time;
  const span = points[points.length - 1]!.time - first;
  const share = span > 0 ? (official[official.length - 1]!.time - first) / span : 1;
  const officialMs = Math.min(DRAW_MS - 150, Math.max(300, Math.round(DRAW_MS * share)));
  return {
    official: { begin: 0, duration: officialMs, easing: "linear" },
    live: { begin: officialMs, duration: DRAW_MS - officialMs, easing: "linear" },
  };
}
