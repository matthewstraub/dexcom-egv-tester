import { parseUtc } from "./glucose";

/**
 * Splice live Dexcom Share readings onto the end of official EGV records.
 *
 * The official API runs about an hour behind; Share covers the last 24 hours
 * with no delay. Only live readings clearly newer than the last official
 * reading are appended, so nothing is ever duplicated or overwritten.
 *
 * Before splicing, a consistency guard compares the two sources wherever
 * they overlap. Share signs in with its own credentials, separate from the
 * OAuth connection, so a misconfiguration could otherwise stitch two
 * different people's glucose onto one chart. If overlapping readings
 * disagree, nothing is merged.
 */

export interface MergeableRecord {
  systemTime: string;
  value: number | null;
  source?: "official" | "share";
}

export type MergeStatus =
  /** Live readings were appended. */
  | "merged"
  /** Live data was available, but none fell after the official data in this window. */
  | "nothing-to-add"
  /** Overlapping readings disagreed, so nothing was merged. */
  | "mismatch"
  /** Merging doesn't apply (sandbox, or no live data). */
  | "skipped";

export interface MergeResult<T> {
  records: Array<T & { source: "official" | "share" }>;
  liveCount: number;
  status: MergeStatus;
  /** Official/live pairs found in the overlap, and their median disagreement. */
  overlapPairs: number;
  medianDiff: number | null;
}

/** Readings within this of each other count as the same moment. Share reads every 5 min. */
export const PAIR_WINDOW_MS = 150_000;
/** Pairs needed before the guard trusts its verdict. */
export const MIN_PAIRS = 3;
/** The same reading from both sources should match; allow a little rounding. */
export const MAX_MEDIAN_DIFF = 3;
/**
 * A window that ended this close to when it was fetched counts as "up to now":
 * it stays open, so new live readings keep arriving for as long as the page is
 * open. Judged against the fetch time rather than the clock, so live readings
 * don't vanish from an open page once it has been up for a while.
 */
export const OPEN_ENDED_WITHIN_MS = 15 * 60_000;

function median(values: number[]): number {
  const sorted = [...values].sort((a, b) => a - b);
  const mid = Math.floor(sorted.length / 2);
  return sorted.length % 2 ? sorted[mid]! : (sorted[mid - 1]! + sorted[mid]!) / 2;
}

export function mergeLiveReadings<T extends MergeableRecord>(
  official: T[],
  live: T[],
  {
    start,
    end,
    enabled,
    queriedAt,
  }: {
    /** The query window, as sent to the API (UTC, with or without "Z"). */
    start: string;
    end: string;
    /** False outside Production: live data is real and must never touch sandbox data. */
    enabled: boolean;
    /** When the official records were fetched (epoch ms). */
    queriedAt: number;
  }
): MergeResult<T> {
  const tagged = official.map((r) => ({ ...r, source: r.source ?? ("official" as const) }));
  const unchanged = (status: MergeStatus, overlapPairs = 0, medianDiff: number | null = null): MergeResult<T> => ({
    records: tagged,
    liveCount: 0,
    status,
    overlapPairs,
    medianDiff,
  });

  if (!enabled || live.length === 0) return unchanged("skipped");

  const startMs = parseUtc(start);
  const endMs = parseUtc(end);
  if (!Number.isFinite(startMs) || !Number.isFinite(endMs)) return unchanged("skipped");
  const upperMs = endMs >= queriedAt - OPEN_ENDED_WITHIN_MS ? Infinity : endMs;

  const officialTimed = tagged
    .map((r) => ({ r, t: parseUtc(r.systemTime) }))
    .filter((x) => Number.isFinite(x.t) && x.r.value !== null);
  const lastOfficialMs = officialTimed.reduce((max, x) => Math.max(max, x.t), -Infinity);
  // The two sources can stamp the same reading a few seconds apart, so the
  // seam between them is a pairing window wide, not a single instant. Without
  // this, the twin of the last official reading would be appended as new.
  const seamMs = lastOfficialMs + PAIR_WINDOW_MS;

  // ── consistency guard: compare wherever both sources have a reading ──
  const diffs: number[] = [];
  for (const l of live) {
    const t = parseUtc(l.systemTime);
    if (l.value === null || !(t >= startMs && t <= seamMs)) continue;
    let nearest: { gap: number; value: number } | null = null;
    for (const o of officialTimed) {
      const gap = Math.abs(o.t - t);
      if (gap <= PAIR_WINDOW_MS && (!nearest || gap < nearest.gap)) nearest = { gap, value: o.r.value! };
    }
    if (nearest) diffs.push(Math.abs(nearest.value - l.value));
  }
  const medianDiff = diffs.length > 0 ? median(diffs) : null;
  if (diffs.length >= MIN_PAIRS && medianDiff! > MAX_MEDIAN_DIFF) {
    return unchanged("mismatch", diffs.length, medianDiff);
  }

  // ── append only what comes after the official data, inside the window ──
  const additions = live
    .map((l) => ({ l, t: parseUtc(l.systemTime) }))
    .filter(({ l, t }) => l.value !== null && t > seamMs && t >= startMs && t <= upperMs)
    .sort((a, b) => a.t - b.t)
    .map(({ l }) => ({ ...l, source: "share" as const }));

  if (additions.length === 0) {
    return { records: tagged, liveCount: 0, status: "nothing-to-add", overlapPairs: diffs.length, medianDiff };
  }

  const records = [...tagged, ...additions].sort((a, b) => parseUtc(a.systemTime) - parseUtc(b.systemTime));
  return { records, liveCount: additions.length, status: "merged", overlapPairs: diffs.length, medianDiff };
}
