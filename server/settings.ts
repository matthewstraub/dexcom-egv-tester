import { eq } from "drizzle-orm";
import { z } from "zod";
import { CHART_RANGE_DEFAULT, CHART_RANGE_LIMITS } from "@shared/const";
import { appSettings } from "../drizzle/schema";
import { getDb } from "./db";

/**
 * Site-wide settings, stored one row per setting in `app_settings` as JSON.
 * Reads never fail: a missing, unreadable or invalid value falls back to the
 * default, so a settings problem can't break the chart.
 */

export const chartRangeSchema = z
  .object({
    min: z.number().int().min(CHART_RANGE_LIMITS.lowest),
    max: z.number().int().max(CHART_RANGE_LIMITS.highest),
  })
  .refine((r) => r.max - r.min >= CHART_RANGE_LIMITS.minSpan, {
    message: `The maximum must be at least ${CHART_RANGE_LIMITS.minSpan} mg/dL above the minimum.`,
  });

export type ChartRange = z.infer<typeof chartRangeSchema>;

const CHART_RANGE = "chartRange";

export async function getChartRange(): Promise<ChartRange> {
  try {
    const db = await getDb();
    if (!db) return { ...CHART_RANGE_DEFAULT };
    const [row] = await db.select().from(appSettings).where(eq(appSettings.name, CHART_RANGE)).limit(1);
    if (!row) return { ...CHART_RANGE_DEFAULT };
    const parsed = chartRangeSchema.safeParse(JSON.parse(row.value));
    return parsed.success ? parsed.data : { ...CHART_RANGE_DEFAULT };
  } catch (err) {
    console.warn(`[Settings] Couldn't read the chart range, using the default: ${(err as Error)?.message ?? err}`);
    return { ...CHART_RANGE_DEFAULT };
  }
}

export async function saveChartRange(range: ChartRange): Promise<ChartRange> {
  const db = await getDb();
  if (!db) throw new Error("Settings can't be saved: the database isn't available.");
  const value = JSON.stringify({ min: range.min, max: range.max });
  await db.insert(appSettings).values({ name: CHART_RANGE, value }).onDuplicateKeyUpdate({ set: { value } });
  return { min: range.min, max: range.max };
}
