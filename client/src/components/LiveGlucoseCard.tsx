import { useEffect, useState } from "react";
import type { inferRouterOutputs } from "@trpc/server";
import { AlertTriangle, Radio } from "lucide-react";
import { Card, CardContent } from "@/components/ui/card";
import { Skeleton } from "@/components/ui/skeleton";
import { getGlucoseColor, TREND_ARROWS } from "@/lib/glucose";
import { formatTime } from "@/lib/timezone";
import type { TimezoneMode } from "../../../shared/const";
import type { AppRouter } from "../../../server/routers";

type LiveResult = inferRouterOutputs<AppRouter>["dexcom"]["latest"];

/** A reading older than this is called out as stale. Share normally updates every 5 min. */
const STALE_AFTER_MIN = 15;

/** Re-render on a timer so "N min ago" stays right between refetches. */
function useNow(intervalMs: number) {
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    const id = setInterval(() => setNow(Date.now()), intervalMs);
    return () => clearInterval(id);
  }, [intervalMs]);
  return now;
}

function describeAge(minutes: number): string {
  if (minutes < 1) return "just now";
  if (minutes < 60) return `${minutes} min ago`;
  const h = Math.floor(minutes / 60);
  const m = minutes % 60;
  return m ? `${h}h ${m}m ago` : `${h}h ago`;
}

/**
 * The current reading from Dexcom Share, shown above the tabs.
 *
 * Renders nothing when Share isn't configured. Its loading placeholder uses
 * only opacity animation (see DOCUMENTATION.md §7.3).
 */
export function LiveGlucoseCard({
  data,
  isLoading,
  timezone,
  className = "",
}: {
  data: LiveResult | undefined;
  isLoading: boolean;
  timezone: TimezoneMode;
  className?: string;
}) {
  const now = useNow(30_000);

  if (isLoading && !data) {
    return (
      <Card className={"bg-card border-border py-0 " + className}>
        <CardContent className="py-4 flex flex-wrap items-center gap-x-6 gap-y-2">
          <Skeleton className="h-10 w-40" />
          <Skeleton className="h-4 w-56" />
        </CardContent>
      </Card>
    );
  }
  if (!data || !data.configured) return null;

  const latest = data.readings.at(-1);
  const ageMin = latest ? Math.max(0, Math.round((now - Date.parse(latest.systemTime)) / 60_000)) : null;
  const stale = ageMin !== null && ageMin > STALE_AFTER_MIN;
  const arrow = latest?.trend ? TREND_ARROWS[latest.trend] ?? "" : "";

  let notice: string | null = null;
  if (data.error) {
    notice = data.retryAt
      ? `Live data paused: ${data.error} Trying again at ${formatTime(data.retryAt, timezone)}.`
      : `Live data unavailable: ${data.error}`;
  } else if (!latest) {
    notice = "No live readings in the last 24 hours.";
  } else if (stale) {
    notice = `No new reading for ${describeAge(ageMin!).replace(" ago", "")} — check the phone and sensor.`;
  }

  return (
    <Card className={"bg-card border-border py-0 " + className}>
      <CardContent className="py-4 space-y-2">
        <div className="flex flex-wrap items-center justify-between gap-x-4 gap-y-1">
          <span className="text-xs font-mono text-muted-foreground">Current glucose</span>
          <span className="flex items-center gap-1.5 text-[11px] font-mono text-primary">
            <Radio className="h-3 w-3 shrink-0" />
            Live · Dexcom Share
          </span>
        </div>

        {latest ? (
          <div className="flex flex-wrap items-baseline gap-x-3 gap-y-1">
            <span
              className={"text-4xl font-mono font-bold tabular-nums " + (stale ? "opacity-60" : "")}
              style={{ color: getGlucoseColor(latest.value) }}
            >
              {latest.value}
            </span>
            <span className="text-sm text-muted-foreground">mg/dL</span>
            {arrow && (
              <span className="text-2xl" aria-label={`trend ${latest.trend}`}>
                {arrow}
              </span>
            )}
            <span className="text-xs font-mono text-muted-foreground whitespace-nowrap">
              {describeAge(ageMin!)} · {formatTime(latest.systemTime, timezone)}
            </span>
          </div>
        ) : null}

        {notice && (
          <div className="flex items-start gap-2 text-xs font-mono text-amber-400">
            <AlertTriangle className="h-3.5 w-3.5 shrink-0 mt-0.5" />
            <span>{notice}</span>
          </div>
        )}

        <p className="text-[10px] font-mono text-muted-foreground">
          For reference only — not for treatment decisions.
        </p>
      </CardContent>
    </Card>
  );
}
