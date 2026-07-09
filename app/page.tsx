"use client";

// app/page.tsx — v29.1 CXSwitch Dashboard
// ============================================================

import { useState, useEffect, useCallback } from "react";

interface Signal {
  id: string;
  pair: string;
  direction: "LONG" | "SHORT";
  entry: number;
  stop: number;
  target: number;
  confidence: number;
  rr: number;
  tradeState?: string;
  lockedStop?: number | null;
  profitLockActive?: boolean;
  entryMode?: string;
  exhaustionWarning?: string;
  timestamp: number;
}

interface MarketSnapshot {
  pair: string;
  price: number;
  trend: string;
  adx?: number;
  rsi?: number;
  stochK?: number;
  stochD?: number;
  regime?: {
    direction: string | null;
    strength: string;
    confidence: number;
  };
}

const PAIRS = ["BTC/USD", "ETH/USD", "SOL/USD", "HYPE/USD"];

export default function Dashboard() {
  const [signals, setSignals] = useState<Signal[]>([]);
  const [snapshots, setSnapshots] = useState<Record<string, MarketSnapshot>>({});
  const [loading, setLoading] = useState(false);
  const [lastUpdate, setLastUpdate] = useState<string>("");
  const [error, setError] = useState<string>("");

  const fetchSignals = useCallback(async () => {
    try {
      const res = await fetch("/api/signal", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ action: "active-signals" }),
      });
      const data = await res.json();
      if (data.signals) setSignals(data.signals);
    } catch (e) {
      console.error("Failed to load signals:", e);
    }
  }, []);

  const fetchSnapshots = useCallback(async () => {
    const snaps: Record<string, MarketSnapshot> = {};
    for (const pair of PAIRS) {
      try {
        const res = await fetch(`/api/signal?pair=${encodeURIComponent(pair)}&action=snapshot`);
        const data = await res.json();
        if (data.snapshot) snaps[pair] = data.snapshot;
      } catch (e) {
        console.error(`Snapshot failed for ${pair}:`, e);
      }
    }
    setSnapshots(snaps);
    setLastUpdate(new Date().toLocaleTimeString());
  }, []);

  const refresh = useCallback(async () => {
    setLoading(true);
    setError("");
    try {
      await Promise.all([fetchSignals(), fetchSnapshots()]);
    } catch (e) {
      setError(String(e));
    } finally {
      setLoading(false);
    }
  }, [fetchSignals, fetchSnapshots]);

  useEffect(() => {
    refresh();
    const interval = setInterval(refresh, 60000); // Auto-refresh every 60s
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

  const getPnlColor = (signal: Signal, currentPrice?: number) => {
    if (!currentPrice) return "text-gray-400";
    const pnl = signal.direction === "LONG"
      ? (currentPrice - signal.entry) / signal.entry * 100
      : (signal.entry - currentPrice) / signal.entry * 100;
    return pnl >= 0 ? "text-green-400" : "text-red-400";
  };

  const getPnl = (signal: Signal, currentPrice?: number) => {
    if (!currentPrice) return "--";
    const pnl = signal.direction === "LONG"
      ? (currentPrice - signal.entry) / signal.entry * 100
      : (signal.entry - currentPrice) / signal.entry * 100;
    return `${pnl >= 0 ? "+" : ""}${pnl.toFixed(2)}%`;
  };

  return (
    <main className="min-h-screen bg-gray-950 text-gray-100 p-6">
      <div className="max-w-6xl mx-auto">
        {/* Header */}
        <div className="flex items-center justify-between mb-8">
          <div>
            <h1 className="text-3xl font-bold tracking-tight">CXSwitch <span className="text-blue-400">v29.1</span></h1>
            <p className="text-gray-500 text-sm mt-1">Consolidated Strategy Engine</p>
          </div>
          <div className="flex items-center gap-3">
            <span className="text-xs text-gray-500">Last update: {lastUpdate || "—"}</span>
            <button
              onClick={refresh}
              disabled={loading}
              className="px-4 py-2 bg-blue-600 hover:bg-blue-500 disabled:opacity-50 rounded-lg text-sm font-medium transition"
            >
              {loading ? "Loading..." : "Refresh"}
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
          <div className="mb-6 p-4 bg-red-900/30 border border-red-700 rounded-lg text-red-300 text-sm">
            {error}
          </div>
        )}

        {/* Active Signals */}
        <section className="mb-8">
          <h2 className="text-lg font-semibold mb-4 text-gray-300">Active Signals</h2>
          {signals.length === 0 ? (
            <div className="p-6 bg-gray-900 rounded-xl border border-gray-800 text-gray-500 text-center">
              No active signals
            </div>
          ) : (
            <div className="grid gap-4">
              {signals.map(s => {
                const snap = snapshots[s.pair];
                const price = snap?.price;
                const stateColor = s.tradeState === "RUNNER" ? "border-yellow-500/50" :
                                   s.tradeState === "LOCKED" ? "border-green-500/50" :
                                   s.tradeState === "BREAK_EVEN" ? "border-blue-500/50" :
                                   "border-gray-700";
                return (
                  <div key={s.id} className={`p-4 bg-gray-900 rounded-xl border ${stateColor} hover:bg-gray-850 transition`}>
                    <div className="flex items-center justify-between mb-2">
                      <div className="flex items-center gap-3">
                        <span className={`text-sm font-bold px-2 py-0.5 rounded ${s.direction === "LONG" ? "bg-green-900/50 text-green-400" : "bg-red-900/50 text-red-400"}`}>
                          {s.direction}
                        </span>
                        <span className="font-mono text-lg">{s.pair}</span>
                        <span className="text-xs text-gray-500 bg-gray-800 px-2 py-0.5 rounded">{s.entryMode}</span>
                        {s.exhaustionWarning && (
                          <span className="text-xs text-yellow-400 bg-yellow-900/30 px-2 py-0.5 rounded">⚠️ Exhaustion</span>
                        )}
                      </div>
                      <div className="text-right">
                        <div className={`font-mono font-bold ${getPnlColor(s, price)}`}>
                          {getPnl(s, price)}
                        </div>
                        <div className="text-xs text-gray-500">{s.tradeState || "OPEN"}</div>
                      </div>
                    </div>
                    <div className="grid grid-cols-4 gap-4 text-sm">
                      <div>
                        <div className="text-gray-500 text-xs">Entry</div>
                        <div className="font-mono">{s.entry.toFixed(2)}</div>
                      </div>
                      <div>
                        <div className="text-gray-500 text-xs">Stop</div>
                        <div className="font-mono text-red-400">{s.stop.toFixed(2)}</div>
                      </div>
                      <div>
                        <div className="text-gray-500 text-xs">Target</div>
                        <div className="font-mono text-green-400">{s.target.toFixed(2)}</div>
                      </div>
                      <div>
                        <div className="text-gray-500 text-xs">R:R / Conf</div>
                        <div className="font-mono">{s.rr.toFixed(2)} / {s.confidence.toFixed(0)}%</div>
                      </div>
                    </div>
                    {s.lockedStop && (
                      <div className="mt-2 text-xs text-blue-400">
                        🔒 Locked stop: {s.lockedStop.toFixed(2)}
                      </div>
                    )}
                  </div>
                );
              })}
            </div>
          )}
        </section>

        {/* Market Snapshots */}
        <section>
          <h2 className="text-lg font-semibold mb-4 text-gray-300">Market Snapshots</h2>
          <div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-4 gap-4">
            {PAIRS.map(pair => {
              const snap = snapshots[pair];
              if (!snap) return (
                <div key={pair} className="p-4 bg-gray-900 rounded-xl border border-gray-800 animate-pulse">
                  <div className="h-4 bg-gray-800 rounded w-20 mb-2"></div>
                  <div className="h-8 bg-gray-800 rounded w-32"></div>
                </div>
              );
              const regimeDir = snap.regime?.direction;
              const regimeColor = regimeDir === "LONG" ? "text-green-400" : regimeDir === "SHORT" ? "text-red-400" : "text-gray-400";
              return (
                <div key={pair} className="p-4 bg-gray-900 rounded-xl border border-gray-800 hover:border-gray-700 transition">
                  <div className="flex items-center justify-between mb-2">
                    <span className="font-mono font-semibold">{pair}</span>
                    <span className={`text-xs font-medium ${regimeColor}`}>
                      {snap.regime?.strength || "—"}
                    </span>
                  </div>
                  <div className="text-2xl font-mono font-bold mb-3">{snap.price?.toFixed(2) || "—"}</div>
                  <div className="space-y-1 text-xs text-gray-400">
                    <div className="flex justify-between">
                      <span>Trend</span>
                      <span className={regimeColor}>{snap.trend || "—"}</span>
                    </div>
                    <div className="flex justify-between">
                      <span>ADX</span>
                      <span className="font-mono">{snap.adx?.toFixed(1) || "—"}</span>
                    </div>
                    <div className="flex justify-between">
                      <span>RSI</span>
                      <span className="font-mono">{snap.rsi?.toFixed(1) || "—"}</span>
                    </div>
                    <div className="flex justify-between">
                      <span>Stoch K/D</span>
                      <span className="font-mono">{snap.stochK?.toFixed(1)}/{snap.stochD?.toFixed(1)}</span>
                    </div>
                  </div>
                </div>
              );
            })}
          </div>
        </section>
      </div>
    </main>
  );
}
