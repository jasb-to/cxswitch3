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
  activeTrade?: ActiveTradeInfo;
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

function getPhaseColor(phase: string | undefined): string {
  if (phase === "EXHAUSTION") return "text-red-400";
  if (phase === "EXPANSION") return "text-amber-400";
  return "text-gray-400";
}

function getPhaseBg(phase: string | undefined): string {
  if (phase === "EXHAUSTION") return "bg-red-500/15 border-red-500/30";
  if (phase === "EXPANSION") return "bg-amber-500/15 border-amber-500/30";
  return "bg-gray-800/50";
}

function getPhaseIcon(phase: string | undefined): string {
  if (phase === "EXHAUSTION") return "🔴";
  if (phase === "EXPANSION") return "🟡";
  return "⚪";
}

// ─── Card Component ───

function MarketCard({ snap }: { snap: MarketSnapshot }) {
  const regime = snap.regime;
  const dirColor = getDirectionColor(regime?.direction);
  const strengthClass = getStrengthBadge(regime?.strength || "NEUTRAL");

  const hasExhaustion = snap.phase1h === "EXHAUSTION" || snap.phase4h === "EXHAUSTION";
  const hasExpansion = snap.phase1h === "EXPANSION" || snap.phase4h === "EXPANSION";
  const priorityPhase = hasExhaustion ? "EXHAUSTION" : hasExpansion ? "EXPANSION" : "NEUTRAL";
  const priorityWarning = snap.phaseWarning1h || snap.phaseWarning4h;

  // Check for trend conflict (trade direction vs 1D trend)
  const tradeDir = snap.activeTrade?.direction;
  const trend1dDir = snap.trend1d?.direction;
  const trendConflict = tradeDir && trend1dDir && tradeDir !== trend1dDir;

  return (
    <div className="p-5 bg-gray-900 rounded-xl border border-gray-800 hover:border-gray-600 transition shadow-lg">
      {/* ─── HEADER ─── */}
      <div className="flex items-center justify-between mb-4">
        <span className="font-mono font-bold text-lg">{snap.pair}</span>
        <span className={`text-sm font-bold px-3 py-1 rounded-lg border ${strengthClass}`}>
          {regime?.strength || "NEUTRAL"}
        </span>
      </div>

      {/* ─── PHASE WARNING ─── */}
      {priorityWarning && (
        <div className={`mb-4 p-3 rounded-lg border ${getPhaseBg(priorityPhase)}`}>
          <div className="flex items-center gap-2">
            <span className="text-lg">{getPhaseIcon(priorityPhase)}</span>
            <span className={`text-sm font-bold ${getPhaseColor(priorityPhase)}`}>
              {priorityPhase}
            </span>
          </div>
          <div className="text-sm text-gray-300 mt-1 pl-7">
            {priorityWarning}
          </div>
          <div className="text-xs text-gray-500 mt-1 pl-7">
            1H: {snap.phase1h} | 4H: {snap.phase4h}
            {snap.stoch1hK !== undefined && (
              <span> | Stoch 1H: {snap.stoch1hK.toFixed(1)} / {snap.stoch1hD?.toFixed(1)}</span>
            )}
          </div>
        </div>
      )}

      {/* ─── ACTIVE TRADE ─── */}
      {snap.activeTrade && (
        <div className="mb-4 p-4 bg-blue-500/10 border border-blue-500/30 rounded-lg">
          {/* Trade header */}
          <div className="flex items-center justify-between mb-3">
            <div className="flex items-center gap-2">
              <span className="text-xl">🔄</span>
              <span className="text-sm font-bold text-blue-400 uppercase tracking-wider">
                ACTIVE TRADE
              </span>
            </div>
            <span className={`text-lg font-mono font-bold ${
              snap.activeTrade.pnl.startsWith("-") ? "text-red-400" : "text-green-400"
            }`}>
              {snap.activeTrade.pnl}
            </span>
          </div>

          {/* Trade details grid */}
          <div className="grid grid-cols-2 gap-3 mb-3">
            <div className="p-2 bg-gray-800/50 rounded">
              <div className="text-xs text-gray-500 uppercase">Direction</div>
              <div className={`text-sm font-bold ${getDirectionColor(snap.activeTrade.direction)}`}>
                {snap.activeTrade.direction}
              </div>
            </div>
            <div className="p-2 bg-gray-800/50 rounded">
              <div className="text-xs text-gray-500 uppercase">State</div>
              <div className="text-sm font-bold text-gray-200">{snap.activeTrade.state}</div>
            </div>
            <div className="p-2 bg-gray-800/50 rounded">
              <div className="text-xs text-gray-500 uppercase">Entry</div>
              <div className="text-sm font-mono font-bold text-gray-200">${snap.activeTrade.entry.toFixed(2)}</div>
            </div>
            <div className="p-2 bg-gray-800/50 rounded">
              <div className="text-xs text-gray-500 uppercase">Current</div>
              <div className="text-sm font-mono font-bold text-gray-200">${snap.price.toFixed(2)}</div>
            </div>
            <div className="p-2 bg-gray-800/50 rounded">
              <div className="text-xs text-gray-500 uppercase">Stop</div>
              <div className="text-sm font-mono font-bold text-red-400">${snap.activeTrade.stop.toFixed(2)}</div>
            </div>
            <div className="p-2 bg-gray-800/50 rounded">
              <div className="text-xs text-gray-500 uppercase">Target</div>
              <div className="text-sm font-mono font-bold text-green-400">${snap.activeTrade.target.toFixed(2)}</div>
            </div>
          </div>

          {/* Locked stop */}
          {snap.activeTrade.lockedStop !== undefined && snap.activeTrade.lockedStop !== null && (
            <div className="p-2 bg-emerald-500/10 border border-emerald-500/20 rounded">
              <div className="text-xs text-emerald-400 uppercase">🔒 Profit Lock Active</div>
              <div className="text-sm font-mono font-bold text-emerald-300">
                Locked Stop: ${snap.activeTrade.lockedStop.toFixed(2)}
              </div>
            </div>
          )}

          {/* Trend conflict warning */}
          {trendConflict && (
            <div className="mt-3 p-2 bg-red-500/15 border border-red-500/30 rounded">
              <div className="text-sm font-bold text-red-400">
                ⚠️ TREND CONFLICT
              </div>
              <div className="text-xs text-gray-400">
                Trade is {snap.activeTrade.direction} but 1D trend is {trend1dDir}. 
                Consider exiting — regime has flipped against position.
              </div>
            </div>
          )}
        </div>
      )}

      {/* ─── PRICE & REGIME ─── */}
      <div className="mb-4">
        <div className="text-3xl font-mono font-bold">${snap.price?.toFixed(2) || "—"}</div>
        <div className={`text-sm font-bold ${dirColor} mt-1`}>
          {snap.activeTrade
            ? `${snap.regime?.direction} — TRADE ACTIVE`
            : (snap.regime?.direction === "TREND_CONFLICT" ? "⚠ TREND CONFLICT" : (snap.regime?.direction || "NEUTRAL"))
          }
        </div>
      </div>

      {/* ─── REGIME SCORE ─── */}
      <div className="mb-4 p-3 bg-gray-800/50 rounded-lg">
        <div className="text-xs text-gray-500 mb-1 uppercase tracking-wider font-semibold">Regime Score</div>
        <div className="text-xl font-mono font-bold text-gray-200">{regime?.confidence || 0}</div>
      </div>

      {/* ─── ENTRY SCORE (no active trade only) ─── */}
      {!snap.activeTrade && snap.entryCandidates && (
        <div className="mb-4 p-3 bg-gray-800/50 rounded-lg">
          <div className="text-xs text-gray-500 mb-2 uppercase tracking-wider font-semibold">Entry Score</div>
          <div className="grid grid-cols-3 gap-3 text-center">
            <div>
              <div className="text-xs text-gray-500">Pullback</div>
              <div className="text-sm font-mono font-bold">{snap.entryCandidates?.pullback?.confidence?.toFixed(0) || "0"}</div>
            </div>
            <div>
              <div className="text-xs text-gray-500">Rejection</div>
              <div className="text-sm font-mono font-bold">{snap.entryCandidates?.rejection?.confidence?.toFixed(0) || "0"}</div>
            </div>
            <div>
              <div className="text-xs text-gray-500">Breakout</div>
              <div className="text-sm font-mono font-bold">{snap.entryCandidates?.breakout?.confidence?.toFixed(0) || "0"}</div>
            </div>
          </div>
        </div>
      )}

      {/* ─── WHY NO TRADE (no active trade only) ─── */}
      {snap.whyNoTrade && snap.whyNoTrade.length > 0 && !snap.activeTrade && (
        <div className="mb-4 p-3 bg-gray-800/50 rounded-lg">
          <div className="text-xs text-gray-500 mb-1 uppercase tracking-wider font-semibold">Why No Trade?</div>
          {snap.whyNoTrade.map((item, i) => (
            <div key={i} className="text-sm text-gray-400">{item}</div>
          ))}
        </div>
      )}

      {/* ─── TREND CONTEXT ─── */}
      <div className="mb-4 p-3 bg-gray-800/40 rounded-lg">
        <div className="text-xs text-gray-500 mb-2 uppercase tracking-wider font-semibold">Trend Context</div>
        <div className="grid grid-cols-3 gap-2 text-center">
          {[
            { label: "1H", trend: snap.trend1h },
            { label: "4H", trend: snap.trend4h },
            { label: "1D", trend: snap.trend1d },
          ].map(({ label, trend }) => (
            <div key={label} className="p-2 bg-gray-800/50 rounded">
              <div className="text-xs text-gray-500">{label}</div>
              <div className={`text-sm font-bold ${getDirectionColor(trend?.direction)}`}>
                {trend?.direction || "—"}
              </div>
              <div className="text-xs text-gray-500">{trend?.strength || ""}</div>
            </div>
          ))}
        </div>
      </div>

      {/* ─── METRICS ─── */}
      <div className="grid grid-cols-2 gap-3">
        <div className="p-3 bg-gray-800/40 rounded-lg">
          <div className="text-xs text-gray-500 uppercase">ADX</div>
          <div className="text-lg font-mono font-semibold">{snap.adx?.toFixed(1) || "—"}</div>
        </div>
        <div className="p-3 bg-gray-800/40 rounded-lg">
          <div className="text-xs text-gray-500 uppercase">RSI</div>
          <div className="text-lg font-mono font-semibold">{snap.rsi?.toFixed(1) || "—"}</div>
        </div>
        <div className="p-3 bg-gray-800/40 rounded-lg">
          <div className="text-xs text-gray-500 uppercase">Stoch 4H</div>
          <div className="text-lg font-mono font-semibold">{snap.stochK?.toFixed(1) || "—"} <span className="text-gray-600">/</span> {snap.stochD?.toFixed(1) || "—"}</div>
        </div>
        <div className="p-3 bg-gray-800/40 rounded-lg">
          <div className="text-xs text-gray-500 uppercase">Stoch 1H</div>
          <div className="text-lg font-mono font-semibold">{snap.stoch1hK?.toFixed(1) || "—"} <span className="text-gray-600">/</span> {snap.stoch1hD?.toFixed(1) || "—"}</div>
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
      <div className="max-w-6xl mx-auto">
        {/* Header */}
        <div className="flex items-center justify-between mb-6">
          <div>
            <h1 className="text-2xl md:text-3xl font-bold tracking-tight">
              CXSwitch <span className="text-blue-400">v32</span>
            </h1>
            <p className="text-gray-500 text-sm mt-1">Trading Dashboard</p>
          </div>
          <div className="flex items-center gap-2 md:gap-3">
            <span className="text-xs text-gray-500 hidden sm:inline">{lastUpdate || "—"}</span>
            <button
              onClick={refresh}
              disabled={loading}
              className="px-4 py-2 bg-blue-600 hover:bg-blue-500 disabled:opacity-50 rounded-lg text-sm font-medium transition"
            >
              {loading ? "..." : "Refresh"}
            </button>
            <button
              onClick={triggerCron}
              disabled={loading}
              className="px-4 py-2 bg-emerald-600 hover:bg-emerald-500 disabled:opacity-50 rounded-lg text-sm font-medium transition"
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
          <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
            {PAIRS.map(pair => {
              const snap = snapshots[pair];
              if (!snap) {
                return (
                  <div key={pair} className="p-5 bg-gray-900 rounded-xl border border-gray-800 animate-pulse">
                    <div className="h-6 bg-gray-800 rounded w-20 mb-4"></div>
                    <div className="h-10 bg-gray-800 rounded w-32 mb-4"></div>
                    <div className="h-5 bg-gray-800 rounded w-full"></div>
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
