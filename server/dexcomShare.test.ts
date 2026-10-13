import { describe, expect, it, vi } from "vitest";
import {
  AUTH_REJECTED_PAUSE_MS,
  AUTH_UNREACHABLE_PAUSE_MS,
  CACHE_TTL_MS,
  SHARE_APPLICATION_ID,
  SHARE_ENDPOINTS,
  SHARE_MAX_COUNT,
  SHARE_MAX_MINUTES,
  createShareClient,
  getLatestShareResult,
  mapShareTrend,
  parseShareReadings,
  type SharePost,
} from "./dexcomShare";

// Placeholders only — no real account is ever contacted by these tests.
const USERNAME = "share-user@example.com";
const PASSWORD = "share-test-password";
const ACCOUNT_ID = "11111111-2222-3333-4444-555555555555";
const SESSION_ID = "aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee";
const NULL_UUID = "00000000-0000-0000-0000-000000000000";

// 2026-10-12 20:40:00 UTC
const T0 = Date.UTC(2026, 9, 12, 20, 40, 0);

/** A reading as Share sends it: WT/ST without an offset, DT with one. */
function shareReading(ms: number, value: number, trend: unknown = "Flat", dtOffset = "-0400") {
  return { WT: `Date(${ms})`, ST: `Date(${ms})`, DT: `Date(${ms}${dtOffset})`, Value: value, Trend: trend };
}

const shareError = (code: string) => Object.assign(new Error(code), { response: { status: 500, data: { Code: code } } });
const networkError = () => Object.assign(new Error("ETIMEDOUT"), { code: "ETIMEDOUT" });

/**
 * A scripted Dexcom Share. Each endpoint gets a queue of responses; an empty
 * queue falls back to the happy path. Every call is recorded.
 */
function fakeShare(script: Partial<Record<keyof typeof SHARE_ENDPOINTS, unknown[]>> = {}) {
  const calls: Array<{ path: string; body: unknown; params?: Record<string, string | number> }> = [];
  const queues = {
    authenticate: [...(script.authenticate ?? [])],
    login: [...(script.login ?? [])],
    readings: [...(script.readings ?? [])],
  };
  const defaults = {
    authenticate: ACCOUNT_ID,
    login: SESSION_ID,
    readings: [shareReading(T0, 120)],
  };
  const post: SharePost = async (path, body, params) => {
    calls.push({ path, body, params });
    const key = (Object.keys(SHARE_ENDPOINTS) as Array<keyof typeof SHARE_ENDPOINTS>).find(
      (k) => SHARE_ENDPOINTS[k] === path
    )!;
    const next = queues[key].length > 0 ? queues[key].shift() : defaults[key];
    if (next instanceof Error) throw next;
    return next;
  };
  const count = (key: keyof typeof SHARE_ENDPOINTS) => calls.filter((c) => c.path === SHARE_ENDPOINTS[key]).length;
  return { post, calls, count };
}

function makeClient(share: ReturnType<typeof fakeShare>, clock = { t: T0 }) {
  return {
    clock,
    client: createShareClient({ post: share.post, username: USERNAME, password: PASSWORD, now: () => clock.t }),
  };
}

describe("Share sign-in and read sequence", () => {
  it("sends exactly the bodies and params Dexcom Share expects", async () => {
    const share = fakeShare();
    const { client } = makeClient(share);
    await client.getRecentReadings();

    expect(share.calls).toEqual([
      {
        path: SHARE_ENDPOINTS.authenticate,
        body: { accountName: USERNAME, password: PASSWORD, applicationId: SHARE_APPLICATION_ID },
        params: undefined,
      },
      {
        path: SHARE_ENDPOINTS.login,
        body: { accountId: ACCOUNT_ID, password: PASSWORD, applicationId: SHARE_APPLICATION_ID },
        params: undefined,
      },
      {
        path: SHARE_ENDPOINTS.readings,
        body: {},
        params: { sessionId: SESSION_ID, minutes: SHARE_MAX_MINUTES, maxCount: SHARE_MAX_COUNT },
      },
    ]);
    expect(SHARE_MAX_MINUTES).toBe(1440);
    expect(SHARE_MAX_COUNT).toBe(288);
  });

  it("reuses the session instead of signing in again", async () => {
    const share = fakeShare();
    const { client, clock } = makeClient(share);
    await client.getRecentReadings();
    clock.t += CACHE_TTL_MS + 1;
    await client.getRecentReadings();
    expect(share.count("authenticate")).toBe(1);
    expect(share.count("login")).toBe(1);
    expect(share.count("readings")).toBe(2);
  });

  it("re-signs in exactly once when the session has expired", async () => {
    const share = fakeShare({ readings: [shareError("SessionIdNotFound")] });
    const { client } = makeClient(share);
    const { readings } = await client.getRecentReadings();
    expect(readings).toHaveLength(1);
    // the account id is kept, so only the session is renewed
    expect(share.count("authenticate")).toBe(1);
    expect(share.count("login")).toBe(2);
    expect(share.count("readings")).toBe(2);
  });

  it("gives up rather than looping when the retry also fails", async () => {
    const share = fakeShare({ readings: [shareError("SessionNotValid"), shareError("SessionNotValid")] });
    const { client } = makeClient(share);
    await expect(client.getRecentReadings()).rejects.toThrow();
    expect(share.count("login")).toBe(2);
    expect(share.count("readings")).toBe(2);
  });
});

describe("Share sign-in pause (account lockout protection)", () => {
  it("stops signing in for 15 minutes after Dexcom rejects the password", async () => {
    const share = fakeShare({ authenticate: [shareError("AccountPasswordInvalid")] });
    const { client, clock } = makeClient(share);

    await expect(client.getRecentReadings()).rejects.toThrow(/rejected the Share username or password/);
    expect(client.pausedUntil()).toBe(T0 + AUTH_REJECTED_PAUSE_MS);

    // Every poll during the pause makes no request to Dexcom at all.
    const before = share.calls.length;
    for (let i = 1; i <= 14; i++) {
      clock.t = T0 + i * 60_000;
      await expect(client.getRecentReadings()).rejects.toThrow();
    }
    expect(share.calls.length).toBe(before);

    // Once it lapses, one attempt is made again.
    clock.t = T0 + AUTH_REJECTED_PAUSE_MS + 1;
    await client.getRecentReadings();
    expect(share.count("authenticate")).toBe(2);
  });

  it("treats the all-zeros account id Dexcom returns for bad credentials as a rejection", async () => {
    const share = fakeShare({ authenticate: [NULL_UUID] });
    const { client } = makeClient(share);
    await expect(client.getRecentReadings()).rejects.toThrow(/rejected/);
    expect(client.pausedUntil()).toBe(T0 + AUTH_REJECTED_PAUSE_MS);
    expect(share.count("login")).toBe(0);
  });

  it("explains a lockout Dexcom has already imposed", async () => {
    const share = fakeShare({ authenticate: [shareError("SSO_AuthenticateMaxAttemptsExceeded")] });
    const { client } = makeClient(share);
    await expect(client.getRecentReadings()).rejects.toThrow(/temporarily locked/);
  });

  it("pauses only briefly when Dexcom simply couldn't be reached", async () => {
    const share = fakeShare({ authenticate: [networkError()] });
    const { client } = makeClient(share);
    await expect(client.getRecentReadings()).rejects.toThrow(/Couldn't reach Dexcom Share/);
    expect(client.pausedUntil()).toBe(T0 + AUTH_UNREACHABLE_PAUSE_MS);
  });

  it("does not pause sign-in when a read fails for other reasons", async () => {
    const share = fakeShare({ readings: [networkError()] });
    const { client, clock } = makeClient(share);
    await expect(client.getRecentReadings()).rejects.toThrow();
    expect(client.pausedUntil()).toBe(0);
    clock.t += 1;
    await client.getRecentReadings();
    expect(share.count("authenticate")).toBe(1);
  });
});

describe("Share caching", () => {
  it("serves repeat calls within a minute from cache", async () => {
    const share = fakeShare();
    const { client, clock } = makeClient(share);
    await client.getRecentReadings();
    clock.t += CACHE_TTL_MS - 1;
    await client.getRecentReadings();
    expect(share.count("readings")).toBe(1);
    clock.t += 2;
    await client.getRecentReadings();
    expect(share.count("readings")).toBe(2);
  });

  it("collapses concurrent callers into one request", async () => {
    const share = fakeShare();
    const { client } = makeClient(share);
    const results = await Promise.all([client.getRecentReadings(), client.getRecentReadings(), client.getRecentReadings()]);
    expect(share.count("readings")).toBe(1);
    expect(new Set(results).size).toBe(1);
  });

  it("keeps the last good readings when a later read fails", async () => {
    const share = fakeShare({ readings: [[shareReading(T0, 110)], networkError()] });
    const { client, clock } = makeClient(share);
    await client.getRecentReadings();
    clock.t += CACHE_TTL_MS + 1;
    await expect(client.getRecentReadings()).rejects.toThrow();
    expect(client.lastGood()?.readings[0]?.value).toBe(110);
  });
});

describe("parseShareReadings", () => {
  it("produces official-shaped records: systemTime in UTC, displayTime with the offset", () => {
    const [r] = parseShareReadings([shareReading(T0, 142, "FortyFiveUp")]);
    expect(r).toMatchObject({
      systemTime: "2026-10-12T20:40:00.000Z",
      displayTime: "2026-10-12T16:40:00.000-04:00",
      value: 142,
      trend: "fortyFiveUp",
      trendRate: null,
      unit: "mg/dL",
      source: "share",
    });
  });

  it("matches the official API's timestamp shapes exactly", () => {
    const [r] = parseShareReadings([shareReading(T0, 100)]);
    expect(r!.systemTime).toMatch(/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/);
    expect(r!.displayTime).toMatch(/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}[+-]\d{2}:\d{2}$/);
  });

  it("handles positive and half-hour offsets", () => {
    expect(parseShareReadings([shareReading(T0, 100, "Flat", "+0530")])[0]!.displayTime).toBe(
      "2026-10-13T02:10:00.000+05:30"
    );
  });

  it("sorts oldest first and drops duplicates", () => {
    const out = parseShareReadings([
      shareReading(T0 + 600_000, 3),
      shareReading(T0, 1),
      shareReading(T0 + 300_000, 2),
      shareReading(T0, 1),
    ]);
    expect(out.map((r) => r.value)).toEqual([1, 2, 3]);
  });

  it("skips malformed entries instead of failing the whole read", () => {
    const out = parseShareReadings([
      shareReading(T0, 100),
      { WT: "garbage", Value: 100 },
      { WT: `Date(${T0 + 1})`, Value: "n/a" },
      { WT: `Date(${T0 + 2})`, Value: 0 },
      null,
    ]);
    expect(out).toHaveLength(1);
  });

  it("rejects a response that isn't a list", () => {
    expect(() => parseShareReadings({ Code: "SessionNotValid" })).toThrow();
  });
});

describe("mapShareTrend", () => {
  it("maps every Share trend name to the UI's camelCase key", () => {
    expect(mapShareTrend("DoubleUp")).toBe("doubleUp");
    expect(mapShareTrend("Flat")).toBe("flat");
    expect(mapShareTrend("FortyFiveDown")).toBe("fortyFiveDown");
    expect(mapShareTrend("NotComputable")).toBe("notComputable");
    expect(mapShareTrend("RateOutOfRange")).toBe("rateOutOfRange");
  });

  it("accepts the legacy numeric trend", () => {
    expect(mapShareTrend(4)).toBe("flat");
    expect(mapShareTrend(1)).toBe("doubleUp");
  });

  it("returns null for anything unrecognised", () => {
    expect(mapShareTrend("Sideways")).toBeNull();
    expect(mapShareTrend(42)).toBeNull();
    expect(mapShareTrend(undefined)).toBeNull();
  });
});

describe("getLatestShareResult", () => {
  it("reports not configured when no Share credentials are set", async () => {
    // Blanking these is what keeps the suite from ever calling real Dexcom,
    // even when the developer's shell has Share credentials exported.
    vi.stubEnv("DEXCOM_SHARE_USERNAME", "");
    vi.stubEnv("DEXCOM_SHARE_PASSWORD", "");
    try {
      expect(await getLatestShareResult()).toEqual({ configured: false });
    } finally {
      vi.unstubAllEnvs();
    }
  });

  it("is reachable through dexcom.latest for a viewer, and refused when signed out", async () => {
    vi.stubEnv("DEXCOM_SHARE_USERNAME", "");
    vi.stubEnv("DEXCOM_SHARE_PASSWORD", "");
    try {
      const { appRouter } = await import("./routers");
      const { createMockContext, createViewerContext } = await import("./testHelpers");
      expect(await appRouter.createCaller(createViewerContext()).dexcom.latest()).toEqual({ configured: false });
      await expect(appRouter.createCaller(createMockContext(null)).dexcom.latest()).rejects.toThrow(/Sign in required/);
    } finally {
      vi.unstubAllEnvs();
    }
  });
});
