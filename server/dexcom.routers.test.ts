import { describe, expect, it, vi } from "vitest";

// Never let these tests reach a real database. Without this, running the suite
// with DATABASE_URL set would disconnect the production Dexcom account.
vi.mock("./db", () => ({ getDb: async () => null }));

import { appRouter } from "./routers";
import { createAdminContext, createMockContext, createViewerContext } from "./testHelpers";

describe("dexcom routers — access", () => {
  it("rejects a signed-out caller", async () => {
    const caller = appRouter.createCaller(createMockContext(null));
    await expect(caller.dexcom.status({ env: "production" })).rejects.toThrow(/Sign in required/);
  });

  it("lets a viewer read connection status", async () => {
    const caller = appRouter.createCaller(createViewerContext());
    const result = await caller.dexcom.status({ env: "production" });
    expect(result).toHaveProperty("connected");
    expect(result.environment).toBe("production");
  });

  it("refuses dexcom.disconnect to a viewer", async () => {
    const caller = appRouter.createCaller(createViewerContext());
    await expect(caller.dexcom.disconnect({ env: "production" })).rejects.toThrow(/Admin password required/);
  });

  it("lets an admin through to dexcom.disconnect", async () => {
    // Passing the access check means reaching the (mocked-absent) database.
    const caller = appRouter.createCaller(createAdminContext());
    await expect(caller.dexcom.disconnect({ env: "sandbox" })).rejects.toThrow(/Database not available/);
  });
});

describe("dexcom routers — status and egvs", () => {
  it("dexcom.status reports sandbox", async () => {
    const caller = appRouter.createCaller(createViewerContext());
    const result = await caller.dexcom.status({ env: "sandbox" });
    expect(result.environment).toBe("sandbox");
  });

  it("dexcom.status defaults to sandbox when env not provided", async () => {
    const caller = appRouter.createCaller(createViewerContext());
    const result = await caller.dexcom.status();
    expect(result.environment).toBe("sandbox");
  });

  it("dexcom.egvs rejects date range exceeding 30 days", async () => {
    const caller = appRouter.createCaller(createViewerContext());
    await expect(
      caller.dexcom.egvs({
        startDate: "2024-01-01T00:00:00",
        endDate: "2024-02-15T00:00:00",
        env: "sandbox",
      })
    ).rejects.toThrow(/exceeds the Dexcom API maximum of 30 days/);
  });

  it("dexcom.egvs rejects when startDate is after endDate", async () => {
    const caller = appRouter.createCaller(createViewerContext());
    await expect(
      caller.dexcom.egvs({
        startDate: "2024-01-15T00:00:00",
        endDate: "2024-01-10T00:00:00",
        env: "sandbox",
      })
    ).rejects.toThrow(/startDate must be before endDate/);
  });

  it("dexcom.egvs rejects invalid date format", async () => {
    const caller = appRouter.createCaller(createViewerContext());
    await expect(
      caller.dexcom.egvs({
        startDate: "not-a-date",
        endDate: "2024-01-10T00:00:00",
        env: "sandbox",
      })
    ).rejects.toThrow(/Invalid date format/);
  });

  it("dexcom.egvs returns 'Not connected' when no tokens exist", async () => {
    const caller = appRouter.createCaller(createViewerContext());
    await expect(
      caller.dexcom.egvs({
        startDate: "2024-01-01T00:00:00",
        endDate: "2024-01-02T00:00:00",
        env: "sandbox",
      })
    ).rejects.toThrow(/Not connected to Dexcom/);
  });
});

describe("auth.me", () => {
  it("reports the caller's role", async () => {
    const caller = appRouter.createCaller(createViewerContext());
    const me = await caller.auth.me();
    expect(me.role).toBe("viewer");
  });

  it("reports null for a signed-out caller", async () => {
    const caller = appRouter.createCaller(createMockContext(null));
    const me = await caller.auth.me();
    expect(me.role).toBeNull();
  });
});
