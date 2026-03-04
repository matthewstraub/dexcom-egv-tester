/**
 * Apple Health Web Worker
 *
 * Runs entirely in the browser. Extracts export.xml from a ZIP file using JSZip,
 * then parses the XML with a lightweight streaming regex-based parser.
 * Aggregates data into 15-minute buckets on-the-fly and posts progress updates
 * back to the main thread.
 *
 * This eliminates all server-side memory/timeout issues since the user's machine
 * handles the heavy lifting.
 */

import JSZip from "jszip";

// ── Types ──

interface HealthMetricDef {
  [key: string]: string;
}

const APPLE_HEALTH_METRICS: HealthMetricDef = {
  stepCount: "HKQuantityTypeIdentifierStepCount",
  heartRate: "HKQuantityTypeIdentifierHeartRate",
  restingHeartRate: "HKQuantityTypeIdentifierRestingHeartRate",
  hrv: "HKQuantityTypeIdentifierHeartRateVariabilitySDNN",
  activeEnergy: "HKQuantityTypeIdentifierActiveEnergyBurned",
  exerciseTime: "HKQuantityTypeIdentifierAppleExerciseTime",
  distance: "HKQuantityTypeIdentifierDistanceWalkingRunning",
  oxygenSaturation: "HKQuantityTypeIdentifierOxygenSaturation",
};

// Reverse lookup: HK type string -> our metric key
const HK_TYPE_TO_METRIC: Record<string, string> = {};
for (const [key, hkType] of Object.entries(APPLE_HEALTH_METRICS)) {
  HK_TYPE_TO_METRIC[hkType] = key;
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

interface RunningStats {
  count: number;
  sum: number;
  min: number;
  max: number;
}

interface WorkoutRecord {
  activityType: string;
  activityLabel: string;
  duration: number;
  totalDistance: number | null;
  distanceUnit: string | null;
  totalEnergyBurned: number | null;
  energyUnit: string | null;
  startDate: string; // ISO string
  endDate: string;
  sourceName: string;
}

interface AggregatedBucket {
  bucketStart: string;
  bucketEnd: string;
  metrics: Record<string, { avg: number; min: number; max: number; sum: number; count: number }>;
}

// ── Date parsing ──

function parseAppleHealthDate(dateStr: string): number {
  if (!dateStr) return NaN;
  const match = dateStr.match(
    /^(\d{4})-(\d{2})-(\d{2})\s+(\d{2}):(\d{2}):(\d{2})\s+([+-]\d{4})$/
  );
  if (!match) {
    return new Date(dateStr).getTime();
  }
  const [, year, month, day, hour, min, sec, tz] = match;
  const tzFormatted = tz.slice(0, 3) + ":" + tz.slice(3);
  return new Date(`${year}-${month}-${day}T${hour}:${min}:${sec}${tzFormatted}`).getTime();
}

// ── Attribute parser ──
// Fast regex-based attribute extraction from XML tags
// Handles both single and double quoted attributes

function extractAttr(tag: string, name: string): string {
  // Try double quotes first (most common)
  const dqRegex = new RegExp(`${name}="([^"]*)"`, "i");
  const dqMatch = tag.match(dqRegex);
  if (dqMatch) return dqMatch[1];

  // Try single quotes
  const sqRegex = new RegExp(`${name}='([^']*)'`, "i");
  const sqMatch = tag.match(sqRegex);
  if (sqMatch) return sqMatch[1];

  return "";
}

// ── Main processing ──

const BUCKET_MS = 15 * 60 * 1000; // 15-minute buckets

function postProgress(stage: string, detail: string, pct?: number) {
  self.postMessage({ type: "progress", stage, detail, pct });
}

async function processFile(file: File) {
  try {
    // Stage 1: Extract XML from ZIP
    postProgress("extracting", "Reading ZIP file...");

    const zip = await JSZip.loadAsync(file, {
      // Progress callback for ZIP loading
      // @ts-ignore - JSZip supports this
    });

    // Find export.xml
    let xmlFile: JSZip.JSZipObject | null = null;
    for (const [path, entry] of Object.entries(zip.files)) {
      if (
        path === "export.xml" ||
        path === "apple_health_export/export.xml" ||
        path.endsWith("/export.xml")
      ) {
        xmlFile = entry;
        break;
      }
    }

    if (!xmlFile) {
      throw new Error(
        "Could not find export.xml in the ZIP file. Please ensure this is an Apple Health export."
      );
    }

    postProgress("extracting", "Extracting export.xml from ZIP...");

    // Get the XML as a string — we'll process it in chunks
    // For very large files, we use the streaming approach
    const xmlText = await xmlFile.async("string");
    const totalLength = xmlText.length;

    postProgress(
      "parsing",
      `Parsing ${(totalLength / 1024 / 1024).toFixed(0)} MB of XML...`,
      0
    );

    // Stage 2: Parse XML using regex-based chunked approach
    // This is much faster than a full SAX parser for our use case since
    // we only care about <Record> and <Workout> self-closing tags

    const bucketMap = new Map<number, Map<string, RunningStats>>();
    const workouts: WorkoutRecord[] = [];
    let minDate = Infinity;
    let maxDate = -Infinity;
    let totalRecords = 0;
    let relevantDataPoints = 0;
    const metricsSet = new Set<string>();

    // Process Record tags
    const recordRegex = /<Record\s[^>]*?\/>/gi;
    const workoutRegex = /<Workout\s[^>]*?(?:\/>|>)/gi;

    // Process in chunks to avoid blocking the main thread
    const CHUNK_SIZE = 5 * 1024 * 1024; // 5MB chunks
    let lastProgressPct = 0;

    // First pass: find all Record tags
    let match: RegExpExecArray | null;
    let searchStart = 0;

    while (searchStart < totalLength) {
      const chunkEnd = Math.min(searchStart + CHUNK_SIZE, totalLength);
      // Extend chunk to include any partial tag at the boundary
      let actualEnd = chunkEnd;
      if (chunkEnd < totalLength) {
        const nextClose = xmlText.indexOf("/>", chunkEnd);
        if (nextClose !== -1 && nextClose - chunkEnd < 10000) {
          actualEnd = nextClose + 2;
        }
      }

      const chunk = xmlText.substring(searchStart, actualEnd);

      // Process Record tags in this chunk
      recordRegex.lastIndex = 0;
      while ((match = recordRegex.exec(chunk)) !== null) {
        totalRecords++;
        const tag = match[0];

        const type = extractAttr(tag, "type");
        const metricKey = HK_TYPE_TO_METRIC[type];
        if (!metricKey) continue;

        const startDateStr = extractAttr(tag, "startDate");
        const valueStr = extractAttr(tag, "value");
        const startTime = parseAppleHealthDate(startDateStr);
        const value = parseFloat(valueStr);

        if (isNaN(startTime) || isNaN(value)) continue;

        // Track date range
        if (startTime < minDate) minDate = startTime;
        const endDateStr = extractAttr(tag, "endDate");
        const endTime = parseAppleHealthDate(endDateStr);
        const effectiveEnd = isNaN(endTime) ? startTime : endTime;
        if (effectiveEnd > maxDate) maxDate = effectiveEnd;

        metricsSet.add(metricKey);
        relevantDataPoints++;

        // Aggregate into bucket
        const bucketKey = Math.floor(startTime / BUCKET_MS) * BUCKET_MS;
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

      // Process Workout tags in this chunk
      workoutRegex.lastIndex = 0;
      while ((match = workoutRegex.exec(chunk)) !== null) {
        const tag = match[0];

        const activityType = extractAttr(tag, "workoutActivityType");
        const startDateStr = extractAttr(tag, "startDate");
        const endDateStr = extractAttr(tag, "endDate");
        const duration = parseFloat(extractAttr(tag, "duration") || "0");
        const totalDistance = parseFloat(extractAttr(tag, "totalDistance") || "");
        const distanceUnit = extractAttr(tag, "totalDistanceUnit") || null;
        const totalEnergy = parseFloat(extractAttr(tag, "totalEnergyBurned") || "");
        const energyUnit = extractAttr(tag, "totalEnergyBurnedUnit") || null;
        const sourceName = extractAttr(tag, "sourceName") || "";

        const startTime = parseAppleHealthDate(startDateStr);
        const endTime = parseAppleHealthDate(endDateStr);

        if (isNaN(startTime)) continue;

        workouts.push({
          activityType,
          activityLabel:
            WORKOUT_TYPE_LABELS[activityType] ||
            activityType.replace("HKWorkoutActivityType", ""),
          duration,
          totalDistance: isNaN(totalDistance) ? null : totalDistance,
          distanceUnit,
          totalEnergyBurned: isNaN(totalEnergy) ? null : totalEnergy,
          energyUnit,
          startDate: new Date(startTime).toISOString(),
          endDate: isNaN(endTime) ? new Date(startTime).toISOString() : new Date(endTime).toISOString(),
          sourceName,
        });
      }

      searchStart = actualEnd;

      // Report progress
      const pct = Math.round((searchStart / totalLength) * 100);
      if (pct > lastProgressPct + 2) {
        lastProgressPct = pct;
        postProgress(
          "parsing",
          `Parsed ${relevantDataPoints.toLocaleString()} data points from ${totalRecords.toLocaleString()} records...`,
          pct
        );
      }
    }

    postProgress("finalizing", "Building aggregated buckets...", 95);

    // Stage 3: Convert bucket map to sorted array
    const sortedKeys = Array.from(bucketMap.keys()).sort((a, b) => a - b);
    const buckets: AggregatedBucket[] = sortedKeys.map((key) => {
      const metrics = bucketMap.get(key)!;
      const bucket: AggregatedBucket = {
        bucketStart: new Date(key).toISOString(),
        bucketEnd: new Date(key + BUCKET_MS).toISOString(),
        metrics: {},
      };
      for (const [metric, stats] of Array.from(metrics.entries())) {
        bucket.metrics[metric] = {
          avg: stats.sum / stats.count,
          min: stats.min,
          max: stats.max,
          sum: stats.sum,
          count: stats.count,
        };
      }
      return bucket;
    });

    // Build summary
    const summary = {
      recordCount: totalRecords,
      relevantDataPoints,
      workoutCount: workouts.length,
      metricsFound: Array.from(metricsSet),
      dateRange:
        minDate !== Infinity && maxDate !== -Infinity
          ? {
              start: new Date(minDate).toISOString(),
              end: new Date(maxDate).toISOString(),
            }
          : null,
      bucketCount: buckets.length,
    };

    postProgress(
      "done",
      `Parsed ${relevantDataPoints.toLocaleString()} data points, ${workouts.length} workouts, ${buckets.length} buckets`,
      100
    );

    // Send results back to main thread
    self.postMessage({
      type: "result",
      summary,
      buckets,
      workouts,
    });
  } catch (err: any) {
    self.postMessage({
      type: "error",
      message: err.message || "Failed to parse Apple Health export",
    });
  }
}

// ── Worker message handler ──

self.onmessage = (e: MessageEvent) => {
  if (e.data.type === "parse") {
    processFile(e.data.file);
  }
};
