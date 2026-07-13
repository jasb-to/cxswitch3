"use client";

import React, { useState, useEffect, useCallback } from "react";

interface TrendlineInfo {
  type: "SUPPORT" | "RESISTANCE";
  startPrice: number;
  endPrice: number;
  touches: number;
  currentPrice: number;
}

interface ActiveTradeInfo {
  signalId: string;
  direction: "LONG" | "SHORT";
  pnl: string;
  entry: number;
  stop: number;
  target: number;
  entryType?: string;
  trendlinePrice?: number;
}

interface MarketSnapshot {
  pair: string;
  price: number;
  timestamp: number;
  bias: {
    direction: string;
    strength: number;
  } | null;
  stoch4h: { k: number; d: number };
  stoch1h: { k: number; d: number };
  stoch15m: { k: number; d: number };
  trendlines: TrendlineInfo[];
  signal?: {
    direction: string;
    entryType: string;
    entry: number;
    stop: number;
    target: number;
    confidence: number;
    rr: number;
  } | null;
  activeTrade?: ActiveTradeInfo;
  debug: string[];
  summary?: {
    debug: string[];
  };
}

const PAIRS = ["BTC/USD", "ETH/USD", "SOL/USD", "HYPE/USD"];

function dirColor(dir: string | null | undefined): string {
  if (!dir) return "text-gray-400";
  const d = String(dir).toUpperCase();
  if (d === "LONG" || d === "BULLISH") return "text-green-400";
  if (d === "SHORT" || d === "BEARISH") return "text-red-400";
  return "text-gray-400";
}

function stochColor(k: number, d: number, direction?: string): string {
  if (k > 80 && d > 70) return "text-red-400";  // Overbought
  if (k < 20 && d < 30) return "text-green-400"; // Oversold
  if (k > d) return "text-green-400";            // Bullish momentum
  return "text-red-400";                          // Bearish momentum
}

function entryTypeBadge(type: string): { label: string; className: string } {
  if (type === "EARLY") return { label: "EARLY", className: "bg-amber-500/20 text-amber-400 border-amber-500/30" };
  if (type === "BREAKOUT") return { label: "BREAKOUT", className: "bg-green-500/20 text-green-400 border-green-500/30" };
  if (type === "RETEST") return { label: "RETEST", className: "bg-blue-500/20 text-blue-400 border-blue-500/30" };
  return { label: "ENTRY", className: "bg-gray-700/50 text-gray-400 border-gray-600/30" };
}

function MarketCard({ snap }: { snap: MarketSnapshot }) {
  const bias = snap.bias;
  const hasSignal = !!snap.signal;
  const hasTrade = !!snap.activeTrade;

  // FIX: Get debug from top-level or nested summary.debug
  const debugLines: string[] = snap.debug || snap.summary?.debug || [];

  // FIX: Ensure trendlines is always an array
  const trendlines: TrendlineInfo[] = snap.trendlines || [];

  const statusBadge = hasTrade
    ? { label: "ACTIVE", className: "bg-blue-500/20 text-blue-400 border-blue-500/30" }
    : hasSignal
    ? entryTypeBadge(snap.signal!.entryType)
    : { label: "WATCH", className: "bg-gray-700/50 text-gray-400 border-gray-600/30" };

  return (
    <div className="p-5 bg-gray-900 rounded-xl border border-gray-800 hover:border-gray-600 transition shadow-lg">
      <div className="flex items-center justify-between mb-4">
        <span className="font-mono font-bold text-xl tracking-tight">{snap.pair.replace("/USD", "")}</span>
        <span className={`text-xs font-bold px-3 py-1 rounded-lg border ${statusBadge.className} uppercase tracking-wider`}>
          {statusBadge.label}
        </span>
      </div>

      <div className="mb-4">
        <div className="text-sm text-gray-500">
          Price: <span className="text-gray-200 font-mono">${snap.price?.toLocaleString(undefined, { minimumFractionDigits: 2, maximumFractionDigits: 2 })}</span>
        </div>
      </div>

      {/* BIAS */}
      <div className="mb-4 p-3 bg-gray-800/50 rounded-lg border border-gray-700/30">
        <div className="flex items-center justify-between">
          <span className="text-xs uppercase text-gray-500 font-semibold tracking-wider">Bias (1D + 4H)</span>
          <span className={`text-sm font-bold ${dirColor(bias?.direction)}`}>
            {bias ? `${bias.direction} (${bias.strength}%)` : "UNCLEAR"}
          </span>
        </div>
      </div>

      {/* STOCH GRID */}
      <div className="grid grid-cols-3 gap-2 mb-4">
        <div className="p-2 bg-gray-800/30 rounded-lg text-center">
          <div className="text-xs text-gray-500 mb-1">4H Stoch</div>
          <div className={`text-sm font-mono font-bold ${stochColor(snap.stoch4h?.k ?? 50, snap.stoch4h?.d ?? 50)}`}>
            {(snap.stoch4h?.k ?? 0).toFixed(1)} / {(snap.stoch4h?.d ?? 0).toFixed(1)}
          </div>
        </div>
        <div className="p-2 bg-gray-800/30 rounded-lg text-center">
          <div className="text-xs text-gray-500 mb-1">1H Stoch</div>
          <div className={`text-sm font-mono font-bold ${stochColor(snap.stoch1h?.k ?? 50, snap.stoch1h?.d ?? 50)}`}>
            {(snap.stoch1h?.k ?? 0).toFixed(1)} / {(snap.stoch1h?.d ?? 0).toFixed(1)}
          </div>
        </div>
        <div className="p-2 bg-gray-800/30 rounded-lg text-center">
          <div className="text-xs text-gray-500 mb-1">15M Stoch</div>
          <div className={`text-sm font-mono font-bold ${stochColor(snap.stoch15m?.k ?? 50, snap.stoch15m?.d ?? 50)}`}>
            {(snap.stoch15m?.k ?? 0).toFixed(1)} / {(snap.stoch15m?.d ?? 0).toFixed(1)}
          </div>
        </div>
      </div>

      {/* TRENDLINES */}
      {trendlines.length > 0 && (
        <div className="mb-4">
          <div className="text-xs uppercase text-gray-500 font-semibold tracking-wider mb-2">Active Trendlines</div>
          <div className="space-y-1">
            {trendlines.map((tl, i) => (
              <div key={i} className="flex justify-between text-xs">
                <span className={tl.type === "RESISTANCE" ? "text-red-400" : "text-green-400"}>
                  {tl.type} ({tl.touches} touches)
                </span>
                <span className="font-mono text-gray-400">
                  ${tl.currentPrice.toFixed(2)}
                </span>
              </div>
            ))}
          </div>
        </div>
      )}

      {/* SIGNAL SETUP */}
      {snap.signal && (
        <div className="mb-4 p-4 bg-gray-800/50 rounded-lg border border-gray-700/50">
          <div className="text-xs uppercase text-gray-500 font-semibold tracking-wider mb-3">Trade Setup</div>
          <div className="space-y-2">
            <div className="flex justify-between">
              <span className="text-sm text-gray-400">Direction:</span>
              <span className={`text-sm font-bold ${dirColor(snap.signal.direction)}`}>{snap.signal.direction}</span>
            </div>
            <div className="flex justify-between">
              <span className="text-sm text-gray-400">Type:</span>
              <span className="text-sm font-bold text-amber-400">{snap.signal.entryType}</span>
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
          </div>
        </div>
      )}

      {/* ACTIVE TRADE */}
      {snap.activeTrade && (
        <div className="mb-4 p-4 bg-blue-500/10 border border-blue-500/30 rounded-lg">
          <div className="flex items-center justify-between mb-3">
            <span className="text-xs uppercase text-blue-400 font-bold tracking-wider">
              Active Trade — {snap.activeTrade.entryType}
            </span>
            <span className={`text-lg font-mono font-bold ${snap.activeTrade.pnl.startsWith("-") ? "text-red-400" : "text-green-400"}`}>
              {snap.activeTrade.pnl}
            </span>
          </div>

          <div className="grid grid-cols-2 gap-2 text-sm">
            <div><span className="text-gray-500">Entry:</span> <span className="font-mono text-gray-200">${snap.activeTrade.entry.toFixed(2)}</span></div>
            <div><span className="text-gray-500">Stop:</span> <span className="font-mono text-red-400">${snap.activeTrade.stop.toFixed(2)}</span></div>
            <div><span className="text-gray-500">Target:</span> <span className="font-mono text-green-400">${snap.activeTrade.target.toFixed(2)}</span></div>
            <div><span className="text-gray-500">Trendline:</span> <span className="font-mono text-amber-400">${snap.activeTrade.trendlinePrice?.toFixed(2) || "—"}</span></div>
          </div>
        </div>
      )}

      {/* DEBUG */}
      {debugLines.length > 0 && (
        <details className="mt-2">
          <summary className="text-xs text-gray-500 cursor-pointer hover:text-gray-400">Show debug</summary>
          <div className="mt-2 p-2 bg-gray-800/30 rounded text-xs text-gray-500 space-y-1">
            {debugLines.map((d, i) => (
              <div key={i}>{d}</div>
            ))}
          </div>
        </details>
      )}

      <div className="text-xs text-gray-600 text-right mt-2">
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
        <div className="flex items-center justify-between mb-8">
          <div>
            <h1 className="text-2xl md:text-3xl font-bold tracking-tight">CXSwitch v36.1</h1>
            <p className="text-gray-500 text-sm mt-1">
              Trendline Break + Stoch Momentum | Active: {activeTrades}
            </p>
            <p className="text-gray-600 text-xs">
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

        <div className="mt-8 pt-4 border-t border-gray-800 text-center">
          <p className="text-xs text-gray-600">
            CXSwitch v36.1 — 1D/4H Bias → Trendline Break → 15M Entry → 1H Stoch Exit
          </p>
        </div>
      </div>
    </main>
  );
}
