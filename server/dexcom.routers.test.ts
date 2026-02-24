import { describe, expect, it } from "vitest";
import { appRouter } from "./routers";
import type { TrpcContext } from "./_core/context";

/**
 * In single-user mode, all procedures are public (no auth required).
 * We use a null user context since the app no longer requires authentication.
 */
function createPublicContext(): TrpcContext {
  return {
    user: null,
    req: { protocol: "https", headers: {} } as TrpcContext["req"],
    res: { clearCookie: () => {} } as unknown as TrpcContext["res"],
  };
}

describe("dexcom routers (single-user mode)", () => {
  it("dexcom.status works without authentication (sandbox)", async () => {
    const caller = appRouter.createCaller(createPublicContext());
    const result = await caller.dexcom.status({ env: "sandbox" });
    expect(result).toHaveProperty("connected");
    expect(result).toHaveProperty("environment");
    expect(result.environment).toBe("sandbox");
  });

  it("dexcom.status works without authentication (production)", async () => {
    const caller = appRouter.createCaller(createPublicContext());
    const result = await caller.dexcom.status({ env: "production" });
    expect(result).toHaveProperty("connected");
    expect(result.environment).toBe("production");
  });

  it("dexcom.status defaults to sandbox when env not provided", async () => {
    const caller = appRouter.createCaller(createPublicContext());
    const result = await caller.dexcom.status();
    expect(result.environment).toBe("sandbox");
  });

  it("dexcom.disconnect works without authentication", async () => {
    const caller = appRouter.createCaller(createPublicContext());
    const result = await caller.dexcom.disconnect({ env: "sandbox" });
    expect(result).toEqual({ success: true });
  });

  it("dexcom.egvs rejects date range exceeding 30 days", async () => {
    const caller = appRouter.createCaller(createPublicContext());
    await expect(
      caller.dexcom.egvs({
        startDate: "2024-01-01T00:00:00",
        endDate: "2024-02-15T00:00:00",
        env: "sandbox",
      })
    ).rejects.toThrow(/exceeds the Dexcom API maximum of 30 days/);
  });

  it("dexcom.egvs rejects when startDate is after endDate", async () => {
    const caller = appRouter.createCaller(createPublicContext());
    await expect(
      caller.dexcom.egvs({
        startDate: "2024-01-15T00:00:00",
        endDate: "2024-01-10T00:00:00",
        env: "sandbox",
      })
    ).rejects.toThrow(/startDate must be before endDate/);
  });

  it("dexcom.egvs rejects invalid date format", async () => {
    const caller = appRouter.createCaller(createPublicContext());
    await expect(
      caller.dexcom.egvs({
        startDate: "not-a-date",
        endDate: "2024-01-10T00:00:00",
        env: "sandbox",
      })
    ).rejects.toThrow(/Invalid date format/);
  });

  it("dexcom.egvs returns 'Not connected' when no tokens exist", async () => {
    // First disconnect to ensure no tokens exist for sandbox
    const caller = appRouter.createCaller(createPublicContext());
    await caller.dexcom.disconnect({ env: "sandbox" });
    await caller.dexcom.disconnect({ env: "production" });
    await expect(
      caller.dexcom.egvs({
        startDate: "2024-01-01T00:00:00",
        endDate: "2024-01-02T00:00:00",
        env: "sandbox",
      })
    ).rejects.toThrow(/Not connected to Dexcom/);
  });

  it("auth.me returns null in single-user mode", async () => {
    const caller = appRouter.createCaller(createPublicContext());
    const result = await caller.auth.me();
    expect(result).toBeNull();
  });
});
