import sax from "sax";
import { Readable } from "stream";
import { APPLE_HEALTH_METRICS, type AppleHealthMetricKey } from "@shared/const";
import yauzl from "yauzl";
import fs from "fs";
import path from "path";
import os from "os";

/**
 * A single parsed health data point.
 * Only used in tests and for the public interface — during streaming parse,
 * we aggregate on-the-fly to avoid accumulating millions of objects.
 */
export interface HealthDataPoint {
  metric: AppleHealthMetricKey;
  value: number;
  unit: string;
  startDate: Date;
  endDate: Date;
  sourceName: string;
}

/**
 * A parsed workout record.
 */
export interface WorkoutRecord {
  activityType: string;
  activityLabel: string;
  duration: number; // minutes
  totalDistance: number | null;
  distanceUnit: string | null;
  totalEnergyBurned: number | null;
  energyUnit: string | null;
  startDate: Date;
  endDate: Date;
  sourceName: string;
}

/**
 * Running statistics accumulator for a single metric in a bucket.
 * Uses Welford's online algorithm to avoid storing all values.
 */
interface RunningStats {
  count: number;
  sum: number;
  min: number;
  max: number;
  // For computing average: sum / count
}

/**
 * Aggregated health data for a time bucket (e.g., 15-minute window).
 */
export interface AggregatedBucket {
  bucketStart: string; // ISO string
  bucketEnd: string;
  metrics: Partial<Record<AppleHealthMetricKey, { avg: number; min: number; max: number; sum: number; count: number }>>;
}

/**
 * Lightweight summary of a parse (no raw data points stored).
 */
export interface AppleHealthParseSummary {
  workouts: WorkoutRecord[];
  dateRange: { start: Date; end: Date } | null;
  recordCount: number;
  relevantDataPoints: number;
  metricsFound: AppleHealthMetricKey[];
}

// Reverse lookup: HK type string -> our metric key
const HK_TYPE_TO_METRIC: Record<string, AppleHealthMetricKey> = {};
for (const [key, hkType] of Object.entries(APPLE_HEALTH_METRICS)) {
  HK_TYPE_TO_METRIC[hkType] = key as AppleHealthMetricKey;
}

// Friendly workout names
const WORKOUT_TYPE_LABELS: Record<string, string> = {
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

/**
 * Parse Apple Health date format: "2024-01-15 09:30:00 -0500"
 */
function parseAppleHealthDate(dateStr: string): Date {
  if (!dateStr) return new Date(NaN);
  const match = dateStr.match(
    /^(\d{4})-(\d{2})-(\d{2})\s+(\d{2}):(\d{2}):(\d{2})\s+([+-]\d{4})$/
  );
  if (!match) {
    return new Date(dateStr);
  }
  const [, year, month, day, hour, min, sec, tz] = match;
  const tzFormatted = tz.slice(0, 3) + ":" + tz.slice(3);
  return new Date(`${year}-${month}-${day}T${hour}:${min}:${sec}${tzFormatted}`);
}

/**
 * Extract export.xml from a ZIP file on disk using yauzl (streaming, low memory).
 * Returns a readable stream of the XML content.
 */
export function streamXmlFromZip(zipPath: string): Promise<NodeJS.ReadableStream> {
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
        reject(new Error("Could not find export.xml in the ZIP file. Please ensure this is an Apple Health export."));
      });

      zipfile.on("error", reject);
    });
  });
}

/**
 * Stream-parse Apple Health XML with on-the-fly aggregation.
 * Instead of accumulating all data points in memory, we aggregate directly
 * into time buckets during parsing. This keeps memory usage constant
 * regardless of file size.
 *
 * @param xmlStream - Readable stream of XML content
 * @param bucketMinutes - Aggregation bucket size in minutes (default 15)
 * @param filterStartDate - Optional start date filter
 * @param filterEndDate - Optional end date filter
 */
export function streamParseAndAggregate(
  xmlStream: NodeJS.ReadableStream,
  bucketMinutes: number = 15,
  filterStartDate?: Date,
  filterEndDate?: Date
): Promise<{ summary: AppleHealthParseSummary; buckets: AggregatedBucket[] }> {
  return new Promise((resolve, reject) => {
    const parser = sax.createStream(false, {
      trim: true,
      normalize: true,
      lowercase: true,
    });

    const bucketMs = bucketMinutes * 60 * 1000;

    // On-the-fly bucket aggregation — Map<bucketKey, Map<metric, RunningStats>>
    const bucketMap = new Map<number, Map<AppleHealthMetricKey, RunningStats>>();

    const workouts: WorkoutRecord[] = [];
    let minDate: Date | null = null;
    let maxDate: Date | null = null;
    let totalRecords = 0;
    let relevantDataPoints = 0;
    const metricsSet = new Set<AppleHealthMetricKey>();

    parser.on("opentag", (node: sax.Tag) => {
      const tagName = node.name.toLowerCase();

      if (tagName === "record") {
        totalRecords++;
        const type = node.attributes.type || node.attributes.TYPE;
        const metricKey = HK_TYPE_TO_METRIC[type as string];

        if (!metricKey) return;

        const startDateStr = (node.attributes.startdate || node.attributes.STARTDATE || "") as string;
        const endDateStr = (node.attributes.enddate || node.attributes.ENDDATE || "") as string;
        const valueStr = (node.attributes.value || node.attributes.VALUE || "") as string;

        const startDate = parseAppleHealthDate(startDateStr);
        const value = parseFloat(valueStr);

        if (isNaN(startDate.getTime()) || isNaN(value)) return;

        // Apply date filter
        if (filterStartDate && startDate < filterStartDate) return;
        if (filterEndDate) {
          const endDate = parseAppleHealthDate(endDateStr);
          if (!isNaN(endDate.getTime()) && endDate > filterEndDate) return;
        }

        // Track date range
        if (!minDate || startDate < minDate) minDate = startDate;
        const endDate = parseAppleHealthDate(endDateStr);
        const effectiveEnd = !isNaN(endDate.getTime()) ? endDate : startDate;
        if (!maxDate || effectiveEnd > maxDate) maxDate = effectiveEnd;

        metricsSet.add(metricKey);
        relevantDataPoints++;

        // Aggregate directly into bucket
        const bucketKey = Math.floor(startDate.getTime() / bucketMs) * bucketMs;
        if (!bucketMap.has(bucketKey)) {
          bucketMap.set(bucketKey, new Map());
        }
        const metrics = bucketMap.get(bucketKey)!;
        if (!metrics.has(metricKey)) {
          metrics.set(metricKey, { count: 0, sum: 0, min: Infinity, max: -Infinity });
        }
        const stats = metrics.get(metricKey)!;
        stats.count++;
        stats.sum += value;
        if (value < stats.min) stats.min = value;
        if (value > stats.max) stats.max = value;
      }

      if (tagName === "workout") {
        const activityType = (node.attributes.workoutactivitytype || node.attributes.WORKOUTACTIVITYTYPE || "") as string;
        const startDateStr = (node.attributes.startdate || node.attributes.STARTDATE || "") as string;
        const endDateStr = (node.attributes.enddate || node.attributes.ENDDATE || "") as string;
        const duration = parseFloat((node.attributes.duration || node.attributes.DURATION || "0") as string);
        const totalDistance = parseFloat((node.attributes.totaldistance || node.attributes.TOTALDISTANCE || "") as string);
        const distanceUnit = (node.attributes.totaldistanceunit || node.attributes.TOTALDISTANCEUNIT || null) as string | null;
        const totalEnergy = parseFloat((node.attributes.totalenergyburned || node.attributes.TOTALENERGYBURNED || "") as string);
        const energyUnit = (node.attributes.totalenergyburnedunit || node.attributes.TOTALENERGYBURNEDUNIT || null) as string | null;
        const sourceName = (node.attributes.sourcename || node.attributes.SOURCENAME || "") as string;

        const startDate = parseAppleHealthDate(startDateStr);
        const endDate = parseAppleHealthDate(endDateStr);

        if (isNaN(startDate.getTime())) return;

        if (filterStartDate && startDate < filterStartDate) return;
        if (filterEndDate && endDate > filterEndDate) return;

        workouts.push({
          activityType,
          activityLabel: WORKOUT_TYPE_LABELS[activityType] || activityType.replace("HKWorkoutActivityType", ""),
          duration,
          totalDistance: isNaN(totalDistance) ? null : totalDistance,
          distanceUnit,
          totalEnergyBurned: isNaN(totalEnergy) ? null : totalEnergy,
          energyUnit,
          startDate,
          endDate,
          sourceName,
        });
      }
    });

    parser.on("error", (err) => {
      console.warn("[AppleHealth] SAX parse warning:", err.message);
      (parser as any).resume();
    });

    parser.on("end", () => {
      // Convert bucket map to sorted array
      const sortedKeys = Array.from(bucketMap.keys()).sort((a, b) => a - b);
      const buckets: AggregatedBucket[] = sortedKeys.map((key) => {
        const metrics = bucketMap.get(key)!;
        const bucket: AggregatedBucket = {
          bucketStart: new Date(key).toISOString(),
          bucketEnd: new Date(key + bucketMs).toISOString(),
          metrics: {},
        };
        for (const [metric, stats] of Array.from(metrics.entries())) {
          (bucket.metrics as any)[metric] = {
            avg: stats.sum / stats.count,
            min: stats.min,
            max: stats.max,
            sum: stats.sum,
            count: stats.count,
          };
        }
        return bucket;
      });

      // Free the bucket map
      bucketMap.clear();

      resolve({
        summary: {
          workouts,
          dateRange: minDate && maxDate ? { start: minDate, end: maxDate } : null,
          recordCount: totalRecords,
          relevantDataPoints,
          metricsFound: Array.from(metricsSet),
        },
        buckets,
      });
    });

    xmlStream.pipe(parser);
  });
}

/**
 * Save an incoming request stream to a temporary file on disk.
 * Returns the path to the temp file.
 */
export function saveStreamToTempFile(inputStream: NodeJS.ReadableStream): Promise<{ tempPath: string; size: number }> {
  return new Promise((resolve, reject) => {
    const tempPath = path.join(os.tmpdir(), `apple-health-${Date.now()}.zip`);
    const writeStream = fs.createWriteStream(tempPath);
    let size = 0;

    inputStream.on("data", (chunk: Buffer) => {
      size += chunk.length;
    });

    inputStream.pipe(writeStream);

    writeStream.on("finish", () => resolve({ tempPath, size }));
    writeStream.on("error", (err) => {
      // Clean up on error
      fs.unlink(tempPath, () => {});
      reject(err);
    });
    inputStream.on("error", (err) => {
      writeStream.destroy();
      fs.unlink(tempPath, () => {});
      reject(err);
    });
  });
}

/**
 * Clean up a temporary file.
 */
export function cleanupTempFile(tempPath: string): void {
  fs.unlink(tempPath, (err) => {
    if (err) console.warn("[AppleHealth] Failed to clean up temp file:", err.message);
  });
}

// ── Legacy functions kept for backward compatibility with tests ──

/**
 * Aggregate health data points into time buckets for chart overlay.
 * @param dataPoints - Parsed health data points
 * @param bucketMinutes - Size of each bucket in minutes (default: 15)
 */
export function aggregateIntoBuckets(
  dataPoints: HealthDataPoint[],
  bucketMinutes: number = 15
): AggregatedBucket[] {
  if (dataPoints.length === 0) return [];

  const bucketMs = bucketMinutes * 60 * 1000;
  const bucketMap = new Map<number, Map<AppleHealthMetricKey, number[]>>();

  for (const dp of dataPoints) {
    const bucketKey = Math.floor(dp.startDate.getTime() / bucketMs) * bucketMs;
    if (!bucketMap.has(bucketKey)) {
      bucketMap.set(bucketKey, new Map());
    }
    const metrics = bucketMap.get(bucketKey)!;
    if (!metrics.has(dp.metric)) {
      metrics.set(dp.metric, []);
    }
    metrics.get(dp.metric)!.push(dp.value);
  }

  const buckets: AggregatedBucket[] = [];
  const sortedKeys = Array.from(bucketMap.keys()).sort((a, b) => a - b);

  for (const key of sortedKeys) {
    const metrics = bucketMap.get(key)!;
    const bucket: AggregatedBucket = {
      bucketStart: new Date(key).toISOString(),
      bucketEnd: new Date(key + bucketMs).toISOString(),
      metrics: {},
    };

    for (const [metric, values] of Array.from(metrics.entries())) {
      const sum = values.reduce((a: number, b: number) => a + b, 0);
      (bucket.metrics as any)[metric] = {
        avg: sum / values.length,
        min: Math.min(...values),
        max: Math.max(...values),
        sum,
        count: values.length,
      };
    }

    buckets.push(bucket);
  }

  return buckets;
}

/**
 * Calculate Pearson correlation coefficient between two arrays.
 */
export function pearsonCorrelation(x: number[], y: number[]): number {
  const n = Math.min(x.length, y.length);
  if (n < 3) return 0;

  const xSlice = x.slice(0, n);
  const ySlice = y.slice(0, n);

  const xMean = xSlice.reduce((a, b) => a + b, 0) / n;
  const yMean = ySlice.reduce((a, b) => a + b, 0) / n;

  let numerator = 0;
  let xDenomSq = 0;
  let yDenomSq = 0;

  for (let i = 0; i < n; i++) {
    const xDiff = xSlice[i] - xMean;
    const yDiff = ySlice[i] - yMean;
    numerator += xDiff * yDiff;
    xDenomSq += xDiff * xDiff;
    yDenomSq += yDiff * yDiff;
  }

  const denominator = Math.sqrt(xDenomSq * yDenomSq);
  if (denominator === 0) return 0;

  return numerator / denominator;
}
