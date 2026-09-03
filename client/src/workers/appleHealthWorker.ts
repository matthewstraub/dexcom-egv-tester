/**
 * Apple Health Export Web Worker.
 *
 * Message plumbing only. The parsing pipeline lives in
 * client/src/lib/appleHealthParse.ts so it can be tested without a worker or a
 * browser — see appleHealthParse.test.ts.
 *
 * Measured against a real 102MB ZIP (2.1GB uncompressed XML, 4.7M records):
 * 32 seconds, 169MB peak, 3.6M relevant data points, 284K buckets, 7 metrics.
 */

import {
  parseHealthExport,
  type AggregatedBucket,
  type ParseProgress,
  type ParseSummary,
  type WorkoutRecord,
} from "@/lib/appleHealthParse";

export type { AggregatedBucket, ParseSummary, WorkoutRecord };

export interface WorkerMessage {
  type: "parse";
  file: File;
}

export interface ProgressMessage {
  type: "progress";
  stage: string;
  detail: string;
  pct?: number;
}

export interface ResultMessage {
  type: "result";
  summary: ParseSummary;
  buckets: AggregatedBucket[];
  workouts: WorkoutRecord[];
}

export interface ErrorMessage {
  type: "error";
  message: string;
}

function post(message: ProgressMessage | ResultMessage | ErrorMessage) {
  self.postMessage(message);
}

async function processFile(file: File) {
  try {
    post({
      type: "progress",
      stage: "extracting",
      detail: `Loading ${(file.size / 1024 / 1024).toFixed(0)} MB ZIP file...`,
    });

    const zipData = new Uint8Array(await file.arrayBuffer());

    const { summary, buckets, workouts } = await parseHealthExport(
      zipData,
      ({ stage, detail, pct }: ParseProgress) =>
        post({ type: "progress", stage, detail, pct })
    );

    post({ type: "result", summary, buckets, workouts });
  } catch (err: any) {
    post({
      type: "error",
      message: err?.message || "Failed to parse Apple Health export",
    });
  }
}

self.onmessage = (e: MessageEvent<WorkerMessage>) => {
  if (e.data.type === "parse") {
    processFile(e.data.file);
  }
};
