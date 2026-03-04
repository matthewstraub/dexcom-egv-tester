import { COOKIE_NAME, type DexcomEnv } from "@shared/const";
import { z } from "zod";
import { getSessionCookieOptions } from "./_core/cookies";
import { systemRouter } from "./_core/systemRouter";
import { publicProcedure, router } from "./_core/trpc";
import {
  getDexcomConnectionStatus,
  getValidAccessToken,
  fetchEgvData,
  fetchDataRange,
  disconnectDexcom,
} from "./dexcom";
import { getLatestHealthData, clearHealthData } from "./appleHealthRoutes";
import { pearsonCorrelation } from "./appleHealth";

const dexcomEnvSchema = z.enum(["sandbox", "production"]);

/**
 * Single-user mode: all Dexcom tokens are stored under this fixed user ID.
 * No authentication is required — the app is publicly accessible.
 */
const SINGLE_USER_ID = 1;

export const appRouter = router({
  system: systemRouter,
  auth: router({
    me: publicProcedure.query(() => null),
    logout: publicProcedure.mutation(({ ctx }) => {
      const cookieOptions = getSessionCookieOptions(ctx.req);
      ctx.res.clearCookie(COOKIE_NAME, { ...cookieOptions, maxAge: -1 });
      return { success: true } as const;
    }),
  }),

  dexcom: router({
    /** Get the current Dexcom connection status for a given environment */
    status: publicProcedure
      .input(z.object({ env: dexcomEnvSchema }).optional())
      .query(async ({ input }) => {
        const env: DexcomEnv = input?.env ?? "sandbox";
        return getDexcomConnectionStatus(SINGLE_USER_ID, env);
      }),

    /** Disconnect from Dexcom (remove stored tokens) for a given environment */
    disconnect: publicProcedure
      .input(z.object({ env: dexcomEnvSchema }).optional())
      .mutation(async ({ input }) => {
        const env: DexcomEnv = input?.env ?? "sandbox";
        await disconnectDexcom(SINGLE_USER_ID, env);
        return { success: true };
      }),

    /** Fetch the available data range for the connected Dexcom user */
    dataRange: publicProcedure
      .input(z.object({ env: dexcomEnvSchema }).optional())
      .query(async ({ input }) => {
        const env: DexcomEnv = input?.env ?? "sandbox";
        const accessToken = await getValidAccessToken(SINGLE_USER_ID, env);
        if (!accessToken) {
          throw new Error("Not connected to Dexcom. Please authorize first.");
        }
        try {
          const data = await fetchDataRange(accessToken, env);
          return data;
        } catch (err: any) {
          throw new Error(
            err?.response?.data?.message || "Failed to fetch data range from Dexcom"
          );
        }
      }),

    /** Fetch EGV data for a given date range */
    egvs: publicProcedure
      .input(
        z.object({
          startDate: z.string(),
          endDate: z.string(),
          env: dexcomEnvSchema.optional(),
        })
      )
      .query(async ({ input }) => {
        const env: DexcomEnv = input.env ?? "sandbox";

        // Validate date range (Dexcom API max 30 days)
        const start = new Date(input.startDate);
        const end = new Date(input.endDate);
        if (isNaN(start.getTime()) || isNaN(end.getTime())) {
          throw new Error("Invalid date format. Please use ISO 8601 format (e.g. 2024-01-15T10:30:00).");
        }
        if (start >= end) {
          throw new Error("startDate must be before endDate.");
        }
        const diffMs = end.getTime() - start.getTime();
        const diffDays = diffMs / (1000 * 60 * 60 * 24);
        if (diffDays > 30) {
          throw new Error(
            `Date range exceeds the Dexcom API maximum of 30 days. Your range is ${diffDays.toFixed(1)} days. Please narrow your query window.`
          );
        }

        const accessToken = await getValidAccessToken(SINGLE_USER_ID, env);
        if (!accessToken) {
          throw new Error("Not connected to Dexcom. Please authorize first.");
        }
        try {
          const data = await fetchEgvData(
            accessToken,
            input.startDate,
            input.endDate,
            env
          );
          return data;
        } catch (err: any) {
          const errData = err?.response?.data;
          const msg = errData?.message || errData?.error_description || "";
          if (msg.toLowerCase().includes("date range") || msg.toLowerCase().includes("invalid")) {
            throw new Error(
              `Dexcom API error: ${msg}. Note: date range must be \u226430 days, and dates must be ISO 8601 UTC timestamps.`
            );
          }
          throw new Error(msg || "Failed to fetch EGV data from Dexcom");
        }
      }),
  }),

  appleHealth: router({
    /** Get the status of the latest Apple Health upload */
    status: publicProcedure.query(() => {
      const { parseResult, uploadedAt } = getLatestHealthData();
      if (!parseResult || !uploadedAt) {
        return { uploaded: false as const };
      }
      return {
        uploaded: true as const,
        uploadedAt,
        summary: {
          totalRecordsScanned: parseResult.recordCount,
          relevantDataPoints: parseResult.dataPoints.length,
          workoutCount: parseResult.workouts.length,
          metricsFound: parseResult.metricsFound,
          dateRange: parseResult.dateRange
            ? {
                start: parseResult.dateRange.start.toISOString(),
                end: parseResult.dateRange.end.toISOString(),
              }
            : null,
        },
      };
    }),

    /** Get aggregated health data buckets for chart overlay */
    buckets: publicProcedure.query(() => {
      const { buckets } = getLatestHealthData();
      return buckets || [];
    }),

    /** Get workout records */
    workouts: publicProcedure.query(() => {
      const { parseResult } = getLatestHealthData();
      if (!parseResult) return [];
      return parseResult.workouts.map((w) => ({
        ...w,
        startDate: w.startDate.toISOString(),
        endDate: w.endDate.toISOString(),
      }));
    }),

    /** Calculate correlations between EGV data and health metrics */
    correlations: publicProcedure
      .input(
        z.object({
          egvData: z.array(
            z.object({
              systemTime: z.string(),
              value: z.number().nullable(),
            })
          ),
        })
      )
      .mutation(({ input }) => {
        const { buckets } = getLatestHealthData();
        if (!buckets || buckets.length === 0) {
          return { correlations: [] };
        }

        // Build a map of bucket start times to EGV values
        const egvByTime = new Map<number, number[]>();
        const bucketMs = 15 * 60 * 1000; // 15-minute buckets

        for (const egv of input.egvData) {
          if (egv.value === null) continue;
          const t = new Date(egv.systemTime).getTime();
          const bucketKey = Math.floor(t / bucketMs) * bucketMs;
          if (!egvByTime.has(bucketKey)) {
            egvByTime.set(bucketKey, []);
          }
          egvByTime.get(bucketKey)!.push(egv.value);
        }

        // For each metric, find overlapping time buckets and compute correlation
        const metricsToCheck = new Set<string>();
        for (const b of buckets) {
          for (const key of Object.keys(b.metrics)) {
            metricsToCheck.add(key);
          }
        }

        const correlations: Array<{
          metric: string;
          correlation: number;
          sampleSize: number;
          strength: string;
          direction: string;
        }> = [];

        for (const metric of Array.from(metricsToCheck)) {
          const egvValues: number[] = [];
          const metricValues: number[] = [];

          for (const bucket of buckets) {
            const metricData = (bucket.metrics as any)[metric];
            if (!metricData) continue;

            const bucketTime = new Date(bucket.bucketStart).getTime();
            const egvs = egvByTime.get(bucketTime);
            if (!egvs || egvs.length === 0) continue;

            const avgEgv = egvs.reduce((a: number, b: number) => a + b, 0) / egvs.length;
            egvValues.push(avgEgv);

            // Use avg for rate metrics (heart rate, HRV), sum for cumulative (steps, energy)
            const useSumMetrics = ["stepCount", "activeEnergy", "exerciseTime", "distance"];
            metricValues.push(useSumMetrics.includes(metric) ? metricData.sum : metricData.avg);
          }

          if (egvValues.length >= 5) {
            const r = pearsonCorrelation(egvValues, metricValues);
            const absR = Math.abs(r);
            let strength = "negligible";
            if (absR >= 0.7) strength = "strong";
            else if (absR >= 0.4) strength = "moderate";
            else if (absR >= 0.2) strength = "weak";

            correlations.push({
              metric,
              correlation: Math.round(r * 1000) / 1000,
              sampleSize: egvValues.length,
              strength,
              direction: r > 0 ? "positive" : r < 0 ? "negative" : "none",
            });
          }
        }

        // Sort by absolute correlation strength
        correlations.sort((a, b) => Math.abs(b.correlation) - Math.abs(a.correlation));

        return { correlations };
      }),

    /** Clear the uploaded Apple Health data */
    clear: publicProcedure.mutation(() => {
      clearHealthData();
      return { success: true };
    }),
  }),
});

export type AppRouter = typeof appRouter;
