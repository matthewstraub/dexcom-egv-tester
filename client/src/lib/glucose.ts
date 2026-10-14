/** Shared glucose display helpers, used by the chart and the live card. */

export const TREND_ARROWS: Record<string, string> = {
  doubleUp: "⬆⬆",
  singleUp: "⬆",
  fortyFiveUp: "↗",
  flat: "→",
  fortyFiveDown: "↘",
  singleDown: "⬇",
  doubleDown: "⬇⬇",
  none: "",
  notComputable: "?",
  rateOutOfRange: "!",
};

/**
 * Colour bands for a reading: red below 80 mg/dL (low and urgent low alike, as
 * on the average badge), green 80–180, amber 181–250, red above 250.
 */
export function getGlucoseColor(value: number | null): string {
  if (value === null) return "oklch(0.58 0.02 264)";
  if (value < 80) return "oklch(0.65 0.25 25)"; // low or urgent low - red
  if (value <= 180) return "oklch(0.72 0.15 145)"; // in range - green
  if (value <= 250) return "oklch(0.75 0.15 60)"; // high - amber
  return "oklch(0.65 0.25 25)"; // very high - red
}

/**
 * Parse a timestamp as UTC. The official API's systemTime ends in "Z", but the
 * query window built from the date inputs does not ("2026-10-12T17:40:00"),
 * and JavaScript would read that as local time.
 */
export function parseUtc(value: string): number {
  return Date.parse(/(Z|[+-]\d{2}:?\d{2})$/.test(value) ? value : `${value}Z`);
}
