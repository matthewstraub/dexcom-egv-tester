import { useAuth } from "@/_core/hooks/useAuth";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Input } from "@/components/ui/input";
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs";
import { Badge } from "@/components/ui/badge";
import { Separator } from "@/components/ui/separator";
import { getLoginUrl } from "@/const";
import { trpc } from "@/lib/trpc";
import { EgvChart } from "@/components/EgvChart";
import { JsonViewer } from "@/components/JsonViewer";
import {
  Activity, CheckCircle2, Circle, ExternalLink, Loader2, LogOut,
  Plug, PlugZap, Terminal, Unplug, XCircle, Globe, FlaskConical,
} from "lucide-react";
import { useEffect, useState } from "react";
import { toast } from "sonner";
import type { DexcomEnv } from "../../../shared/const";
import { DEXCOM_BASE_URLS } from "../../../shared/const";

const TREND_MAP: Record<string, { arrow: string; range: string }> = {
  doubleUp: { arrow: "\u2B06\u2B06", range: "(+3 to +8)" },
  singleUp: { arrow: "\u2B06", range: "(+2 to +3)" },
  fortyFiveUp: { arrow: "\u2197", range: "(+1 to +2)" },
  flat: { arrow: "\u2192", range: "(-1 to +1)" },
  fortyFiveDown: { arrow: "\u2198", range: "(-2 to -1)" },
  singleDown: { arrow: "\u2B07", range: "(-3 to -2)" },
  doubleDown: { arrow: "\u2B07\u2B07", range: "(-8 to -3)" },
};

function OAuthStep({ step, title, description, status }: { step: number; title: string; description: string; status: "pending" | "complete" | "ready" }) {
  const cls = status === "complete"
    ? "bg-green-500/10 text-green-400 border border-green-500/30"
    : status === "ready"
      ? "bg-primary/10 text-primary border border-primary/30"
      : "bg-secondary text-muted-foreground border border-border";
  const textCls = status === "complete" ? "text-green-400" : status === "ready" ? "text-primary" : "text-muted-foreground";
  return (
    <div className="flex items-start gap-3">
      <div className={"w-6 h-6 rounded-full flex items-center justify-center text-xs font-mono shrink-0 " + cls}>
        {status === "complete" ? "\u2713" : step}
      </div>
      <div>
        <p className={"text-sm font-medium " + textCls}>{title}</p>
        <p className="text-xs text-muted-foreground mt-0.5">{description}</p>
      </div>
    </div>
  );
}

function ParamRow({ name, type, required, description }: { name: string; type: string; required?: boolean; description: string }) {
  return (
    <div className="flex flex-col gap-0.5 px-3 py-2 rounded-md bg-secondary/30">
      <div className="flex items-center gap-2">
        <code className="text-xs text-primary">{name}</code>
        <span className="text-[10px] text-muted-foreground">{type}</span>
        {required && <Badge variant="outline" className="text-[10px] h-4 px-1 border-destructive/30 text-destructive">required</Badge>}
      </div>
      <span className="text-[11px] text-muted-foreground">{description}</span>
    </div>
  );
}

function EnvToggle({ env, onChange }: { env: DexcomEnv; onChange: (env: DexcomEnv) => void }) {
  return (
    <div className="flex items-center gap-1 p-0.5 rounded-lg bg-secondary/50 border border-border">
      <button
        onClick={() => onChange("sandbox")}
        className={
          "flex items-center gap-1.5 px-3 py-1.5 rounded-md text-xs font-mono transition-all " +
          (env === "sandbox"
            ? "bg-amber-500/15 text-amber-400 border border-amber-500/30"
            : "text-muted-foreground hover:text-foreground")
        }
      >
        <FlaskConical className="h-3 w-3" />
        Sandbox
      </button>
      <button
        onClick={() => onChange("production")}
        className={
          "flex items-center gap-1.5 px-3 py-1.5 rounded-md text-xs font-mono transition-all " +
          (env === "production"
            ? "bg-green-500/15 text-green-400 border border-green-500/30"
            : "text-muted-foreground hover:text-foreground")
        }
      >
        <Globe className="h-3 w-3" />
        Production
      </button>
    </div>
  );
}

export default function Home() {
  const { user, loading, isAuthenticated, logout } = useAuth();
  const [activeTab, setActiveTab] = useState("connect");
  const [startDate, setStartDate] = useState("");
  const [endDate, setEndDate] = useState("");
  const [queryEnabled, setQueryEnabled] = useState(false);
  const [dexcomEnv, setDexcomEnv] = useState<DexcomEnv>("sandbox");

  const dexcomStatus = trpc.dexcom.status.useQuery(
    { env: dexcomEnv },
    { enabled: isAuthenticated, refetchOnWindowFocus: false }
  );

  const dataRange = trpc.dexcom.dataRange.useQuery(
    { env: dexcomEnv },
    {
      enabled: isAuthenticated && dexcomStatus.data?.connected === true,
      refetchOnWindowFocus: false,
      retry: false,
    }
  );

  const egvQuery = trpc.dexcom.egvs.useQuery(
    { startDate, endDate, env: dexcomEnv },
    { enabled: queryEnabled && !!startDate && !!endDate, refetchOnWindowFocus: false, retry: false }
  );

  const disconnectMutation = trpc.dexcom.disconnect.useMutation({
    onSuccess: () => { toast.success(`Disconnected from Dexcom (${dexcomEnv})`); dexcomStatus.refetch(); },
  });

  // Handle env change: reset query state and refetch status
  const handleEnvChange = (newEnv: DexcomEnv) => {
    setDexcomEnv(newEnv);
    setQueryEnabled(false);
    setStartDate("");
    setEndDate("");
  };

  useEffect(() => {
    const params = new URLSearchParams(window.location.search);
    if (params.get("dexcom_connected") === "true") {
      const connectedEnv = (params.get("env") as DexcomEnv) || "sandbox";
      setDexcomEnv(connectedEnv);
      toast.success(`Successfully connected to Dexcom (${connectedEnv})!`);
      dexcomStatus.refetch();
      setActiveTab("data");
      window.history.replaceState({}, "", "/");
    }
    if (params.get("dexcom_error")) {
      toast.error("Dexcom error: " + params.get("dexcom_error"));
      window.history.replaceState({}, "", "/");
    }
  }, []);

  useEffect(() => {
    if (dataRange.data?.egvs) {
      const egvRange = dataRange.data.egvs;
      if (egvRange.start?.systemTime && egvRange.end?.systemTime) {
        const endTime = new Date(egvRange.end.systemTime);
        const startTime = new Date(endTime.getTime() - 3 * 60 * 60 * 1000);
        setStartDate(startTime.toISOString().slice(0, 19));
        setEndDate(endTime.toISOString().slice(0, 19));
      }
    }
  }, [dataRange.data]);

  useEffect(() => {
    if (dexcomStatus.data?.connected) setActiveTab("data");
  }, [dexcomStatus.data?.connected]);

  const handleConnect = async () => {
    try {
      const origin = window.location.origin;
      const response = await fetch(`/api/dexcom/authorize?origin=${encodeURIComponent(origin)}&env=${dexcomEnv}`);
      const data = await response.json();
      if (data.authUrl) window.location.href = data.authUrl;
      else toast.error("Failed to get authorization URL");
    } catch { toast.error("Failed to initiate Dexcom connection"); }
  };

  const handleFetchEgvs = () => {
    if (!startDate || !endDate) { toast.error("Please enter both start and end dates"); return; }
    const start = new Date(startDate);
    const end = new Date(endDate);
    if (isNaN(start.getTime()) || isNaN(end.getTime())) { toast.error("Invalid date format"); return; }
    if (start >= end) { toast.error("Start date must be before end date"); return; }
    const diffDays = (end.getTime() - start.getTime()) / (1000 * 60 * 60 * 24);
    if (diffDays > 30) { toast.error(`Date range is ${diffDays.toFixed(1)} days. Dexcom API maximum is 30 days.`); return; }
    setQueryEnabled(true);
  };

  const recordCount = egvQuery.data?.records?.length ?? 0;
  const baseUrl = DEXCOM_BASE_URLS[dexcomEnv];
  const isProduction = dexcomEnv === "production";

  if (loading) {
    return (
      <div className="min-h-screen flex items-center justify-center bg-background">
        <div className="flex flex-col items-center gap-4">
          <Loader2 className="h-8 w-8 animate-spin text-primary" />
          <span className="font-mono text-sm text-muted-foreground">Initializing...</span>
        </div>
      </div>
    );
  }

  if (!isAuthenticated) {
    return (
      <div className="min-h-screen flex items-center justify-center bg-background">
        <Card className="w-full max-w-md bg-card border-border">
          <CardHeader className="text-center space-y-4">
            <div className="mx-auto w-12 h-12 rounded-lg bg-primary/10 flex items-center justify-center">
              <Terminal className="h-6 w-6 text-primary" />
            </div>
            <CardTitle className="text-xl font-semibold">Dexcom EGV Tester</CardTitle>
            <p className="text-sm text-muted-foreground">Sign in to test the Dexcom API and explore EGV data</p>
          </CardHeader>
          <CardContent>
            <Button onClick={() => (window.location.href = getLoginUrl())} className="w-full" size="lg">Sign In to Continue</Button>
          </CardContent>
        </Card>
      </div>
    );
  }

  return (
    <div className="min-h-screen bg-background">
      <header className="border-b border-border bg-card/50 backdrop-blur-sm sticky top-0 z-50">
        <div className="container flex items-center justify-between h-14">
          <div className="flex items-center gap-3">
            <div className="w-8 h-8 rounded-md bg-primary/10 flex items-center justify-center">
              <Terminal className="h-4 w-4 text-primary" />
            </div>
            <div>
              <h1 className="text-sm font-semibold tracking-tight">Dexcom EGV Tester</h1>
              <p className="text-[10px] font-mono text-muted-foreground">{baseUrl.replace("https://", "")}</p>
            </div>
          </div>
          <div className="flex items-center gap-3">
            <EnvToggle env={dexcomEnv} onChange={handleEnvChange} />
            <Separator orientation="vertical" className="h-6" />
            <div className="flex items-center gap-2 px-3 py-1.5 rounded-md bg-secondary/50 border border-border">
              {dexcomStatus.data?.connected ? (
                <><Circle className="h-2 w-2 fill-green-400 text-green-400" /><span className="text-xs font-mono text-green-400">Connected</span></>
              ) : (
                <><Circle className="h-2 w-2 fill-muted-foreground text-muted-foreground" /><span className="text-xs font-mono text-muted-foreground">Disconnected</span></>
              )}
            </div>
            <Separator orientation="vertical" className="h-6" />
            <div className="flex items-center gap-2">
              <span className="text-xs text-muted-foreground">{user?.name}</span>
              <Button variant="ghost" size="sm" onClick={logout} className="h-8 w-8 p-0"><LogOut className="h-3.5 w-3.5" /></Button>
            </div>
          </div>
        </div>
      </header>

      <main className="container py-6">
        <Tabs value={activeTab} onValueChange={setActiveTab}>
          <TabsList className="bg-secondary/50 border border-border mb-6">
            <TabsTrigger value="connect" className="font-mono text-xs data-[state=active]:bg-card"><Plug className="h-3.5 w-3.5 mr-1.5" />Connect</TabsTrigger>
            <TabsTrigger value="data" className="font-mono text-xs data-[state=active]:bg-card" disabled={!dexcomStatus.data?.connected}><Activity className="h-3.5 w-3.5 mr-1.5" />EGV Data</TabsTrigger>
            <TabsTrigger value="info" className="font-mono text-xs data-[state=active]:bg-card"><ExternalLink className="h-3.5 w-3.5 mr-1.5" />API Info</TabsTrigger>
          </TabsList>

          <TabsContent value="connect" className="space-y-6">
            {isProduction && (
              <Card className="bg-amber-500/5 border-amber-500/20">
                <CardContent className="pt-6">
                  <div className="flex items-start gap-3">
                    <Globe className="h-5 w-5 text-amber-400 shrink-0 mt-0.5" />
                    <div>
                      <p className="text-sm font-medium text-amber-400">Production Environment</p>
                      <p className="text-xs text-muted-foreground mt-1">
                        You are connecting to the <strong>production</strong> Dexcom API. This will access real patient data.
                        The user who authorizes will sign in with their actual Dexcom account credentials.
                      </p>
                    </div>
                  </div>
                </CardContent>
              </Card>
            )}

            <div className="grid gap-6 lg:grid-cols-2">
              <Card className="bg-card border-border">
                <CardHeader><CardTitle className="text-base flex items-center gap-2"><PlugZap className="h-4 w-4 text-primary" />Dexcom OAuth2 Connection</CardTitle></CardHeader>
                <CardContent className="space-y-4">
                  <div className="space-y-3">
                    <OAuthStep
                      step={1}
                      title="Redirect to Dexcom Login"
                      description={`User is redirected to ${baseUrl.replace("https://", "")} for authentication`}
                      status={dexcomStatus.data?.connected ? "complete" : "pending"}
                    />
                    <OAuthStep
                      step={2}
                      title="User Authorizes Access"
                      description={isProduction ? "User signs in with Dexcom credentials and grants authorization" : "Select sandbox user and grant HIPAA authorization"}
                      status={dexcomStatus.data?.connected ? "complete" : "pending"}
                    />
                    <OAuthStep step={3} title="Exchange Code for Tokens" description="Authorization code exchanged for access + refresh tokens" status={dexcomStatus.data?.connected ? "complete" : "pending"} />
                    <OAuthStep step={4} title="Fetch EGV Data" description="Use bearer token to call /v3/users/self/egvs" status={dexcomStatus.data?.connected ? "ready" : "pending"} />
                  </div>
                  <Separator />
                  {dexcomStatus.data?.connected ? (
                    <div className="space-y-3">
                      <div className="flex items-center gap-2 text-sm">
                        <CheckCircle2 className="h-4 w-4 text-green-400" />
                        <span className="text-green-400 font-medium">Connected to Dexcom {isProduction ? "Production" : "Sandbox"}</span>
                      </div>
                      <Button variant="outline" size="sm" onClick={() => disconnectMutation.mutate({ env: dexcomEnv })} disabled={disconnectMutation.isPending} className="text-destructive hover:text-destructive">
                        <Unplug className="h-3.5 w-3.5 mr-1.5" />Disconnect
                      </Button>
                    </div>
                  ) : (
                    <Button onClick={handleConnect} className="w-full">
                      <PlugZap className="h-4 w-4 mr-2" />Connect to Dexcom {isProduction ? "Production" : "Sandbox"}
                    </Button>
                  )}
                </CardContent>
              </Card>

              <Card className="bg-card border-border">
                <CardHeader><CardTitle className="text-base flex items-center gap-2"><Terminal className="h-4 w-4 text-primary" />Setup Instructions</CardTitle></CardHeader>
                <CardContent className="space-y-4">
                  <div className="space-y-3">
                    <div>
                      <label className="text-xs font-mono text-muted-foreground block mb-1.5">Redirect URI (add this to your Dexcom app)</label>
                      <div className="flex gap-2">
                        <code className="flex-1 px-3 py-2 rounded-md bg-[oklch(0.14_0.012_264)] border border-border text-xs font-mono text-primary break-all">{window.location.origin}/api/dexcom/callback</code>
                        <Button variant="outline" size="sm" onClick={() => { navigator.clipboard.writeText(window.location.origin + "/api/dexcom/callback"); toast.success("Copied redirect URI"); }}>Copy</Button>
                      </div>
                    </div>
                    <Separator />
                    <div>
                      <label className="text-xs font-mono text-muted-foreground block mb-1.5">Environment</label>
                      <Badge
                        variant="secondary"
                        className={"font-mono text-xs " + (isProduction ? "bg-green-500/10 text-green-400 border-green-500/20" : "bg-amber-500/10 text-amber-400 border-amber-500/20")}
                      >
                        {isProduction ? "Production" : "Sandbox"}
                      </Badge>
                    </div>
                    <div>
                      <label className="text-xs font-mono text-muted-foreground block mb-1.5">Base URL</label>
                      <code className="text-xs font-mono text-foreground">{baseUrl}</code>
                    </div>
                    {!isProduction && (
                      <div>
                        <label className="text-xs font-mono text-muted-foreground block mb-1.5">Sandbox Users (no password required)</label>
                        <div className="space-y-1">
                          {[{ user: "User7", desc: "G7 Mobile App" }, { user: "User8", desc: "ONE+ Mobile App" }, { user: "User6", desc: "G6 Mobile App" }, { user: "User4", desc: "G6 Touchscreen Receiver" }].map((u) => (
                            <div key={u.user} className="flex items-center gap-2 text-xs font-mono"><span className="text-primary">{u.user}</span><span className="text-muted-foreground">{"\u2014"} {u.desc}</span></div>
                          ))}
                        </div>
                      </div>
                    )}
                    {isProduction && (
                      <div>
                        <label className="text-xs font-mono text-muted-foreground block mb-1.5">Authentication</label>
                        <p className="text-xs text-muted-foreground">
                          In production, users sign in with their real Dexcom account credentials.
                          The data returned will be the actual CGM data from the authorized user's device.
                        </p>
                      </div>
                    )}
                  </div>
                </CardContent>
              </Card>
            </div>
          </TabsContent>

          <TabsContent value="data" className="space-y-6">
            <Card className="bg-card border-border">
              <CardHeader><CardTitle className="text-base flex items-center gap-2"><Activity className="h-4 w-4 text-primary" />EGV Query{recordCount > 0 && <Badge variant="secondary" className="font-mono text-xs ml-2">{recordCount} records</Badge>}</CardTitle></CardHeader>
              <CardContent>
                <div className="flex flex-col sm:flex-row gap-3">
                  <div className="flex-1">
                    <label className="text-xs font-mono text-muted-foreground block mb-1.5">startDate (ISO 8601)</label>
                    <Input type="datetime-local" value={startDate} onChange={(e) => { setStartDate(e.target.value); setQueryEnabled(false); }} className="font-mono text-xs bg-input border-border" />
                  </div>
                  <div className="flex-1">
                    <label className="text-xs font-mono text-muted-foreground block mb-1.5">endDate (ISO 8601)</label>
                    <Input type="datetime-local" value={endDate} onChange={(e) => { setEndDate(e.target.value); setQueryEnabled(false); }} className="font-mono text-xs bg-input border-border" />
                  </div>
                  <div className="flex items-end">
                    <Button onClick={handleFetchEgvs} disabled={egvQuery.isFetching} className="w-full sm:w-auto">
                      {egvQuery.isFetching ? <Loader2 className="h-4 w-4 mr-2 animate-spin" /> : <Activity className="h-4 w-4 mr-2" />}Fetch EGVs
                    </Button>
                  </div>
                </div>
                <div className="mt-3 space-y-2">
                  {startDate && endDate && (() => {
                    const diff = (new Date(endDate).getTime() - new Date(startDate).getTime()) / (1000 * 60 * 60 * 24);
                    const isOver = diff > 30;
                    return (
                      <div className={"px-3 py-2 rounded-md border " + (isOver ? "bg-destructive/10 border-destructive/30" : "bg-secondary/30 border-border")}>
                        <span className={"text-xs font-mono " + (isOver ? "text-destructive" : "text-muted-foreground")}>
                          Selected range: <span className={isOver ? "text-destructive font-medium" : "text-foreground"}>{diff.toFixed(1)} days</span>
                          {isOver && " (max 30 days)"}
                        </span>
                      </div>
                    );
                  })()}
                  {dataRange.data?.egvs && (
                    <div className="px-3 py-2 rounded-md bg-secondary/30 border border-border">
                      <span className="text-xs font-mono text-muted-foreground">Available range: <span className="text-foreground">{new Date(dataRange.data.egvs.start.systemTime).toLocaleDateString()}</span> {"\u2192"} <span className="text-foreground">{new Date(dataRange.data.egvs.end.systemTime).toLocaleDateString()}</span> <span className="text-muted-foreground">(max 30-day window per query)</span></span>
                    </div>
                  )}
                </div>
              </CardContent>
            </Card>

            {egvQuery.error && (
              <Card className="bg-card border-destructive/50"><CardContent className="pt-6"><div className="flex items-start gap-3"><XCircle className="h-5 w-5 text-destructive shrink-0 mt-0.5" /><div><p className="text-sm font-medium text-destructive">API Error</p><p className="text-xs font-mono text-muted-foreground mt-1">{egvQuery.error.message}</p></div></div></CardContent></Card>
            )}

            {egvQuery.data?.records && egvQuery.data.records.length > 0 && (
              <Card className="bg-card border-border">
                <CardHeader><CardTitle className="text-base">Glucose Timeline</CardTitle></CardHeader>
                <CardContent>
                  <EgvChart records={egvQuery.data.records} />
                  <div className="flex items-center gap-4 mt-4 text-xs font-mono text-muted-foreground">
                    <div className="flex items-center gap-1.5"><div className="w-3 h-0.5 bg-[oklch(0.75_0.15_60)]" /><span>70 / 180 mg/dL thresholds</span></div>
                    <div className="flex items-center gap-1.5"><div className="w-3 h-3 bg-[oklch(0.72_0.15_145)] opacity-10 rounded-sm" /><span>Target range</span></div>
                  </div>
                </CardContent>
              </Card>
            )}

            {egvQuery.data && <JsonViewer data={egvQuery.data} title={`Response \u2014 GET /v3/users/self/egvs (${dexcomEnv})`} maxHeight="500px" />}
            {dataRange.data && <JsonViewer data={dataRange.data} title={`Response \u2014 GET /v3/users/self/dataRange (${dexcomEnv})`} maxHeight="300px" />}
          </TabsContent>

          <TabsContent value="info" className="space-y-6">
            <Card className="bg-card border-border">
              <CardHeader><CardTitle className="text-base">Dexcom API V3 {"\u2014"} EGV Endpoint</CardTitle></CardHeader>
              <CardContent className="space-y-4">
                <div className="space-y-3 font-mono text-sm">
                  <div className="flex items-center gap-2">
                    <Badge className="bg-green-500/10 text-green-400 border-green-500/20 font-mono text-xs">GET</Badge>
                    <code className="text-foreground">/v3/users/self/egvs</code>
                  </div>
                  <div className="flex items-center gap-2 text-xs text-muted-foreground">
                    <span>Base URL:</span>
                    <code className={isProduction ? "text-green-400" : "text-amber-400"}>{baseUrl}</code>
                  </div>
                  <Separator />
                  <div>
                    <h4 className="text-xs text-muted-foreground mb-2">Query Parameters</h4>
                    <div className="space-y-2">
                      <ParamRow name="startDate" type="string (ISO 8601)" required description="Beginning of the time window" />
                      <ParamRow name="endDate" type="string (ISO 8601)" required description="End of the time window" />
                    </div>
                  </div>
                  <Separator />
                  <div>
                    <h4 className="text-xs text-muted-foreground mb-2">Response Fields (per record)</h4>
                    <div className="space-y-2">
                      <ParamRow name="value" type="integer (39-401)" description="Estimated glucose value in mg/dL" />
                      <ParamRow name="trend" type="string" description="Trend direction (flat, singleUp, doubleDown, etc.)" />
                      <ParamRow name="trendRate" type="number" description="Rate of change in mg/dL/min" />
                      <ParamRow name="status" type="string | null" description="high or low when out of range" />
                      <ParamRow name="unit" type="string" description="Unit of measurement (mg/dL, mmol/L)" />
                      <ParamRow name="systemTime" type="string (ISO 8601)" description="UTC time of the reading" />
                      <ParamRow name="displayTime" type="string (ISO 8601)" description="Local time displayed on device" />
                      <ParamRow name="displayDevice" type="string" description="Device type (iOS, android, receiver)" />
                      <ParamRow name="transmitterGeneration" type="string" description="Transmitter gen (g6, g7, etc.)" />
                    </div>
                  </div>
                  <Separator />
                  <div>
                    <h4 className="text-xs text-muted-foreground mb-2">Trend Values</h4>
                    <div className="grid grid-cols-2 gap-1 text-xs">
                      {Object.entries(TREND_MAP).map(([key, { arrow, range }]) => (
                        <div key={key} className="flex items-center gap-2 py-0.5">
                          <span className="w-5 text-center">{arrow}</span>
                          <span className="text-primary">{key}</span>
                          <span className="text-muted-foreground">{range}</span>
                        </div>
                      ))}
                    </div>
                  </div>
                </div>
              </CardContent>
            </Card>
          </TabsContent>
        </Tabs>
      </main>
    </div>
  );
}
