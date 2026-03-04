/**
 * Apple Health Express Routes
 *
 * Provides the raw binary upload endpoint that streams the ZIP file
 * to a temp file on disk, creates a DB job, and kicks off background
 * processing. No S3 or external storage required.
 *
 * This route is registered BEFORE body parsers in server/_core/index.ts.
 */

import type { Express, Request, Response } from "express";
import { nanoid } from "nanoid";
import fs from "fs";
import path from "path";
import os from "os";
import { getDb } from "./db";
import { healthUploadJobs } from "../drizzle/schema";
import { processHealthUpload } from "./appleHealthProcessor";

// Max upload size: 500 MB (compressed ZIP)
const MAX_UPLOAD_BYTES = 500 * 1024 * 1024;

export function registerAppleHealthRoutes(app: Express) {
  /**
   * POST /api/apple-health/upload
   * Accepts a ZIP file as raw binary body.
   * Streams the upload to a temp file on disk, creates a processing job,
   * and starts background processing. Returns immediately with the job ID.
   *
   * This route is registered before body parsers so the raw stream is available.
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

      // Stream the upload body directly to a temp file on disk
      const fileId = nanoid();
      tempPath = path.join(os.tmpdir(), `apple-health-${fileId}.zip`);
      const writeStream = fs.createWriteStream(tempPath);
      let totalSize = 0;

      await new Promise<void>((resolve, reject) => {
        req.on("data", (chunk: Buffer) => {
          totalSize += chunk.length;
          if (totalSize > MAX_UPLOAD_BYTES) {
            req.destroy();
            writeStream.destroy();
            reject(new Error(`File too large (exceeds ${MAX_UPLOAD_BYTES / 1024 / 1024} MB limit)`));
            return;
          }
          writeStream.write(chunk);
        });
        req.on("end", () => {
          writeStream.end();
          resolve();
        });
        req.on("error", (err) => {
          writeStream.destroy();
          reject(err);
        });
        writeStream.on("error", reject);
      });

      if (totalSize === 0) {
        res.status(400).json({ error: "No file data received" });
        return;
      }

      console.log(`[AppleHealth] Saved ${(totalSize / 1024 / 1024).toFixed(2)} MB to temp file`);

      // Create a job record in the database
      const db = await getDb();
      if (!db) {
        res.status(500).json({ error: "Database not available" });
        return;
      }

      const result = await db.insert(healthUploadJobs).values({
        fileRef: tempPath, // Store the temp file path as the reference
        status: "pending",
      });

      const jobId = Number(result[0].insertId);

      // Return immediately with the job ID
      // The frontend will poll for status updates
      res.json({
        success: true,
        jobId,
        size: totalSize,
      });

      // Fire and forget — start processing in the background
      // The temp file will be cleaned up by the processor when done
      processHealthUpload(jobId, tempPath).catch((err) => {
        console.error(`[AppleHealth] Background processing failed for job ${jobId}:`, err);
      });

      // Don't clean up tempPath here — the processor will handle it
      tempPath = null;

    } catch (err: any) {
      console.error("[AppleHealth] Upload error:", err);

      // Clean up temp file on error
      if (tempPath) {
        fs.unlink(tempPath, () => {});
      }

      res.status(500).json({
        error: err.message || "Failed to process upload",
      });
    }
  });
}

// Legacy exports for backward compatibility (no-ops)
export function getLatestHealthData() {
  return { summary: null, buckets: null, uploadedAt: null };
}

export function clearHealthData() {
  // No-op — clearing is now done via the database
}
