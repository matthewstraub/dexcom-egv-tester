import sax from "sax";
import AdmZip from "adm-zip";
import { Readable } from "stream";
import { APPLE_HEALTH_METRICS, type AppleHealthMetricKey } from "@shared/const";

/**
 * A single parsed health data point.
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
 * Aggregated health data for a time bucket (e.g., 15-minute or 1-hour window).
 */
export interface AggregatedBucket {
  bucketStart: string; // ISO string
  bucketEnd: string;
  metrics: Partial<Record<AppleHealthMetricKey, { avg: number; min: number; max: number; sum: number; count: number }>>;
}

/**
 * Full parsed result from an Apple Health export.
 */
export interface AppleHealthParseResult {
  dataPoints: HealthDataPoint[];
  workouts: WorkoutRecord[];
  dateRange: { start: Date; end: Date } | null;
  recordCount: number;
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
  // Format: "2024-01-15 09:30:00 -0500" or "2024-01-15 09:30:00 +0000"
  const match = dateStr.match(
    /^(\d{4})-(\d{2})-(\d{2})\s+(\d{2}):(\d{2}):(\d{2})\s+([+-]\d{4})$/
  );
  if (!match) {
    // Try ISO format fallback
    return new Date(dateStr);
  }
  const [, year, month, day, hour, min, sec, tz] = match;
  // Convert to ISO format: 2024-01-15T09:30:00-05:00
  const tzFormatted = tz.slice(0, 3) + ":" + tz.slice(3);
  return new Date(`${year}-${month}-${day}T${hour}:${min}:${sec}${tzFormatted}`);
}

/**
 * Extract the XML content from an Apple Health export ZIP file.
 * Returns a Buffer of the export.xml content.
 */
export function extractXmlFromZip(zipBuffer: Buffer): Buffer {
  const zip = new AdmZip(zipBuffer);
  const entries = zip.getEntries();

  // Look for export.xml (may be in apple_health_export/ directory)
  const xmlEntry = entries.find(
    (e) =>
      e.entryName === "export.xml" ||
      e.entryName === "apple_health_export/export.xml" ||
      e.entryName.endsWith("/export.xml")
  );

  if (!xmlEntry) {
    throw new Error(
      "Could not find export.xml in the ZIP file. Please ensure this is an Apple Health export."
    );
  }

  return xmlEntry.getData();
}

/**
 * Parse Apple Health XML using a streaming SAX parser.
 * Filters records to only the metrics we care about, within an optional date range.
 */
export function parseAppleHealthXml(
  xmlBuffer: Buffer,
  filterStartDate?: Date,
  filterEndDate?: Date
): Promise<AppleHealthParseResult> {
  return new Promise((resolve, reject) => {
    const parser = sax.createStream(false, {
      trim: true,
      normalize: true,
      lowercase: true,
    });

    const dataPoints: HealthDataPoint[] = [];
    const workouts: WorkoutRecord[] = [];
    let minDate: Date | null = null;
    let maxDate: Date | null = null;
    let totalRecords = 0;
    const metricsSet = new Set<AppleHealthMetricKey>();

    parser.on("opentag", (node: sax.Tag) => {
      const tagName = node.name.toLowerCase();

      if (tagName === "record") {
        totalRecords++;
        const type = node.attributes.type || node.attributes.TYPE;
        const metricKey = HK_TYPE_TO_METRIC[type as string];

        if (!metricKey) return; // Skip types we don't care about

        const startDateStr = (node.attributes.startdate || node.attributes.STARTDATE || "") as string;
        const endDateStr = (node.attributes.enddate || node.attributes.ENDDATE || "") as string;
        const valueStr = (node.attributes.value || node.attributes.VALUE || "") as string;
        const unit = (node.attributes.unit || node.attributes.UNIT || "") as string;
        const sourceName = (node.attributes.sourcename || node.attributes.SOURCENAME || "") as string;

        const startDate = parseAppleHealthDate(startDateStr);
        const endDate = parseAppleHealthDate(endDateStr);
        const value = parseFloat(valueStr);

        if (isNaN(startDate.getTime()) || isNaN(value)) return;

        // Apply date filter if provided
        if (filterStartDate && startDate < filterStartDate) return;
        if (filterEndDate && endDate > filterEndDate) return;

        // Track date range
        if (!minDate || startDate < minDate) minDate = startDate;
        if (!maxDate || endDate > maxDate) maxDate = endDate;

        metricsSet.add(metricKey);

        dataPoints.push({
          metric: metricKey,
          value,
          unit,
          startDate,
          endDate,
          sourceName,
        });
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

        // Apply date filter
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
      // SAX parser is lenient — log and continue
      console.warn("[AppleHealth] SAX parse warning:", err.message);
      (parser as any).resume();
    });

    parser.on("end", () => {
      resolve({
        dataPoints,
        workouts,
        dateRange: minDate && maxDate ? { start: minDate, end: maxDate } : null,
        recordCount: totalRecords,
        metricsFound: Array.from(metricsSet),
      });
    });

    // Stream the buffer through the parser
    const readable = Readable.from(xmlBuffer);
    readable.pipe(parser);
  });
}

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
    // Bucket by the start of the time window
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

  // Convert to sorted array
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
