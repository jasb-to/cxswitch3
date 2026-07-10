"use client";

import { useState, useEffect, useCallback } from "react";
import { EntryTier } from "@/lib/strategy";

interface RegimeData {
  direction: string | null;
  strength: string;
  confidence: number;
  score: number;
  reason: string[];
}

interface TrendContext {
  direction: string;
  strength: string;
}

interface EntryCandidates {
  pullback: { eligible: boolean; confidence: number; rejectionReason: string | null };
  rejection: { eligible: boolean; confidence: number; rejectionReason: string | null };
  breakout: { eligible: boolean; confidence: number; rejectionReason: string | null };
}

// v31.2 — active trade info + phase detection
interface ActiveTradeInfo {
  signalId: string;
  direction: "LONG" | "SHORT";
  state: string;
  pnl: string;
  lockedStop?: number;
  entry: number;
  stop: number;
  target: number;
  entryTier?: EntryTier;
  positionSizePct?: number;
}

interface MarketSnapshot {
  pair: string;
  price: number;
  trend: string;
  regime: RegimeData;
  adx?: number;
  rsi?: number;
  stochK?: number;
  stochD?: number;
  stoch1hK?: number;
  stoch1hD?: number;
  trend1h?: TrendContext;
  trend4h?: TrendContext;
  trend1d?: TrendContext;
  entryCandidates?: EntryCandidates;
  rejectionStage?: string | null;
  recommendedAction?: string;
  positionSize?: string;
  whyNoTrade?: string[];
  entryTier?: EntryTier | null;
  trendConflict?: boolean;
  // v29.2
  activeTrade?: ActiveTradeInfo;
  // v31.2 — phase detection
  phase1h?: "EXPANSION" | "EXHAUSTION" | "NEUTRAL";
  phaseWarning1h?: string | null;
  phase4h?: "EXPANSION" | "EXHAUSTION" | "NEUTRAL";
  phaseWarning4h?: string | null;
}

const PAIRS = ["BTC/USD", "ETH/USD", "SOL/USD", "HYPE/USD"];

// ─── Helpers ───

function getDirectionColor(direction: string | null | undefined): string {
  if (!direction) return "text-gray-400";
  const d = String(direction).toUpperCase();
  if (d === "LONG" || d === "BULLISH") return "text-green-400";
  if (d === "SHORT" || d === "BEARISH") return "text-red-400";
  if (d === "TREND_CONFLICT") return "text-yellow-400";
  return "text-gray-400";
}

function getStrengthBadge(strength: string): string {
  const s = (strength || "").toUpperCase();
  if (s === "STRONG") return "bg-green-500/20 text-green-400 border-green-500/30";
  if (s === "MODERATE" || s === "MEDIUM") return "bg-yellow-500/20 text-yellow-400 border-yellow-500/30";
  if (s === "WEAK") return "bg-orange-500/20 text-orange-400 border-orange-500/30";
  if (s === "ACTIVE") return "bg-blue-500/20 text-blue-400 border-blue-500/30";
  return "bg-gray-700/50 text-gray-400 border-gray-600/30";
}

function getActionColor(action: string | undefined): string {
  if (!action) return "text-gray-400";
  if (action.includes("CONFIRMED")) return "text-green-400";
  if (action.includes("EARLY")) return "text-yellow-400";
  if (action.includes("WATCH")) return "text-blue-400";
  if (action.includes("HOLDING")) return "text-blue-400";
  return "text-gray-400";
}

function getActionBg(action: string | undefined): string {
  if (!action) return "bg-gray-800/50";
  if (action.includes("CONFIRMED")) return "bg-green-500/10 border-green-500/20";
  if (action.includes("EARLY")) return "bg-yellow-500/10 border-yellow-500/20";
  if (action.includes("WATCH")) return "bg-blue-500/10 border-blue-500/20";
  if (action.includes("HOLDING")) return "bg-blue-500/10 border-blue-500/20";
  return "bg-gray-800/50 border-gray-700/30";
}

function getTierEmoji(tier: EntryTier | null | undefined): string {
  if (tier === "CONFIRMED_ENTRY") return "🟢";
  if (tier === "EARLY_ENTRY") return "🟡";
  return "⚪";
}

function getPhaseColor(phase: string | undefined): string {
  if (phase === "EXHAUSTION") return "text-red-400";
  if (phase === "EXPANSION") return "text-yellow-400";
  return "text-gray-400";
}

function getPhaseBg(phase: string | undefined): string {
  if (phase === "EXHAUSTION") return "bg-red-500/10 border-red-500/20";
  if (phase === "EXPANSION") return "bg-yellow-500/10 border-yellow-500/20";
  return "bg-gray-800/50";
}

// ─── Card Component ───

function MarketCard({ snap }: { snap: MarketSnapshot }) {
  const regime = snap.regime;
  const dirColor = getDirectionColor(regime?.direction);
  const strengthClass = getStrengthBadge(regime?.strength || "NEUTRAL");
  const actionColor = getActionColor(snap.recommendedAction);
  const actionBg = getActionBg(snap.recommendedAction);
  const bestConf = Math.max(
    snap.entryCandidates?.pullback?.confidence || 0,
    snap.entryCandidates?.rejection?.confidence || 0,
    snap.entryCandidates?.breakout?.confidence || 0
  );

  // v31.2: Determine most urgent phase warning
  const hasExhaustion = snap.phase1h === "EXHAUSTION" || snap.phase4h === "EXHAUSTION";
  const hasExpansion = snap.phase1h === "EXPANSION" || snap.phase4h === "EXPANSION";
  const priorityWarning = snap.phaseWarning1h || snap.phaseWarning4h;

  return (
    <div className="p-4 bg-gray-900 rounded-xl border border-gray-800 hover:border-gray-700 transition">
      {/* Header */}
      <div className="flex items-center justify-between mb-3">
        <span className="font-mono font-bold text-sm">{snap.pair}</span>
        <span className={`text-[10px] font-bold px-2 py-0.5 rounded border ${strengthClass}`}>
          {regime?.strength || "NEUTRAL"}
        </span>
      </div>

      {/* v31.2 — Phase Warning Banner (always shown if active) */}
      {priorityWarning && (
        <div className={`mb-3 p-2.5 rounded-lg border ${getPhaseBg(hasExhaustion ? "EXHAUSTION" : hasExpansion ? "EXPANSION" : "NEUTRAL")}`}>
          <div className={`text-xs font-bold ${getPhaseColor(hasExhaustion ? "EXHAUSTION" : hasExpansion ? "EXPANSION" : "NEUTRAL")}`}>
            {priorityWarning}
          </div>
          <div className="text-[10px] text-gray-500 mt-0.5">
            1H: {snap.phase1h || "NEUTRAL"} | 4H: {snap.phase4h || "NEUTRAL"}
            {snap.stoch1hK !== undefined && (
              <span> | Stoch 1H: {snap.stoch1hK.toFixed(1)} / {snap.stoch1hD?.toFixed(1)}</span>
            )}
          </div>
        </div>
      )}

      {/* v29.2 — Active Trade Banner */}
      {snap.activeTrade && (
        <div className="mb-3 p-3 bg-blue-500/10 border border-blue-500/20 rounded-lg">
          <div className="flex items-center justify-between">
            <span className="text-xs font-bold text-blue-400 uppercase tracking-wider">
              🔄 ACTIVE TRADE
            </span>
            <span className={`text-xs font-mono font-bold ${
              snap.activeTrade.pnl.startsWith("-") ? "text-red-400" : "text-green-400"
            }`}>
              {snap.activeTrade.pnl}
            </span>
          </div>
          <div className="text-xs text-gray-400 mt-1">
            {snap.activeTrade.direction} | State: {snap.activeTrade.state}
            {snap.activeTrade.lockedStop !== undefined && (
              <span> | Locked Stop: ${snap.activeTrade.lockedStop.toFixed(2)}</span>
            )}
          </div>
          <div className="text-xs text-gray-500 mt-0.5">
            Entry: ${snap.activeTrade.entry.toFixed(2)} | Stop: ${snap.activeTrade.stop.toFixed(2)} | Target: ${snap.activeTrade.target.toFixed(2)}
          </div>
        </div>
      )}

      {/* Price & Regime Direction */}
      <div className="mb-3">
        <div className="text-2xl font-mono font-bold">${snap.price?.toFixed(2) || "—"}</div>
        <div className={`text-xs font-bold ${dirColor} mt-0.5`}>
          {snap.activeTrade
            ? `${snap.regime?.direction} — TRADE ACTIVE`
            : (snap.regime?.direction === "TREND_CONFLICT" ? "⚠ TREND CONFLICT" : (snap.regime?.direction || "NEUTRAL"))
          }
        </div>
      </div>

      {/* Regime Score */}
      <div className="mb-3 p-2 bg-gray-800/40 rounded-lg">
        <div className="text-[10px] text-gray-500 mb-1 uppercase tracking-wider font-semibold">Regime Score</div>
        <div className="text-lg font-mono font-bold text-gray-200">{regime?.confidence || 0}</div>
      </div>

      {/* Entry Score — hide when active trade is running */}
      {!snap.activeTrade && (
        <div className="mb-3 p-2 bg-gray-800/40 rounded-lg">
          <div className="text-[10px] text-gray-500 mb-1.5 uppercase tracking-wider font-semibold">Entry Score</div>
          <div className="grid grid-cols-3 gap-2 text-center mb-2">
            <div>
              <div className="text-[10px] text-gray-600">Pullback</div>
              <div className="text-xs font-mono font-semibold">{snap.entryCandidates?.pullback?.confidence?.toFixed(0) || "0"}</div>
            </div>
            <div>
              <div className="text-[10px] text-gray-600">Rejection</div>
              <div className="text-xs font-mono font-semibold">{snap.entryCandidates?.rejection?.confidence?.toFixed(0) || "0"}</div>
            </div>
            <div>
              <div className="text-[10px] text-gray-600">Breakout</div>
              <div className="text-xs font-mono font-semibold">{snap.entryCandidates?.breakout?.confidence?.toFixed(0) || "0"}</div>
            </div>
          </div>
          <div className="flex items-center justify-between pt-1.5 border-t border-gray-700/50">
            <span className="text-[10px] text-gray-500">Best Candidate</span>
            <span className="text-xs font-mono font-bold text-gray-300">{bestConf.toFixed(0)} / 100</span>
          </div>
        </div>
      )}

      {/* Recommended Action Tier */}
      {snap.recommendedAction && (
        <div className={`mb-3 p-3 rounded-lg border ${actionBg}`}>
          <div className={`text-sm font-bold ${actionColor}`}>
            {getTierEmoji(snap.entryTier)} {snap.recommendedAction}
          </div>
          {snap.positionSize && (
            <div className="text-xs text-gray-400 mt-0.5">{snap.positionSize}</div>
          )}
        </div>
      )}

      {/* Why No Trade — HIDE when active trade exists */}
      {snap.whyNoTrade && snap.whyNoTrade.length > 0 && !snap.activeTrade && (
        <div className="mb-3 p-2.5 bg-gray-800/40 rounded-lg">
          <div className="text-[10px] text-gray-500 mb-1.5 uppercase tracking-wider font-semibold">Why No Trade?</div>
          <div className="space-y-1">
            {snap.whyNoTrade.map((item, i) => (
              <div key={i} className="text-xs text-gray-400">{item}</div>
            ))}
          </div>
        </div>
      )}

      {/* Trend Context */}
      <div className="mb-3 p-2 bg-gray-800/30 rounded-lg">
        <div className="text-[10px] text-gray-500 mb-1 uppercase tracking-wider">Trend Context</div>
        <div className="grid grid-cols-3 gap-1 text-center">
          {[
            { label: "1H", trend: snap.trend1h },
            { label: "4H", trend: snap.trend4h },
            { label: "1D", trend: snap.trend1d },
          ].map(({ label, trend }) => (
            <div key={label}>
              <div className="text-[10px] text-gray-600">{label}</div>
              <div className={`text-xs font-bold ${getDirectionColor(trend?.direction)}`}>
                {trend?.direction || "—"}
              </div>
              <div className="text-[10px] text-gray-600">{trend?.strength || ""}</div>
            </div>
          ))}
        </div>
      </div>

      {/* Metrics */}
      <div className="grid grid-cols-2 gap-2 text-xs">
        <div className="p-2 bg-gray-800/30 rounded-lg">
          <div className="text-gray-600">ADX</div>
          <div className="font-mono font-semibold">{snap.adx?.toFixed(1) || "—"}</div>
        </div>
        <div className="p-2 bg-gray-800/30 rounded-lg">
          <div className="text-gray-600">RSI</div>
          <div className="font-mono font-semibold">{snap.rsi?.toFixed(1) || "—"}</div>
        </div>
        <div className="p-2 bg-gray-800/30 rounded-lg">
          <div className="text-gray-600">Stoch 4H</div>
          <div className="font-mono font-semibold">{snap.stochK?.toFixed(1) || "—"} / {snap.stochD?.toFixed(1) || "—"}</div>
        </div>
        <div className="p-2 bg-gray-800/30 rounded-lg">
          <div className="text-gray-600">Stoch 1H</div>
          <div className="font-mono font-semibold">{snap.stoch1hK?.toFixed(1) || "—"} / {snap.stoch1hD?.toFixed(1) || "—"}</div>
        </div>
      </div>
    </div>
  );
}

// ─── Main Dashboard ───

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
      setLastUpdate(new Date(data.lastCronRun || Date.now()).toLocaleTimeString());
      setError("");
    } catch (e) {
      setError(String(e));
    }
  }, []);

  const refresh = useCallback(async () => {
    setLoading(true);
    try {
      await fetchSnapshots();
    } catch (e) {
      setError(String(e));
    } finally {
      setLoading(false);
    }
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
      const res = await fetch(`/api/cron?secret=${encodeURIComponent(secret)}`);
      const data = await res.json();
      console.log("Cron result:", data);
      await refresh();
    } catch (e) {
      setError(`Cron trigger failed: ${e}`);
    } finally {
      setLoading(false);
    }
  };

  return (
    <main className="min-h-screen bg-gray-950 text-gray-100 p-4 md:p-6">
      <div className="max-w-5xl mx-auto">
        {/* Header */}
        <div className="flex items-center justify-between mb-6">
          <div>
            <h1 className="text-2xl md:text-3xl font-bold tracking-tight">
              CXSwitch <span className="text-blue-400">v31.2</span>
            </h1>
            <p className="text-gray-500 text-sm mt-1">Trading Dashboard</p>
          </div>
          <div className="flex items-center gap-2 md:gap-3">
            <span className="text-xs text-gray-500 hidden sm:inline">{lastUpdate || "—"}</span>
            <button
              onClick={refresh}
              disabled={loading}
              className="px-3 py-2 bg-blue-600 hover:bg-blue-500 disabled:opacity-50 rounded-lg text-sm font-medium transition"
            >
              {loading ? "..." : "Refresh"}
            </button>
            <button
              onClick={triggerCron}
              disabled={loading}
              className="px-3 py-2 bg-emerald-600 hover:bg-emerald-500 disabled:opacity-50 rounded-lg text-sm font-medium transition"
            >
              Run Cron
            </button>
          </div>
        </div>

        {error && (
          <div className="mb-4 p-3 bg-red-900/30 border border-red-700 rounded-lg text-red-300 text-sm">
            {error}
          </div>
        )}

        {/* Market Cards */}
        <section>
          <h2 className="text-lg font-semibold mb-4 text-gray-300">Markets</h2>
          <div className="grid grid-cols-1 md:grid-cols-2 gap-3 md:gap-4">
            {PAIRS.map(pair => {
              const snap = snapshots[pair];
              if (!snap) {
                return (
                  <div key={pair} className="p-4 bg-gray-900 rounded-xl border border-gray-800 animate-pulse">
                    <div className="h-5 bg-gray-800 rounded w-16 mb-3"></div>
                    <div className="h-8 bg-gray-800 rounded w-24 mb-3"></div>
                    <div className="h-4 bg-gray-800 rounded w-full"></div>
                  </div>
                );
              }
              return <MarketCard key={pair} snap={snap} />;
            })}
          </div>
        </section>
      </div>
    </main>
  );
}
