// The bug this guards against only shows when the machine isn't on UTC, so
// pin a zone that isn't before anything reads the clock.
process.env.TZ = "America/New_York";

import { describe, expect, it } from "vitest";
import { chartHeaderText, type ChartExportMeta } from "./export";

const meta: ChartExportMeta = {
  // As the date inputs produce them: UTC, with no "Z".
  startDate: "2026-10-13T00:41:00",
  endDate: "2026-10-14T00:41:00",
  timezone: "utc",
  avgGlucose: 132.4,
  recordCount: 288,
  liveCount: 12,
  env: "production",
};

describe("chartHeaderText", () => {
  it("runs somewhere the bug would show", () => {
    // A bare ISO date-time is local time to JavaScript; here, that's not UTC.
    expect(new Date("2026-10-13T00:41:00").toISOString()).not.toBe("2026-10-13T00:41:00.000Z");
  });

  it("prints the window in UTC exactly as queried", () => {
    expect(chartHeaderText(meta).window).toBe("2026-10-13 00:41:00.000 UTC  →  2026-10-14 00:41:00.000 UTC");
  });

  it("prints the same moments in local time in local mode", () => {
    const { window } = chartHeaderText({ ...meta, timezone: "local" });
    // 00:41 UTC is 8:41 PM the evening before in New York (EDT, UTC-4).
    expect(window).toMatch(/10\/12\/2026, 08:41:00\sPM .* 10\/13\/2026, 08:41:00\sPM/);
  });

  it("summarises the span, counts and environment", () => {
    const text = chartHeaderText(meta);
    expect(text.stats).toBe("Range: 1.0 days  ·  288 records (12 live)  ·  Production");
    expect(text.avg).toBe("Avg: 132 mg/dL");
    expect(text.title).toBe("Glucose Timeline (UTC)");
    expect(chartHeaderText({ ...meta, endDate: "2026-10-13T03:41:00", liveCount: 0, avgGlucose: null }).stats).toBe(
      "Range: 3.0 hours  ·  288 records  ·  Production"
    );
  });
});
