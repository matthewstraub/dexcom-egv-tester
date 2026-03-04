import { COOKIE_NAME, type DexcomEnv } from "@shared/const";
import { eq, desc, and, gte, lte } from "drizzle-orm";
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
import { pearsonCorrelation } from "./appleHealth";
// S3 storage no longer needed — uploads go to temp file on disk
import { getDb } from "./db";
import {
  healthUploadJobs,
  healthBuckets,
  healthWorkouts,
} from "../drizzle/schema";
// processHealthUpload is called from the Express route, not from tRPC
import type { AggregatedBucket, AppleHealthParseSummary } from "./appleHealth";
import type { AppleHealthMetricKey } from "@shared/const";

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
    /**
     * Poll the status of a processing job.
     */
    jobStatus: publicProcedure
      .input(z.object({ jobId: z.number() }))
      .query(async ({ input }) => {
        const db = await getDb();
        if (!db) throw new Error("Database not available");

        const [job] = await db
          .select()
          .from(healthUploadJobs)
          .where(eq(healthUploadJobs.id, input.jobId))
          .limit(1);

        if (!job) {
          return { status: "not_found" as const };
        }

        return {
          status: job.status as "pending" | "processing" | "completed" | "failed",
          errorMessage: job.errorMessage,
          summary: job.status === "completed" ? {
            totalRecordsScanned: job.totalRecordsScanned || 0,
            relevantDataPoints: job.relevantDataPoints || 0,
            workoutCount: job.workoutCount || 0,
            metricsFound: job.metricsFound ? job.metricsFound.split(",") : [],
            dateRange: job.dataRangeStart && job.dataRangeEnd ? {
              start: job.dataRangeStart,
              end: job.dataRangeEnd,
            } : null,
            bucketCount: job.bucketCount || 0,
          } : null,
        };
      }),

    /**
     * Get the status of the latest completed upload.
     * Returns data from the most recent completed job in the database.
     */
    status: publicProcedure.query(async () => {
      const db = await getDb();
      if (!db) return { uploaded: false as const };

      const [job] = await db
        .select()
        .from(healthUploadJobs)
        .where(eq(healthUploadJobs.status, "completed"))
        .orderBy(desc(healthUploadJobs.createdAt))
        .limit(1);

      if (!job) {
        return { uploaded: false as const };
      }

      return {
        uploaded: true as const,
        jobId: job.id,
        uploadedAt: job.createdAt.toISOString(),
        summary: {
          totalRecordsScanned: job.totalRecordsScanned || 0,
          relevantDataPoints: job.relevantDataPoints || 0,
          workoutCount: job.workoutCount || 0,
          metricsFound: job.metricsFound ? job.metricsFound.split(",") : [],
          dateRange: job.dataRangeStart && job.dataRangeEnd ? {
            start: job.dataRangeStart,
            end: job.dataRangeEnd,
          } : null,
        },
      };
    }),

    /**
     * Get aggregated health data buckets from the latest completed job.
     * Reconstructs the AggregatedBucket[] format from the database rows.
     */
    buckets: publicProcedure.query(async () => {
      const db = await getDb();
      if (!db) return [];

      // Get the latest completed job
      const [job] = await db
        .select()
        .from(healthUploadJobs)
        .where(eq(healthUploadJobs.status, "completed"))
        .orderBy(desc(healthUploadJobs.createdAt))
        .limit(1);

      if (!job) return [];

      // Get all bucket rows for this job
      const rows = await db
        .select()
        .from(healthBuckets)
        .where(eq(healthBuckets.jobId, job.id));

      // Reconstruct AggregatedBucket[] from flat rows
      const bucketMap = new Map<string, AggregatedBucket>();

      for (const row of rows) {
        if (!bucketMap.has(row.bucketStart)) {
          bucketMap.set(row.bucketStart, {
            bucketStart: row.bucketStart,
            bucketEnd: row.bucketEnd,
            metrics: {},
          });
        }
        const bucket = bucketMap.get(row.bucketStart)!;
        (bucket.metrics as any)[row.metric] = {
          avg: parseFloat(row.avg),
          min: parseFloat(row.min),
          max: parseFloat(row.max),
          sum: parseFloat(row.sum),
          count: row.count,
        };
      }

      // Sort by bucket start time
      return Array.from(bucketMap.values()).sort(
        (a, b) => new Date(a.bucketStart).getTime() - new Date(b.bucketStart).getTime()
      );
    }),

    /**
     * Get workout records from the latest completed job.
     */
    workouts: publicProcedure.query(async () => {
      const db = await getDb();
      if (!db) return [];

      // Get the latest completed job
      const [job] = await db
        .select()
        .from(healthUploadJobs)
        .where(eq(healthUploadJobs.status, "completed"))
        .orderBy(desc(healthUploadJobs.createdAt))
        .limit(1);

      if (!job) return [];

      const rows = await db
        .select()
        .from(healthWorkouts)
        .where(eq(healthWorkouts.jobId, job.id));

      return rows.map((w) => ({
        activityType: w.activityType,
        activityLabel: w.activityLabel,
        duration: parseFloat(w.duration),
        totalDistance: w.totalDistance ? parseFloat(w.totalDistance) : null,
        distanceUnit: w.distanceUnit,
        totalEnergyBurned: w.totalEnergyBurned ? parseFloat(w.totalEnergyBurned) : null,
        energyUnit: w.energyUnit,
        startDate: w.startDate,
        endDate: w.endDate,
        sourceName: w.sourceName,
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
      .mutation(async ({ input }) => {
        const db = await getDb();
        if (!db) return { correlations: [] };

        // Get the latest completed job
        const [job] = await db
          .select()
          .from(healthUploadJobs)
          .where(eq(healthUploadJobs.status, "completed"))
          .orderBy(desc(healthUploadJobs.createdAt))
          .limit(1);

        if (!job) return { correlations: [] };

        // Get bucket data from DB
        const rows = await db
          .select()
          .from(healthBuckets)
          .where(eq(healthBuckets.jobId, job.id));

        if (rows.length === 0) return { correlations: [] };

        // Reconstruct buckets
        const bucketMap = new Map<string, AggregatedBucket>();
        for (const row of rows) {
          if (!bucketMap.has(row.bucketStart)) {
            bucketMap.set(row.bucketStart, {
              bucketStart: row.bucketStart,
              bucketEnd: row.bucketEnd,
              metrics: {},
            });
          }
          const bucket = bucketMap.get(row.bucketStart)!;
          (bucket.metrics as any)[row.metric] = {
            avg: parseFloat(row.avg),
            min: parseFloat(row.min),
            max: parseFloat(row.max),
            sum: parseFloat(row.sum),
            count: row.count,
          };
        }

        const buckets = Array.from(bucketMap.values());

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

    /** Clear all Apple Health data (delete all jobs, buckets, workouts) */
    clear: publicProcedure.mutation(async () => {
      const db = await getDb();
      if (!db) return { success: true };

      // Delete all data in reverse dependency order
      await db.delete(healthBuckets);
      await db.delete(healthWorkouts);
      await db.delete(healthUploadJobs);

      return { success: true };
    }),
  }),
});

export type AppRouter = typeof appRouter;
