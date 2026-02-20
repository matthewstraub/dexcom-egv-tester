export const COOKIE_NAME = "app_session_id";
export const ONE_YEAR_MS = 1000 * 60 * 60 * 24 * 365;
export const AXIOS_TIMEOUT_MS = 30_000;
export const UNAUTHED_ERR_MSG = 'Please login (10001)';
export const NOT_ADMIN_ERR_MSG = 'You do not have required permission (10002)';

export type DexcomEnv = "sandbox" | "production";
export type TimezoneMode = "utc" | "local";

export const DEXCOM_BASE_URLS: Record<DexcomEnv, string> = {
  sandbox: "https://sandbox-api.dexcom.com",
  production: "https://api.dexcom.com",
};
