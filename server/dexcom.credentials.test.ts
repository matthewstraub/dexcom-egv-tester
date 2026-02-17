import { describe, expect, it } from "vitest";

describe("Dexcom credentials", () => {
  it("DEXCOM_CLIENT_ID is set and non-empty", () => {
    const clientId = process.env.DEXCOM_CLIENT_ID;
    expect(clientId).toBeDefined();
    expect(clientId).not.toBe("");
    expect(typeof clientId).toBe("string");
  });

  it("DEXCOM_CLIENT_SECRET is set and non-empty", () => {
    const clientSecret = process.env.DEXCOM_CLIENT_SECRET;
    expect(clientSecret).toBeDefined();
    expect(clientSecret).not.toBe("");
    expect(typeof clientSecret).toBe("string");
  });
});
