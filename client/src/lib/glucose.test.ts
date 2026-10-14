import { describe, expect, it } from "vitest";
import { getGlucoseColor, parseUtc } from "./glucose";

const RED = getGlucoseColor(40);
const GREEN = getGlucoseColor(120);
const AMBER = getGlucoseColor(200);

describe("getGlucoseColor", () => {
  it("shows every low in red, urgent or not", () => {
    for (const v of [40, 53, 54, 62, 79]) expect(getGlucoseColor(v)).toBe(RED);
  });

  it("shows 80–180 in green and 181–250 in amber", () => {
    for (const v of [80, 120, 180]) expect(getGlucoseColor(v)).toBe(GREEN);
    for (const v of [181, 212, 250]) expect(getGlucoseColor(v)).toBe(AMBER);
  });

  it("shows very high readings in red", () => {
    expect(getGlucoseColor(251)).toBe(RED);
    expect(getGlucoseColor(400)).toBe(RED);
  });

  it("uses a neutral colour for a missing value", () => {
    const missing = getGlucoseColor(null);
    expect([RED, GREEN, AMBER]).not.toContain(missing);
  });
});

describe("parseUtc", () => {
  it("reads a timestamp with no designator as UTC", () => {
    expect(parseUtc("2026-10-13T00:41:00")).toBe(Date.UTC(2026, 9, 13, 0, 41));
  });

  it("respects an explicit Z or offset", () => {
    expect(parseUtc("2026-10-13T00:41:00Z")).toBe(Date.UTC(2026, 9, 13, 0, 41));
    expect(parseUtc("2026-10-12T20:41:00-04:00")).toBe(Date.UTC(2026, 9, 13, 0, 41));
  });
});
