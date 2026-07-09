"use client";

import { useState, useEffect, useCallback } from "react";

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

function parseTrend(trend: string): { direction: string; strength: string } {
  if (!trend || trend === "—" || trend === "null null" || trend === "null ") {
    return { direction: "NEUTRAL", strength: "NEUTRAL" };
  }
  const parts = trend.split(" ").filter(Boolean);
  if (parts.length >= 2) {
    const dir = parts[0] === "null" ? "NEUTRAL" : parts[0];
    return { direction: dir, strength: parts[1] };
  }
  return { direction: parts[0] || "NEUTRAL", strength: "NEUTRAL" };
}

function getDirectionColor(direction: string | null | undefined): string {
  if (!direction) return "text-gray-400";
  const d = String(direction).toUpperCase();
  if (d === "LONG" || d === "BULLISH") return "text-green-400";
  if (d === "SHORT" || d === "BEARISH") return "text-red-400";
  return "text-gray-400";
}

function getStrengthBadge(strength: string): string {
  const s = (strength || "").toUpperCase();
  if (s === "STRONG") return "bg-green-500/20 text-green-400 border-green-500/30";
  if (s === "MODERATE" || s === "MEDIUM") return "bg-yellow-500/20 text-yellow-400 border-yellow-500/30";
  if (s === "WEAK") return "bg-orange-500/20 text-orange-400 border-orange-500/30";
  return "bg-gray-700/50 text-gray-400 border-gray-600/30";
}

function getAdxLabel(adx: number | undefined): string {
  if (adx === undefined) return "—";
  if (adx > 25) return "TRENDING";
  if (adx > 20) return "MODERATE";
  return "WEAK";
}

function getAdxColor(adx: number | undefined): string {
  if (adx === undefined) return "text-gray-500";
  if (adx > 25) return "text-green-400";
  if (adx > 20) return "text-yellow-400";
  return "text-red-400";
}

export default function Dashboard() {
  const [snapshots, setSnapshots] = useState<Record<string, MarketSnapshot>>({});
  const [loading, setLoading] = useState(false);
  const [lastUpdate, setLastUpdate] = useState<string>("");
  const [error, setError] = useState<string>("");

  const fetchSnapshots = useCallback(async () => {
    const snaps: Record<string, MarketSnapshot> = {};
    for (const pair of PAIRS) {
      try {
        const res = await fetch(`/api/signals?pair=${encodeURIComponent(pair)}&action=snapshot`);
        if (!res.ok) continue;
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

  // Market summary
  const bullish = Object.values(snapshots).filter(s => {
    const d = s.regime?.direction || parseTrend(s.trend).direction;
    return d === "LONG";
  }).length;
  const bearish = Object.values(snapshots).filter(s => {
    const d = s.regime?.direction || parseTrend(s.trend).direction;
    return d === "SHORT";
  }).length;
  const neutral = PAIRS.length - bullish - bearish;

  // Trading cycle phase
  const totalAdx = Object.values(snapshots).reduce((sum, s) => sum + (s.adx || 0), 0);
  const avgAdx = Object.values(snapshots).length > 0 ? totalAdx / Object.values(snapshots).length : 0;
  const cyclePhase = avgAdx > 25 ? "TRENDING" : avgAdx > 18 ? "TRANSITIONING" : "RANGING";
  const cycleColor = avgAdx > 25 ? "text-green-400" : avgAdx > 18 ? "text-yellow-400" : "text-gray-400";

  return (
    <main className="min-h-screen bg-gray-950 text-gray-100 p-4 md:p-6">
      <div className="max-w-5xl mx-auto">
        {/* Header */}
        <div className="flex items-center justify-between mb-6">
          <div>
            <h1 className="text-2xl md:text-3xl font-bold tracking-tight">
              CXSwitch <span className="text-blue-400">v29.1</span>
            </h1>
            <p className="text-gray-500 text-sm mt-1">Consolidated Strategy Engine</p>
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

        {/* Trading Cycle Summary */}
        <div className="mb-6 p-4 bg-gray-900 rounded-xl border border-gray-800">
          <h2 className="text-sm font-semibold text-gray-400 mb-3 uppercase tracking-wider">Trading Cycle</h2>
          <div className="grid grid-cols-4 gap-3">
            <div className="text-center">
              <div className="text-xs text-gray-500 mb-1">Phase</div>
              <div className={`text-sm font-bold ${cycleColor}`}>{cyclePhase}</div>
            </div>
            <div className="text-center">
              <div className="text-xs text-gray-500 mb-1">Avg ADX</div>
              <div className="text-sm font-bold text-gray-200">{avgAdx.toFixed(1)}</div>
            </div>
            <div className="text-center">
              <div className="text-xs text-gray-500 mb-1">Bullish</div>
              <div className="text-sm font-bold text-green-400">{bullish}</div>
            </div>
            <div className="text-center">
              <div className="text-xs text-gray-500 mb-1">Bearish</div>
              <div className="text-sm font-bold text-red-400">{bearish}</div>
            </div>
          </div>
        </div>

        {/* 2x2 Market Snapshot Cards */}
        <section>
          <h2 className="text-lg font-semibold mb-4 text-gray-300">Market Snapshots</h2>
          <div className="grid grid-cols-2 gap-3 md:gap-4">
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

              const regimeDir = snap.regime?.direction;
              const regimeStrength = snap.regime?.strength;
              const parsed = parseTrend(snap.trend);
              const direction = regimeDir || parsed.direction;
              const strength = regimeStrength || parsed.strength;
              const dirColor = getDirectionColor(direction);
              const strengthClass = getStrengthBadge(strength);
              const adxLabel = getAdxLabel(snap.adx);
              const adxColor = getAdxColor(snap.adx);

              return (
                <div key={pair} className="p-4 bg-gray-900 rounded-xl border border-gray-800 hover:border-gray-700 transition">
                  {/* Pair header with strength badge */}
                  <div className="flex items-center justify-between mb-3">
                    <span className="font-mono font-bold text-sm">{pair}</span>
                    <span className={`text-[10px] font-bold px-2 py-0.5 rounded border ${strengthClass}`}>
                      {strength}
                    </span>
                  </div>

                  {/* Price and Direction */}
                  <div className="mb-3">
                    <div className="text-2xl font-mono font-bold">${snap.price?.toFixed(2) || "—"}</div>
                    <div className={`text-xs font-bold ${dirColor} mt-0.5`}>
                      {direction || "NEUTRAL"}
                    </div>
                  </div>

                  {/* Trend Context - 1H / 4H / 1D */}
                  <div className="mb-3 p-2 bg-gray-800/50 rounded-lg">
                    <div className="text-[10px] text-gray-500 mb-1.5 uppercase tracking-wider">Trend Context</div>
                    <div className="grid grid-cols-3 gap-1 text-center">
                      <div>
                        <div className="text-[10px] text-gray-500">1H</div>
                        <div className={`text-xs font-bold ${dirColor}`}>{direction || "—"}</div>
                      </div>
                      <div>
                        <div className="text-[10px] text-gray-500">4H</div>
                        <div className={`text-xs font-bold ${dirColor}`}>{direction || "—"}</div>
                      </div>
                      <div>
                        <div className="text-[10px] text-gray-500">1D</div>
                        <div className={`text-xs font-bold ${dirColor}`}>{direction || "—"}</div>
                      </div>
                    </div>
                  </div>

                  {/* Metrics grid */}
                  <div className="grid grid-cols-2 gap-2 text-xs">
                    <div className="p-2 bg-gray-800/50 rounded-lg">
                      <div className="text-gray-500 mb-0.5">ADX</div>
                      <div className="flex items-baseline gap-1">
                        <span className="font-mono font-semibold">{snap.adx?.toFixed(1) || "—"}</span>
                        <span className={`text-[10px] ${adxColor}`}>{adxLabel}</span>
                      </div>
                    </div>
                    <div className="p-2 bg-gray-800/50 rounded-lg">
                      <div className="text-gray-500 mb-0.5">RSI</div>
                      <div className="font-mono font-semibold">{snap.rsi?.toFixed(1) || "—"}</div>
                    </div>
                    <div className="p-2 bg-gray-800/50 rounded-lg">
                      <div className="text-gray-500 mb-0.5">Stoch K</div>
                      <div className="font-mono font-semibold">{snap.stochK?.toFixed(1) || "—"}</div>
                    </div>
                    <div className="p-2 bg-gray-800/50 rounded-lg">
                      <div className="text-gray-500 mb-0.5">Stoch D</div>
                      <div className="font-mono font-semibold">{snap.stochD?.toFixed(1) || "—"}</div>
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
