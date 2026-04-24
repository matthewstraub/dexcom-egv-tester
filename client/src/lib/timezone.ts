import type { TimezoneMode } from "../../../shared/const";

/**
 * Get the user's local timezone abbreviation (e.g., "EST", "PST", "CET").
 */
export function getLocalTimezoneAbbr(): string {
  try {
    const parts = new Intl.DateTimeFormat("en-US", { timeZoneName: "short" }).formatToParts(new Date());
    return parts.find((p) => p.type === "timeZoneName")?.value || "Local";
  } catch {
    return "Local";
  }
}

/**
 * Get the user's IANA timezone name (e.g., "America/New_York").
 */
export function getLocalTimezoneName(): string {
  try {
    return Intl.DateTimeFormat().resolvedOptions().timeZone;
  } catch {
    return "Local";
  }
}

/**
 * Format a Date or ISO string for display, respecting the timezone mode.
 * Returns a full date+time string.
 */
export function formatDateTime(date: Date | string, mode: TimezoneMode): string {
  const d = typeof date === "string" ? new Date(date) : date;
  if (isNaN(d.getTime())) return "Invalid Date";

  if (mode === "utc") {
    return d.toISOString().replace("T", " ").replace("Z", " UTC").slice(0, 23) + " UTC";
  }
  return d.toLocaleString([], {
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
    second: "2-digit",
  });
}

/**
 * Format a Date or ISO string as a short time (HH:MM) for chart axes.
 */
export function formatTime(date: Date | string | number, mode: TimezoneMode): string {
  const d = typeof date === "number" ? new Date(date) : typeof date === "string" ? new Date(date) : date;
  if (isNaN(d.getTime())) return "--:--";

  if (mode === "utc") {
    return d.toISOString().slice(11, 16);
  }
  return d.toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" });
}

/**
 * Format a Date or ISO string as a short date+time for chart axes (multi-day view).
 * Returns "MM/DD HH:MM" format.
 */
export function formatDateTimeShort(date: Date | string | number, mode: TimezoneMode): string {
  const d = typeof date === "number" ? new Date(date) : typeof date === "string" ? new Date(date) : date;
  if (isNaN(d.getTime())) return "--/-- --:--";

  if (mode === "utc") {
    const month = String(d.getUTCMonth() + 1).padStart(2, "0");
    const day = String(d.getUTCDate()).padStart(2, "0");
    const hours = String(d.getUTCHours()).padStart(2, "0");
    const mins = String(d.getUTCMinutes()).padStart(2, "0");
    return `${month}/${day} ${hours}:${mins}`;
  }
  const month = String(d.getMonth() + 1).padStart(2, "0");
  const day = String(d.getDate()).padStart(2, "0");
  const hours = String(d.getHours()).padStart(2, "0");
  const mins = String(d.getMinutes()).padStart(2, "0");
  return `${month}/${day} ${hours}:${mins}`;
}

/**
 * Format a Date or ISO string as a short date for display.
 */
export function formatDate(date: Date | string, mode: TimezoneMode): string {
  const d = typeof date === "string" ? new Date(date) : date;
  if (isNaN(d.getTime())) return "Invalid Date";

  if (mode === "utc") {
    return d.toISOString().slice(0, 10);
  }
  return d.toLocaleDateString();
}

/**
 * Convert a datetime-local input value to an ISO 8601 UTC string for the Dexcom API.
 * When in "local" mode, the input value represents local time, so we need to convert to UTC.
 * When in "utc" mode, the input value is already UTC.
 */
export function inputToApiDate(inputValue: string, mode: TimezoneMode): string {
  if (!inputValue) return "";

  if (mode === "utc") {
    // Input is UTC — just return as-is (Dexcom expects ISO 8601 without Z)
    return inputValue;
  }

  // Input is local time — the datetime-local input already represents local time
  // new Date(inputValue) interprets it as local, .toISOString() converts to UTC
  const d = new Date(inputValue);
  if (isNaN(d.getTime())) return inputValue;
  return d.toISOString().slice(0, 19);
}

/**
 * Convert a UTC ISO string (from API) to a datetime-local input value.
 * When in "local" mode, convert UTC to local time for the input.
 * When in "utc" mode, keep as UTC.
 */
export function apiDateToInput(isoString: string, mode: TimezoneMode): string {
  if (!isoString) return "";

  const d = new Date(isoString + (isoString.endsWith("Z") ? "" : "Z"));
  if (isNaN(d.getTime())) return isoString;

  if (mode === "utc") {
    return d.toISOString().slice(0, 19);
  }

  // Convert to local time string for datetime-local input
  const year = d.getFullYear();
  const month = String(d.getMonth() + 1).padStart(2, "0");
  const day = String(d.getDate()).padStart(2, "0");
  const hours = String(d.getHours()).padStart(2, "0");
  const minutes = String(d.getMinutes()).padStart(2, "0");
  const seconds = String(d.getSeconds()).padStart(2, "0");
  return `${year}-${month}-${day}T${hours}:${minutes}:${seconds}`;
}
