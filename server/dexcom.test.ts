import { inspect } from "node:util";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

// axios is fully mocked: nothing in this file can reach Dexcom.
const axiosMock = vi.hoisted(() => ({ get: vi.fn(), post: vi.fn() }));
vi.mock("axios", () => ({ default: axiosMock }));

// One stored token row, served through the slice of drizzle's builder that
// getValidAccessToken uses.
const db = vi.hoisted(() => ({ row: null as null | Record<string, unknown>, updates: [] as unknown[] }));
vi.mock("./db", () => ({
  getDb: async () => ({
    select: () => ({ from: () => ({ where: () => ({ limit: async () => (db.row ? [db.row] : []) }) }) }),
    update: () => ({ set: (values: unknown) => ({ where: async () => void db.updates.push(values) }) }),
  }),
}));

import {
  DEXCOM_TIMEOUT_MS,
  describeDexcomError,
  exchangeCodeForTokens,
  fetchDataRange,
  fetchEgvData,
  getValidAccessToken,
  refreshAccessToken,
} from "./dexcom";

// Placeholders only.
const SECRET = "client-secret-PLACEHOLDER";
const REFRESH_TOKEN = "refresh-token-PLACEHOLDER";

/** Shaped like an axios error from the token endpoint: the body rides along in config. */
function tokenError(response?: { status: number; data?: unknown }) {
  return Object.assign(new Error(response ? "Request failed with status code 400" : "connect ETIMEDOUT 104.18.40.46:443"), {
    code: response ? "ERR_BAD_REQUEST" : "ETIMEDOUT",
    config: {
      url: "https://sandbox-api.dexcom.com/v3/oauth2/token",
      data: `client_id=abc&client_secret=${SECRET}&refresh_token=${REFRESH_TOKEN}&grant_type=refresh_token`,
    },
    request: { _header: "POST /v3/oauth2/token HTTP/1.1" },
    response,
  });
}

describe("describeDexcomError", () => {
  it("summarises an HTTP failure from Dexcom's own error body, not the request", () => {
    const line = describeDexcomError(
      tokenError({ status: 400, data: { error: "invalid_grant", error_description: "Refresh token is expired" } })
    );
    expect(line).toBe("HTTP 400: Refresh token is expired");
  });

  it("summarises a network failure by its code", () => {
    expect(describeDexcomError(tokenError())).toBe("ETIMEDOUT: connect ETIMEDOUT 104.18.40.46:443");
  });

  it("never includes the client secret or tokens", () => {
    for (const err of [tokenError(), tokenError({ status: 401 }), tokenError({ status: 500, data: "<html>Bad gateway</html>" })]) {
      const line = describeDexcomError(err);
      expect(line).not.toContain(SECRET);
      expect(line).not.toContain(REFRESH_TOKEN);
    }
  });

  it("copes with values that aren't errors at all", () => {
    expect(describeDexcomError(undefined)).toBe("unknown error");
    expect(describeDexcomError("boom")).toBe("unknown error");
  });
});

describe("a failed token refresh", () => {
  let logged: string[];
  beforeEach(() => {
    db.row = { accessToken: "old-access", refreshToken: REFRESH_TOKEN, expiresAt: new Date(Date.now() - 1000) };
    db.updates = [];
    logged = [];
    // Format arguments the way console.error prints them, nested fields included.
    vi.spyOn(console, "error").mockImplementation((...args: unknown[]) =>
      void logged.push(args.map((a) => (typeof a === "string" ? a : inspect(a, { depth: 5 }))).join(" "))
    );
  });
  afterEach(() => {
    vi.restoreAllMocks();
    axiosMock.post.mockReset();
  });

  it("logs one secret-free line and reports the connection as unusable", async () => {
    axiosMock.post.mockRejectedValue(tokenError({ status: 400, data: { error: "invalid_grant" } }));
    expect(await getValidAccessToken(1, "sandbox")).toBeNull();
    expect(logged).toEqual(["[Dexcom] Failed to refresh token (sandbox): HTTP 400: invalid_grant"]);
    expect(db.updates).toHaveLength(0);
  });

  it("does the same when Dexcom can't be reached", async () => {
    axiosMock.post.mockRejectedValue(tokenError());
    expect(await getValidAccessToken(1, "production")).toBeNull();
    expect(logged).toHaveLength(1);
    expect(logged[0]).toContain("ETIMEDOUT");
    expect(logged[0]).not.toContain(SECRET);
    expect(logged[0]).not.toContain(REFRESH_TOKEN);
  });
});

describe("Dexcom request timeouts", () => {
  afterEach(() => {
    axiosMock.post.mockReset();
    axiosMock.get.mockReset();
  });

  it("puts a timeout on every call to Dexcom", async () => {
    axiosMock.post.mockResolvedValue({ data: {} });
    axiosMock.get.mockResolvedValue({ data: {} });
    await exchangeCodeForTokens("auth-code", "https://example.test/api/dexcom/callback", "sandbox");
    await refreshAccessToken("refresh", "sandbox");
    await fetchEgvData("access", "2026-10-13T00:00:00", "2026-10-14T00:00:00", "sandbox");
    await fetchDataRange("access", "sandbox");

    const configs = [
      ...axiosMock.post.mock.calls.map((call) => call[2]),
      ...axiosMock.get.mock.calls.map((call) => call[1]),
    ];
    expect(configs).toHaveLength(4);
    for (const config of configs) expect(config.timeout).toBe(DEXCOM_TIMEOUT_MS);
  });
});
