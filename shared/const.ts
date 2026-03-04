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

/** Apple Health record types we extract for correlation with EGV data */
export const APPLE_HEALTH_METRICS = {
  stepCount: "HKQuantityTypeIdentifierStepCount",
  heartRate: "HKQuantityTypeIdentifierHeartRate",
  restingHeartRate: "HKQuantityTypeIdentifierRestingHeartRate",
  hrv: "HKQuantityTypeIdentifierHeartRateVariabilitySDNN",
  activeEnergy: "HKQuantityTypeIdentifierActiveEnergyBurned",
  exerciseTime: "HKQuantityTypeIdentifierAppleExerciseTime",
  distance: "HKQuantityTypeIdentifierDistanceWalkingRunning",
  oxygenSaturation: "HKQuantityTypeIdentifierOxygenSaturation",
} as const;

export type AppleHealthMetricKey = keyof typeof APPLE_HEALTH_METRICS;

export const METRIC_LABELS: Record<AppleHealthMetricKey, { label: string; unit: string; color: string }> = {
  stepCount: { label: "Steps", unit: "steps", color: "oklch(0.72 0.15 180)" },
  heartRate: { label: "Heart Rate", unit: "bpm", color: "oklch(0.65 0.25 25)" },
  restingHeartRate: { label: "Resting HR", unit: "bpm", color: "oklch(0.70 0.20 350)" },
  hrv: { label: "HRV (SDNN)", unit: "ms", color: "oklch(0.72 0.15 290)" },
  activeEnergy: { label: "Active Energy", unit: "kcal", color: "oklch(0.75 0.15 60)" },
  exerciseTime: { label: "Exercise Time", unit: "min", color: "oklch(0.72 0.15 145)" },
  distance: { label: "Distance", unit: "mi", color: "oklch(0.68 0.18 220)" },
  oxygenSaturation: { label: "SpO2", unit: "%", color: "oklch(0.70 0.15 200)" },
};
