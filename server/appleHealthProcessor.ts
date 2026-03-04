/**
 * Apple Health Background Processor
 *
 * Reads a ZIP from a temp file on disk, streams XML extraction and parsing,
 * aggregates into 15-minute buckets on-the-fly, and writes results
 * to the database in batches.
 *
 * Runs as a "fire and forget" background task — the caller gets a job ID
 * immediately and polls for completion.
 */

import { eq } from "drizzle-orm";
import { drizzle } from "drizzle-orm/mysql2";
import {
  healthUploadJobs,
  healthBuckets,
  healthWorkouts,
} from "../drizzle/schema";
import {
  streamParseAndAggregate,
  type AggregatedBucket,
  type AppleHealthParseSummary,
} from "./appleHealth";
import { getDb } from "./db";
import yauzl from "yauzl";
import fs from "fs";

const BUCKET_BATCH_SIZE = 500; // Write buckets to DB in batches of 500

/**
 * Extract export.xml from a ZIP file on disk using yauzl (streaming, low memory).
 * Returns a readable stream of the XML content.
 */
function streamXmlFromZipFile(zipPath: string): Promise<NodeJS.ReadableStream> {
  return new Promise((resolve, reject) => {
    yauzl.open(zipPath, { lazyEntries: true, autoClose: true }, (err, zipfile) => {
      if (err || !zipfile) {
        reject(err || new Error("Failed to open ZIP file"));
        return;
      }

      zipfile.readEntry();

      zipfile.on("entry", (entry) => {
        const name = entry.fileName;
        if (
          name === "export.xml" ||
          name === "apple_health_export/export.xml" ||
          name.endsWith("/export.xml")
        ) {
          zipfile.openReadStream(entry, (err2, readStream) => {
            if (err2 || !readStream) {
              reject(err2 || new Error("Failed to read export.xml from ZIP"));
              return;
            }
            resolve(readStream);
          });
        } else {
          zipfile.readEntry();
        }
      });

      zipfile.on("end", () => {
        reject(new Error("Could not find export.xml in the ZIP file."));
      });

      zipfile.on("error", reject);
    });
  });
}

/**
 * Write aggregated buckets to the database in batches.
 */
async function writeBucketsToDb(
  db: ReturnType<typeof drizzle>,
  jobId: number,
  buckets: AggregatedBucket[]
): Promise<number> {
  let totalRows = 0;

  // Flatten buckets into individual metric rows
  const rows: Array<{
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

  for (const bucket of buckets) {
    for (const [metric, stats] of Object.entries(bucket.metrics)) {
      if (!stats) continue;
      rows.push({
        jobId,
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

  // Write in batches
  for (let i = 0; i < rows.length; i += BUCKET_BATCH_SIZE) {
    const batch = rows.slice(i, i + BUCKET_BATCH_SIZE);
    if (batch.length > 0) {
      await db.insert(healthBuckets).values(batch);
      totalRows += batch.length;
    }
  }

  return totalRows;
}

/**
 * Write workout records to the database.
 */
async function writeWorkoutsToDb(
  db: ReturnType<typeof drizzle>,
  jobId: number,
  workouts: AppleHealthParseSummary["workouts"]
): Promise<void> {
  if (workouts.length === 0) return;

  const rows = workouts.map((w) => ({
    jobId,
    activityType: w.activityType,
    activityLabel: w.activityLabel,
    duration: String(w.duration),
    totalDistance: w.totalDistance !== null ? String(w.totalDistance) : null,
    distanceUnit: w.distanceUnit,
    totalEnergyBurned: w.totalEnergyBurned !== null ? String(w.totalEnergyBurned) : null,
    energyUnit: w.energyUnit,
    startDate: w.startDate.toISOString(),
    endDate: w.endDate.toISOString(),
    sourceName: w.sourceName || null,
  }));

  // Write in batches of 100
  for (let i = 0; i < rows.length; i += 100) {
    const batch = rows.slice(i, i + 100);
    await db.insert(healthWorkouts).values(batch);
  }
}

/**
 * Process an Apple Health upload job.
 * This is the main background processing function.
 *
 * 1. Reads ZIP from the temp file on disk
 * 2. Streams XML from the ZIP
 * 3. Parses and aggregates on-the-fly
 * 4. Writes results to the database
 * 5. Updates the job status
 * 6. Cleans up the temp file
 */
export async function processHealthUpload(jobId: number, tempFilePath: string): Promise<void> {
  const db = await getDb();
  if (!db) {
    console.error("[HealthProcessor] Database not available");
    return;
  }

  try {
    // Mark job as processing
    await db
      .update(healthUploadJobs)
      .set({ status: "processing" })
      .where(eq(healthUploadJobs.id, jobId));

    console.log(`[HealthProcessor] Starting job ${jobId}: reading from ${tempFilePath}`);

    // Verify the temp file exists
    if (!fs.existsSync(tempFilePath)) {
      throw new Error("Upload file not found on disk. It may have been cleaned up.");
    }

    const fileStats = fs.statSync(tempFilePath);
    console.log(`[HealthProcessor] File size: ${(fileStats.size / 1024 / 1024).toFixed(2)} MB`);

    // Step 1: Stream XML from ZIP
    console.log(`[HealthProcessor] Extracting XML from ZIP...`);
    const xmlStream = await streamXmlFromZipFile(tempFilePath);

    // Step 2: Parse and aggregate
    console.log(`[HealthProcessor] Parsing XML with on-the-fly aggregation...`);
    const { summary, buckets } = await streamParseAndAggregate(xmlStream, 15);

    console.log(
      `[HealthProcessor] Parsed ${summary.relevantDataPoints} data points, ` +
      `${summary.workouts.length} workouts from ${summary.recordCount} total records`
    );

    // Step 3: Delete any existing data from this job (in case of retry)
    await db.delete(healthBuckets).where(eq(healthBuckets.jobId, jobId));
    await db.delete(healthWorkouts).where(eq(healthWorkouts.jobId, jobId));

    // Step 4: Write results to database
    console.log(`[HealthProcessor] Writing ${buckets.length} buckets to database...`);
    const totalBucketRows = await writeBucketsToDb(db, jobId, buckets);
    console.log(`[HealthProcessor] Wrote ${totalBucketRows} bucket rows`);

    console.log(`[HealthProcessor] Writing ${summary.workouts.length} workouts to database...`);
    await writeWorkoutsToDb(db, jobId, summary.workouts);

    // Step 5: Update job as completed
    await db
      .update(healthUploadJobs)
      .set({
        status: "completed",
        totalRecordsScanned: summary.recordCount,
        relevantDataPoints: summary.relevantDataPoints,
        workoutCount: summary.workouts.length,
        metricsFound: summary.metricsFound.join(","),
        dataRangeStart: summary.dateRange?.start.toISOString() || null,
        dataRangeEnd: summary.dateRange?.end.toISOString() || null,
        bucketCount: buckets.length,
      })
      .where(eq(healthUploadJobs.id, jobId));

    console.log(`[HealthProcessor] Job ${jobId} completed successfully`);
  } catch (err: any) {
    console.error(`[HealthProcessor] Job ${jobId} failed:`, err);

    try {
      await db
        .update(healthUploadJobs)
        .set({
          status: "failed",
          errorMessage: err.message || "Unknown processing error",
        })
        .where(eq(healthUploadJobs.id, jobId));
    } catch (updateErr) {
      console.error(`[HealthProcessor] Failed to update job status:`, updateErr);
    }
  } finally {
    // Clean up temp file
    fs.unlink(tempFilePath, (err) => {
      if (err) console.warn("[HealthProcessor] Failed to clean up temp file:", err.message);
      else console.log(`[HealthProcessor] Cleaned up temp file: ${tempFilePath}`);
    });
  }
}
