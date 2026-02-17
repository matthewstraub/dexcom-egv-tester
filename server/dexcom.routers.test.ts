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

function createAuthContext(): TrpcContext {
  return {
    user: {
      id: 1,
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
    await expect(caller.dexcom.status()).rejects.toThrow();
  });

  it("dexcom.disconnect requires authentication", async () => {
    const caller = appRouter.createCaller(createUnauthContext());
    await expect(caller.dexcom.disconnect()).rejects.toThrow();
  });

  it("dexcom.egvs requires authentication", async () => {
    const caller = appRouter.createCaller(createUnauthContext());
    await expect(
      caller.dexcom.egvs({ startDate: "2024-01-01T00:00:00", endDate: "2024-01-02T00:00:00" })
    ).rejects.toThrow();
  });

  it("dexcom.status returns disconnected for user with no tokens", async () => {
    const caller = appRouter.createCaller(createAuthContext());
    const result = await caller.dexcom.status();
    expect(result).toHaveProperty("connected");
    expect(result.connected).toBe(false);
  });
});
