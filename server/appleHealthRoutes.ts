import type { Express, Request, Response } from "express";
import {
  streamXmlFromZip,
  streamParseAndAggregate,
  saveStreamToTempFile,
  cleanupTempFile,
  type AppleHealthParseSummary,
  type AggregatedBucket,
} from "./appleHealth";

// In-memory store for the latest parsed Apple Health data (single-user mode)
// We only store the summary + aggregated buckets, NOT the raw data points.
let latestSummary: AppleHealthParseSummary | null = null;
let latestBuckets: AggregatedBucket[] | null = null;
let uploadTimestamp: string | null = null;

export function getLatestHealthData() {
  return {
    summary: latestSummary,
    buckets: latestBuckets,
    uploadedAt: uploadTimestamp,
  };
}

export function clearHealthData() {
  latestSummary = null;
  latestBuckets = null;
  uploadTimestamp = null;
}

// Max upload size: 500 MB (compressed ZIP)
const MAX_UPLOAD_BYTES = 500 * 1024 * 1024;

export function registerAppleHealthRoutes(app: Express) {
  /**
   * POST /api/apple-health/upload
   * Accepts a ZIP file (Apple Health export) as raw binary body.
   * Streams the file to disk, then streams XML extraction and parsing
   * to minimize memory usage (works within 512 MB).
   *
   * Query params:
   *   - startDate (optional): ISO 8601 filter start
   *   - endDate (optional): ISO 8601 filter end
   *   - bucketMinutes (optional): aggregation bucket size, default 15
   */
  app.post("/api/apple-health/upload", async (req: Request, res: Response) => {
    let tempPath: string | null = null;

    try {
      // Check content-length header for early rejection
      const contentLength = parseInt(req.headers["content-length"] || "0");
      if (contentLength > MAX_UPLOAD_BYTES) {
        res.status(413).json({
          error: `File too large (${(contentLength / 1024 / 1024).toFixed(0)} MB). Maximum is ${MAX_UPLOAD_BYTES / 1024 / 1024} MB.`,
        });
        return;
      }

      console.log("[AppleHealth] Streaming upload to temp file...");

      // Step 1: Stream the upload body to a temp file on disk (not in memory)
      const { tempPath: savedPath, size } = await saveStreamToTempFile(req);
      tempPath = savedPath;

      if (size === 0) {
        res.status(400).json({ error: "No file data received" });
        return;
      }

      if (size > MAX_UPLOAD_BYTES) {
        res.status(413).json({
          error: `File too large (${(size / 1024 / 1024).toFixed(0)} MB). Maximum is ${MAX_UPLOAD_BYTES / 1024 / 1024} MB.`,
        });
        return;
      }

      console.log(`[AppleHealth] Saved upload to disk: ${(size / 1024 / 1024).toFixed(2)} MB`);

      // Parse optional date filters
      const startDateStr = req.query.startDate as string | undefined;
      const endDateStr = req.query.endDate as string | undefined;
      const bucketMinutes = parseInt(req.query.bucketMinutes as string) || 15;

      const filterStart = startDateStr ? new Date(startDateStr) : undefined;
      const filterEnd = endDateStr ? new Date(endDateStr) : undefined;

      // Step 2: Stream XML from ZIP (yauzl streams decompression, no full buffer)
      console.log("[AppleHealth] Streaming XML from ZIP...");
      const xmlStream = await streamXmlFromZip(tempPath);

      // Step 3: Stream-parse XML and aggregate into buckets on-the-fly
      console.log("[AppleHealth] Parsing XML with on-the-fly aggregation...");
      const { summary, buckets } = await streamParseAndAggregate(
        xmlStream,
        bucketMinutes,
        filterStart,
        filterEnd
      );

      console.log(
        `[AppleHealth] Parsed ${summary.relevantDataPoints} data points, ` +
        `${summary.workouts.length} workouts from ${summary.recordCount} total records. ` +
        `Metrics found: ${summary.metricsFound.join(", ")}. ` +
        `Aggregated into ${buckets.length} buckets.`
      );

      // Step 4: Store only summary + buckets (not raw data points)
      latestSummary = summary;
      latestBuckets = buckets;
      uploadTimestamp = new Date().toISOString();

      res.json({
        success: true,
        summary: {
          totalRecordsScanned: summary.recordCount,
          relevantDataPoints: summary.relevantDataPoints,
          workouts: summary.workouts.length,
          metricsFound: summary.metricsFound,
          dateRange: summary.dateRange
            ? {
                start: summary.dateRange.start.toISOString(),
                end: summary.dateRange.end.toISOString(),
              }
            : null,
          bucketCount: buckets.length,
          bucketMinutes,
        },
      });
    } catch (err: any) {
      console.error("[AppleHealth] Upload error:", err);
      res.status(500).json({
        error: err.message || "Failed to process Apple Health export",
      });
    } finally {
      // Always clean up the temp file
      if (tempPath) {
        cleanupTempFile(tempPath);
      }
    }
  });
}
