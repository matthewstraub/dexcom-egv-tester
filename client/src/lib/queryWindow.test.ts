import { describe, expect, it } from "vitest";
import { lastHoursWindow } from "./queryWindow";

describe("lastHoursWindow", () => {
  const now = Date.UTC(2026, 9, 14, 22, 52, 37, 512);

  it("ends at the start of the current minute", () => {
    expect(lastHoursWindow(24, now).end.toISOString()).toBe("2026-10-14T22:52:00.000Z");
  });

  it("covers exactly the requested hours, 24 by default", () => {
    const { start, end } = lastHoursWindow(undefined, now);
    expect(end.getTime() - start.getTime()).toBe(24 * 3_600_000);
    expect(start.toISOString()).toBe("2026-10-13T22:52:00.000Z");
  });
});
