/**
 * Split a date range into chunks of at most `maxDays` days.
 *
 * The Health Correlations view fetches EGV data in 7-day chunks rather than one
 * request: Dexcom caps a single query at 30 days, and Render's free tier has a
 * ~30s request timeout that a wide range would blow through.
 *
 * Inputs are treated as UTC — a value without a trailing `Z` gets one — and
 * outputs are ISO 8601 without the `Z`, which is the form the Dexcom API wants.
 */
export function splitDateRange(
  startISO: string,
  endISO: string,
  maxDays: number = 7
): Array<{ start: string; end: string }> {
  const chunks: Array<{ start: string; end: string }> = [];
  const startMs = new Date(startISO + (startISO.endsWith("Z") ? "" : "Z")).getTime();
  const endMs = new Date(endISO + (endISO.endsWith("Z") ? "" : "Z")).getTime();
  const chunkMs = maxDays * 24 * 60 * 60 * 1000;

  let cursor = startMs;
  while (cursor < endMs) {
    const chunkEnd = Math.min(cursor + chunkMs, endMs);
    // Format as ISO 8601 without Z (Dexcom expects this)
    const startStr = new Date(cursor).toISOString().slice(0, 19);
    const endStr = new Date(chunkEnd).toISOString().slice(0, 19);
    chunks.push({ start: startStr, end: endStr });
    cursor = chunkEnd;
  }
  return chunks;
}
