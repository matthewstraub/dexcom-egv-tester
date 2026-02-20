import { useMemo } from "react";
import {
  LineChart,
  Line,
  XAxis,
  YAxis,
  CartesianGrid,
  Tooltip,
  ResponsiveContainer,
  ReferenceLine,
  ReferenceArea,
} from "recharts";
import type { TimezoneMode } from "../../../shared/const";
import { formatTime, formatDateTime } from "@/lib/timezone";

interface EgvRecord {
  recordId: string;
  systemTime: string;
  displayTime: string;
  value: number | null;
  status: string | null;
  trend: string | null;
  trendRate: number | null;
  unit: string;
  rateUnit: string;
  displayDevice: string;
  transmitterGeneration: string;
}

interface EgvChartProps {
  records: EgvRecord[];
  timezone: TimezoneMode;
}

const TREND_ARROWS: Record<string, string> = {
  doubleUp: "⬆⬆",
  singleUp: "⬆",
  fortyFiveUp: "↗",
  flat: "→",
  fortyFiveDown: "↘",
  singleDown: "⬇",
  doubleDown: "⬇⬇",
  none: "",
  notComputable: "?",
  rateOutOfRange: "!",
};

function getGlucoseColor(value: number | null): string {
  if (value === null) return "oklch(0.58 0.02 264)";
  if (value < 54) return "oklch(0.65 0.25 25)"; // urgent low - red
  if (value < 70) return "oklch(0.75 0.15 60)"; // low - amber
  if (value <= 180) return "oklch(0.72 0.15 145)"; // in range - green
  if (value <= 250) return "oklch(0.75 0.15 60)"; // high - amber
  return "oklch(0.65 0.25 25)"; // very high - red
}

export function EgvChart({ records, timezone }: EgvChartProps) {
  const chartData = useMemo(() => {
    return records
      .filter(r => r.value !== null)
      .map(r => ({
        time: new Date(r.systemTime).getTime(),
        value: r.value,
        trend: r.trend,
        trendRate: r.trendRate,
        systemTime: r.systemTime,
        displayTime: r.displayTime,
      }))
      .sort((a, b) => a.time - b.time);
  }, [records]);

  if (chartData.length === 0) {
    return (
      <div className="flex items-center justify-center h-64 text-muted-foreground font-mono text-sm">
        No EGV data to display
      </div>
    );
  }

  return (
    <div className="w-full h-80">
      <ResponsiveContainer width="100%" height="100%">
        <LineChart data={chartData} margin={{ top: 10, right: 10, left: 0, bottom: 0 }}>
          <CartesianGrid
            strokeDasharray="3 3"
            stroke="oklch(0.25 0.02 264)"
            strokeOpacity={0.5}
          />
          {/* Target range background */}
          <ReferenceArea
            y1={70}
            y2={180}
            fill="oklch(0.72 0.15 145)"
            fillOpacity={0.06}
          />
          {/* Low threshold */}
          <ReferenceLine
            y={70}
            stroke="oklch(0.75 0.15 60)"
            strokeDasharray="4 4"
            strokeOpacity={0.5}
          />
          {/* High threshold */}
          <ReferenceLine
            y={180}
            stroke="oklch(0.75 0.15 60)"
            strokeDasharray="4 4"
            strokeOpacity={0.5}
          />
          {/* Urgent low */}
          <ReferenceLine
            y={54}
            stroke="oklch(0.65 0.25 25)"
            strokeDasharray="4 4"
            strokeOpacity={0.4}
          />
          <XAxis
            dataKey="time"
            type="number"
            domain={["dataMin", "dataMax"]}
            tickFormatter={(val) => formatTime(val, timezone)}
            stroke="oklch(0.45 0.02 264)"
            tick={{ fontSize: 11, fontFamily: "Fira Code" }}
          />
          <YAxis
            domain={[40, 400]}
            stroke="oklch(0.45 0.02 264)"
            tick={{ fontSize: 11, fontFamily: "Fira Code" }}
            tickFormatter={(val) => `${val}`}
          />
          <Tooltip
            content={({ active, payload }) => {
              if (!active || !payload?.length) return null;
              const d = payload[0].payload;
              const trendArrow = TREND_ARROWS[d.trend] || "";
              return (
                <div className="bg-[oklch(0.19_0.016_264)] border border-border rounded-lg px-3 py-2 shadow-lg">
                  <div className="font-mono text-xs text-muted-foreground mb-1">
                    {formatDateTime(d.systemTime, timezone)}
                  </div>
                  <div className="flex items-baseline gap-2">
                    <span
                      className="font-mono text-lg font-bold"
                      style={{ color: getGlucoseColor(d.value) }}
                    >
                      {d.value}
                    </span>
                    <span className="text-xs text-muted-foreground">mg/dL</span>
                    {trendArrow && (
                      <span className="text-sm">{trendArrow}</span>
                    )}
                  </div>
                  {d.trendRate !== null && (
                    <div className="font-mono text-xs text-muted-foreground mt-0.5">
                      Rate: {d.trendRate.toFixed(1)} mg/dL/min
                    </div>
                  )}
                </div>
              );
            }}
          />
          <Line
            type="monotone"
            dataKey="value"
            stroke="oklch(0.72 0.15 180)"
            strokeWidth={2}
            dot={false}
            activeDot={{
              r: 4,
              fill: "oklch(0.72 0.15 180)",
              stroke: "oklch(0.16 0.014 264)",
              strokeWidth: 2,
            }}
          />
        </LineChart>
      </ResponsiveContainer>
    </div>
  );
}
