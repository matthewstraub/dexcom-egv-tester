import axios from "axios";
import { ENV } from "./_core/env";

/**
 * Dexcom Share: the service the Dexcom Follow app reads from.
 *
 * The official developer API (dexcom.ts) delays data by an hour in the US;
 * Share has no delay, which is why Follow and every third-party live view use
 * it. It is unofficial and undocumented — the endpoints and constants below
 * come from pydexcom — and it signs in with the CGM wearer's own Dexcom
 * username and password.
 *
 * Two rules shape this module:
 *  - Dexcom locks an account after repeated failed sign-ins, which would also
 *    break the wearer's Follow app. A failed login therefore pauses all login
 *    attempts instead of retrying on the next poll.
 *  - At most one Share read per minute per server, however many tabs are open.
 */

export const SHARE_BASE_URL = "https://share2.dexcom.com/ShareWebServices/Services/";
export const SHARE_APPLICATION_ID = "d89443d2-327c-4a6f-89e5-496bbb0317db";

export const SHARE_ENDPOINTS = {
  authenticate: "General/AuthenticatePublisherAccount",
  login: "General/LoginPublisherAccountById",
  readings: "Publisher/ReadPublisherLatestGlucoseValues",
} as const;

/** Share only reaches back one day: 1440 minutes, one reading per 5 minutes. */
export const SHARE_MAX_MINUTES = 1440;
export const SHARE_MAX_COUNT = 288;

export const CACHE_TTL_MS = 60_000;
/** Pause after Dexcom rejects a sign-in. Long, to stay clear of the lockout. */
export const AUTH_REJECTED_PAUSE_MS = 15 * 60_000;
/** Pause after a sign-in attempt that never got an answer (network, timeout). */
export const AUTH_UNREACHABLE_PAUSE_MS = 2 * 60_000;

const NULL_UUID = "00000000-0000-0000-0000-000000000000";
const SESSION_ERROR_CODES = new Set(["SessionIdNotFound", "SessionNotValid"]);

/** One reading, in the same shape as an official-API EGV record, plus its source. */
export interface ShareReading {
  recordId: string;
  systemTime: string;
  displayTime: string;
  value: number;
  trend: string | null;
  trendRate: null;
  status: null;
  unit: "mg/dL";
  rateUnit: "mg/dL/min";
  displayDevice: "share";
  transmitterGeneration: "";
  source: "share";
}

export type ShareResult =
  | { configured: false }
  | {
      configured: true;
      readings: ShareReading[];
      fetchedAt: string | null;
      error?: string;
      retryAt?: string;
    };

/** Transport: resolves with the parsed JSON body, or rejects axios-style. */
export type SharePost = (
  path: string,
  body: unknown,
  params?: Record<string, string | number>
) => Promise<unknown>;

// ── Parsing ──

/**
 * Share timestamps are epoch milliseconds with an optional offset:
 * DT looks like "Date(1691455258000-0400)", while WT and ST are usually
 * plain "Date(1691455258000)". The milliseconds are UTC either way.
 */
const SHARE_DATE = /^\/?Date\((-?\d+)(?:([+-])(\d{2})(\d{2}))?\)\/?$/;

function parseShareDate(raw: unknown): { ms: number; offsetMinutes: number } | null {
  if (typeof raw !== "string") return null;
  const m = raw.match(SHARE_DATE);
  if (!m) return null;
  const offsetMinutes = m[2] ? (m[2] === "-" ? -1 : 1) * (Number(m[3]) * 60 + Number(m[4])) : 0;
  return { ms: Number(m[1]), offsetMinutes };
}

const pad = (n: number, width = 2) => String(Math.abs(n)).padStart(width, "0");

/**
 * Local wall-clock time with its offset — the same shape the official API uses
 * for displayTime, e.g. "2026-10-12T20:41:00.000-04:00".
 */
function formatWithOffset(ms: number, offsetMinutes: number): string {
  const local = new Date(ms + offsetMinutes * 60_000);
  const sign = offsetMinutes < 0 ? "-" : "+";
  return (
    `${local.getUTCFullYear()}-${pad(local.getUTCMonth() + 1)}-${pad(local.getUTCDate())}` +
    `T${pad(local.getUTCHours())}:${pad(local.getUTCMinutes())}:${pad(local.getUTCSeconds())}` +
    `.${pad(local.getUTCMilliseconds(), 3)}` +
    `${sign}${pad(Math.trunc(offsetMinutes / 60))}:${pad(offsetMinutes % 60)}`
  );
}

const TREND_NAMES = [
  "None",
  "DoubleUp",
  "SingleUp",
  "FortyFiveUp",
  "Flat",
  "FortyFiveDown",
  "SingleDown",
  "DoubleDown",
  "NotComputable",
  "RateOutOfRange",
];

/**
 * Share sends trend names in PascalCase ("FortyFiveUp"); older versions sent
 * the index as a number. Map both to the camelCase keys the UI already uses.
 */
export function mapShareTrend(raw: unknown): string | null {
  const name = typeof raw === "number" ? TREND_NAMES[raw] : typeof raw === "string" ? raw : undefined;
  if (!name || !TREND_NAMES.includes(name)) return null;
  return name.charAt(0).toLowerCase() + name.slice(1);
}

/**
 * Turn a Share response into official-shaped records, oldest first.
 * WT (wall time) becomes systemTime and DT (display time) becomes displayTime;
 * malformed entries are skipped rather than failing the whole read.
 */
export function parseShareReadings(raw: unknown): ShareReading[] {
  if (!Array.isArray(raw)) throw new Error("Unexpected response from Dexcom Share");
  const byTime = new Map<number, ShareReading>();
  for (const entry of raw) {
    const wall = parseShareDate(entry?.WT);
    const value = Number(entry?.Value);
    if (!wall || !Number.isFinite(value) || value <= 0) continue;
    const display = parseShareDate(entry?.DT) ?? wall;
    byTime.set(wall.ms, {
      recordId: `share-${wall.ms}`,
      systemTime: new Date(wall.ms).toISOString(),
      displayTime: formatWithOffset(display.ms, display.offsetMinutes),
      value: Math.round(value),
      trend: mapShareTrend(entry?.Trend),
      trendRate: null,
      status: null,
      unit: "mg/dL",
      rateUnit: "mg/dL/min",
      displayDevice: "share",
      transmitterGeneration: "",
      source: "share",
    });
  }
  return Array.from(byTime.entries())
    .sort(([a], [b]) => a - b)
    .map(([, reading]) => reading);
}

// ── Errors ──

function shareErrorCode(err: unknown): string | undefined {
  const code = (err as any)?.response?.data?.Code;
  return typeof code === "string" ? code : undefined;
}

function isSessionError(err: unknown): boolean {
  const code = shareErrorCode(err);
  return code !== undefined && SESSION_ERROR_CODES.has(code);
}

/** Dexcom answered (rejected), as opposed to never answering. */
function gotResponse(err: unknown): boolean {
  return Boolean((err as any)?.response);
}

function describeLoginFailure(err: unknown): string {
  const code = shareErrorCode(err) ?? "";
  if (/MaxAttempts/i.test(code)) {
    return "Dexcom has temporarily locked this account after too many sign-in attempts.";
  }
  if (/Password|Authenticate|Account/i.test(code) || (err as Error)?.message === "rejected") {
    return "Dexcom rejected the Share username or password.";
  }
  if (!gotResponse(err)) return "Couldn't reach Dexcom Share.";
  return "Couldn't sign in to Dexcom Share.";
}

// ── Client ──

export function createShareClient({
  post,
  username,
  password,
  now = Date.now,
}: {
  post: SharePost;
  username: string;
  password: string;
  now?: () => number;
}) {
  let accountId: string | null = null;
  let sessionId: string | null = null;
  let pausedUntil = 0;
  let pauseReason = "";
  let lastGood: { readings: ShareReading[]; at: number } | null = null;
  let inFlight: Promise<{ readings: ShareReading[]; at: number }> | null = null;

  async function signIn(): Promise<string> {
    if (now() < pausedUntil) throw new Error(pauseReason);
    try {
      if (!accountId) {
        const id = await post(SHARE_ENDPOINTS.authenticate, {
          accountName: username,
          password,
          applicationId: SHARE_APPLICATION_ID,
        });
        if (typeof id !== "string" || id === NULL_UUID) throw new Error("rejected");
        accountId = id;
      }
      const sid = await post(SHARE_ENDPOINTS.login, {
        accountId,
        password,
        applicationId: SHARE_APPLICATION_ID,
      });
      if (typeof sid !== "string" || sid === NULL_UUID) throw new Error("rejected");
      sessionId = sid;
      return sid;
    } catch (err) {
      // Never retry a failed sign-in on the next poll — see the module comment.
      accountId = null;
      sessionId = null;
      const rejected = gotResponse(err) || (err as Error)?.message === "rejected";
      pausedUntil = now() + (rejected ? AUTH_REJECTED_PAUSE_MS : AUTH_UNREACHABLE_PAUSE_MS);
      pauseReason = describeLoginFailure(err);
      console.warn(
        `[Share] Sign-in failed (${shareErrorCode(err) ?? (rejected ? "rejected" : "unreachable")}); ` +
          `pausing sign-in attempts for ${rejected ? 15 : 2} minutes`
      );
      throw new Error(pauseReason);
    }
  }

  const read = (sid: string) =>
    post(SHARE_ENDPOINTS.readings, {}, {
      sessionId: sid,
      minutes: SHARE_MAX_MINUTES,
      maxCount: SHARE_MAX_COUNT,
    });

  async function fetchFresh() {
    let sid = sessionId ?? (await signIn());
    let raw: unknown;
    try {
      raw = await read(sid);
    } catch (err) {
      if (!isSessionError(err)) throw err;
      // An expired session: one fresh sign-in and one retry, never more.
      sessionId = null;
      sid = await signIn();
      raw = await read(sid);
    }
    const readings = parseShareReadings(raw);
    lastGood = { readings, at: now() };
    return lastGood;
  }

  return {
    /** The last 24 hours of readings, cached for a minute. */
    async getRecentReadings(): Promise<{ readings: ShareReading[]; at: number }> {
      if (lastGood && now() - lastGood.at < CACHE_TTL_MS) return lastGood;
      inFlight ??= fetchFresh().finally(() => {
        inFlight = null;
      });
      return inFlight;
    },
    /** Readings from the last successful fetch, however old. */
    lastGood: () => lastGood,
    /** When sign-in attempts resume, or 0 if they aren't paused. */
    pausedUntil: () => (now() < pausedUntil ? pausedUntil : 0),
  };
}

// ── Server singleton ──

const axiosPost: SharePost = async (path, body, params) => {
  const response = await axios.post(`${SHARE_BASE_URL}${path}`, body, {
    params,
    timeout: 10_000,
    headers: { "Content-Type": "application/json", Accept: "application/json" },
  });
  return response.data;
};

let client: ReturnType<typeof createShareClient> | null = null;

export function isShareConfigured(): boolean {
  return Boolean(ENV.dexcomShareUsername && ENV.dexcomSharePassword);
}

/**
 * For the dexcom.latest procedure. Never throws: a Share problem comes back as
 * data, with the last good readings if there are any, so it can't take the
 * EGV page down with it.
 */
export async function getLatestShareResult(): Promise<ShareResult> {
  if (!isShareConfigured()) return { configured: false };
  client ??= createShareClient({
    post: axiosPost,
    username: ENV.dexcomShareUsername,
    password: ENV.dexcomSharePassword,
  });
  try {
    const { readings, at } = await client.getRecentReadings();
    return { configured: true, readings, fetchedAt: new Date(at).toISOString() };
  } catch (err) {
    const stale = client.lastGood();
    const paused = client.pausedUntil();
    if (!paused) console.warn(`[Share] Read failed: ${(err as Error)?.message ?? "unknown error"}`);
    return {
      configured: true,
      readings: stale?.readings ?? [],
      fetchedAt: stale ? new Date(stale.at).toISOString() : null,
      error: (err as Error)?.message || "Live data is unavailable.",
      retryAt: paused ? new Date(paused).toISOString() : undefined,
    };
  }
}
