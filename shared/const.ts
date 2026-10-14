export const COOKIE_NAME = "app_session_id";

export type DexcomEnv = "sandbox" | "production";
export type TimezoneMode = "utc" | "local";

export const DEXCOM_BASE_URLS: Record<DexcomEnv, string> = {
  sandbox: "https://sandbox-api.dexcom.com",
  production: "https://api.dexcom.com",
};

/**
 * The EGV chart's vertical range in mg/dL when no admin has set one. Admins
 * can change it (settings.setChartRange); the chart still widens to fit any
 * reading outside it.
 */
export const CHART_RANGE_DEFAULT = { min: 40, max: 350 } as const;
/** Bounds an admin's chart range must stay within. */
export const CHART_RANGE_LIMITS = { lowest: 0, highest: 500, minSpan: 50 } as const;

