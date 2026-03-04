import { COOKIE_NAME, type DexcomEnv } from "@shared/const";
import { eq, desc } from "drizzle-orm";
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
import { getDb } from "./db";
import {
  healthUploadJobs,
  healthBuckets,
  healthWorkouts,
} from "../drizzle/schema";
import type { AggregatedBucket } from "./appleHealth";
import type { AppleHealthMetricKey } from "@shared/const";

const dexcomEnvSchema = z.enum(["sandbox", "production"]);

/**
 * Single-user mode: all Dexcom tokens are stored under this fixed user ID.
 * No authentication is required — the app is publicly accessible.
 */
const SINGLE_USER_ID = 1;

const BUCKET_BATCH_SIZE = 500;

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
     * Step 1: Save summary + workouts (small payload ~0.5MB).
     * Returns a jobId that the frontend uses for subsequent bucket batch saves.
     */
    saveResults: publicProcedure
      .input(
        z.object({
          summary: z.object({
            recordCount: z.number(),
            relevantDataPoints: z.number(),
            workoutCount: z.number(),
            metricsFound: z.array(z.string()),
            dateRange: z.object({
              start: z.string(),
              end: z.string(),
            }).nullable(),
            bucketCount: z.number(),
          }),
          workouts: z.array(
            z.object({
              activityType: z.string(),
              activityLabel: z.string(),
              duration: z.number(),
              totalDistance: z.number().nullable().optional(),
              distanceUnit: z.string().nullable().optional(),
              totalEnergyBurned: z.number().nullable().optional(),
              energyUnit: z.string().nullable().optional(),
              startDate: z.string(),
              endDate: z.string(),
              sourceName: z.string().optional(),
            })
          ),
        })
      )
      .mutation(async ({ input }) => {
        const db = await getDb();
        if (!db) throw new Error("Database not available");

        // Clear any existing data first
        await db.delete(healthBuckets);
        await db.delete(healthWorkouts);
        await db.delete(healthUploadJobs);

        // Create a completed job record
        const result = await db.insert(healthUploadJobs).values({
          fileRef: "client-parsed",
          status: "completed",
          totalRecordsScanned: input.summary.recordCount,
          relevantDataPoints: input.summary.relevantDataPoints,
          workoutCount: input.summary.workoutCount,
          metricsFound: input.summary.metricsFound.join(","),
          dataRangeStart: input.summary.dateRange?.start || null,
          dataRangeEnd: input.summary.dateRange?.end || null,
          bucketCount: input.summary.bucketCount,
        });

        const jobId = Number(result[0].insertId);

        // Write workouts in batches (small payload)
        if (input.workouts.length > 0) {
          const workoutRows = input.workouts.map((w) => ({
            jobId,
            activityType: w.activityType,
            activityLabel: w.activityLabel,
            duration: String(w.duration),
            totalDistance: w.totalDistance !== null ? String(w.totalDistance) : null,
            distanceUnit: w.distanceUnit,
            totalEnergyBurned: w.totalEnergyBurned !== null ? String(w.totalEnergyBurned) : null,
            energyUnit: w.energyUnit,
            startDate: w.startDate,
            endDate: w.endDate,
            sourceName: w.sourceName || null,
          }));

          for (let i = 0; i < workoutRows.length; i += 100) {
            const batch = workoutRows.slice(i, i + 100);
            await db.insert(healthWorkouts).values(batch);
          }
        }

        return {
          success: true,
          jobId,
          workoutsWritten: input.workouts.length,
        };
      }),

    /**
     * Step 2: Save a batch of buckets (called multiple times by the frontend).
     * Each call sends ~10K buckets (~3MB) to stay well under body parser limits.
     */
    saveBucketBatch: publicProcedure
      .input(
        z.object({
          jobId: z.number(),
          buckets: z.array(
            z.object({
              bucketStart: z.string(),
              bucketEnd: z.string(),
              metrics: z.record(
                z.string(),
                z.object({
                  avg: z.number(),
                  min: z.number(),
                  max: z.number(),
                  sum: z.number(),
                  count: z.number(),
                })
              ),
            })
          ),
        })
      )
      .mutation(async ({ input }) => {
        const db = await getDb();
        if (!db) throw new Error("Database not available");

        const bucketRows: Array<{
          jobId: number;
          bucketStart: string;
          bucketEnd: string;
          metric: string;
          avg: string;
          min: string;
          max: string;
          sum: string;
          count: number;
        }> = [];

        for (const bucket of input.buckets) {
          for (const [metric, stats] of Object.entries(bucket.metrics)) {
            if (!stats) continue;
            bucketRows.push({
              jobId: input.jobId,
              bucketStart: bucket.bucketStart,
              bucketEnd: bucket.bucketEnd,
              metric,
              avg: String(stats.avg),
              min: String(stats.min),
              max: String(stats.max),
              sum: String(stats.sum),
              count: stats.count,
            });
          }
        }

        // Write to DB in sub-batches of 500 rows
        for (let i = 0; i < bucketRows.length; i += BUCKET_BATCH_SIZE) {
          const batch = bucketRows.slice(i, i + BUCKET_BATCH_SIZE);
          if (batch.length > 0) {
            await db.insert(healthBuckets).values(batch);
          }
        }

        return {
          success: true,
          rowsWritten: bucketRows.length,
        };
      }),

    /**
     * Get the status of the latest completed upload.
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
     */
    buckets: publicProcedure.query(async () => {
      const db = await getDb();
      if (!db) return [];

      const [job] = await db
        .select()
        .from(healthUploadJobs)
        .where(eq(healthUploadJobs.status, "completed"))
        .orderBy(desc(healthUploadJobs.createdAt))
        .limit(1);

      if (!job) return [];

      const rows = await db
        .select()
        .from(healthBuckets)
        .where(eq(healthBuckets.jobId, job.id));

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

        const [job] = await db
          .select()
          .from(healthUploadJobs)
          .where(eq(healthUploadJobs.status, "completed"))
          .orderBy(desc(healthUploadJobs.createdAt))
          .limit(1);

        if (!job) return { correlations: [] };

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
        const bucketMs = 15 * 60 * 1000;

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

        correlations.sort((a, b) => Math.abs(b.correlation) - Math.abs(a.correlation));

        return { correlations };
      }),

    /** Clear all Apple Health data */
    clear: publicProcedure.mutation(async () => {
      const db = await getDb();
      if (!db) return { success: true };

      await db.delete(healthBuckets);
      await db.delete(healthWorkouts);
      await db.delete(healthUploadJobs);

      return { success: true };
    }),
  }),
});

export type AppRouter = typeof appRouter;
