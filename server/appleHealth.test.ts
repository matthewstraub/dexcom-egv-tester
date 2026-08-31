import { describe, expect, it } from "vitest";
import { pearsonCorrelation } from "./appleHealth";

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
