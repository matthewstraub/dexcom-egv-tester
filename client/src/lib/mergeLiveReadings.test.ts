import { describe, expect, it } from "vitest";
import { mergeLiveReadings, OPEN_ENDED_WITHIN_MS } from "./mergeLiveReadings";

const MIN = 60_000;
// 2026-10-12 17:00:00 UTC
const T0 = Date.UTC(2026, 9, 12, 17, 0, 0);
const iso = (ms: number) => new Date(ms).toISOString();
/** The query window format the date inputs produce: UTC without a "Z". */
const windowStr = (ms: number) => iso(ms).slice(0, 19);

const official = (minute: number, value: number) => ({ systemTime: iso(T0 + minute * MIN), value });
const live = (minute: number, value: number) => ({ systemTime: iso(T0 + minute * MIN), value, source: "share" as const });

/** Official data every 5 min for minutes 0..120; live mirrors it and runs on to 180. */
function scenario({ liveOffset = 0 } = {}) {
  const off = Array.from({ length: 25 }, (_, i) => official(i * 5, 100 + i));
  const liv = Array.from({ length: 37 }, (_, i) => live(i * 5, 100 + i + liveOffset));
  return { off, liv };
}

const window3h = { start: windowStr(T0), end: windowStr(T0 + 180 * MIN), enabled: true, queriedAt: T0 + 180 * MIN };

describe("mergeLiveReadings", () => {
  it("appends only live readings newer than the last official one", () => {
    const { off, liv } = scenario();
    const result = mergeLiveReadings(off, liv, window3h);
    expect(result.status).toBe("merged");
    expect(result.liveCount).toBe(12); // minutes 125..180
    const liveTimes = result.records.filter((r) => r.source === "share").map((r) => r.systemTime);
    expect(liveTimes[0]).toBe(iso(T0 + 125 * MIN));
    expect(liveTimes.at(-1)).toBe(iso(T0 + 180 * MIN));
  });

  it("never duplicates or replaces an official reading", () => {
    const { off, liv } = scenario();
    const result = mergeLiveReadings(off, liv, window3h);
    const times = result.records.map((r) => r.systemTime);
    expect(new Set(times).size).toBe(times.length);
    expect(result.records.filter((r) => r.source === "official")).toHaveLength(off.length);
  });

  it("returns records in chronological order, tagged by source", () => {
    const { off, liv } = scenario();
    const { records } = mergeLiveReadings([...off].reverse(), liv, window3h);
    const ms = records.map((r) => Date.parse(r.systemTime));
    expect(ms).toEqual([...ms].sort((a, b) => a - b));
    expect(records.every((r) => r.source === "official" || r.source === "share")).toBe(true);
  });

  it("reports how well the overlap agreed", () => {
    const { off, liv } = scenario();
    const result = mergeLiveReadings(off, liv, window3h);
    expect(result.overlapPairs).toBe(25);
    expect(result.medianDiff).toBe(0);
  });

  it("refuses to merge when the overlap disagrees — e.g. two different accounts", () => {
    const { off, liv } = scenario({ liveOffset: 40 });
    const result = mergeLiveReadings(off, liv, window3h);
    expect(result.status).toBe("mismatch");
    expect(result.liveCount).toBe(0);
    expect(result.records).toHaveLength(off.length);
    expect(result.medianDiff).toBe(40);
  });

  it("tolerates small rounding differences between the sources", () => {
    const { off, liv } = scenario({ liveOffset: 2 });
    expect(mergeLiveReadings(off, liv, window3h).status).toBe("merged");
  });

  it("pairs readings a couple of minutes apart, but not further", () => {
    const off = [official(0, 100), official(5, 100), official(10, 100)];
    const shifted = [live(2, 140), live(7, 140), live(12, 140), live(20, 141)];
    // within ±2.5 min: three disagreeing pairs -> mismatch
    expect(mergeLiveReadings(off, shifted, window3h).status).toBe("mismatch");
    const far = [live(3, 140), live(8, 140), live(13, 140), live(20, 141)];
    // 3 min apart is outside the pairing window -> nothing to compare, so merge
    expect(mergeLiveReadings(off, far, window3h).status).toBe("merged");
  });

  it("doesn't duplicate the boundary reading when Share stamps it a little later", () => {
    const off = [official(0, 100), official(5, 101), official(10, 102)];
    const twin = { systemTime: iso(T0 + 10 * MIN + 20_000), value: 102, source: "share" as const };
    const result = mergeLiveReadings(off, [twin, live(15, 103)], window3h);
    expect(result.liveCount).toBe(1);
    expect(result.records.filter((r) => r.source === "share").map((r) => r.value)).toEqual([103]);
    expect(result.records.filter((r) => r.value === 102)).toHaveLength(1);
  });

  it("merges without a verdict when there's too little overlap to judge", () => {
    const off = [official(0, 100), official(5, 101)];
    const liv = [live(0, 150), live(5, 151), live(10, 152)];
    const result = mergeLiveReadings(off, liv, window3h);
    expect(result.overlapPairs).toBe(2);
    expect(result.status).toBe("merged");
  });

  it("uses live readings alone when the window has no official data yet", () => {
    const liv = [live(170, 120), live(175, 121), live(180, 122)];
    const result = mergeLiveReadings([], liv, window3h);
    expect(result.status).toBe("merged");
    expect(result.liveCount).toBe(3);
  });

  it("keeps a window fetched 'up to now' open, however long the page stays open", () => {
    const off = [official(0, 100)];
    // Past the window end at 180: one reading soon after, one hours later.
    const liv = [live(5, 101), live(190, 102), live(420, 103)];
    const open = mergeLiveReadings(off, liv, { ...window3h, queriedAt: T0 + 185 * MIN });
    expect(open.liveCount).toBe(3);
  });

  it("closes a window that had already ended when it was fetched", () => {
    const off = [official(0, 100)];
    const liv = [live(5, 101), live(190, 102)];
    const closed = mergeLiveReadings(off, liv, { ...window3h, queriedAt: T0 + 180 * MIN + OPEN_ENDED_WITHIN_MS + MIN });
    expect(closed.liveCount).toBe(1);
  });

  it("respects the start of the window", () => {
    const liv = [live(-30, 99), live(10, 101)];
    expect(mergeLiveReadings([], liv, window3h).liveCount).toBe(1);
  });

  it("reads the window as UTC even though it has no 'Z'", () => {
    // If the window were misread as local time it would shift by the UTC offset
    // and drop or admit the wrong readings.
    const liv = [live(0, 100), live(180, 101)];
    expect(mergeLiveReadings([], liv, window3h).liveCount).toBe(2);
  });

  it("never touches data outside Production", () => {
    const { off, liv } = scenario();
    const result = mergeLiveReadings(off, liv, { ...window3h, enabled: false });
    expect(result.status).toBe("skipped");
    expect(result.records).toHaveLength(off.length);
    expect(result.records.every((r) => r.source === "official")).toBe(true);
  });

  it("does nothing when there's no live data", () => {
    const { off } = scenario();
    expect(mergeLiveReadings(off, [], window3h).status).toBe("skipped");
  });

  it("says when live data had nothing newer to add", () => {
    const { off } = scenario();
    const result = mergeLiveReadings(off, [live(60, 112)], window3h);
    expect(result.status).toBe("nothing-to-add");
    expect(result.liveCount).toBe(0);
  });

  it("ignores null values on either side", () => {
    const off = [official(0, 100), { systemTime: iso(T0 + 5 * MIN), value: null }];
    const liv = [live(5, 101), { systemTime: iso(T0 + 10 * MIN), value: null, source: "share" as const }];
    const result = mergeLiveReadings(off, liv, window3h);
    expect(result.liveCount).toBe(1);
  });
});
