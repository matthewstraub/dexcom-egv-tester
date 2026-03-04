/**
 * Apple Health Express Routes
 *
 * Provides the raw binary upload endpoint that streams the ZIP file
 * directly to S3 storage, bypassing Express body parsing entirely.
 * This route is registered BEFORE body parsers in server/_core/index.ts.
 */

import type { Express, Request, Response } from "express";
import { storagePut } from "./storage";
import { nanoid } from "nanoid";

// Max upload size: 500 MB (compressed ZIP)
const MAX_UPLOAD_BYTES = 500 * 1024 * 1024;

export function registerAppleHealthRoutes(app: Express) {
  /**
   * POST /api/apple-health/upload-to-s3
   * Accepts a ZIP file as raw binary body.
   * Buffers the upload and sends it to S3 storage.
   * Returns the S3 key and URL for the frontend to start processing.
   *
   * This route is registered before body parsers so the raw stream is available.
   */
  app.post("/api/apple-health/upload-to-s3", async (req: Request, res: Response) => {
    try {
      // Check content-length header for early rejection
      const contentLength = parseInt(req.headers["content-length"] || "0");
      if (contentLength > MAX_UPLOAD_BYTES) {
        res.status(413).json({
          error: `File too large (${(contentLength / 1024 / 1024).toFixed(0)} MB). Maximum is ${MAX_UPLOAD_BYTES / 1024 / 1024} MB.`,
        });
        return;
      }

      console.log("[AppleHealth] Receiving upload for S3 storage...");

      // Collect the body into a buffer
      // This is necessary because the S3 storage helper expects a Buffer.
      // The ZIP file is already compressed, so this is the compressed size (typically 10-100MB).
      const chunks: Buffer[] = [];
      let totalSize = 0;

      await new Promise<void>((resolve, reject) => {
        req.on("data", (chunk: Buffer) => {
          totalSize += chunk.length;
          if (totalSize > MAX_UPLOAD_BYTES) {
            req.destroy();
            reject(new Error(`File too large (exceeds ${MAX_UPLOAD_BYTES / 1024 / 1024} MB limit)`));
            return;
          }
          chunks.push(chunk);
        });
        req.on("end", resolve);
        req.on("error", reject);
      });

      if (totalSize === 0) {
        res.status(400).json({ error: "No file data received" });
        return;
      }

      const buffer = Buffer.concat(chunks);
      console.log(`[AppleHealth] Received ${(totalSize / 1024 / 1024).toFixed(2)} MB, uploading to S3...`);

      // Upload to S3
      const fileKey = `apple-health-uploads/${nanoid()}.zip`;
      const { key, url } = await storagePut(fileKey, buffer, "application/zip");

      console.log(`[AppleHealth] Uploaded to S3: ${key}`);

      // Free the buffer immediately
      chunks.length = 0;

      res.json({
        success: true,
        s3Key: key,
        s3Url: url,
        size: totalSize,
      });
    } catch (err: any) {
      console.error("[AppleHealth] Upload to S3 error:", err);
      res.status(500).json({
        error: err.message || "Failed to upload file to storage",
      });
    }
  });
}

// Legacy exports removed — data is now stored in the database
export function getLatestHealthData() {
  // This is kept for backward compatibility but should not be used.
  // All data is now in the database.
  return { summary: null, buckets: null, uploadedAt: null };
}

export function clearHealthData() {
  // No-op — clearing is now done via the database
}
