export const COOKIE_NAME = "app_session_id";

export type DexcomEnv = "sandbox" | "production";
export type TimezoneMode = "utc" | "local";

export const DEXCOM_BASE_URLS: Record<DexcomEnv, string> = {
  sandbox: "https://sandbox-api.dexcom.com",
  production: "https://api.dexcom.com",
};

