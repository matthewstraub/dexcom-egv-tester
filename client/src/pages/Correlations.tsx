import { useState, useRef, useCallback, useMemo, useEffect } from "react";
import { trpc } from "@/lib/trpc";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Progress } from "@/components/ui/progress";
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
  Cpu,
  Play,
} from "lucide-react";
import {
  type AppleHealthMetricKey,
  type DexcomEnv,
  type TimezoneMode,
  METRIC_LABELS,
} from "../../../shared/const";
import CorrelationChart from "@/components/CorrelationChart";
import { formatDateTime, inputToApiDate } from "@/lib/timezone";

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

type UploadStage = "idle" | "extracting" | "parsing" | "saving" | "done" | "error";

/** Split a date range into chunks of at most `maxDays` days */
function splitDateRange(startISO: string, endISO: string, maxDays: number = 7): Array<{ start: string; end: string }> {
  const chunks: Array<{ start: string; end: string }> = [];
  const startMs = new Date(startISO + (startISO.endsWith("Z") ? "" : "Z")).getTime();
  const endMs = new Date(endISO + (endISO.endsWith("Z") ? "" : "Z")).getTime();
  const chunkMs = maxDays * 24 * 60 * 60 * 1000;

  let cursor = startMs;
  while (cursor < endMs) {
    const chunkEnd = Math.min(cursor + chunkMs, endMs);
    // Format as ISO 8601 without Z (Dexcom expects this)
    const startStr = new Date(cursor).toISOString().slice(0, 19);
    const endStr = new Date(chunkEnd).toISOString().slice(0, 19);
    chunks.push({ start: startStr, end: endStr });
    cursor = chunkEnd;
  }
  return chunks;
}

export default function Correlations({ dexcomEnv, timezone }: CorrelationsProps) {
  const [uploadStage, setUploadStage] = useState<UploadStage>("idle");
  const [progressDetail, setProgressDetail] = useState("");
  const [progressPct, setProgressPct] = useState(0);
  const [selectedMetrics, setSelectedMetrics] = useState<AppleHealthMetricKey[]>(["heartRate", "stepCount"]);
  const [egvStartDate, setEgvStartDate] = useState("");
  const [egvEndDate, setEgvEndDate] = useState("");
  const [correlating, setCorrelating] = useState(false);

  // EGV data fetched via chunked approach
  const [egvRecords, setEgvRecords] = useState<any[]>([]);
  const [egvLoading, setEgvLoading] = useState(false);
  const [egvError, setEgvError] = useState<string | null>(null);
  const [egvLoadProgress, setEgvLoadProgress] = useState("");

  const fileInputRef = useRef<HTMLInputElement>(null);
  const workerRef = useRef<Worker | null>(null);

  // Queries
  const healthStatus = trpc.appleHealth.status.useQuery();
  const healthBuckets = trpc.appleHealth.buckets.useQuery(undefined, {
    enabled: healthStatus.data?.uploaded === true,
  });
  const workouts = trpc.appleHealth.workouts.useQuery(undefined, {
    enabled: healthStatus.data?.uploaded === true,
  });
  const dexcomStatus = trpc.dexcom.status.useQuery({ env: dexcomEnv });

  // Mutations
  const saveResultsMutation = trpc.appleHealth.saveResults.useMutation();
  const saveBucketBatchMutation = trpc.appleHealth.saveBucketBatch.useMutation();
  const correlationMutation = trpc.appleHealth.correlations.useMutation();
  const clearMutation = trpc.appleHealth.clear.useMutation({
    onSuccess: () => {
      healthStatus.refetch();
      healthBuckets.refetch();
      workouts.refetch();
      setEgvRecords([]);
      setEgvError(null);
      toast.success("Apple Health data cleared");
    },
  });

  // Direct fetch helper to bypass tRPC batch link for sequential chunk requests

  // Cleanup worker on unmount
  useEffect(() => {
    return () => {
      if (workerRef.current) {
        workerRef.current.terminate();
        workerRef.current = null;
      }
    };
  }, []);

  const handleFileUpload = useCallback(async (e: React.ChangeEvent<HTMLInputElement>) => {
    const file = e.target.files?.[0];
    if (!file) return;

    if (!file.name.endsWith(".zip")) {
      toast.error("Please upload a ZIP file (Apple Health export)");
      return;
    }

    const sizeMB = file.size / 1024 / 1024;
    if (sizeMB > 2000) {
      toast.error("File too large (max 2 GB).");
      return;
    }

    setUploadStage("extracting");
    setProgressDetail(`Reading ${sizeMB.toFixed(0)} MB ZIP file...`);
    setProgressPct(0);

    try {
      // Create a Web Worker for parsing
      const worker = new Worker(
        new URL("../workers/appleHealthWorker.ts", import.meta.url),
        { type: "module" }
      );
      workerRef.current = worker;

      const result = await new Promise<{
        summary: any;
        buckets: any[];
        workouts: any[];
      }>((resolve, reject) => {
        worker.onmessage = (event) => {
          const msg = event.data;

          if (msg.type === "progress") {
            setUploadStage(msg.stage === "extracting" ? "extracting" : "parsing");
            setProgressDetail(msg.detail);
            if (msg.pct !== undefined) {
              setProgressPct(msg.pct);
            }
          } else if (msg.type === "result") {
            resolve({
              summary: msg.summary,
              buckets: msg.buckets,
              workouts: msg.workouts,
            });
          } else if (msg.type === "error") {
            reject(new Error(msg.message));
          }
        };

        worker.onerror = (err) => {
          reject(new Error(err.message || "Worker error"));
        };

        // Start parsing
        worker.postMessage({ type: "parse", file });
      });

      // Terminate the worker
      worker.terminate();
      workerRef.current = null;

      // Stage 3: Save results to server in batches
      setUploadStage("saving");
      setProgressDetail(
        `Saving ${result.workouts.length} workouts...`
      );
      setProgressPct(90);

      // Step 1: Save summary + workouts (small payload)
      const saveResult = await saveResultsMutation.mutateAsync({
        summary: result.summary,
        workouts: result.workouts,
      });

      // Step 2: Save buckets in batches of 10,000 (~3MB each)
      const BATCH_SIZE = 10000;
      const totalBatches = Math.ceil(result.buckets.length / BATCH_SIZE);
      for (let i = 0; i < result.buckets.length; i += BATCH_SIZE) {
        const batchNum = Math.floor(i / BATCH_SIZE) + 1;
        const batch = result.buckets.slice(i, i + BATCH_SIZE);
        setProgressDetail(
          `Saving buckets batch ${batchNum}/${totalBatches} (${Math.min(i + BATCH_SIZE, result.buckets.length).toLocaleString()}/${result.buckets.length.toLocaleString()})...`
        );
        setProgressPct(90 + Math.round((batchNum / totalBatches) * 10));

        await saveBucketBatchMutation.mutateAsync({
          jobId: saveResult.jobId,
          buckets: batch,
        });
      }

      setUploadStage("done");
      setProgressDetail("");
      setProgressPct(100);

      // Refetch health data
      healthStatus.refetch();
      healthBuckets.refetch();
      workouts.refetch();

      // Auto-set date range to last 7 days of data
      if (result.summary.dateRange) {
        const start = new Date(result.summary.dateRange.start);
        const end = new Date(result.summary.dateRange.end);
        const sevenDaysAgo = new Date(end.getTime() - 7 * 24 * 60 * 60 * 1000);
        const effectiveStart = sevenDaysAgo > start ? sevenDaysAgo : start;
        setEgvStartDate(effectiveStart.toISOString().slice(0, 19));
        setEgvEndDate(end.toISOString().slice(0, 19));
      }

      toast.success(
        `Parsed ${result.summary.relevantDataPoints.toLocaleString()} data points and ${result.summary.workoutCount} workouts`
      );
    } catch (err: any) {
      setUploadStage("error");
      setProgressDetail(err.message || "");
      toast.error(err.message || "Failed to parse Apple Health export");

      // Cleanup worker
      if (workerRef.current) {
        workerRef.current.terminate();
        workerRef.current = null;
      }
    } finally {
      if (fileInputRef.current) fileInputRef.current.value = "";
    }
  }, [saveResultsMutation]);

  /**
   * Fetch a single EGV chunk via direct fetch() to bypass tRPC's httpBatchLink.
   * This ensures truly sequential requests that won't overwhelm the server.
   */
  async function fetchEgvChunkDirect(
    startDate: string,
    endDate: string,
    env: DexcomEnv
  ): Promise<{ records: any[] }> {
    // Build the tRPC query URL for a single non-batched procedure call
    const input = JSON.stringify({ startDate, endDate, env });
    const url = `/api/trpc/dexcom.egvs?input=${encodeURIComponent(input)}`;

    const res = await fetch(url, { credentials: "include" });
    if (!res.ok) {
      const text = await res.text();
      throw new Error(`HTTP ${res.status}: ${text.slice(0, 200)}`);
    }

    const json = await res.json();
    // tRPC non-batched response: { result: { data: { json: ... } } }
    const data = json?.result?.data?.json ?? json?.result?.data ?? json?.result;
    return data ?? { records: [] };
  }

  /**
   * Fetch EGV data in chunks of 7 days to avoid Dexcom's 30-day limit
   * and Render's 30-second timeout.
   * Uses direct fetch() to bypass tRPC batch link and ensure truly sequential requests.
   */
  const handleApplyRange = useCallback(async () => {
    if (!egvStartDate || !egvEndDate) {
      toast.error("Please select both start and end dates.");
      return;
    }

    // Convert input dates to UTC for the API
    const apiStart = inputToApiDate(egvStartDate, timezone);
    const apiEnd = inputToApiDate(egvEndDate, timezone);

    if (new Date(apiStart) >= new Date(apiEnd)) {
      toast.error("Start date must be before end date.");
      return;
    }

    setEgvLoading(true);
    setEgvError(null);
    setEgvRecords([]);
    setEgvLoadProgress("Preparing...");

    try {
      // Split into 7-day chunks to stay well under Dexcom's 30-day max
      const chunks = splitDateRange(apiStart, apiEnd, 7);
      const allRecords: any[] = [];

      for (let i = 0; i < chunks.length; i++) {
        const chunk = chunks[i];
        setEgvLoadProgress(
          `Fetching EGV data: chunk ${i + 1}/${chunks.length}...`
        );

        try {
          const data = await fetchEgvChunkDirect(chunk.start, chunk.end, dexcomEnv);

          if (data?.records) {
            allRecords.push(...data.records);
          }
        } catch (chunkErr: any) {
          // If a chunk fails, log it but continue with other chunks
          console.warn(`Chunk ${i + 1} failed:`, chunkErr.message);
          // If it's an auth error, stop entirely
          if (chunkErr.message?.includes("Not connected") || chunkErr.message?.includes("authorize")) {
            throw chunkErr;
          }
          // For other errors (e.g., no data for this range), continue
        }

        // Small delay between chunks to let the server GC and avoid OOM
        if (i < chunks.length - 1) {
          await new Promise((r) => setTimeout(r, 500));
        }
      }

      setEgvRecords(allRecords);
      setEgvLoadProgress("");

      if (allRecords.length === 0) {
        toast.info("No EGV records found for this date range.");
      } else {
        toast.success(`Loaded ${allRecords.length.toLocaleString()} EGV records across ${chunks.length} chunk${chunks.length > 1 ? "s" : ""}.`);
      }
    } catch (err: any) {
      setEgvError(err.message || "Failed to fetch EGV data");
      toast.error(err.message || "Failed to fetch EGV data");
    } finally {
      setEgvLoading(false);
      setEgvLoadProgress("");
    }
  }, [egvStartDate, egvEndDate, timezone, dexcomEnv]);

  const handleCalculateCorrelations = useCallback(async () => {
    if (!egvRecords.length) {
      toast.error("No EGV data available. Please fetch EGV data first.");
      return;
    }
    setCorrelating(true);
    try {
      await correlationMutation.mutateAsync({
        egvData: egvRecords.map((r: any) => ({
          systemTime: r.systemTime,
          value: r.value,
        })),
      });
    } catch (err: any) {
      toast.error(err.message || "Failed to calculate correlations");
    } finally {
      setCorrelating(false);
    }
  }, [egvRecords, correlationMutation]);

  const toggleMetric = (metric: AppleHealthMetricKey) => {
    setSelectedMetrics((prev) =>
      prev.includes(metric)
        ? prev.filter((m) => m !== metric)
        : [...prev, metric]
    );
  };

  const isConnected = dexcomStatus.data?.connected === true;
  const hasHealthData = healthStatus.data?.uploaded === true;
  const hasEgvData = egvRecords.length > 0;
  const isProcessing = uploadStage === "extracting" || uploadStage === "parsing" || uploadStage === "saving";
  const hasDatesSelected = !!egvStartDate && !!egvEndDate;

  // Compute date range in days for display
  const rangeDays = useMemo(() => {
    if (!egvStartDate || !egvEndDate) return null;
    const apiStart = inputToApiDate(egvStartDate, timezone);
    const apiEnd = inputToApiDate(egvEndDate, timezone);
    const diff = (new Date(apiEnd).getTime() - new Date(apiStart).getTime()) / (1000 * 60 * 60 * 24);
    return isNaN(diff) ? null : diff;
  }, [egvStartDate, egvEndDate, timezone]);

  const filteredWorkouts = useMemo(() => {
    if (!workouts.data || !egvRecords.length) return [];
    // Use the actual time range of fetched EGV data
    const times = egvRecords.map((r: any) => new Date(r.systemTime).getTime());
    const start = Math.min(...times);
    const end = Math.max(...times);
    return workouts.data.filter((w: any) => {
      const wStart = new Date(w.startDate).getTime();
      return wStart >= start && wStart <= end;
    });
  }, [workouts.data, egvRecords]);

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
            <div className="flex items-center gap-1.5 mt-2 text-blue-400">
              <Cpu className="w-3 h-3" />
              <span>Files are parsed locally in your browser — nothing is uploaded to the server until parsing is complete.</span>
            </div>
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
              disabled={isProcessing}
              className="font-mono text-xs"
            >
              {isProcessing ? (
                <>
                  <Loader2 className="w-3 h-3 mr-1 animate-spin" />
                  Processing...
                </>
              ) : (
                <>
                  <Upload className="w-3 h-3 mr-1" />
                  Upload ZIP
                </>
              )}
            </Button>

            {hasHealthData && !isProcessing && (
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
          {isProcessing && (
            <div className="bg-blue-500/10 rounded-md p-3 border border-blue-500/20 space-y-2">
              <div className="flex items-center gap-2 text-xs font-mono text-blue-400">
                <Loader2 className="w-3 h-3 animate-spin" />
                <span>
                  {uploadStage === "extracting" && "Extracting XML from ZIP..."}
                  {uploadStage === "parsing" && "Parsing health data..."}
                  {uploadStage === "saving" && "Saving results to database..."}
                </span>
              </div>
              <Progress value={progressPct} className="h-1.5" />
              <div className="text-[10px] font-mono text-muted-foreground">
                {progressDetail}
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
                <span>{progressDetail || "Processing failed. Please try again."}</span>
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
                Start Date ({timezone === "utc" ? "UTC" : "Local"})
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
                End Date ({timezone === "utc" ? "UTC" : "Local"})
              </label>
              <input
                type="datetime-local"
                value={egvEndDate}
                onChange={(e) => setEgvEndDate(e.target.value)}
                className="w-full bg-background border border-border rounded px-2 py-1.5 text-xs font-mono text-foreground focus:outline-none focus:ring-1 focus:ring-primary"
              />
            </div>
          </div>

          {/* Date range info */}
          {rangeDays !== null && rangeDays > 0 && (
            <div className="text-[10px] font-mono text-muted-foreground">
              Selected range: {rangeDays.toFixed(1)} days
              {rangeDays > 7 && ` (will fetch in ${Math.ceil(rangeDays / 7)} chunks of up to 7 days each)`}
            </div>
          )}

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

          {/* Apply / Show Correlations button */}
          <div className="flex items-center gap-3 pt-1">
            <Button
              size="sm"
              onClick={handleApplyRange}
              disabled={!hasDatesSelected || !isConnected || !hasHealthData || egvLoading}
              className="font-mono text-xs bg-emerald-600 hover:bg-emerald-700 text-white"
            >
              {egvLoading ? (
                <>
                  <Loader2 className="w-3 h-3 mr-1.5 animate-spin" />
                  Loading EGV Data...
                </>
              ) : (
                <>
                  <Play className="w-3 h-3 mr-1.5" />
                  Show Correlations
                </>
              )}
            </Button>

            {hasEgvData && (
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
                    Calculate Pearson r
                  </>
                )}
              </Button>
            )}

            {/* Contextual hints */}
            {!hasHealthData && !isProcessing && (
              <span className="text-[10px] font-mono text-muted-foreground">
                Upload Apple Health data first (Step 1)
              </span>
            )}
            {hasHealthData && !isConnected && (
              <span className="text-[10px] font-mono text-muted-foreground">
                Connect to Dexcom first (Connect tab)
              </span>
            )}
            {hasHealthData && isConnected && !hasDatesSelected && (
              <span className="text-[10px] font-mono text-muted-foreground">
                Select a date range above
              </span>
            )}
          </div>

          {/* EGV loading progress */}
          {egvLoading && egvLoadProgress && (
            <div className="flex items-center gap-2 text-xs font-mono text-blue-400 bg-blue-400/10 rounded-md p-2 border border-blue-400/20">
              <Loader2 className="w-3 h-3 animate-spin" />
              {egvLoadProgress}
            </div>
          )}

          {/* EGV fetch status messages */}
          {egvError && !egvLoading && (
            <div className="flex items-center gap-2 text-xs font-mono text-red-400 bg-red-400/10 rounded-md p-2 border border-red-400/20">
              <XCircle className="w-3 h-3" />
              Failed to load EGV data: {egvError}
            </div>
          )}

          {hasEgvData && !egvLoading && (
            <div className="flex items-center gap-2 text-xs font-mono text-green-400 bg-green-400/10 rounded-md p-2 border border-green-400/20">
              <CheckCircle2 className="w-3 h-3" />
              Loaded {egvRecords.length.toLocaleString()} EGV records. Chart is displayed below.
            </div>
          )}

          {!egvLoading && !egvError && !hasEgvData && egvRecords !== null && egvLoadProgress === "" && egvStartDate && egvEndDate && egvRecords.length === 0 && uploadStage === "done" && (
            <div className="flex items-center gap-2 text-xs font-mono text-yellow-400 bg-yellow-400/10 rounded-md p-2 border border-yellow-400/20">
              <AlertTriangle className="w-3 h-3" />
              No EGV records found for this date range. Try adjusting the dates.
            </div>
          )}
        </CardContent>
      </Card>

      {/* Step 3: Correlation Chart */}
      {hasEgvData && healthBuckets.data && (
        <Card className="bg-card border-border">
          <CardHeader className="pb-3">
            <CardTitle className="text-sm font-mono flex items-center gap-2">
              <Activity className="w-4 h-4 text-purple-400" />
              Glucose + Health Metrics Overlay
            </CardTitle>
          </CardHeader>
          <CardContent>
            <CorrelationChart
              egvData={egvRecords}
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
      {!hasHealthData && !isProcessing && uploadStage !== "error" && (
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
