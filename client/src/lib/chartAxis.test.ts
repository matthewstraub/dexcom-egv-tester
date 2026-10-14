import { describe, expect, it } from "vitest";
import { DRAW_MS, drawTimings, yAxisDomain, yAxisTicks } from "./chartAxis";

describe("yAxisDomain", () => {
  it("uses the configured range when every reading fits", () => {
    expect(yAxisDomain({ min: 40, max: 350 }, [72, 140, 301])).toEqual([40, 350]);
  });

  it("widens to fit readings outside it rather than clipping them", () => {
    expect(yAxisDomain({ min: 70, max: 300 }, [55, 140, 384])).toEqual([55, 384]);
  });

  it("copes with no readings", () => {
    expect(yAxisDomain({ min: 40, max: 350 }, [])).toEqual([40, 350]);
  });
});

describe("yAxisTicks", () => {
  it("labels the default range every 50", () => {
    expect(yAxisTicks(40, 350)).toEqual([50, 100, 150, 200, 250, 300, 350]);
  });

  it("uses finer steps for a narrow range and coarser ones for a wide one", () => {
    expect(yAxisTicks(60, 200)).toEqual([75, 100, 125, 150, 175, 200]);
    expect(yAxisTicks(0, 500)).toEqual([0, 100, 200, 300, 400, 500]);
  });

  it("never puts a tick outside the range", () => {
    for (const [lo, hi] of [[40, 400], [55, 384], [12, 163]] as const) {
      for (const t of yAxisTicks(lo, hi)) {
        expect(t).toBeGreaterThanOrEqual(lo);
        expect(t).toBeLessThanOrEqual(hi);
      }
    }
  });
});

describe("drawTimings", () => {
  const MIN = 60_000;
  const point = (minute: number, kind: "official" | "live" | "seam") => ({
    time: minute * MIN,
    value: kind === "live" ? null : 100,
    liveValue: kind === "official" ? null : 100,
  });

  it("starts the live tail exactly when the official line finishes", () => {
    // 23 hours official, then an hour of live readings.
    const points = [
      ...Array.from({ length: 276 }, (_, i) => point(i * 5, "official")),
      point(1380, "seam"),
      ...Array.from({ length: 12 }, (_, i) => point(1385 + i * 5, "live")),
    ];
    const { official, live } = drawTimings(points);
    expect(official.begin).toBe(0);
    expect(live.begin).toBe(official.duration);
    expect(official.duration + live.duration).toBe(DRAW_MS);
    // The official line covers most of the chart, so it gets most of the time.
    expect(official.duration).toBeGreaterThan(live.duration * 5);
    expect(official.easing).toBe("linear");
  });

  it("keeps the default animation when there's only one series", () => {
    const officialOnly = [point(0, "official"), point(5, "official")];
    expect(drawTimings(officialOnly).official).toEqual({ begin: 0, duration: DRAW_MS, easing: "ease" });
    const liveOnly = [point(0, "live"), point(5, "live")];
    expect(drawTimings(liveOnly).live).toEqual({ begin: 0, duration: DRAW_MS, easing: "ease" });
  });

  it("gives each series a visible share however lopsided the split", () => {
    const tinyOfficial = [point(0, "official"), point(1, "seam"), point(600, "live")];
    const { official, live } = drawTimings(tinyOfficial);
    expect(official.duration).toBeGreaterThanOrEqual(300);
    expect(live.duration).toBeGreaterThanOrEqual(150);
  });
});
