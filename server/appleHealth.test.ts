import { describe, expect, it } from "vitest";
import { Readable } from "stream";
import {
  aggregateIntoBuckets,
  pearsonCorrelation,
  streamParseAndAggregate,
  type HealthDataPoint,
} from "./appleHealth";
import type { AppleHealthMetricKey } from "@shared/const";

// ── pearsonCorrelation ──────────────────────────────────────────────

describe("pearsonCorrelation", () => {
  it("returns 1 for perfectly correlated arrays", () => {
    const x = [1, 2, 3, 4, 5];
    const y = [2, 4, 6, 8, 10];
    const r = pearsonCorrelation(x, y);
    expect(r).toBeCloseTo(1, 5);
  });

  it("returns -1 for perfectly inversely correlated arrays", () => {
    const x = [1, 2, 3, 4, 5];
    const y = [10, 8, 6, 4, 2];
    const r = pearsonCorrelation(x, y);
    expect(r).toBeCloseTo(-1, 5);
  });

  it("returns 0 for uncorrelated arrays", () => {
    const x = [1, 2, 3, 4, 5];
    const y = [5, 5, 5, 5, 5];
    const r = pearsonCorrelation(x, y);
    expect(r).toBe(0);
  });

  it("returns 0 when arrays have fewer than 3 elements", () => {
    const r = pearsonCorrelation([1, 2], [3, 4]);
    expect(r).toBe(0);
  });

  it("handles arrays of different lengths by using the shorter length", () => {
    const x = [1, 2, 3, 4, 5, 6, 7];
    const y = [2, 4, 6];
    const r = pearsonCorrelation(x, y);
    expect(r).toBeCloseTo(1, 5);
  });

  it("computes a moderate positive correlation", () => {
    const x = [1, 2, 3, 4, 5, 6, 7, 8, 9, 10];
    const y = [2, 3, 2, 5, 4, 7, 6, 9, 8, 10];
    const r = pearsonCorrelation(x, y);
    expect(r).toBeGreaterThan(0.8);
    expect(r).toBeLessThan(1);
  });
});

// ── aggregateIntoBuckets (legacy, still used in tests) ──────────────

describe("aggregateIntoBuckets", () => {
  it("returns empty array for empty input", () => {
    const result = aggregateIntoBuckets([]);
    expect(result).toEqual([]);
  });

  it("aggregates data points into 15-minute buckets", () => {
    const baseTime = new Date("2024-01-15T10:00:00Z");
    const dataPoints: HealthDataPoint[] = [
      {
        metric: "heartRate" as AppleHealthMetricKey,
        value: 70,
        unit: "count/min",
        startDate: new Date(baseTime.getTime()),
        endDate: new Date(baseTime.getTime() + 60000),
        sourceName: "Apple Watch",
      },
      {
        metric: "heartRate" as AppleHealthMetricKey,
        value: 80,
        unit: "count/min",
        startDate: new Date(baseTime.getTime() + 5 * 60000),
        endDate: new Date(baseTime.getTime() + 6 * 60000),
        sourceName: "Apple Watch",
      },
      {
        metric: "heartRate" as AppleHealthMetricKey,
        value: 90,
        unit: "count/min",
        startDate: new Date(baseTime.getTime() + 20 * 60000),
        endDate: new Date(baseTime.getTime() + 21 * 60000),
        sourceName: "Apple Watch",
      },
    ];

    const result = aggregateIntoBuckets(dataPoints, 15);

    expect(result).toHaveLength(2);

    const firstBucket = result[0];
    expect(firstBucket.metrics.heartRate).toBeDefined();
    expect(firstBucket.metrics.heartRate!.avg).toBe(75);
    expect(firstBucket.metrics.heartRate!.min).toBe(70);
    expect(firstBucket.metrics.heartRate!.max).toBe(80);
    expect(firstBucket.metrics.heartRate!.sum).toBe(150);
    expect(firstBucket.metrics.heartRate!.count).toBe(2);

    const secondBucket = result[1];
    expect(secondBucket.metrics.heartRate).toBeDefined();
    expect(secondBucket.metrics.heartRate!.avg).toBe(90);
    expect(secondBucket.metrics.heartRate!.count).toBe(1);
  });

  it("handles multiple metrics in the same bucket", () => {
    const baseTime = new Date("2024-01-15T10:00:00Z");
    const dataPoints: HealthDataPoint[] = [
      {
        metric: "heartRate" as AppleHealthMetricKey,
        value: 72,
        unit: "count/min",
        startDate: baseTime,
        endDate: new Date(baseTime.getTime() + 60000),
        sourceName: "Apple Watch",
      },
      {
        metric: "stepCount" as AppleHealthMetricKey,
        value: 150,
        unit: "count",
        startDate: baseTime,
        endDate: new Date(baseTime.getTime() + 60000),
        sourceName: "iPhone",
      },
    ];

    const result = aggregateIntoBuckets(dataPoints, 15);

    expect(result).toHaveLength(1);
    expect(result[0].metrics.heartRate).toBeDefined();
    expect(result[0].metrics.stepCount).toBeDefined();
    expect(result[0].metrics.heartRate!.avg).toBe(72);
    expect(result[0].metrics.stepCount!.sum).toBe(150);
  });

  it("sorts buckets chronologically", () => {
    const dataPoints: HealthDataPoint[] = [
      {
        metric: "heartRate" as AppleHealthMetricKey,
        value: 80,
        unit: "count/min",
        startDate: new Date("2024-01-15T11:00:00Z"),
        endDate: new Date("2024-01-15T11:01:00Z"),
        sourceName: "Apple Watch",
      },
      {
        metric: "heartRate" as AppleHealthMetricKey,
        value: 70,
        unit: "count/min",
        startDate: new Date("2024-01-15T10:00:00Z"),
        endDate: new Date("2024-01-15T10:01:00Z"),
        sourceName: "Apple Watch",
      },
    ];

    const result = aggregateIntoBuckets(dataPoints, 15);

    expect(result).toHaveLength(2);
    const t0 = new Date(result[0].bucketStart).getTime();
    const t1 = new Date(result[1].bucketStart).getTime();
    expect(t0).toBeLessThan(t1);
  });

  it("uses custom bucket size", () => {
    const baseTime = new Date("2024-01-15T10:00:00Z");
    const dataPoints: HealthDataPoint[] = [];

    for (let i = 0; i < 6; i++) {
      dataPoints.push({
        metric: "heartRate" as AppleHealthMetricKey,
        value: 70 + i,
        unit: "count/min",
        startDate: new Date(baseTime.getTime() + i * 10 * 60000),
        endDate: new Date(baseTime.getTime() + (i * 10 + 1) * 60000),
        sourceName: "Apple Watch",
      });
    }

    const result = aggregateIntoBuckets(dataPoints, 30);
    expect(result).toHaveLength(2);
    expect(result[0].metrics.heartRate!.count).toBe(3);
    expect(result[0].metrics.heartRate!.avg).toBeCloseTo(71, 1);
    expect(result[1].metrics.heartRate!.count).toBe(3);
    expect(result[1].metrics.heartRate!.avg).toBeCloseTo(74, 1);
  });
});

// ── streamParseAndAggregate ─────────────────────────────────────────

describe("streamParseAndAggregate", () => {
  function xmlStream(xml: string): NodeJS.ReadableStream {
    return Readable.from(Buffer.from(xml));
  }

  it("parses health records from XML stream and aggregates into buckets", async () => {
    const xml = `<?xml version="1.0" encoding="UTF-8"?>
<HealthData>
  <Record type="HKQuantityTypeIdentifierHeartRate"
    startDate="2024-01-15 10:00:00 +0000"
    endDate="2024-01-15 10:01:00 +0000"
    value="72" unit="count/min" sourceName="Apple Watch" />
  <Record type="HKQuantityTypeIdentifierHeartRate"
    startDate="2024-01-15 10:05:00 +0000"
    endDate="2024-01-15 10:06:00 +0000"
    value="78" unit="count/min" sourceName="Apple Watch" />
  <Record type="HKQuantityTypeIdentifierStepCount"
    startDate="2024-01-15 10:00:00 +0000"
    endDate="2024-01-15 10:15:00 +0000"
    value="200" unit="count" sourceName="iPhone" />
</HealthData>`;

    const { summary, buckets } = await streamParseAndAggregate(xmlStream(xml));

    expect(summary.recordCount).toBe(3);
    expect(summary.relevantDataPoints).toBe(3);
    expect(summary.metricsFound).toContain("heartRate");
    expect(summary.metricsFound).toContain("stepCount");
    expect(summary.dateRange).not.toBeNull();

    // All 3 records fall in the same 15-min bucket (10:00-10:15)
    expect(buckets).toHaveLength(1);
    expect(buckets[0].metrics.heartRate).toBeDefined();
    expect(buckets[0].metrics.heartRate!.avg).toBe(75);
    expect(buckets[0].metrics.heartRate!.count).toBe(2);
    expect(buckets[0].metrics.stepCount).toBeDefined();
    expect(buckets[0].metrics.stepCount!.sum).toBe(200);
  });

  it("parses workout records from XML stream", async () => {
    const xml = `<?xml version="1.0" encoding="UTF-8"?>
<HealthData>
  <Workout workoutActivityType="HKWorkoutActivityTypeRunning"
    startDate="2024-01-15 08:00:00 +0000"
    endDate="2024-01-15 08:30:00 +0000"
    duration="30" totalDistance="3.1" totalDistanceUnit="mi"
    totalEnergyBurned="250" totalEnergyBurnedUnit="kcal"
    sourceName="Apple Watch" />
</HealthData>`;

    const { summary } = await streamParseAndAggregate(xmlStream(xml));

    expect(summary.workouts).toHaveLength(1);
    expect(summary.workouts[0].activityLabel).toBe("Running");
    expect(summary.workouts[0].duration).toBe(30);
    expect(summary.workouts[0].totalDistance).toBe(3.1);
    expect(summary.workouts[0].totalEnergyBurned).toBe(250);
  });

  it("skips irrelevant record types", async () => {
    const xml = `<?xml version="1.0" encoding="UTF-8"?>
<HealthData>
  <Record type="HKQuantityTypeIdentifierBodyMass"
    startDate="2024-01-15 10:00:00 +0000"
    endDate="2024-01-15 10:00:00 +0000"
    value="75" unit="kg" sourceName="iPhone" />
  <Record type="HKQuantityTypeIdentifierHeartRate"
    startDate="2024-01-15 10:00:00 +0000"
    endDate="2024-01-15 10:01:00 +0000"
    value="72" unit="count/min" sourceName="Apple Watch" />
</HealthData>`;

    const { summary } = await streamParseAndAggregate(xmlStream(xml));

    // 2 total records scanned, but only 1 relevant
    expect(summary.recordCount).toBe(2);
    expect(summary.relevantDataPoints).toBe(1);
    expect(summary.metricsFound).toEqual(["heartRate"]);
  });

  it("applies date filter", async () => {
    const xml = `<?xml version="1.0" encoding="UTF-8"?>
<HealthData>
  <Record type="HKQuantityTypeIdentifierHeartRate"
    startDate="2024-01-14 10:00:00 +0000"
    endDate="2024-01-14 10:01:00 +0000"
    value="70" unit="count/min" sourceName="Apple Watch" />
  <Record type="HKQuantityTypeIdentifierHeartRate"
    startDate="2024-01-15 10:00:00 +0000"
    endDate="2024-01-15 10:01:00 +0000"
    value="80" unit="count/min" sourceName="Apple Watch" />
</HealthData>`;

    const filterStart = new Date("2024-01-15T00:00:00Z");
    const { summary, buckets } = await streamParseAndAggregate(
      xmlStream(xml),
      15,
      filterStart
    );

    // Only the Jan 15 record should pass the filter
    expect(summary.relevantDataPoints).toBe(1);
    expect(buckets).toHaveLength(1);
    expect(buckets[0].metrics.heartRate!.avg).toBe(80);
  });

  it("returns empty results for empty XML", async () => {
    const xml = `<?xml version="1.0" encoding="UTF-8"?><HealthData></HealthData>`;
    const { summary, buckets } = await streamParseAndAggregate(xmlStream(xml));

    expect(summary.recordCount).toBe(0);
    expect(summary.relevantDataPoints).toBe(0);
    expect(summary.workouts).toHaveLength(0);
    expect(summary.dateRange).toBeNull();
    expect(buckets).toHaveLength(0);
  });

  it("uses custom bucket size", async () => {
    const xml = `<?xml version="1.0" encoding="UTF-8"?>
<HealthData>
  <Record type="HKQuantityTypeIdentifierHeartRate"
    startDate="2024-01-15 10:00:00 +0000"
    endDate="2024-01-15 10:01:00 +0000"
    value="70" unit="count/min" sourceName="Apple Watch" />
  <Record type="HKQuantityTypeIdentifierHeartRate"
    startDate="2024-01-15 10:20:00 +0000"
    endDate="2024-01-15 10:21:00 +0000"
    value="80" unit="count/min" sourceName="Apple Watch" />
  <Record type="HKQuantityTypeIdentifierHeartRate"
    startDate="2024-01-15 10:40:00 +0000"
    endDate="2024-01-15 10:41:00 +0000"
    value="90" unit="count/min" sourceName="Apple Watch" />
</HealthData>`;

    // With 30-min buckets: first two in one bucket, third in another
    const { buckets } = await streamParseAndAggregate(xmlStream(xml), 30);
    expect(buckets).toHaveLength(2);
    expect(buckets[0].metrics.heartRate!.count).toBe(2);
    expect(buckets[0].metrics.heartRate!.avg).toBe(75);
    expect(buckets[1].metrics.heartRate!.count).toBe(1);
    expect(buckets[1].metrics.heartRate!.avg).toBe(90);
  });
});

// ── tRPC appleHealth router ─────────────────────────────────────────

describe("appleHealth tRPC router", () => {
  it("status returns uploaded: false when no data is loaded", async () => {
    const { appRouter } = await import("./routers");
    const { createMockContext } = await import("./testHelpers");

    const ctx = createMockContext();
    const caller = appRouter.createCaller(ctx);

    const status = await caller.appleHealth.status();
    expect(status.uploaded).toBe(false);
  });

  it("buckets returns empty array when no data is loaded", async () => {
    const { appRouter } = await import("./routers");
    const { createMockContext } = await import("./testHelpers");

    const ctx = createMockContext();
    const caller = appRouter.createCaller(ctx);

    const buckets = await caller.appleHealth.buckets();
    expect(buckets).toEqual([]);
  });

  it("workouts returns empty array when no data is loaded", async () => {
    const { appRouter } = await import("./routers");
    const { createMockContext } = await import("./testHelpers");

    const ctx = createMockContext();
    const caller = appRouter.createCaller(ctx);

    const workouts = await caller.appleHealth.workouts();
    expect(workouts).toEqual([]);
  });

  it("correlations returns empty when no health data is loaded", async () => {
    const { appRouter } = await import("./routers");
    const { createMockContext } = await import("./testHelpers");

    const ctx = createMockContext();
    const caller = appRouter.createCaller(ctx);

    const result = await caller.appleHealth.correlations({
      egvData: [
        { systemTime: "2024-01-15T10:00:00Z", value: 120 },
        { systemTime: "2024-01-15T10:15:00Z", value: 130 },
      ],
    });

    expect(result.correlations).toEqual([]);
  });

  it("clear returns success", async () => {
    const { appRouter } = await import("./routers");
    const { createMockContext } = await import("./testHelpers");

    const ctx = createMockContext();
    const caller = appRouter.createCaller(ctx);

    const result = await caller.appleHealth.clear();
    expect(result).toEqual({ success: true });
  });
});
