import { describe, expect, it } from "vitest";
import { appRouter } from "./routers";
import type { TrpcContext } from "./_core/context";

function createUnauthContext(): TrpcContext {
  return {
    user: null,
    req: { protocol: "https", headers: {} } as TrpcContext["req"],
    res: { clearCookie: () => {} } as unknown as TrpcContext["res"],
  };
}

function createAuthContext(userId = 1): TrpcContext {
  return {
    user: {
      id: userId,
      openId: "test-user",
      email: "test@example.com",
      name: "Test User",
      loginMethod: "manus",
      role: "user",
      createdAt: new Date(),
      updatedAt: new Date(),
      lastSignedIn: new Date(),
    },
    req: { protocol: "https", headers: {} } as TrpcContext["req"],
    res: { clearCookie: () => {} } as unknown as TrpcContext["res"],
  };
}

describe("dexcom routers", () => {
  it("dexcom.status requires authentication", async () => {
    const caller = appRouter.createCaller(createUnauthContext());
    await expect(caller.dexcom.status({ env: "sandbox" })).rejects.toThrow();
  });

  it("dexcom.disconnect requires authentication", async () => {
    const caller = appRouter.createCaller(createUnauthContext());
    await expect(caller.dexcom.disconnect({ env: "sandbox" })).rejects.toThrow();
  });

  it("dexcom.egvs requires authentication", async () => {
    const caller = appRouter.createCaller(createUnauthContext());
    await expect(
      caller.dexcom.egvs({ startDate: "2024-01-01T00:00:00", endDate: "2024-01-02T00:00:00", env: "sandbox" })
    ).rejects.toThrow();
  });

  it("dexcom.status returns disconnected for user with no tokens (sandbox)", async () => {
    const caller = appRouter.createCaller(createAuthContext(99999));
    const result = await caller.dexcom.status({ env: "sandbox" });
    expect(result).toHaveProperty("connected");
    expect(result.connected).toBe(false);
    expect(result.environment).toBe("sandbox");
  });

  it("dexcom.status returns disconnected for user with no tokens (production)", async () => {
    const caller = appRouter.createCaller(createAuthContext(99999));
    const result = await caller.dexcom.status({ env: "production" });
    expect(result).toHaveProperty("connected");
    expect(result.connected).toBe(false);
    expect(result.environment).toBe("production");
  });

  it("dexcom.egvs rejects date range exceeding 30 days", async () => {
    const caller = appRouter.createCaller(createAuthContext());
    await expect(
      caller.dexcom.egvs({
        startDate: "2024-01-01T00:00:00",
        endDate: "2024-02-15T00:00:00",
        env: "sandbox",
      })
    ).rejects.toThrow(/exceeds the Dexcom API maximum of 30 days/);
  });

  it("dexcom.egvs rejects when startDate is after endDate", async () => {
    const caller = appRouter.createCaller(createAuthContext());
    await expect(
      caller.dexcom.egvs({
        startDate: "2024-01-15T00:00:00",
        endDate: "2024-01-10T00:00:00",
        env: "sandbox",
      })
    ).rejects.toThrow(/startDate must be before endDate/);
  });

  it("dexcom.egvs rejects invalid date format", async () => {
    const caller = appRouter.createCaller(createAuthContext());
    await expect(
      caller.dexcom.egvs({
        startDate: "not-a-date",
        endDate: "2024-01-10T00:00:00",
        env: "sandbox",
      })
    ).rejects.toThrow(/Invalid date format/);
  });

  it("dexcom.status defaults to sandbox when env not provided", async () => {
    const caller = appRouter.createCaller(createAuthContext(99999));
    const result = await caller.dexcom.status();
    expect(result.environment).toBe("sandbox");
  });

  it("dexcom.egvs accepts production env parameter", async () => {
    const caller = appRouter.createCaller(createAuthContext());
    // Should fail with "Not connected" since no production tokens exist, but env should be accepted
    await expect(
      caller.dexcom.egvs({
        startDate: "2024-01-01T00:00:00",
        endDate: "2024-01-02T00:00:00",
        env: "production",
      })
    ).rejects.toThrow(/Not connected to Dexcom/);
  });
});
