import type { Express, Request, Response } from "express";
import {
  extractXmlFromZip,
  parseAppleHealthXml,
  aggregateIntoBuckets,
  type AppleHealthParseResult,
} from "./appleHealth";

// In-memory store for the latest parsed Apple Health data (single-user mode)
let latestParseResult: AppleHealthParseResult | null = null;
let latestBuckets: ReturnType<typeof aggregateIntoBuckets> | null = null;
let uploadTimestamp: string | null = null;

export function getLatestHealthData() {
  return {
    parseResult: latestParseResult,
    buckets: latestBuckets,
    uploadedAt: uploadTimestamp,
  };
}

export function clearHealthData() {
  latestParseResult = null;
  latestBuckets = null;
  uploadTimestamp = null;
}

export function registerAppleHealthRoutes(app: Express) {
  /**
   * POST /api/apple-health/upload
   * Accepts a ZIP file (Apple Health export) as raw binary body.
   * Parses the XML, extracts relevant metrics, and stores in memory.
   * Query params:
   *   - startDate (optional): ISO 8601 filter start
   *   - endDate (optional): ISO 8601 filter end
   *   - bucketMinutes (optional): aggregation bucket size, default 15
   */
  app.post("/api/apple-health/upload", async (req: Request, res: Response) => {
    try {
      // Collect the raw body as a buffer
      const chunks: Buffer[] = [];
      req.on("data", (chunk: Buffer) => chunks.push(chunk));

      await new Promise<void>((resolve, reject) => {
        req.on("end", resolve);
        req.on("error", reject);
      });

      const zipBuffer = Buffer.concat(chunks);

      if (zipBuffer.length === 0) {
        res.status(400).json({ error: "No file data received" });
        return;
      }

      console.log(`[AppleHealth] Received upload: ${(zipBuffer.length / 1024 / 1024).toFixed(2)} MB`);

      // Parse optional date filters from query params
      const startDateStr = req.query.startDate as string | undefined;
      const endDateStr = req.query.endDate as string | undefined;
      const bucketMinutes = parseInt(req.query.bucketMinutes as string) || 15;

      const filterStart = startDateStr ? new Date(startDateStr) : undefined;
      const filterEnd = endDateStr ? new Date(endDateStr) : undefined;

      // Extract XML from ZIP
      console.log("[AppleHealth] Extracting XML from ZIP...");
      const xmlBuffer = extractXmlFromZip(zipBuffer);
      console.log(`[AppleHealth] XML size: ${(xmlBuffer.length / 1024 / 1024).toFixed(2)} MB`);

      // Parse the XML
      console.log("[AppleHealth] Parsing XML (streaming)...");
      const parseResult = await parseAppleHealthXml(xmlBuffer, filterStart, filterEnd);
      console.log(
        `[AppleHealth] Parsed ${parseResult.dataPoints.length} data points, ` +
        `${parseResult.workouts.length} workouts from ${parseResult.recordCount} total records. ` +
        `Metrics found: ${parseResult.metricsFound.join(", ")}`
      );

      // Aggregate into time buckets
      const buckets = aggregateIntoBuckets(parseResult.dataPoints, bucketMinutes);
      console.log(`[AppleHealth] Aggregated into ${buckets.length} time buckets (${bucketMinutes}min each)`);

      // Store in memory
      latestParseResult = parseResult;
      latestBuckets = buckets;
      uploadTimestamp = new Date().toISOString();

      res.json({
        success: true,
        summary: {
          totalRecordsScanned: parseResult.recordCount,
          relevantDataPoints: parseResult.dataPoints.length,
          workouts: parseResult.workouts.length,
          metricsFound: parseResult.metricsFound,
          dateRange: parseResult.dateRange
            ? {
                start: parseResult.dateRange.start.toISOString(),
                end: parseResult.dateRange.end.toISOString(),
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
    }
  });
}
