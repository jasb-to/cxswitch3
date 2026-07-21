"use client";

import React, { useState, useEffect, useCallback } from "react";
import { Signal, MarketSnapshot, ExitRecord } from "@/lib/strategy";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs";
import { ScrollArea } from "@/components/ui/scroll-area";
import { Separator } from "@/components/ui/separator";
import { Skeleton } from "@/components/ui/skeleton";
import {
  ArrowUpRight,
  ArrowDownRight,
  TrendingUp,
  TrendingDown,
  Target,
  Shield,
  Activity,
  Clock,
  Zap,
  BarChart3,
  AlertTriangle,
  CheckCircle2,
  XCircle,
  RefreshCw,
  Settings,
  Eye,
  Flame,
  Crosshair,
  Rocket,
  Gauge,
} from "lucide-react";

// ─── Types ───
interface DashboardData {
  signals: Signal[];
  snapshots: Record<string, MarketSnapshot>;
  exits: ExitRecord[];
  lastUpdated: number;
  systemStatus: "online" | "degraded" | "offline";
  version: string;
}

// ─── Helpers ───
function formatPrice(price: number): string {
  return price >= 1000
    ? `$${price.toLocaleString("en-US", { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`
    : `$${price.toFixed(4)}`;
}

function formatTimeAgo(ts: number): string {
  const diff = Date.now() - ts;
  const mins = Math.floor(diff / 60000);
  if (mins < 1) return "just now";
  if (mins < 60) return `${mins}m ago`;
  const hours = Math.floor(mins / 60);
  if (hours < 24) return `${hours}h ago`;
  return `${Math.floor(hours / 24)}d ago`;
}

function formatR(r: number): string {
  return r >= 0 ? `+${r.toFixed(2)}R` : `${r.toFixed(2)}R`;
}

// ─── Entry Type Badge (v41 update) ───
function entryTypeBadge(entryType: string | undefined): React.ReactNode {
  if (!entryType) return <Badge variant="outline">Unknown</Badge>;

  const config: Record<string, { label: string; icon: React.ReactNode; variant: "default" | "secondary" | "destructive" | "outline" }> = {
    PULLBACK: { label: "Pullback", icon: <Crosshair className="w-3 h-3 mr-1" />, variant: "default" },
    BREAKOUT: { label: "Breakout", icon: <Rocket className="w-3 h-3 mr-1" />, variant: "secondary" },
    FADE: { label: "Fade", icon: <Zap className="w-3 h-3 mr-1" />, variant: "destructive" },
  };

  const cfg = config[entryType] || { label: entryType, icon: null, variant: "outline" as const };

  return (
    <Badge variant={cfg.variant} className="flex items-center gap-0.5">
      {cfg.icon}
      {cfg.label}
    </Badge>
  );
}

// ─── Direction Badge ───
function directionBadge(direction: string): React.ReactNode {
  return direction === "LONG" ? (
    <Badge className="bg-emerald-500 hover:bg-emerald-600 text-white flex items-center gap-1">
      <ArrowUpRight className="w-3 h-3" /> LONG
    </Badge>
  ) : (
    <Badge className="bg-rose-500 hover:bg-rose-600 text-white flex items-center gap-1">
      <ArrowDownRight className="w-3 h-3" /> SHORT
    </Badge>
  );
}

// ─── Confidence Badge ───
function confidenceBadge(confidence: number): React.ReactNode {
  if (confidence >= 80) return <Badge className="bg-emerald-500 text-white">{confidence}%</Badge>;
  if (confidence >= 60) return <Badge className="bg-amber-500 text-white">{confidence}%</Badge>;
  if (confidence >= 40) return <Badge variant="outline">{confidence}%</Badge>;
  return <Badge variant="secondary">{confidence}%</Badge>;
}

// ─── Phase Badge ───
function phaseBadge(phase: string): React.ReactNode {
  const colors: Record<string, string> = {
    ENTRY: "bg-blue-500",
    BUILDING: "bg-amber-500",
    TREND: "bg-emerald-500",
    PROFIT_PROTECTION: "bg-purple-500",
    EXIT: "bg-rose-500",
    COOLDOWN: "bg-slate-500",
    WATCH: "bg-slate-400",
  };
  return <Badge className={`${colors[phase] || "bg-slate-500"} text-white`}>{phase}</Badge>;
}

// ─── Signal Card ───
function SignalCard({ signal }: { signal: Signal }) {
  const currentR = signal.tradeState?.currentR || 0;
  const isProfitable = currentR > 0;
  const pnlColor = isProfitable ? "text-emerald-500" : currentR < 0 ? "text-rose-500" : "text-slate-500";

  return (
    <Card className="hover:shadow-md transition-shadow">
      <CardHeader className="pb-2">
        <div className="flex items-center justify-between">
          <div className="flex items-center gap-2">
            {directionBadge(signal.direction)}
            {entryTypeBadge(signal.entryType)}
            <span className="font-bold text-lg">{signal.pair}</span>
          </div>
          <div className="flex items-center gap-2">
            {confidenceBadge(signal.confidence)}
            <span className="text-xs text-muted-foreground">{formatTimeAgo(signal.timestamp)}</span>
          </div>
        </div>
      </CardHeader>
      <CardContent className="space-y-3">
        <div className="grid grid-cols-3 gap-4">
          <div>
            <p className="text-xs text-muted-foreground">Entry</p>
            <p className="font-mono font-semibold">{formatPrice(signal.entry)}</p>
          </div>
          <div>
            <p className="text-xs text-muted-foreground">Stop</p>
            <p className="font-mono font-semibold text-rose-500">{formatPrice(signal.stop)}</p>
          </div>
          <div>
            <p className="text-xs text-muted-foreground">Target</p>
            <p className="font-mono font-semibold text-emerald-500">{formatPrice(signal.target)}</p>
          </div>
        </div>

        <Separator />

        <div className="flex items-center justify-between">
          <div className="flex items-center gap-2">
            <Gauge className="w-4 h-4 text-muted-foreground" />
            <span className={`font-mono font-bold ${pnlColor}`}>{formatR(currentR)}</span>
          </div>
          <div className="flex items-center gap-2 text-xs text-muted-foreground">
            {signal.rr && (
              <span>RR {signal.rr.toFixed(2)}</span>
            )}
            {signal.positionSizePct && (
              <span>Size {(signal.positionSizePct * 100).toFixed(0)}%</span>
            )}
            <span className="text-xs bg-slate-100 px-1.5 py-0.5 rounded">v{signal.version || 41}</span>
          </div>
        </div>

        {signal.tradeState && (
          <div className="flex items-center gap-2">
            {phaseBadge(signal.tradeState.phase)}
            {signal.tradeState.lockedStop && (
              <Badge variant="outline" className="text-amber-600 border-amber-300">
                <Shield className="w-3 h-3 mr-1" /> Trail: {formatPrice(signal.tradeState.lockedStop)}
              </Badge>
            )}
          </div>
        )}

        {signal.trendlinePrice && (
          <p className="text-xs text-muted-foreground">
            Trendline: {formatPrice(signal.trendlinePrice)}
          </p>
        )}

        {signal.debug && signal.debug.length > 0 && (
          <details className="text-xs">
            <summary className="cursor-pointer text-muted-foreground hover:text-foreground">Debug ({signal.debug.length} lines)</summary>
            <ScrollArea className="h-32 mt-2 bg-slate-50 rounded p-2">
              <pre className="text-[10px] leading-tight">{signal.debug.slice(0, 20).join("\n")}</pre>
            </ScrollArea>
          </details>
        )}
      </CardContent>
    </Card>
  );
}

// ─── Snapshot Card ───
function SnapshotCard({ snapshot }: { snapshot: MarketSnapshot }) {
  const dirColor = snapshot.bias?.direction === "LONG" ? "text-emerald-500" : snapshot.bias?.direction === "SHORT" ? "text-rose-500" : "text-slate-500";
  const dirIcon = snapshot.bias?.direction === "LONG" ? <TrendingUp className="w-4 h-4" /> : <TrendingDown className="w-4 h-4" />;

  return (
    <Card>
      <CardHeader className="pb-2">
        <div className="flex items-center justify-between">
          <div className="flex items-center gap-2">
            {dirIcon}
            <span className="font-bold">{snapshot.pair}</span>
          </div>
          <div className="flex items-center gap-2">
            {snapshot.readiness >= 80 ? (
              <Flame className="w-4 h-4 text-orange-500" />
            ) : snapshot.readiness >= 60 ? (
              <Eye className="w-4 h-4 text-amber-500" />
            ) : (
              <Clock className="w-4 h-4 text-slate-400" />
            )}
            <span className="text-sm font-mono">{snapshot.readiness}%</span>
          </div>
        </div>
      </CardHeader>
      <CardContent className="space-y-2">
        <div className="flex items-center justify-between">
          <span className="text-2xl font-bold font-mono">{formatPrice(snapshot.price)}</span>
          <span className={`text-sm font-semibold ${dirColor}`}>
            {snapshot.bias?.direction || "—"} {snapshot.bias?.strength || ""}
          </span>
        </div>

        <div className="grid grid-cols-2 gap-2 text-xs">
          <div className="bg-slate-50 rounded p-2">
            <p className="text-muted-foreground">1D Trend</p>
            <p className="font-semibold">{snapshot.trend1d?.direction || "—"} {snapshot.trend1d?.strength || ""}</p>
          </div>
          <div className="bg-slate-50 rounded p-2">
            <p className="text-muted-foreground">4H Trend</p>
            <p className="font-semibold">{snapshot.trend4h?.direction || "—"} {snapshot.trend4h?.strength || ""}</p>
          </div>
        </div>

        <div className="grid grid-cols-3 gap-1 text-xs text-center">
          <div className="bg-slate-50 rounded p-1">
            <p className="text-muted-foreground">4H Stoch</p>
            <p className="font-mono">K:{snapshot.stoch4h.k.toFixed(1)}</p>
          </div>
          <div className="bg-slate-50 rounded p-1">
            <p className="text-muted-foreground">1H Stoch</p>
            <p className="font-mono">K:{snapshot.stoch1h.k.toFixed(1)}</p>
          </div>
          <div className="bg-slate-50 rounded p-1">
            <p className="text-muted-foreground">15M Stoch</p>
            <p className="font-mono">K:{snapshot.stoch15m.k.toFixed(1)}</p>
          </div>
        </div>

        <div className="flex items-center gap-2 text-xs">
          <Badge variant={snapshot.emaAligned ? "default" : "outline"} className={snapshot.emaAligned ? "bg-emerald-500" : ""}>
            {snapshot.emaAligned ? "Aligned" : "Misaligned"}
          </Badge>
          {snapshot.isPullback && (
            <Badge variant="secondary">
              <Crosshair className="w-3 h-3 mr-1" /> Pullback
            </Badge>
          )}
          {snapshot.volumeConfirmed && (
            <Badge variant="outline" className="text-blue-600">
              <Activity className="w-3 h-3 mr-1" /> Vol
            </Badge>
          )}
        </div>

        {snapshot.recommendedAction && (
          <div className="bg-amber-50 border border-amber-200 rounded p-2 text-xs">
            <p className="font-semibold text-amber-700 flex items-center gap-1">
              <Zap className="w-3 h-3" /> {snapshot.recommendedAction}
            </p>
            {snapshot.entryTier && (
              <p className="text-muted-foreground mt-1">{snapshot.entryTier}</p>
            )}
          </div>
        )}
      </CardContent>
    </Card>
  );
}

// ─── Exit Card ───
function ExitCard({ exit }: { exit: ExitRecord }) {
  const isWin = exit.pnl > 0;
  return (
    <Card className={isWin ? "border-emerald-200" : "border-rose-200"}>
      <CardContent className="p-4">
        <div className="flex items-center justify-between">
          <div className="flex items-center gap-2">
            {exit.direction === "LONG" ? (
              <ArrowUpRight className={`w-4 h-4 ${isWin ? "text-emerald-500" : "text-rose-500"}`} />
            ) : (
              <ArrowDownRight className={`w-4 h-4 ${isWin ? "text-emerald-500" : "text-rose-500"}`} />
            )}
            <span className="font-semibold">{exit.pair}</span>
            <Badge variant="outline" className="text-xs">{exit.reason.replace(/_/g, " ")}</Badge>
          </div>
          <span className={`font-mono font-bold ${isWin ? "text-emerald-500" : "text-rose-500"}`}>
            {isWin ? "+" : ""}{exit.pnl.toFixed(2)}%
          </span>
        </div>
        <div className="flex items-center gap-4 mt-2 text-xs text-muted-foreground">
          <span>Entry: {formatPrice(exit.entry)}</span>
          <span>Exit: {formatPrice(exit.exitPrice)}</span>
          <span>{formatTimeAgo(exit.timestamp)}</span>
        </div>
      </CardContent>
    </Card>
  );
}

// ─── Stats Card ───
function StatsCard({ title, value, icon, color }: { title: string; value: string; icon: React.ReactNode; color: string }) {
  return (
    <Card>
      <CardContent className="p-4 flex items-center gap-4">
        <div className={`p-2 rounded-lg ${color}`}>
          {icon}
        </div>
        <div>
          <p className="text-sm text-muted-foreground">{title}</p>
          <p className="text-2xl font-bold">{value}</p>
        </div>
      </CardContent>
    </Card>
  );
}

// ─── Main Dashboard ───
export default function DashboardPage() {
  const [data, setData] = useState<DashboardData | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [activeTab, setActiveTab] = useState("signals");

  const fetchData = useCallback(async () => {
    try {
      const res = await fetch("/api/dashboard");
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      const json = await res.json();
      setData(json);
      setError(null);
    } catch (err) {
      setError(err instanceof Error ? err.message : "Failed to fetch");
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    fetchData();
    const interval = setInterval(fetchData, 30000); // 30s refresh
    return () => clearInterval(interval);
  }, [fetchData]);

  if (loading) {
    return (
      <div className="p-6 space-y-4">
        <Skeleton className="h-8 w-64" />
        <div className="grid grid-cols-4 gap-4">
          {[1, 2, 3, 4].map(i => <Skeleton key={i} className="h-24" />)}
        </div>
        <Skeleton className="h-96" />
      </div>
    );
  }

  if (error) {
    return (
      <div className="p-6">
        <Card className="border-rose-200">
          <CardContent className="p-6 flex items-center gap-4">
            <AlertTriangle className="w-8 h-8 text-rose-500" />
            <div>
              <p className="font-semibold text-rose-600">Connection Error</p>
              <p className="text-sm text-muted-foreground">{error}</p>
              <Button variant="outline" size="sm" className="mt-2" onClick={fetchData}>
                <RefreshCw className="w-4 h-4 mr-2" /> Retry
              </Button>
            </div>
          </CardContent>
        </Card>
      </div>
    );
  }

  if (!data) return null;

  const activeSignals = data.signals.filter(s => !s.exited);
  const exitedSignals = data.signals.filter(s => s.exited);
  const winCount = data.exits.filter(e => e.pnl > 0).length;
  const lossCount = data.exits.filter(e => e.pnl < 0).length;
  const totalPnL = data.exits.reduce((sum, e) => sum + e.pnl, 0);
  const winRate = data.exits.length > 0 ? (winCount / data.exits.length * 100).toFixed(1) : "0";

  return (
    <div className="p-6 space-y-6 max-w-7xl mx-auto">
      {/* Header */}
      <div className="flex items-center justify-between">
        <div>
          <h1 className="text-2xl font-bold flex items-center gap-2">
            <BarChart3 className="w-6 h-6" />
            CXSwitch Dashboard
          </h1>
          <p className="text-sm text-muted-foreground">
            v41 "Trendline Break" — Method 1 (Pressure Cooker) Early Entry
          </p>
        </div>
        <div className="flex items-center gap-2">
          <Badge
            variant={data.systemStatus === "online" ? "default" : data.systemStatus === "degraded" ? "secondary" : "destructive"}
            className={data.systemStatus === "online" ? "bg-emerald-500" : ""}
          >
            {data.systemStatus === "online" ? <CheckCircle2 className="w-3 h-3 mr-1" /> : <XCircle className="w-3 h-3 mr-1" />}
            {data.systemStatus}
          </Badge>
          <span className="text-xs text-muted-foreground">Updated {formatTimeAgo(data.lastUpdated)}</span>
          <Button variant="outline" size="sm" onClick={fetchData}>
            <RefreshCw className="w-4 h-4" />
          </Button>
        </div>
      </div>

      {/* Stats */}
      <div className="grid grid-cols-4 gap-4">
        <StatsCard
          title="Active Signals"
          value={activeSignals.length.toString()}
          icon={<Target className="w-5 h-5 text-white" />}
          color="bg-blue-500"
        />
        <StatsCard
          title="Win Rate"
          value={`${winRate}%`}
          icon={<CheckCircle2 className="w-5 h-5 text-white" />}
          color="bg-emerald-500"
        />
        <StatsCard
          title="Net PnL"
          value={`${totalPnL >= 0 ? "+" : ""}${totalPnL.toFixed(2)}%`}
          icon={<Activity className="w-5 h-5 text-white" />}
          color={totalPnL >= 0 ? "bg-emerald-500" : "bg-rose-500"}
        />
        <StatsCard
          title="Total Exits"
          value={data.exits.length.toString()}
          icon={<Shield className="w-5 h-5 text-white" />}
          color="bg-slate-500"
        />
      </div>

      {/* Tabs */}
      <Tabs value={activeTab} onValueChange={setActiveTab}>
        <TabsList>
          <TabsTrigger value="signals">
            <Target className="w-4 h-4 mr-2" /> Signals ({activeSignals.length})
          </TabsTrigger>
          <TabsTrigger value="snapshots">
            <Eye className="w-4 h-4 mr-2" /> Market ({Object.keys(data.snapshots).length})
          </TabsTrigger>
          <TabsTrigger value="exits">
            <Shield className="w-4 h-4 mr-2" /> Exits ({data.exits.length})
          </TabsTrigger>
          <TabsTrigger value="history">
            <Clock className="w-4 h-4 mr-2" /> History ({exitedSignals.length})
          </TabsTrigger>
        </TabsList>

        <TabsContent value="signals" className="space-y-4 mt-4">
          {activeSignals.length === 0 ? (
            <Card>
              <CardContent className="p-8 text-center text-muted-foreground">
                <Clock className="w-8 h-8 mx-auto mb-2" />
                <p>No active signals. Waiting for setup...</p>
              </CardContent>
            </Card>
          ) : (
            activeSignals.map(signal => <SignalCard key={signal.id} signal={signal} />)
          )}
        </TabsContent>

        <TabsContent value="snapshots" className="space-y-4 mt-4">
          {Object.keys(data.snapshots).length === 0 ? (
            <Card>
              <CardContent className="p-8 text-center text-muted-foreground">
                <Eye className="w-8 h-8 mx-auto mb-2" />
                <p>No market data available.</p>
              </CardContent>
            </Card>
          ) : (
            Object.values(data.snapshots).map(snapshot => <SnapshotCard key={snapshot.pair} snapshot={snapshot} />)
          )}
        </TabsContent>

        <TabsContent value="exits" className="space-y-4 mt-4">
          {data.exits.length === 0 ? (
            <Card>
              <CardContent className="p-8 text-center text-muted-foreground">
                <Shield className="w-8 h-8 mx-auto mb-2" />
                <p>No exits yet.</p>
              </CardContent>
            </Card>
          ) : (
            data.exits.map(exit => <ExitCard key={exit.id} exit={exit} />)
          )}
        </TabsContent>

        <TabsContent value="history" className="space-y-4 mt-4">
          {exitedSignals.length === 0 ? (
            <Card>
              <CardContent className="p-8 text-center text-muted-foreground">
                <Clock className="w-8 h-8 mx-auto mb-2" />
                <p>No historical signals.</p>
              </CardContent>
            </Card>
          ) : (
            exitedSignals.map(signal => <SignalCard key={signal.id} signal={signal} />)
          )}
        </TabsContent>
      </Tabs>

      {/* Footer */}
      <div className="text-center text-xs text-muted-foreground pt-4">
        CXSwitch v41 "Trendline Break" — Method 1 (Pressure Cooker) Early Entry | Built for account building with tighter stops
      </div>
    </div>
  );
}
