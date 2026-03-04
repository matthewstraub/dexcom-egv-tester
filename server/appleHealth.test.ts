import { describe, expect, it } from "vitest";
import {
  aggregateIntoBuckets,
  pearsonCorrelation,
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
    // Constant y means no correlation
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
    // Only first 3 elements used: [1,2,3] vs [2,4,6] → r = 1
    expect(r).toBeCloseTo(1, 5);
  });

  it("computes a moderate positive correlation", () => {
    // Some noise in the data
    const x = [1, 2, 3, 4, 5, 6, 7, 8, 9, 10];
    const y = [2, 3, 2, 5, 4, 7, 6, 9, 8, 10];
    const r = pearsonCorrelation(x, y);
    expect(r).toBeGreaterThan(0.8);
    expect(r).toBeLessThan(1);
  });
});

// ── aggregateIntoBuckets ────────────────────────────────────────────

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
        startDate: new Date(baseTime.getTime() + 5 * 60000), // 5 min later, same bucket
        endDate: new Date(baseTime.getTime() + 6 * 60000),
        sourceName: "Apple Watch",
      },
      {
        metric: "heartRate" as AppleHealthMetricKey,
        value: 90,
        unit: "count/min",
        startDate: new Date(baseTime.getTime() + 20 * 60000), // 20 min later, next bucket
        endDate: new Date(baseTime.getTime() + 21 * 60000),
        sourceName: "Apple Watch",
      },
    ];

    const result = aggregateIntoBuckets(dataPoints, 15);

    expect(result).toHaveLength(2);

    // First bucket: 10:00-10:15 with values 70, 80
    const firstBucket = result[0];
    expect(firstBucket.metrics.heartRate).toBeDefined();
    expect(firstBucket.metrics.heartRate!.avg).toBe(75);
    expect(firstBucket.metrics.heartRate!.min).toBe(70);
    expect(firstBucket.metrics.heartRate!.max).toBe(80);
    expect(firstBucket.metrics.heartRate!.sum).toBe(150);
    expect(firstBucket.metrics.heartRate!.count).toBe(2);

    // Second bucket: 10:15-10:30 with value 90
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

    // Add data points every 10 minutes for 1 hour
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

    // With 30-minute buckets, should get 2 buckets
    const result = aggregateIntoBuckets(dataPoints, 30);
    expect(result).toHaveLength(2);

    // First bucket: 10:00-10:30 with 3 values (70, 71, 72)
    expect(result[0].metrics.heartRate!.count).toBe(3);
    expect(result[0].metrics.heartRate!.avg).toBeCloseTo(71, 1);

    // Second bucket: 10:30-11:00 with 3 values (73, 74, 75)
    expect(result[1].metrics.heartRate!.count).toBe(3);
    expect(result[1].metrics.heartRate!.avg).toBeCloseTo(74, 1);
  });
});

// ── tRPC appleHealth router ─────────────────────────────────────────

describe("appleHealth tRPC router", () => {
  it("status returns uploaded: false when no data is loaded", async () => {
    // Import the router
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
