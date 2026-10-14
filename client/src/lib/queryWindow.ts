/** The default EGV query: the last 24 hours, ending at the current minute. */
export const DEFAULT_WINDOW_HOURS = 24;

/**
 * The window of the last `hours` hours, ending at the start of the current
 * minute so the date inputs show round times. Readings newer than the end
 * still appear: a window that ends near when it's fetched stays open (see
 * mergeLiveReadings).
 */
export function lastHoursWindow(hours = DEFAULT_WINDOW_HOURS, now = Date.now()): { start: Date; end: Date } {
  const end = Math.floor(now / 60_000) * 60_000;
  return { start: new Date(end - hours * 3_600_000), end: new Date(end) };
}
