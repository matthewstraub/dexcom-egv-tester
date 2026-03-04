/**
 * Apple Health Background Processor
 *
 * Downloads a ZIP from S3, streams XML extraction and parsing,
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
import { Readable } from "stream";
import yauzl from "yauzl";
import fs from "fs";
import path from "path";
import os from "os";

const BUCKET_BATCH_SIZE = 500; // Write buckets to DB in batches of 500

/**
 * Download a file from a URL as a stream and save to a temp file.
 * This avoids loading the entire file into memory.
 */
async function downloadToTempFile(url: string): Promise<{ tempPath: string; size: number }> {
  const tempPath = path.join(os.tmpdir(), `apple-health-${Date.now()}.zip`);
  const response = await fetch(url);

  if (!response.ok || !response.body) {
    throw new Error(`Failed to download file from S3: ${response.status} ${response.statusText}`);
  }

  const writeStream = fs.createWriteStream(tempPath);
  let size = 0;

  // Convert web ReadableStream to Node.js stream and pipe to file
  const reader = response.body.getReader();

  return new Promise<{ tempPath: string; size: number }>((resolve, reject) => {
    function pump() {
      reader.read().then(({ done, value }) => {
        if (done) {
          writeStream.end();
          return;
        }
        size += value.byteLength;
        const canContinue = writeStream.write(Buffer.from(value));
        if (canContinue) {
          pump();
        } else {
          writeStream.once("drain", pump);
        }
      }).catch((err) => {
        writeStream.destroy();
        fs.unlink(tempPath, () => {});
        reject(err);
      });
    }

    writeStream.on("finish", () => resolve({ tempPath, size }));
    writeStream.on("error", (err) => {
      fs.unlink(tempPath, () => {});
      reject(err);
    });

    pump();
  });
}

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
 * 1. Downloads ZIP from S3 to a temp file
 * 2. Streams XML from the ZIP
 * 3. Parses and aggregates on-the-fly
 * 4. Writes results to the database
 * 5. Updates the job status
 */
export async function processHealthUpload(jobId: number): Promise<void> {
  const db = await getDb();
  if (!db) {
    console.error("[HealthProcessor] Database not available");
    return;
  }

  let tempPath: string | null = null;

  try {
    // Mark job as processing
    await db
      .update(healthUploadJobs)
      .set({ status: "processing" })
      .where(eq(healthUploadJobs.id, jobId));

    // Get the job details
    const [job] = await db
      .select()
      .from(healthUploadJobs)
      .where(eq(healthUploadJobs.id, jobId))
      .limit(1);

    if (!job) {
      console.error(`[HealthProcessor] Job ${jobId} not found`);
      return;
    }

    console.log(`[HealthProcessor] Starting job ${jobId}: downloading from S3...`);

    // Step 1: Download ZIP from S3 to temp file
    const { tempPath: downloadedPath, size } = await downloadToTempFile(job.s3Url);
    tempPath = downloadedPath;
    console.log(`[HealthProcessor] Downloaded ${(size / 1024 / 1024).toFixed(2)} MB to temp file`);

    // Step 2: Stream XML from ZIP
    console.log(`[HealthProcessor] Extracting XML from ZIP...`);
    const xmlStream = await streamXmlFromZipFile(tempPath);

    // Step 3: Parse and aggregate
    console.log(`[HealthProcessor] Parsing XML with on-the-fly aggregation...`);
    const { summary, buckets } = await streamParseAndAggregate(xmlStream, 15);

    console.log(
      `[HealthProcessor] Parsed ${summary.relevantDataPoints} data points, ` +
      `${summary.workouts.length} workouts from ${summary.recordCount} total records`
    );

    // Step 4: Delete any existing data from previous jobs (keep only latest)
    // First, find all other jobs and delete their data
    const existingJobs = await db
      .select({ id: healthUploadJobs.id })
      .from(healthUploadJobs)
      .where(eq(healthUploadJobs.id, jobId));

    // Delete old bucket and workout data for this job (in case of retry)
    await db.delete(healthBuckets).where(eq(healthBuckets.jobId, jobId));
    await db.delete(healthWorkouts).where(eq(healthWorkouts.jobId, jobId));

    // Step 5: Write results to database
    console.log(`[HealthProcessor] Writing ${buckets.length} buckets to database...`);
    const totalBucketRows = await writeBucketsToDb(db, jobId, buckets);
    console.log(`[HealthProcessor] Wrote ${totalBucketRows} bucket rows`);

    console.log(`[HealthProcessor] Writing ${summary.workouts.length} workouts to database...`);
    await writeWorkoutsToDb(db, jobId, summary.workouts);

    // Step 6: Update job as completed
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
    if (tempPath) {
      fs.unlink(tempPath, (err) => {
        if (err) console.warn("[HealthProcessor] Failed to clean up temp file:", err.message);
      });
    }
  }
}
