import { useState, useRef, useCallback, useMemo, useEffect } from "react";
import { trpc } from "@/lib/trpc";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { toast } from "sonner";
import {
  Upload,
  Trash2,
  Activity,
  Heart,
  Footprints,
  Flame,
  Timer,
  TrendingUp,
  TrendingDown,
  Minus,
  Loader2,
  FileArchive,
  BarChart3,
  AlertTriangle,
  Dumbbell,
  Clock,
  CheckCircle2,
  XCircle,
} from "lucide-react";
import {
  type AppleHealthMetricKey,
  type DexcomEnv,
  type TimezoneMode,
  METRIC_LABELS,
} from "../../../shared/const";
import CorrelationChart from "@/components/CorrelationChart";
import { formatDateTime } from "@/lib/timezone";

interface CorrelationsProps {
  dexcomEnv: DexcomEnv;
  timezone: TimezoneMode;
}

const METRIC_ICONS: Record<AppleHealthMetricKey, typeof Heart> = {
  heartRate: Heart,
  restingHeartRate: Heart,
  hrv: Activity,
  stepCount: Footprints,
  activeEnergy: Flame,
  exerciseTime: Timer,
  distance: TrendingUp,
  oxygenSaturation: Activity,
};

type UploadStage = "idle" | "uploading" | "processing" | "done" | "error";

export default function Correlations({ dexcomEnv, timezone }: CorrelationsProps) {
  const [uploadStage, setUploadStage] = useState<UploadStage>("idle");
  const [uploadProgress, setUploadProgress] = useState("");
  const [currentJobId, setCurrentJobId] = useState<number | null>(null);
  const [selectedMetrics, setSelectedMetrics] = useState<AppleHealthMetricKey[]>(["heartRate", "stepCount"]);
  const [egvStartDate, setEgvStartDate] = useState("");
  const [egvEndDate, setEgvEndDate] = useState("");
  const [correlating, setCorrelating] = useState(false);
  const fileInputRef = useRef<HTMLInputElement>(null);
  const pollIntervalRef = useRef<ReturnType<typeof setInterval> | null>(null);

  // Queries
  const healthStatus = trpc.appleHealth.status.useQuery();
  const healthBuckets = trpc.appleHealth.buckets.useQuery(undefined, {
    enabled: healthStatus.data?.uploaded === true,
  });
  const workouts = trpc.appleHealth.workouts.useQuery(undefined, {
    enabled: healthStatus.data?.uploaded === true,
  });
  const dexcomStatus = trpc.dexcom.status.useQuery({ env: dexcomEnv });

  // Job status polling
  const jobStatus = trpc.appleHealth.jobStatus.useQuery(
    { jobId: currentJobId! },
    {
      enabled: currentJobId !== null && (uploadStage === "processing"),
      refetchInterval: 2000, // Poll every 2 seconds
    }
  );

  // React to job status changes
  useEffect(() => {
    if (!jobStatus.data || uploadStage !== "processing") return;

    if (jobStatus.data.status === "completed") {
      setUploadStage("done");
      setUploadProgress("");
      setCurrentJobId(null);

      // Refetch health data
      healthStatus.refetch();
      healthBuckets.refetch();
      workouts.refetch();

      // Auto-set date range
      if (jobStatus.data.summary?.dateRange) {
        const start = new Date(jobStatus.data.summary.dateRange.start);
        const end = new Date(jobStatus.data.summary.dateRange.end);
        const sevenDaysAgo = new Date(end.getTime() - 7 * 24 * 60 * 60 * 1000);
        const effectiveStart = sevenDaysAgo > start ? sevenDaysAgo : start;
        setEgvStartDate(effectiveStart.toISOString().slice(0, 19));
        setEgvEndDate(end.toISOString().slice(0, 19));
      }

      toast.success(
        `Parsed ${jobStatus.data.summary?.relevantDataPoints.toLocaleString()} data points and ${jobStatus.data.summary?.workoutCount} workouts`
      );
    } else if (jobStatus.data.status === "failed") {
      setUploadStage("error");
      setUploadProgress("");
      setCurrentJobId(null);
      toast.error(jobStatus.data.errorMessage || "Processing failed");
    }
  }, [jobStatus.data, uploadStage]);

  // Mutations
  const correlationMutation = trpc.appleHealth.correlations.useMutation();
  const clearMutation = trpc.appleHealth.clear.useMutation({
    onSuccess: () => {
      healthStatus.refetch();
      healthBuckets.refetch();
      workouts.refetch();
      toast.success("Apple Health data cleared");
    },
  });

  // EGV data for the selected date range
  const egvQuery = trpc.dexcom.egvs.useQuery(
    { startDate: egvStartDate, endDate: egvEndDate, env: dexcomEnv },
    { enabled: !!egvStartDate && !!egvEndDate && dexcomStatus.data?.connected === true }
  );

  const handleFileUpload = useCallback(async (e: React.ChangeEvent<HTMLInputElement>) => {
    const file = e.target.files?.[0];
    if (!file) return;

    if (!file.name.endsWith(".zip")) {
      toast.error("Please upload a ZIP file (Apple Health export)");
      return;
    }

    const sizeMB = file.size / 1024 / 1024;
    if (sizeMB > 500) {
      toast.error("File too large (max 500 MB). Try exporting a shorter date range from Apple Health.");
      return;
    }

    setUploadStage("uploading");
    setUploadProgress(`Uploading ${sizeMB.toFixed(0)} MB...`);

    try {
      // Upload the ZIP to the server, which saves to temp file and starts
      // background processing. Returns immediately with a job ID.
      const uploadResult = await new Promise<{ jobId: number }>((resolve, reject) => {
        const xhr = new XMLHttpRequest();
        xhr.timeout = 10 * 60 * 1000; // 10 minutes for upload

        xhr.upload.addEventListener("progress", (event) => {
          if (event.lengthComputable) {
            const pct = Math.round((event.loaded / event.total) * 100);
            setUploadProgress(
              pct < 100
                ? `Uploading... ${pct}%`
                : "Upload complete, starting processing..."
            );
          }
        });

        xhr.addEventListener("load", () => {
          const contentType = xhr.getResponseHeader("content-type") || "";
          if (!contentType.includes("application/json")) {
            reject(new Error(
              `Server returned unexpected response (${xhr.status}). ` +
              "This may be a timeout or memory issue. Try a smaller export."
            ));
            return;
          }
          try {
            const data = JSON.parse(xhr.responseText);
            if (xhr.status >= 200 && xhr.status < 300 && data.success) {
              resolve({ jobId: data.jobId });
            } else {
              reject(new Error(data.error || `Upload failed (HTTP ${xhr.status})`));
            }
          } catch {
            reject(new Error("Failed to parse server response"));
          }
        });

        xhr.addEventListener("error", () => {
          reject(new Error("Network error during upload"));
        });

        xhr.addEventListener("timeout", () => {
          reject(new Error("Upload timed out. Try a smaller file."));
        });

        xhr.open("POST", "/api/apple-health/upload");
        xhr.setRequestHeader("Content-Type", "application/octet-stream");
        xhr.send(file);
      });

      // Switch to processing stage — the server is now parsing in the background
      setUploadStage("processing");
      setUploadProgress("Processing health data (this may take a few minutes)...");
      setCurrentJobId(uploadResult.jobId);
      // Polling will be handled by the jobStatus query with refetchInterval

    } catch (err: any) {
      setUploadStage("error");
      setUploadProgress("");
      toast.error(err.message || "Failed to upload Apple Health export");
    } finally {
      if (fileInputRef.current) fileInputRef.current.value = "";
    }
  }, []);

  const handleCalculateCorrelations = useCallback(async () => {
    if (!egvQuery.data?.records?.length) {
      toast.error("No EGV data available. Please fetch EGV data first.");
      return;
    }
    setCorrelating(true);
    try {
      await correlationMutation.mutateAsync({
        egvData: egvQuery.data.records.map((r: any) => ({
          systemTime: r.systemTime,
          value: r.value,
        })),
      });
    } catch (err: any) {
      toast.error(err.message || "Failed to calculate correlations");
    } finally {
      setCorrelating(false);
    }
  }, [egvQuery.data, correlationMutation]);

  const toggleMetric = (metric: AppleHealthMetricKey) => {
    setSelectedMetrics((prev) =>
      prev.includes(metric)
        ? prev.filter((m) => m !== metric)
        : [...prev, metric]
    );
  };

  const isConnected = dexcomStatus.data?.connected === true;
  const hasHealthData = healthStatus.data?.uploaded === true;
  const hasEgvData = !!egvQuery.data?.records?.length;
  const isUploading = uploadStage === "uploading" || uploadStage === "processing";

  const filteredWorkouts = useMemo(() => {
    if (!workouts.data || !egvStartDate || !egvEndDate) return [];
    const start = new Date(egvStartDate).getTime();
    const end = new Date(egvEndDate).getTime();
    return workouts.data.filter((w: any) => {
      const wStart = new Date(w.startDate).getTime();
      return wStart >= start && wStart <= end;
    });
  }, [workouts.data, egvStartDate, egvEndDate]);

  return (
    <div className="space-y-4">
      {/* Step 1: Upload Apple Health Data */}
      <Card className="bg-card border-border">
        <CardHeader className="pb-3">
          <CardTitle className="text-sm font-mono flex items-center gap-2">
            <FileArchive className="w-4 h-4 text-green-400" />
            Step 1: Upload Apple Health Export
          </CardTitle>
        </CardHeader>
        <CardContent className="space-y-4">
          <div className="text-xs text-muted-foreground font-mono space-y-2">
            <p>
              Export your health data from the Apple Health app on your iPhone:
            </p>
            <ol className="list-decimal list-inside space-y-1 ml-2">
              <li>Open the <strong>Health</strong> app on your iPhone</li>
              <li>Tap your <strong>profile picture</strong> (top right)</li>
              <li>Scroll down and tap <strong>Export All Health Data</strong></li>
              <li>Save the ZIP file and upload it here</li>
            </ol>
          </div>

          <div className="flex items-center gap-3">
            <input
              ref={fileInputRef}
              type="file"
              accept=".zip"
              onChange={handleFileUpload}
              className="hidden"
              id="health-upload"
            />
            <Button
              variant="outline"
              size="sm"
              onClick={() => fileInputRef.current?.click()}
              disabled={isUploading}
              className="font-mono text-xs"
            >
              {isUploading ? (
                <>
                  <Loader2 className="w-3 h-3 mr-1 animate-spin" />
                  {uploadProgress || "Processing..."}
                </>
              ) : (
                <>
                  <Upload className="w-3 h-3 mr-1" />
                  Upload ZIP
                </>
              )}
            </Button>

            {hasHealthData && !isUploading && (
              <Button
                variant="ghost"
                size="sm"
                onClick={() => clearMutation.mutate()}
                className="font-mono text-xs text-red-400 hover:text-red-300"
              >
                <Trash2 className="w-3 h-3 mr-1" />
                Clear Data
              </Button>
            )}
          </div>

          {/* Processing status indicator */}
          {uploadStage === "processing" && (
            <div className="bg-blue-500/10 rounded-md p-3 border border-blue-500/20">
              <div className="flex items-center gap-2 text-xs font-mono text-blue-400">
                <Loader2 className="w-3 h-3 animate-spin" />
                <span>{uploadProgress}</span>
              </div>
              <div className="text-[10px] font-mono text-muted-foreground mt-1">
                Your file has been uploaded to cloud storage. The server is now parsing the XML data
                and saving results to the database. This page will update automatically when complete.
              </div>
            </div>
          )}

          {uploadStage === "done" && !hasHealthData && (
            <div className="bg-green-500/10 rounded-md p-3 border border-green-500/20">
              <div className="flex items-center gap-2 text-xs font-mono text-green-400">
                <CheckCircle2 className="w-3 h-3" />
                <span>Processing complete! Loading data...</span>
              </div>
            </div>
          )}

          {uploadStage === "error" && (
            <div className="bg-red-500/10 rounded-md p-3 border border-red-500/20">
              <div className="flex items-center gap-2 text-xs font-mono text-red-400">
                <XCircle className="w-3 h-3" />
                <span>Processing failed. Please try again with a smaller file.</span>
              </div>
            </div>
          )}

          {/* Upload status */}
          {hasHealthData && healthStatus.data?.uploaded && (
            <div className="bg-background/50 rounded-md p-3 border border-border/50">
              <div className="text-xs font-mono text-green-400 mb-2">
                Data loaded successfully
              </div>
              <div className="grid grid-cols-2 sm:grid-cols-4 gap-2 text-xs font-mono">
                <div>
                  <span className="text-muted-foreground">Data Points:</span>{" "}
                  <span className="text-foreground">
                    {healthStatus.data.summary?.relevantDataPoints.toLocaleString()}
                  </span>
                </div>
                <div>
                  <span className="text-muted-foreground">Workouts:</span>{" "}
                  <span className="text-foreground">
                    {healthStatus.data.summary?.workoutCount}
                  </span>
                </div>
                <div>
                  <span className="text-muted-foreground">Metrics:</span>{" "}
                  <span className="text-foreground">
                    {healthStatus.data.summary?.metricsFound.length}
                  </span>
                </div>
                <div>
                  <span className="text-muted-foreground">Uploaded:</span>{" "}
                  <span className="text-foreground">
                    {formatDateTime(healthStatus.data.uploadedAt!, timezone)}
                  </span>
                </div>
              </div>
              {healthStatus.data.summary?.dateRange && (
                <div className="mt-2 text-xs font-mono text-muted-foreground">
                  Health data range:{" "}
                  {formatDateTime(healthStatus.data.summary.dateRange.start, timezone)} to{" "}
                  {formatDateTime(healthStatus.data.summary.dateRange.end, timezone)}
                </div>
              )}
              {healthStatus.data.summary?.metricsFound && (
                <div className="mt-2 flex flex-wrap gap-1">
                  {healthStatus.data.summary.metricsFound.map((m: string) => {
                    const info = METRIC_LABELS[m as AppleHealthMetricKey];
                    return info ? (
                      <span
                        key={m}
                        className="inline-flex items-center px-2 py-0.5 rounded text-[10px] font-mono border border-border/50"
                        style={{ color: info.color }}
                      >
                        {info.label}
                      </span>
                    ) : null;
                  })}
                </div>
              )}
            </div>
          )}
        </CardContent>
      </Card>

      {/* Step 2: Select Date Range & Metrics */}
      <Card className="bg-card border-border">
        <CardHeader className="pb-3">
          <CardTitle className="text-sm font-mono flex items-center gap-2">
            <BarChart3 className="w-4 h-4 text-blue-400" />
            Step 2: Configure Correlation View
          </CardTitle>
        </CardHeader>
        <CardContent className="space-y-4">
          {!isConnected && (
            <div className="flex items-center gap-2 text-xs font-mono text-yellow-400 bg-yellow-400/10 rounded-md p-2 border border-yellow-400/20">
              <AlertTriangle className="w-3 h-3" />
              Connect to Dexcom first (use the Connect tab) to overlay EGV data.
            </div>
          )}

          {/* Date range inputs */}
          <div className="grid grid-cols-1 sm:grid-cols-2 gap-3">
            <div>
              <label className="text-xs font-mono text-muted-foreground block mb-1">
                Start Date (UTC)
              </label>
              <input
                type="datetime-local"
                value={egvStartDate}
                onChange={(e) => setEgvStartDate(e.target.value)}
                className="w-full bg-background border border-border rounded px-2 py-1.5 text-xs font-mono text-foreground focus:outline-none focus:ring-1 focus:ring-primary"
              />
            </div>
            <div>
              <label className="text-xs font-mono text-muted-foreground block mb-1">
                End Date (UTC)
              </label>
              <input
                type="datetime-local"
                value={egvEndDate}
                onChange={(e) => setEgvEndDate(e.target.value)}
                className="w-full bg-background border border-border rounded px-2 py-1.5 text-xs font-mono text-foreground focus:outline-none focus:ring-1 focus:ring-primary"
              />
            </div>
          </div>

          {/* Metric toggles */}
          <div>
            <label className="text-xs font-mono text-muted-foreground block mb-2">
              Overlay Metrics
            </label>
            <div className="flex flex-wrap gap-2">
              {(Object.keys(METRIC_LABELS) as AppleHealthMetricKey[]).map((metric) => {
                const info = METRIC_LABELS[metric];
                const Icon = METRIC_ICONS[metric];
                const isSelected = selectedMetrics.includes(metric);
                const isAvailable =
                  hasHealthData &&
                  healthStatus.data?.uploaded &&
                  healthStatus.data.summary?.metricsFound.includes(metric);

                return (
                  <button
                    key={metric}
                    onClick={() => toggleMetric(metric)}
                    disabled={!isAvailable}
                    className={`inline-flex items-center gap-1.5 px-2.5 py-1 rounded text-xs font-mono border transition-all ${
                      isSelected
                        ? "border-primary/50 bg-primary/10"
                        : "border-border/50 bg-background/30 hover:border-border"
                    } ${!isAvailable ? "opacity-30 cursor-not-allowed" : "cursor-pointer"}`}
                    style={isSelected ? { color: info.color } : undefined}
                  >
                    <Icon className="w-3 h-3" />
                    {info.label}
                    <span className="text-muted-foreground">({info.unit})</span>
                  </button>
                );
              })}
            </div>
          </div>

          {/* Calculate button */}
          {hasHealthData && hasEgvData && (
            <Button
              variant="outline"
              size="sm"
              onClick={handleCalculateCorrelations}
              disabled={correlating}
              className="font-mono text-xs"
            >
              {correlating ? (
                <>
                  <Loader2 className="w-3 h-3 mr-1 animate-spin" />
                  Calculating...
                </>
              ) : (
                <>
                  <TrendingUp className="w-3 h-3 mr-1" />
                  Calculate Correlations
                </>
              )}
            </Button>
          )}
        </CardContent>
      </Card>

      {/* Step 3: Correlation Chart */}
      {hasHealthData && hasEgvData && healthBuckets.data && (
        <Card className="bg-card border-border">
          <CardHeader className="pb-3">
            <CardTitle className="text-sm font-mono flex items-center gap-2">
              <Activity className="w-4 h-4 text-purple-400" />
              Glucose + Health Metrics Overlay
            </CardTitle>
          </CardHeader>
          <CardContent>
            <CorrelationChart
              egvData={egvQuery.data?.records || []}
              healthBuckets={healthBuckets.data}
              workouts={filteredWorkouts}
              selectedMetrics={selectedMetrics}
              timezone={timezone}
            />
          </CardContent>
        </Card>
      )}

      {/* Workouts in range */}
      {filteredWorkouts.length > 0 && (
        <Card className="bg-card border-border">
          <CardHeader className="pb-3">
            <CardTitle className="text-sm font-mono flex items-center gap-2">
              <Dumbbell className="w-4 h-4 text-orange-400" />
              Workouts in Range ({filteredWorkouts.length})
            </CardTitle>
          </CardHeader>
          <CardContent>
            <div className="space-y-2">
              {filteredWorkouts.map((w: any, i: number) => (
                <div
                  key={i}
                  className="flex items-center justify-between bg-background/50 rounded-md p-2 border border-border/50 text-xs font-mono"
                >
                  <div className="flex items-center gap-2">
                    <Dumbbell className="w-3 h-3 text-orange-400" />
                    <span className="text-foreground font-medium">{w.activityLabel}</span>
                  </div>
                  <div className="flex items-center gap-4 text-muted-foreground">
                    <span className="flex items-center gap-1">
                      <Clock className="w-3 h-3" />
                      {Math.round(w.duration)} min
                    </span>
                    {w.totalEnergyBurned && (
                      <span className="flex items-center gap-1">
                        <Flame className="w-3 h-3" />
                        {Math.round(w.totalEnergyBurned)} kcal
                      </span>
                    )}
                    <span>{formatDateTime(w.startDate, timezone)}</span>
                  </div>
                </div>
              ))}
            </div>
          </CardContent>
        </Card>
      )}

      {/* Correlation Results */}
      {correlationMutation.data?.correlations && correlationMutation.data.correlations.length > 0 && (
        <Card className="bg-card border-border">
          <CardHeader className="pb-3">
            <CardTitle className="text-sm font-mono flex items-center gap-2">
              <BarChart3 className="w-4 h-4 text-cyan-400" />
              Correlation Analysis (Pearson r)
            </CardTitle>
          </CardHeader>
          <CardContent>
            <div className="text-xs font-mono text-muted-foreground mb-3">
              Pearson correlation coefficient between glucose levels and each health metric.
              Values range from -1 (inverse) to +1 (direct). Computed over 15-minute time buckets.
            </div>
            <div className="space-y-2">
              {correlationMutation.data.correlations.map((c: any) => {
                const info = METRIC_LABELS[c.metric as AppleHealthMetricKey];
                if (!info) return null;

                const absR = Math.abs(c.correlation);
                const barWidth = Math.round(absR * 100);
                const isPositive = c.correlation > 0;

                return (
                  <div
                    key={c.metric}
                    className="bg-background/50 rounded-md p-3 border border-border/50"
                  >
                    <div className="flex items-center justify-between mb-1">
                      <div className="flex items-center gap-2">
                        <span style={{ color: info.color }} className="font-medium">
                          {info.label}
                        </span>
                        <span className="text-muted-foreground">({info.unit})</span>
                      </div>
                      <div className="flex items-center gap-2">
                        {isPositive ? (
                          <TrendingUp className="w-3 h-3 text-green-400" />
                        ) : c.correlation < 0 ? (
                          <TrendingDown className="w-3 h-3 text-red-400" />
                        ) : (
                          <Minus className="w-3 h-3 text-muted-foreground" />
                        )}
                        <span
                          className={`font-bold ${
                            c.strength === "strong"
                              ? "text-yellow-400"
                              : c.strength === "moderate"
                              ? "text-blue-400"
                              : "text-muted-foreground"
                          }`}
                        >
                          r = {c.correlation.toFixed(3)}
                        </span>
                      </div>
                    </div>

                    {/* Visual bar */}
                    <div className="relative h-2 bg-background rounded-full overflow-hidden">
                      <div
                        className="absolute top-0 h-full rounded-full transition-all"
                        style={{
                          width: `${barWidth}%`,
                          backgroundColor: info.color,
                          opacity: 0.6,
                          left: isPositive ? "50%" : `${50 - barWidth}%`,
                        }}
                      />
                      <div className="absolute top-0 left-1/2 w-px h-full bg-border" />
                    </div>

                    <div className="flex justify-between mt-1 text-[10px] text-muted-foreground">
                      <span>
                        {c.strength} {c.direction} correlation
                      </span>
                      <span>n = {c.sampleSize} buckets</span>
                    </div>
                  </div>
                );
              })}
            </div>

            <div className="mt-3 text-[10px] font-mono text-muted-foreground bg-background/30 rounded p-2 border border-border/30">
              <strong>Interpretation guide:</strong> |r| &gt; 0.7 = strong, 0.4-0.7 = moderate,
              0.2-0.4 = weak, &lt; 0.2 = negligible. Positive r means the metric and glucose tend
              to rise/fall together. Negative r means they move in opposite directions. Correlation
              does not imply causation.
            </div>
          </CardContent>
        </Card>
      )}

      {/* Empty state */}
      {!hasHealthData && !isUploading && uploadStage !== "error" && (
        <div className="text-center py-12 text-muted-foreground font-mono text-sm">
          <FileArchive className="w-8 h-8 mx-auto mb-3 opacity-50" />
          <p>Upload your Apple Health export to get started</p>
          <p className="text-xs mt-1">
            Supports step count, heart rate, HRV, active energy, workouts, and more
          </p>
        </div>
      )}
    </div>
  );
}
