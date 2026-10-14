import { beforeEach, describe, expect, it, vi } from "vitest";
import { CHART_RANGE_DEFAULT } from "@shared/const";

// A controllable stand-in for the app_settings table; no real database is used.
const db = vi.hoisted(() => ({
  available: true,
  row: undefined as undefined | { name: string; value: string },
  selectError: null as Error | null,
  upserts: [] as Array<{ values: unknown; update: unknown }>,
}));
vi.mock("./db", () => ({
  getDb: async () =>
    db.available
      ? {
          select: () => ({
            from: () => ({
              where: () => ({
                limit: async () => {
                  if (db.selectError) throw db.selectError;
                  return db.row ? [db.row] : [];
                },
              }),
            }),
          }),
          insert: () => ({
            values: (values: unknown) => ({
              onDuplicateKeyUpdate: async (update: unknown) => void db.upserts.push({ values, update }),
            }),
          }),
        }
      : null,
}));

import { appRouter } from "./routers";
import { chartRangeSchema, getChartRange, saveChartRange } from "./settings";
import { createAdminContext, createMockContext, createViewerContext } from "./testHelpers";

beforeEach(() => {
  db.available = true;
  db.row = undefined;
  db.selectError = null;
  db.upserts = [];
});

describe("chartRangeSchema", () => {
  it("accepts a sensible range", () => {
    expect(chartRangeSchema.safeParse({ min: 40, max: 350 }).success).toBe(true);
  });

  it.each([
    [{ min: 200, max: 220 }, "too narrow"],
    [{ min: 300, max: 100 }, "upside down"],
    [{ min: -10, max: 300 }, "below zero"],
    [{ min: 40, max: 600 }, "above 500"],
    [{ min: 40.5, max: 350 }, "not whole numbers"],
  ])("rejects %j (%s)", (range) => {
    expect(chartRangeSchema.safeParse(range).success).toBe(false);
  });
});

describe("getChartRange", () => {
  it("uses the default when nothing has been saved", async () => {
    expect(await getChartRange()).toEqual(CHART_RANGE_DEFAULT);
  });

  it("returns the saved range", async () => {
    db.row = { name: "chartRange", value: JSON.stringify({ min: 50, max: 300 }) };
    expect(await getChartRange()).toEqual({ min: 50, max: 300 });
  });

  it("falls back to the default for a value that's unreadable or invalid", async () => {
    db.row = { name: "chartRange", value: "{not json" };
    expect(await getChartRange()).toEqual(CHART_RANGE_DEFAULT);
    db.row = { name: "chartRange", value: JSON.stringify({ min: 300, max: 310 }) };
    expect(await getChartRange()).toEqual(CHART_RANGE_DEFAULT);
  });

  it("falls back to the default if the table can't be read", async () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    db.selectError = new Error("Table 'app_settings' doesn't exist");
    expect(await getChartRange()).toEqual(CHART_RANGE_DEFAULT);
    expect(warn).toHaveBeenCalledOnce();
    warn.mockRestore();
  });

  it("uses the default without a database", async () => {
    db.available = false;
    expect(await getChartRange()).toEqual(CHART_RANGE_DEFAULT);
  });
});

describe("saveChartRange", () => {
  it("stores the range as JSON, inserting or updating the one row", async () => {
    expect(await saveChartRange({ min: 50, max: 300 })).toEqual({ min: 50, max: 300 });
    expect(db.upserts).toEqual([
      { values: { name: "chartRange", value: '{"min":50,"max":300}' }, update: { set: { value: '{"min":50,"max":300}' } } },
    ]);
  });

  it("refuses without a database", async () => {
    db.available = false;
    await expect(saveChartRange({ min: 50, max: 300 })).rejects.toThrow(/database isn't available/);
  });
});

describe("settings procedures", () => {
  it("lets anyone signed in read the settings", async () => {
    const result = await appRouter.createCaller(createViewerContext()).settings.get();
    expect(result).toEqual({ chartRange: CHART_RANGE_DEFAULT });
  });

  it("refuses the settings to a signed-out caller", async () => {
    await expect(appRouter.createCaller(createMockContext(null)).settings.get()).rejects.toMatchObject({ code: "UNAUTHORIZED" });
  });

  it("lets only an admin change the chart range", async () => {
    await expect(
      appRouter.createCaller(createViewerContext()).settings.setChartRange({ min: 50, max: 300 })
    ).rejects.toMatchObject({ code: "FORBIDDEN" });
    expect(db.upserts).toHaveLength(0);

    await appRouter.createCaller(createAdminContext()).settings.setChartRange({ min: 50, max: 300 });
    expect(db.upserts).toHaveLength(1);
  });

  it("rejects an invalid range before saving anything", async () => {
    await expect(
      appRouter.createCaller(createAdminContext()).settings.setChartRange({ min: 300, max: 320 })
    ).rejects.toMatchObject({ code: "BAD_REQUEST" });
    expect(db.upserts).toHaveLength(0);
  });
});
