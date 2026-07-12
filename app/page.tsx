"use client";

import { useState, useEffect, useCallback } from "react";

interface TrendContext {
  direction: string;
  strength: string;
}

interface ActiveTradeInfo {
  signalId: string;
  direction: "LONG" | "SHORT";
  state: string;
  pnl: string;
  lockedStop?: number;
  entry: number;
  stop: number;
  target: number;
  entryTier?: string;
  positionSizePct?: number;
}

interface MarketSnapshot {
  pair: string;
  price: number;
  trend: string;
  regime: {
    direction: string | null;
    strength: string;
    confidence: number;
    lockedUntil?: number | null;
  };
  adx?: number;
  rsi?: number;
  stochK?: number;
  stochD?: number;
  stoch1hK?: number;
  stoch1hD?: number;
  trend1h?: TrendContext;
  trend4h?: TrendContext;
  trend1d?: TrendContext;
  trendStrength?: { adx: number; isStrong: boolean };
  phase1h?: "EXPANSION" | "EXHAUSTION" | "NEUTRAL";
  phase4h?: "EXPANSION" | "EXHAUSTION" | "NEUTRAL";
  structure15m?: string;
  readiness?: number;
  recommendedAction?: string;
  entryTier?: string | null;
  positionSize?: string | null;
  whyNoTrade?: string[];
  activeTrade?: ActiveTradeInfo;
  ema21?: number;
  distToEMA21?: number;
  signal?: any;
}

const PAIRS = ["BTC/USD", "ETH/USD", "SOL/USD", "HYPE/USD"];

function dirColor(dir: string | null | undefined): string {
  if (!dir) return "text-gray-400";
  const d = String(dir).toUpperCase();
  if (d === "LONG" || d === "BULLISH") return "text-green-400";
  if (d === "SHORT" || d === "BEARISH") return "text-red-400";
  return "text-gray-400";
}

function strengthBadge(strength: string): string {
  const s = (strength || "").toUpperCase();
  if (s === "STRONG") return "bg-green-500/20 text-green-400 border-green-500/30";
  if (s === "MEDIUM" || s === "MODERATE") return "bg-yellow-500/20 text-yellow-400 border-yellow-500/30";
  if (s === "ACTIVE") return "bg-blue-500/20 text-blue-400 border-blue-500/30";
  return "bg-gray-700/50 text-gray-400 border-gray-600/30";
}

function phaseColor(phase: string | undefined): string {
  if (phase === "EXHAUSTION") return "text-red-400";
  if (phase === "EXPANSION") return "text-amber-400";
  return "text-gray-400";
}

function phaseBg(phase: string | undefined): string {
  if (phase === "EXHAUSTION") return "bg-red-500/15 border-red-500/30";
  if (phase === "EXPANSION") return "bg-amber-500/15 border-amber-500/30";
  return "bg-gray-800/50";
}

function phaseLabel(phase: string | undefined, dir: string | null): string {
  if (!phase || !dir) return "Building";
  if (phase === "EXPANSION") return "Expanding";
  if (phase === "EXHAUSTION") return "Exhaustion";
  return "Building";
}

function readinessColor(pct: number): string {
  if (pct >= 80) return "text-green-400";
  if (pct >= 50) return "text-amber-400";
  return "text-gray-400";
}

function readinessBarColor(pct: number): string {
  if (pct >= 80) return "bg-green-500";
  if (pct >= 50) return "bg-amber-500";
  return "bg-gray-600";
}

function statusBadge(snap: MarketSnapshot): { label: string; className: string } {
  if (snap.activeTrade) {
    return { label: "ACTIVE", className: "bg-blue-500/20 text-blue-400 border-blue-500/30" };
  }
  if (snap.signal) {
    return snap.signal.scale === "ADD"
      ? { label: "SNIPER", className: "bg-red-500/20 text-red-400 border-red-500/30" }
      : { label: "BUILDING", className: "bg-amber-500/20 text-amber-400 border-amber-500/30" };
  }
  if ((snap.readiness || 0) >= 60) {
    return { label: "BUILDING", className: "bg-amber-500/20 text-amber-400 border-amber-500/30" };
  }
  return { label: "WATCH", className: "bg-gray-700/50 text-gray-400 border-gray-600/30" };
}

function MarketCard({ snap }: { snap: MarketSnapshot }) {
  const badge = statusBadge(snap);
  const regimeDir = snap.regime?.direction;
  const regimeStr = snap.regime?.strength || "NEUTRAL";

  return (
    <div className="p-5 bg-gray-900 rounded-xl border border-gray-800 hover:border-gray-600 transition shadow-lg">
      {/* Header */}
      <div className="flex items-center justify-between mb-4">
        <span className="font-mono font-bold text-xl tracking-tight">{snap.pair.replace("/USD", "")}</span>
        <span className={`text-xs font-bold px-3 py-1 rounded-lg border ${badge.className} uppercase tracking-wider`}>
          {badge.label}
        </span>
      </div>

      {/* Price */}
      <div className="mb-4">
        <div className="text-sm text-gray-500">Price: <span className="text-gray-200 font-mono">${snap.price?.toLocaleString(undefined, { minimumFractionDigits: 2, maximumFractionDigits: 2 })}</span></div>
      </div>

      {/* 4H Trend + 15M Structure */}
      <div className="grid grid-cols-2 gap-4 mb-4">
        <div>
          <div className="text-xs uppercase text-gray-500 font-semibold tracking-wider mb-1">4H Trend</div>
          <div className={`text-sm font-bold ${dirColor(snap.trend4h?.direction)}`}>
            {snap.trend4h?.direction === "LONG" ? "Bullish" : snap.trend4h?.direction === "SHORT" ? "Bearish" : "Neutral"}
          </div>
        </div>
        <div>
          <div className="text-xs uppercase text-gray-500 font-semibold tracking-wider mb-1">15M Structure</div>
          <div className="text-sm font-bold text-gray-200">{snap.structure15m || "Neutral"}</div>
        </div>
      </div>

      {/* Macro Bias */}
      <div className="mb-4">
        <div className="text-xs uppercase text-gray-500 font-semibold tracking-wider mb-1">Macro Bias</div>
        <div className={`text-sm font-bold ${dirColor(snap.trend1d?.direction)}`}>
          {snap.trend1d?.direction === "LONG" ? "Bullish" : snap.trend1d?.direction === "SHORT" ? "Bearish" : "Neutral"}
          {snap.trend1d?.strength ? ` (${snap.trend1d.strength.toLowerCase()})` : ""}
        </div>
      </div>

      {/* Phase Banner */}
      <div className={`mb-4 p-3 rounded-lg border ${phaseBg(snap.phase4h)}`}>
        <div className="flex items-center justify-between">
          <span className="text-xs uppercase text-gray-500 font-semibold tracking-wider">Phase</span>
          <span className={`text-sm font-bold ${phaseColor(snap.phase4h)}`}>
            {phaseLabel(snap.phase4h, regimeDir)}
          </span>
        </div>
        <div className="text-xs text-gray-500 mt-1">
          4H Stoch: {snap.stochK?.toFixed(1)} / {snap.stochD?.toFixed(1)}
          {snap.phase4h === "EXPANSION" ? " — momentum running, dont chase" : snap.phase4h === "EXHAUSTION" ? " — reversal zone, watch for entry" : " — waiting for setup"}
        </div>
      </div>

      {/* Readiness Bar */}
      <div className="mb-4">
        <div className="flex items-center justify-between mb-1">
          <span className="text-xs uppercase text-gray-500 font-semibold tracking-wider">Readiness</span>
          <span className={`text-sm font-bold ${readinessColor(snap.readiness || 0)}`}>{snap.readiness || 0}%</span>
        </div>
        <div className="w-full h-1.5 bg-gray-800 rounded-full overflow-hidden">
          <div
            className={`h-full rounded-full ${readinessBarColor(snap.readiness || 0)} transition-all duration-500`}
            style={{ width: `${Math.min(snap.readiness || 0, 100)}%` }}
          />
        </div>
      </div>

      {/* Trade Setup (when signal exists) */}
      {snap.signal && (
        <div className="mb-4 p-4 bg-gray-800/50 rounded-lg border border-gray-700/50">
          <div className="text-xs uppercase text-gray-500 font-semibold tracking-wider mb-3">Trade Setup</div>
          <div className="space-y-2">
            <div className="flex justify-between">
              <span className="text-sm text-gray-400">Direction:</span>
              <span className={`text-sm font-bold ${dirColor(snap.signal.direction)}`}>{snap.signal.direction}</span>
            </div>
            <div className="flex justify-between">
              <span className="text-sm text-gray-400">Entry:</span>
              <span className="text-sm font-mono font-bold text-gray-200">${snap.signal.entry.toFixed(2)}</span>
            </div>
            <div className="flex justify-between">
              <span className="text-sm text-gray-400">SL:</span>
              <span className="text-sm font-mono font-bold text-red-400">${snap.signal.stop.toFixed(2)}</span>
            </div>
            <div className="flex justify-between">
              <span className="text-sm text-gray-400">TP:</span>
              <span className="text-sm font-mono font-bold text-green-400">${snap.signal.target.toFixed(2)}</span>
            </div>
            <div className="flex justify-between">
              <span className="text-sm text-gray-400">RR:</span>
              <span className="text-sm font-mono font-bold text-gray-200">{snap.signal.rr.toFixed(2)}</span>
            </div>
            <div className="flex justify-between">
              <span className="text-sm text-gray-400">Confidence:</span>
              <span className={`text-sm font-bold ${snap.signal.confidence >= 70 ? "text-green-400" : "text-amber-400"}`}>{snap.signal.confidence}%</span>
            </div>
            {snap.signal.reason && (
              <div className="text-xs text-gray-500 mt-2 pt-2 border-t border-gray-700/50">
                Reason: {snap.signal.reason.split(" | ").slice(0, 3).join(" | ")}
              </div>
            )}
          </div>
        </div>
      )}

      {/* Active Trade */}
      {snap.activeTrade && (
        <div className="mb-4 p-4 bg-blue-500/10 border border-blue-500/30 rounded-lg">
          <div className="flex items-center justify-between mb-3">
            <span className="text-xs uppercase text-blue-400 font-bold tracking-wider">Active Trade</span>
            <span className={`text-lg font-mono font-bold ${snap.activeTrade.pnl.startsWith("-") ? "text-red-400" : "text-green-400"}`}>
              {snap.activeTrade.pnl}
            </span>
          </div>
          <div className="grid grid-cols-2 gap-2 text-sm">
            <div><span className="text-gray-500">Entry:</span> <span className="font-mono text-gray-200">${snap.activeTrade.entry.toFixed(2)}</span></div>
            <div><span className="text-gray-500">Stop:</span> <span className="font-mono text-red-400">${snap.activeTrade.stop.toFixed(2)}</span></div>
            <div><span className="text-gray-500">Target:</span> <span className="font-mono text-green-400">${snap.activeTrade.target.toFixed(2)}</span></div>
            <div><span className="text-gray-500">State:</span> <span className="font-bold text-blue-400">{snap.activeTrade.state}</span></div>
          </div>
          {snap.activeTrade.lockedStop !== undefined && snap.activeTrade.lockedStop !== null && (
            <div className="mt-2 p-2 bg-emerald-500/10 border border-emerald-500/20 rounded text-xs">
              <span className="text-emerald-400">Profit Lock:</span> <span className="font-mono text-emerald-300">${snap.activeTrade.lockedStop.toFixed(2)}</span>
            </div>
          )}
        </div>
      )}

      {/* Why No Trade */}
      {!snap.signal && !snap.activeTrade && snap.whyNoTrade && snap.whyNoTrade.length > 0 && (
        <div className="mb-4 p-3 bg-gray-800/30 rounded-lg">
          <div className="text-xs uppercase text-gray-500 font-semibold tracking-wider mb-1">Why No Trade?</div>
          <div className="text-xs text-gray-400">{snap.whyNoTrade[0]}</div>
        </div>
      )}

      {/* Footer */}
      <div className="text-xs text-gray-600 text-right">
        Updated: {new Date(snap.timestamp).toLocaleString()}
      </div>
    </div>
  );
}

export default function Dashboard() {
  const [snapshots, setSnapshots] = useState<Record<string, MarketSnapshot>>({});
  const [loading, setLoading] = useState(false);
  const [lastUpdate, setLastUpdate] = useState<string>("");
  const [error, setError] = useState<string>("");

  const fetchSnapshots = useCallback(async () => {
    try {
      const res = await fetch("/api/signals");
      if (!res.ok) {
        const err = await res.json().catch(() => ({}));
        setError(err.error || `HTTP ${res.status}`);
        return;
      }
      const data = await res.json();
      const marketMap: Record<string, MarketSnapshot> = {};
      const markets = data.markets || data.snapshot?.markets || [];
      for (const m of markets) {
        if (m.pair) marketMap[m.pair] = m;
      }
      setSnapshots(marketMap);
      setLastUpdate(new Date(data.lastCronRun || Date.now()).toLocaleString());
      setError("");
    } catch (e) {
      setError(String(e));
    }
  }, []);

  const refresh = useCallback(async () => {
    setLoading(true);
    try { await fetchSnapshots(); } catch (e) { setError(String(e)); }
    finally { setLoading(false); }
  }, [fetchSnapshots]);

  useEffect(() => {
    refresh();
    const interval = setInterval(refresh, 60000);
    return () => clearInterval(interval);
  }, [refresh]);

  const triggerCron = async () => {
    setLoading(true);
    try {
      const secret = process.env.NEXT_PUBLIC_CRON_SECRET || "";
      await fetch(`/api/cron?secret=${encodeURIComponent(secret)}`);
      await refresh();
    } catch (e) {
      setError(`Cron failed: ${e}`);
    } finally {
      setLoading(false);
    }
  };

  const activeTrades = Object.values(snapshots).filter(s => s.activeTrade).length;

  return (
    <main className="min-h-screen bg-black text-gray-100 p-4 md:p-6">
      <div className="max-w-6xl mx-auto">
        {/* Header */}
        <div className="flex items-center justify-between mb-8">
          <div>
            <h1 className="text-2xl md:text-3xl font-bold tracking-tight">CXSwitch v33</h1>
            <p className="text-gray-500 text-sm mt-1">
              Last updated: {lastUpdate || "—"}
            </p>
          </div>
          <div className="flex items-center gap-2">
            <button
              onClick={refresh}
              disabled={loading}
              className="px-4 py-2 bg-gray-800 hover:bg-gray-700 disabled:opacity-50 rounded-lg text-sm font-medium transition border border-gray-700"
            >
              {loading ? "..." : "Refresh"}
            </button>
            <button
              onClick={triggerCron}
              disabled={loading}
              className="px-4 py-2 bg-gray-800 hover:bg-gray-700 disabled:opacity-50 rounded-lg text-sm font-medium transition border border-gray-700"
            >
              {loading ? "Running..." : "Run Cron"}
            </button>
          </div>
        </div>

        {error && (
          <div className="mb-4 p-3 bg-red-900/30 border border-red-700 rounded-lg text-red-300 text-sm">
            {error}
          </div>
        )}

        {/* 2x2 Grid */}
        <section>
          <h2 className="text-lg font-semibold mb-4 text-gray-300">Market Overview</h2>
          <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
            {PAIRS.map(pair => {
              const snap = snapshots[pair];
              if (!snap) {
                return (
                  <div key={pair} className="p-5 bg-gray-900 rounded-xl border border-gray-800 animate-pulse">
                    <div className="h-6 bg-gray-800 rounded w-16 mb-4"></div>
                    <div className="h-4 bg-gray-800 rounded w-32 mb-4"></div>
                    <div className="h-20 bg-gray-800 rounded w-full mb-4"></div>
                    <div className="h-2 bg-gray-800 rounded w-full"></div>
                  </div>
                );
              }
              return <MarketCard key={pair} snap={snap} />;
            })}
          </div>
        </section>

        {/* Footer */}
        <div className="mt-8 pt-4 border-t border-gray-800 text-center">
          <p className="text-xs text-gray-600">
            CXSwitch v33 — Early Entry System | Five Exits: SL · TP · 4H Structure · EMA21 Breach · 1D Regime Flip
          </p>
        </div>
      </div>
    </main>
  );
}
