import {
  ComposedChart,
  Line,
  Bar,
  XAxis,
  YAxis,
  CartesianGrid,
  Tooltip,
  Legend,
  ResponsiveContainer,
  ReferenceLine,
  ReferenceArea,
} from "recharts";
import type { TimezoneMode, AppleHealthMetricKey } from "../../../shared/const";
import { METRIC_LABELS } from "../../../shared/const";
import { formatTime } from "../lib/timezone";

interface EgvRecord {
  systemTime: string;
  value: number | null;
}

interface AggregatedBucket {
  bucketStart: string;
  bucketEnd: string;
  metrics: Partial<
    Record<
      AppleHealthMetricKey,
      { avg: number; min: number; max: number; sum: number; count: number }
    >
  >;
}

interface WorkoutRecord {
  activityLabel: string;
  startDate: string;
  endDate: string;
  duration: number;
  totalEnergyBurned: number | null;
}

interface CorrelationChartProps {
  egvData: EgvRecord[];
  healthBuckets: AggregatedBucket[];
  workouts: WorkoutRecord[];
  selectedMetrics: AppleHealthMetricKey[];
  timezone: TimezoneMode;
}

export default function CorrelationChart({
  egvData,
  healthBuckets,
  workouts,
  selectedMetrics,
  timezone,
}: CorrelationChartProps) {
  // Merge EGV data and health buckets into a unified timeline
  const bucketMs = 15 * 60 * 1000;

  // Create a map of health data by bucket time
  const healthMap = new Map<number, AggregatedBucket>();
  for (const bucket of healthBuckets) {
    const t = new Date(bucket.bucketStart).getTime();
    healthMap.set(t, bucket);
  }

  // Build unified data points from EGV records
  const dataMap = new Map<number, any>();

  for (const egv of egvData) {
    if (egv.value === null) continue;
    const t = new Date(egv.systemTime).getTime();
    const bucketKey = Math.floor(t / bucketMs) * bucketMs;

    if (!dataMap.has(bucketKey)) {
      dataMap.set(bucketKey, {
        time: bucketKey,
        egvValues: [],
      });
    }
    dataMap.get(bucketKey)!.egvValues.push(egv.value);
  }

  // Also add health-only buckets that may not have EGV data
  for (const bucket of healthBuckets) {
    const t = new Date(bucket.bucketStart).getTime();
    if (!dataMap.has(t)) {
      dataMap.set(t, {
        time: t,
        egvValues: [],
      });
    }
  }

  // Build final chart data
  const chartData = Array.from(dataMap.entries())
    .sort(([a], [b]) => a - b)
    .map(([time, data]) => {
      const point: any = {
        time,
        timeLabel: formatTime(time, timezone),
      };

      // Average EGV for this bucket
      if (data.egvValues.length > 0) {
        point.glucose =
          Math.round(
            (data.egvValues.reduce((a: number, b: number) => a + b, 0) /
              data.egvValues.length) *
              10
          ) / 10;
      }

      // Add health metrics
      const healthBucket = healthMap.get(time);
      if (healthBucket) {
        for (const metric of selectedMetrics) {
          const metricData = healthBucket.metrics[metric];
          if (metricData) {
            // Use sum for cumulative metrics, avg for rate metrics
            const useSumMetrics: AppleHealthMetricKey[] = [
              "stepCount",
              "activeEnergy",
              "exerciseTime",
              "distance",
            ];
            point[metric] = Math.round(
              (useSumMetrics.includes(metric) ? metricData.sum : metricData.avg) * 100
            ) / 100;
          }
        }
      }

      return point;
    });

  if (chartData.length === 0) {
    return (
      <div className="flex items-center justify-center h-64 text-muted-foreground font-mono text-sm">
        No overlapping data found between EGV and health metrics for this time range.
      </div>
    );
  }

  // Determine which metrics use bar vs line
  const barMetrics: AppleHealthMetricKey[] = ["stepCount", "activeEnergy", "exerciseTime", "distance"];
  const lineMetrics: AppleHealthMetricKey[] = ["heartRate", "restingHeartRate", "hrv", "oxygenSaturation"];

  // Find workout time ranges for reference areas
  const workoutAreas = workouts
    .filter((w) => {
      const wStart = new Date(w.startDate).getTime();
      const wEnd = new Date(w.endDate).getTime();
      const chartStart = chartData[0]?.time || 0;
      const chartEnd = chartData[chartData.length - 1]?.time || 0;
      return wStart < chartEnd && wEnd > chartStart;
    })
    .map((w) => ({
      x1: new Date(w.startDate).getTime(),
      x2: new Date(w.endDate).getTime(),
      label: w.activityLabel,
    }));

  return (
    <ResponsiveContainer width="100%" height={400}>
      <ComposedChart data={chartData} margin={{ top: 10, right: 10, left: 0, bottom: 0 }}>
        <CartesianGrid
          strokeDasharray="3 3"
          stroke="oklch(0.25 0.02 264)"
          vertical={false}
        />

        {/* Workout reference areas */}
        {workoutAreas.map((area, i) => (
          <ReferenceArea
            key={`workout-${i}`}
            x1={area.x1}
            x2={area.x2}
            fill="oklch(0.50 0.15 145 / 0.15)"
            stroke="oklch(0.60 0.15 145)"
            strokeDasharray="3 3"
            label={{
              value: area.label,
              position: "insideTop",
              fill: "oklch(0.70 0.15 145)",
              fontSize: 10,
            }}
          />
        ))}

        {/* Target glucose range */}
        <ReferenceArea
          y1={70}
          y2={180}
          fill="oklch(0.50 0.15 145 / 0.06)"
          yAxisId="glucose"
        />
        <ReferenceLine
          y={70}
          yAxisId="glucose"
          stroke="oklch(0.55 0.15 145)"
          strokeDasharray="4 4"
          strokeOpacity={0.5}
        />
        <ReferenceLine
          y={180}
          yAxisId="glucose"
          stroke="oklch(0.55 0.15 145)"
          strokeDasharray="4 4"
          strokeOpacity={0.5}
        />

        <XAxis
          dataKey="time"
          type="number"
          domain={["dataMin", "dataMax"]}
          tickFormatter={(t) => formatTime(t, timezone)}
          stroke="oklch(0.45 0.02 264)"
          tick={{ fontSize: 10, fontFamily: "'Fira Code', monospace" }}
          scale="time"
        />

        {/* Left Y-axis: Glucose */}
        <YAxis
          yAxisId="glucose"
          domain={[40, 400]}
          stroke="oklch(0.65 0.20 145)"
          tick={{ fontSize: 10, fontFamily: "'Fira Code', monospace", fill: "oklch(0.65 0.20 145)" }}
          label={{
            value: "mg/dL",
            angle: -90,
            position: "insideLeft",
            fill: "oklch(0.65 0.20 145)",
            fontSize: 10,
          }}
        />

        {/* Right Y-axis: Health metric */}
        {selectedMetrics.length > 0 && (
          <YAxis
            yAxisId="health"
            orientation="right"
            stroke="oklch(0.45 0.02 264)"
            tick={{ fontSize: 10, fontFamily: "'Fira Code', monospace" }}
            label={{
              value: selectedMetrics.map((m) => METRIC_LABELS[m].unit).join(" / "),
              angle: 90,
              position: "insideRight",
              fill: "oklch(0.55 0.02 264)",
              fontSize: 10,
            }}
          />
        )}

        <Tooltip
          contentStyle={{
            backgroundColor: "oklch(0.18 0.02 264)",
            border: "1px solid oklch(0.30 0.02 264)",
            borderRadius: "6px",
            fontFamily: "'Fira Code', monospace",
            fontSize: "11px",
            color: "oklch(0.85 0.02 264)",
          }}
          labelFormatter={(t) => formatTime(t, timezone)}
          formatter={(value: number, name: string) => {
            if (name === "glucose") return [`${value} mg/dL`, "Glucose"];
            const metricInfo = METRIC_LABELS[name as AppleHealthMetricKey];
            if (metricInfo) return [`${value} ${metricInfo.unit}`, metricInfo.label];
            return [value, name];
          }}
        />

        <Legend
          wrapperStyle={{
            fontFamily: "'Fira Code', monospace",
            fontSize: "11px",
          }}
        />

        {/* Glucose line */}
        <Line
          yAxisId="glucose"
          type="monotone"
          dataKey="glucose"
          name="glucose"
          stroke="oklch(0.72 0.20 145)"
          strokeWidth={2}
          dot={false}
          connectNulls
        />

        {/* Health metric lines/bars */}
        {selectedMetrics.map((metric) => {
          const info = METRIC_LABELS[metric];
          if (barMetrics.includes(metric)) {
            return (
              <Bar
                key={metric}
                yAxisId="health"
                dataKey={metric}
                name={metric}
                fill={info.color}
                opacity={0.6}
                barSize={8}
              />
            );
          }
          return (
            <Line
              key={metric}
              yAxisId="health"
              type="monotone"
              dataKey={metric}
              name={metric}
              stroke={info.color}
              strokeWidth={1.5}
              dot={false}
              connectNulls
              strokeDasharray={metric === "restingHeartRate" ? "5 3" : undefined}
            />
          );
        })}
      </ComposedChart>
    </ResponsiveContainer>
  );
}
