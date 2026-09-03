/**
 * Apple Health export parsing.
 *
 * Extracted from the Web Worker so it can be tested directly: everything here
 * is plain data in, plain data out, with no `self` and no `postMessage`. The
 * worker (client/src/workers/appleHealthWorker.ts) is now just message plumbing
 * around `parseHealthExport`.
 *
 * The pipeline:
 *  1. Parse the ZIP central directory to locate export.xml and its compressed
 *     extent. Apple Health ZIPs use data descriptors (flag bit 3), so the local
 *     header's size fields are zero and unusable.
 *  2. Stream those bytes through DecompressionStream("deflate-raw") — a 100MB
 *     export expands to ~2GB of XML, past V8's max string length, so it can
 *     never be buffered whole.
 *  3. Scan the text in chunks with regex tag extraction, aggregating into
 *     15-minute buckets on the fly rather than accumulating data points.
 */

// ── Types ──

export interface ParseSummary {
  recordCount: number;
  relevantDataPoints: number;
  workoutCount: number;
  metricsFound: string[];
  dateRange: { start: string; end: string } | null;
  bucketCount: number;
}

export interface AggregatedBucket {
  bucketStart: string;
  bucketEnd: string;
  metrics: Record<string, { avg: number; min: number; max: number; sum: number; count: number }>;
}

export interface WorkoutRecord {
  activityType: string;
  activityLabel: string;
  duration: number;
  startDate: string;
  endDate: string;
  sourceName?: string;
  totalDistance?: number | null;
  distanceUnit?: string | null;
  totalEnergyBurned?: number | null;
  energyUnit?: string | null;
}

export interface ZipEntry {
  fileName: string;
  compressionMethod: number;
  compressedSize: number;
  uncompressedSize: number;
  dataOffset: number;
}

export interface ParseResult {
  summary: ParseSummary;
  buckets: AggregatedBucket[];
  workouts: WorkoutRecord[];
}

// ── Constants ──

export const APPLE_HEALTH_METRICS: Record<string, string> = {
  stepCount: "HKQuantityTypeIdentifierStepCount",
  heartRate: "HKQuantityTypeIdentifierHeartRate",
  restingHeartRate: "HKQuantityTypeIdentifierRestingHeartRate",
  hrv: "HKQuantityTypeIdentifierHeartRateVariabilitySDNN",
  activeEnergy: "HKQuantityTypeIdentifierActiveEnergyBurned",
  exerciseTime: "HKQuantityTypeIdentifierAppleExerciseTime",
  distance: "HKQuantityTypeIdentifierDistanceWalkingRunning",
  oxygenSaturation: "HKQuantityTypeIdentifierOxygenSaturation",
};

export const HK_TYPE_TO_METRIC: Record<string, string> = {};
for (const [key, hkType] of Object.entries(APPLE_HEALTH_METRICS)) {
  HK_TYPE_TO_METRIC[hkType] = key;
}

export const WORKOUT_TYPE_LABELS: Record<string, string> = {
  HKWorkoutActivityTypeRunning: "Running",
  HKWorkoutActivityTypeWalking: "Walking",
  HKWorkoutActivityTypeCycling: "Cycling",
  HKWorkoutActivityTypeSwimming: "Swimming",
  HKWorkoutActivityTypeYoga: "Yoga",
  HKWorkoutActivityTypeHiking: "Hiking",
  HKWorkoutActivityTypeFunctionalStrengthTraining: "Strength Training",
  HKWorkoutActivityTypeTraditionalStrengthTraining: "Strength Training",
  HKWorkoutActivityTypeHighIntensityIntervalTraining: "HIIT",
  HKWorkoutActivityTypeCoreTraining: "Core Training",
  HKWorkoutActivityTypeElliptical: "Elliptical",
  HKWorkoutActivityTypeRowing: "Rowing",
  HKWorkoutActivityTypeDance: "Dance",
  HKWorkoutActivityTypePilates: "Pilates",
  HKWorkoutActivityTypeCooldown: "Cooldown",
  HKWorkoutActivityTypeMixedCardio: "Mixed Cardio",
  HKWorkoutActivityTypeStairClimbing: "Stair Climbing",
  HKWorkoutActivityTypeOther: "Other",
};

export const BUCKET_MS = 15 * 60 * 1000;

// ── ZIP central directory ──

function readUint16LE(buf: Uint8Array, offset: number): number {
  return buf[offset]! | (buf[offset + 1]! << 8);
}

function readUint32LE(buf: Uint8Array, offset: number): number {
  return (
    (buf[offset]! | (buf[offset + 1]! << 8) | (buf[offset + 2]! << 16) | (buf[offset + 3]! << 24)) >>> 0
  );
}

function readString(buf: Uint8Array, offset: number, length: number): string {
  return new TextDecoder("utf-8").decode(buf.subarray(offset, offset + length));
}

/**
 * Locate the export.xml entry by walking the ZIP's central directory.
 * Throws if the EOCD signature is missing; returns null if the archive is a
 * valid ZIP that simply has no export.xml.
 */
export function findExportXmlFromCentralDir(buf: Uint8Array): ZipEntry | null {
  let eocdOffset = -1;
  const searchStart = Math.max(0, buf.length - 65536);
  for (let i = buf.length - 22; i >= searchStart; i--) {
    if (readUint32LE(buf, i) === 0x06054b50) {
      eocdOffset = i;
      break;
    }
  }
  if (eocdOffset === -1) throw new Error("Not a valid ZIP file (EOCD signature not found)");

  const cdOffset = readUint32LE(buf, eocdOffset + 16);
  const cdSize = readUint32LE(buf, eocdOffset + 12);

  let offset = cdOffset;
  const cdEnd = cdOffset + cdSize;
  while (offset < cdEnd && offset < buf.length - 46) {
    const sig = readUint32LE(buf, offset);
    if (sig !== 0x02014b50) break;

    const compressionMethod = readUint16LE(buf, offset + 10);
    const compressedSize = readUint32LE(buf, offset + 20);
    const uncompressedSize = readUint32LE(buf, offset + 24);
    const fileNameLength = readUint16LE(buf, offset + 28);
    const extraFieldLength = readUint16LE(buf, offset + 30);
    const commentLength = readUint16LE(buf, offset + 32);
    const localHeaderOffset = readUint32LE(buf, offset + 42);
    const fileName = readString(buf, offset + 46, fileNameLength);

    if (fileName.endsWith("export.xml")) {
      // The local header's own name/extra lengths give the true data start.
      const localFnLen = readUint16LE(buf, localHeaderOffset + 26);
      const localExLen = readUint16LE(buf, localHeaderOffset + 28);
      const dataOffset = localHeaderOffset + 30 + localFnLen + localExLen;
      return { fileName, compressionMethod, compressedSize, uncompressedSize, dataOffset };
    }

    offset += 46 + fileNameLength + extraFieldLength + commentLength;
  }
  return null;
}

// ── Tag helpers ──

/** Apple Health writes dates as "2024-01-15 08:30:00 -0500". */
export function parseAppleHealthDate(dateStr: string): number {
  if (!dateStr) return NaN;
  const m = dateStr.match(/^(\d{4})-(\d{2})-(\d{2})\s+(\d{2}):(\d{2}):(\d{2})\s+([+-]\d{4})$/);
  if (!m) return new Date(dateStr).getTime();
  return new Date(
    `${m[1]}-${m[2]}-${m[3]}T${m[4]}:${m[5]}:${m[6]}${m[7]!.slice(0, 3)}:${m[7]!.slice(3)}`
  ).getTime();
}

export function extractAttr(tag: string, name: string): string {
  const m = tag.match(new RegExp(name + '="([^"]*)"'));
  return m ? m[1]! : "";
}

// ── Streaming aggregator ──

interface RunningStats {
  count: number;
  sum: number;
  min: number;
  max: number;
}

// Matches self-closing <Record .../> and open <Record ...> alike (heartRate has children).
const RECORD_RE = /<Record\s[^>]*?(?:\/?>)/gi;
const WORKOUT_RE = /<Workout\s[^>]*?(?:\/?>)/gi;

export interface HealthAggregator {
  /** Feed a chunk of XML text. Safe to split anywhere, including mid-tag. */
  ingest(text: string): void;
  /** Flush any buffered partial text and build the result. */
  finish(): ParseResult;
  /** Records seen so far, for progress reporting. */
  readonly stats: { recordCount: number; relevantDataPoints: number };
}

/**
 * Accumulates buckets and workouts from XML fed in arbitrary chunks.
 *
 * Chunk boundaries are handled by holding back everything after the last `>`
 * and prepending it to the next chunk, so a tag split across chunks is still
 * seen exactly once. `finish()` runs that held-back tail through the same
 * extraction path as every other chunk — the worker previously had a separate,
 * partial copy of this logic that skipped date-range tracking and dropped
 * workouts entirely.
 */
export function createHealthAggregator(): HealthAggregator {
  const bucketMap = new Map<number, Map<string, RunningStats>>();
  const workouts: WorkoutRecord[] = [];
  const metricsSet = new Set<string>();
  let minDate = Infinity;
  let maxDate = -Infinity;
  let recordCount = 0;
  let relevantDataPoints = 0;
  let leftover = "";

  function extract(text: string) {
    RECORD_RE.lastIndex = 0;
    let match: RegExpExecArray | null;
    while ((match = RECORD_RE.exec(text)) !== null) {
      recordCount++;
      const tag = match[0];
      const metricKey = HK_TYPE_TO_METRIC[extractAttr(tag, "type")];
      if (!metricKey) continue;

      const st = parseAppleHealthDate(extractAttr(tag, "startDate"));
      const val = parseFloat(extractAttr(tag, "value"));
      if (isNaN(st) || isNaN(val)) continue;

      if (st < minDate) minDate = st;
      const et = parseAppleHealthDate(extractAttr(tag, "endDate"));
      const effectiveEnd = isNaN(et) ? st : et;
      if (effectiveEnd > maxDate) maxDate = effectiveEnd;

      metricsSet.add(metricKey);
      relevantDataPoints++;

      const bk = Math.floor(st / BUCKET_MS) * BUCKET_MS;
      let bm = bucketMap.get(bk);
      if (!bm) {
        bm = new Map();
        bucketMap.set(bk, bm);
      }
      let s = bm.get(metricKey);
      if (!s) {
        s = { count: 0, sum: 0, min: Infinity, max: -Infinity };
        bm.set(metricKey, s);
      }
      s.count++;
      s.sum += val;
      if (val < s.min) s.min = val;
      if (val > s.max) s.max = val;
    }

    WORKOUT_RE.lastIndex = 0;
    while ((match = WORKOUT_RE.exec(text)) !== null) {
      const tag = match[0];
      const at = extractAttr(tag, "workoutActivityType");
      const st = parseAppleHealthDate(extractAttr(tag, "startDate"));
      if (isNaN(st)) continue;
      const et = parseAppleHealthDate(extractAttr(tag, "endDate"));
      const src = extractAttr(tag, "sourceName");
      workouts.push({
        activityType: at,
        activityLabel: WORKOUT_TYPE_LABELS[at] || at.replace("HKWorkoutActivityType", ""),
        duration: parseFloat(extractAttr(tag, "duration") || "0"),
        startDate: new Date(st).toISOString(),
        endDate: isNaN(et) ? new Date(st).toISOString() : new Date(et).toISOString(),
        sourceName: src || undefined,
        totalDistance: null,
        distanceUnit: null,
        totalEnergyBurned: null,
        energyUnit: null,
      });
    }
  }

  return {
    stats: {
      get recordCount() {
        return recordCount;
      },
      get relevantDataPoints() {
        return relevantDataPoints;
      },
    } as { recordCount: number; relevantDataPoints: number },

    ingest(text: string) {
      const combined = leftover + text;
      const lastTagEnd = combined.lastIndexOf(">");
      if (lastTagEnd === -1) {
        leftover = combined;
        return;
      }
      leftover = combined.substring(lastTagEnd + 1);
      extract(combined.substring(0, lastTagEnd + 1));
    },

    finish(): ParseResult {
      if (leftover.length > 0) {
        extract(leftover);
        leftover = "";
      }

      const buckets: AggregatedBucket[] = Array.from(bucketMap.keys())
        .sort((a, b) => a - b)
        .map((key) => {
          const bucket: AggregatedBucket = {
            bucketStart: new Date(key).toISOString(),
            bucketEnd: new Date(key + BUCKET_MS).toISOString(),
            metrics: {},
          };
          for (const [metric, s] of Array.from(bucketMap.get(key)!.entries())) {
            bucket.metrics[metric] = {
              avg: s.sum / s.count,
              min: s.min,
              max: s.max,
              sum: s.sum,
              count: s.count,
            };
          }
          return bucket;
        });

      workouts.sort((a, b) => new Date(a.startDate).getTime() - new Date(b.startDate).getTime());

      return {
        summary: {
          recordCount,
          relevantDataPoints,
          workoutCount: workouts.length,
          metricsFound: Array.from(metricsSet),
          dateRange:
            minDate !== Infinity && maxDate !== -Infinity
              ? { start: new Date(minDate).toISOString(), end: new Date(maxDate).toISOString() }
              : null,
          bucketCount: buckets.length,
        },
        buckets,
        workouts,
      };
    },
  };
}

// ── Full pipeline ──

export interface ParseProgress {
  stage: string;
  detail: string;
  pct?: number;
}

/** Bytes fed into the decompressor at a time. */
const FEED_CHUNK = 512 * 1024;

/**
 * Locate, decompress and parse export.xml out of an Apple Health ZIP.
 *
 * `onProgress` is optional so this is callable from a test without stubbing
 * anything; the worker passes its postMessage bridge.
 */
export async function parseHealthExport(
  zipData: Uint8Array,
  onProgress?: (p: ParseProgress) => void
): Promise<ParseResult> {
  const report = (stage: string, detail: string, pct?: number) => onProgress?.({ stage, detail, pct });

  report("extracting", "ZIP loaded, scanning structure...");

  const entry = findExportXmlFromCentralDir(zipData);
  if (!entry) {
    throw new Error(
      "Could not find export.xml in the ZIP file. Make sure this is an Apple Health export."
    );
  }
  if (entry.compressionMethod !== 8) {
    throw new Error(`Unsupported compression method: ${entry.compressionMethod}. Expected DEFLATE (8).`);
  }

  const compMB = (entry.compressedSize / 1024 / 1024).toFixed(0);
  const uncMB = (entry.uncompressedSize / 1024 / 1024).toFixed(0);
  report("extracting", `Found export.xml (${compMB} MB compressed → ${uncMB} MB uncompressed)`);

  const compressedData = zipData.subarray(entry.dataOffset, entry.dataOffset + entry.compressedSize);

  const compressedStream = new ReadableStream<Uint8Array>({
    start(controller) {
      let offset = 0;
      function pushChunk() {
        if (offset >= compressedData.length) {
          controller.close();
          return;
        }
        const end = Math.min(offset + FEED_CHUNK, compressedData.length);
        controller.enqueue(compressedData.subarray(offset, end));
        offset = end;
        // Yield periodically so progress messages keep flowing.
        if (offset % (FEED_CHUNK * 10) === 0) {
          setTimeout(pushChunk, 0);
        } else {
          pushChunk();
        }
      }
      pushChunk();
    },
  });

  const decompressed = compressedStream.pipeThrough(
    new DecompressionStream("deflate-raw") as any
  ) as ReadableStream<Uint8Array>;

  const aggregator = createHealthAggregator();
  const decoder = new TextDecoder("utf-8");
  const reader = decompressed.getReader();
  let bytesDecompressed = 0;
  let lastReportedPct = 0;

  report("parsing", "Starting XML analysis...", 0);

  while (true) {
    const { done, value } = await reader.read();
    if (done) break;

    bytesDecompressed += value.length;
    aggregator.ingest(decoder.decode(value, { stream: true }));

    const pct =
      entry.uncompressedSize > 0
        ? Math.min(99, Math.round((bytesDecompressed / entry.uncompressedSize) * 100))
        : Math.min(99, Math.round((bytesDecompressed / (2 * 1024 * 1024 * 1024)) * 100));
    if (pct > lastReportedPct + 2) {
      lastReportedPct = pct;
      report(
        "parsing",
        `${aggregator.stats.recordCount.toLocaleString()} records scanned, ${aggregator.stats.relevantDataPoints.toLocaleString()} relevant data points`,
        pct
      );
    }
  }

  report("finalizing", "Building aggregated results...", 95);
  const result = aggregator.finish();

  report(
    "done",
    `Parsed ${result.summary.relevantDataPoints.toLocaleString()} data points, ${result.workouts.length} workouts, ${result.buckets.length} buckets`,
    100
  );

  return result;
}
