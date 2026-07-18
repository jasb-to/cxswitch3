"use client";

import React, { useState, useEffect, useCallback } from "react";

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
  bias: { direction: string; strength: number } | null;
  stoch4h: { k: number; d: number };
  stoch1h: { k: number; d: number };
  stoch15m: { k: number; d: number };
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
  trendDirection: string | null;
  trendStrengthLabel: string;
  trend1d: { direction: string | null; strength: string } | null;
  trend4h: { direction: string | null; strength: string } | null;
  isExhausted: boolean;
  exhaustionReason: string;
  readiness: number;
  readinessLabel: string;
  adx: number | null;
  debug: string[];
  summary?: { debug: string[] };
  rsi?: number;
}

const PAIRS = ["BTC/USD", "ETH/USD", "SOL/USD", "HYPE/USD"];

function dirColor(dir: string | null | undefined): string {
  if (!dir) return "text-gray-400";
  const d = String(dir).toUpperCase();
  if (d === "LONG" || d === "BULLISH") return "text-green-400";
  if (d === "SHORT" || d === "BEARISH") return "text-red-400";
  return "text-gray-400";
}

function stochColor(k: number, d: number): string {
  if (k > 80 && d > 70) return "text-red-400 font-bold";
  if (k < 20 && d < 30) return "text-green-400 font-bold";
  if (k > d) return "text-green-400";
  return "text-red-400";
}

function stochBg(k: number): string {
  if (k > 80) return "bg-red-500/10 border-red-500/20";
  if (k < 20) return "bg-green-500/10 border-green-500/20";
  return "bg-gray-800/30 border-gray-700/20";
}

function readinessBarColors(score: number, hasTrade: boolean): { bg: string; text: string; bar: string } {
  if (hasTrade) return { bg: "bg-blue-500/10", text: "text-blue-400", bar: "bg-blue-500" };
  if (score >= 80) return { bg: "bg-green-500/10", text: "text-green-400", bar: "bg-green-500" };
  if (score >= 60) return { bg: "bg-amber-500/10", text: "text-amber-400", bar: "bg-amber-500" };
  if (score >= 40) return { bg: "bg-blue-500/10", text: "text-blue-400", bar: "bg-blue-500" };
  return { bg: "bg-gray-700/30", text: "text-gray-400", bar: "bg-gray-500" };
}

function entryTypeBadge(type: string): { label: string; className: string } {
  if (type === "EARLY") return { label: "EARLY", className: "bg-amber-500/20 text-amber-400 border-amber-500/30" };
  if (type === "BREAKOUT") return { label: "BREAKOUT", className: "bg-green-500/20 text-green-400 border-green-500/30" };
  if (type === "RETEST") return { label: "RETEST", className: "bg-blue-500/20 text-blue-400 border-blue-500/30" };
  return { label: "ENTRY", className: "bg-gray-700/50 text-gray-400 border-gray-600/30" };
}

function TrendBadge({ direction, strength, label }: { direction: string | null; strength: string; label: string }) {
  if (!direction) {
    return (
      <div className="p-2.5 bg-gray-800/30 rounded-lg text-center border border-gray-700/20">
        <div className="text-[10px] uppercase text-gray-500 mb-1 tracking-wider">{label}</div>
        <div className="text-sm font-bold text-gray-500">NONE</div>
      </div>
    );
  }
  const isLong = direction.toUpperCase() === "LONG";
  return (
    <div className={`p-2.5 rounded-lg text-center border ${isLong ? "bg-green-500/5 border-green-500/15" : "bg-red-500/5 border-red-500/15"}`}>
      <div className="text-[10px] uppercase text-gray-500 mb-1 tracking-wider">{label}</div>
      <div className={`text-sm font-bold ${dirColor(direction)}`}>{direction}</div>
      <div className={`text-[10px] mt-0.5 ${strength === "STRONG" ? "text-green-400 font-semibold" : strength === "MEDIUM" ? "text-amber-400" : "text-gray-500"}`}>{strength}</div>
    </div>
  );
}

function ReadinessBar({ score, label, hasTrade }: { score: number; label: string; hasTrade: boolean }) {
  const colors = readinessBarColors(score, hasTrade);
  return (
    <div className={`p-3 rounded-lg border ${colors.bg} ${hasTrade ? "border-blue-500/30" : "border-gray-700/30"}`}>
      <div className="flex items-center justify-between">
        <span className="text-xs uppercase text-gray-500 font-semibold tracking-wider">{hasTrade ? "In Trade" : "Readiness"}</span>
        <span className={`text-sm font-bold ${colors.text}`}>{hasTrade ? "ACTIVE" : `${label} (${score})`}</span>
      </div>
      {!hasTrade && (
        <div className="w-full h-2 bg-gray-800 rounded-full overflow-hidden mt-2">
          <div className={`h-full ${colors.bar} rounded-full transition-all duration-500`} style={{ width: `${score}%` }} />
        </div>
      )}
    </div>
  );
}

function StructurePanel({ debug, hasSignal, hasTrade }: { debug: string[]; hasSignal: boolean; hasTrade: boolean }) {
  if (!debug || debug.length === 0) return null;

  const structureLines = debug.filter(d => {
    if (d.includes("SIGNAL:")) return false;
    if (d === "Volume: CONFIRMED (+20%)" || d === "Volume: weak") return false;
    return d.includes("Structure:") ||
           d.includes("EMA") ||
           d.includes("TREND:") ||
           d.includes("PULLBACK:") ||
           d.includes("pullback") ||
           d.includes("ADX:") ||
           d.includes("Stoch:") ||
           d.includes("Readiness:") ||
           d.includes("trendline") ||
           d.includes("blocked") ||
           d.includes("waiting") ||
           d.includes("aligned") ||
           d.includes("cross");
  });

  if (structureLines.length === 0) return null;

  // DEDUPLICATE: keep only first occurrence of each line
  const seen = new Set<string>();
  const uniqueLines = structureLines.filter(line => {
    if (seen.has(line)) return false;
    seen.add(line);
    return true;
  });

  return (
    <div className="mb-4 p-3 bg-gray-800/40 rounded-lg border border-gray-700/30">
      <div className="text-xs uppercase text-gray-500 font-semibold tracking-wider mb-2">Structure</div>
      <div className="space-y-1">
        {uniqueLines.map((line, i) => {
          let color = "text-gray-400";
          if (line.includes("LONG")) color = "text-green-400";
          if (line.includes("SHORT")) color = "text-red-400";
          if (line.includes("PULLBACK:")) color = "text-amber-400 font-semibold";
          if (line.includes("Readiness:")) color = "text-blue-400";
          if (line.includes("blocked")) color = "text-orange-400";
          if (line.includes("CONFIRMED")) color = "text-green-400";
          if (line.includes("aligned")) color = "text-green-400";
          return <div key={i} className={`text-xs ${color}`}>{line}</div>;
        })}
      </div>
    </div>
  );
}

function MarketCard({ snap }: { snap: MarketSnapshot }) {
  const hasSignal = !!snap.signal;
  const hasTrade = !!snap.activeTrade;
  const colors = readinessBarColors(snap.readiness ?? 0, hasTrade);

  let statusBadge;
  if (hasTrade) {
    const dir = snap.activeTrade!.direction;
    statusBadge = {
      label: dir,
      className: dir === "LONG"
        ? "bg-green-500/20 text-green-400 border-green-500/30"
        : "bg-red-500/20 text-red-400 border-red-500/30"
    };
  } else if (hasSignal) {
    statusBadge = entryTypeBadge(snap.signal!.entryType);
  } else {
    statusBadge = { label: snap.readinessLabel || "WATCH", className: `${colors.bg} ${colors.text} border-gray-600/30` };
  }

  const debugLines: string[] = snap.debug || snap.summary?.debug || [];

  return (
    <div className="p-5 bg-gray-900 rounded-xl border border-gray-800 hover:border-gray-600 transition shadow-lg">
      {/* HEADER */}
      <div className="flex items-center justify-between mb-4">
        <div>
          <span className="font-mono font-bold text-xl tracking-tight">{snap.pair.replace("/USD", "")}</span>
          <div className="text-sm text-gray-500 mt-0.5">
            ${snap.price?.toLocaleString(undefined, { minimumFractionDigits: 2, maximumFractionDigits: 2 })}
          </div>
        </div>
        <span className={`text-xs font-bold px-3 py-1.5 rounded-lg border ${statusBadge.className} uppercase tracking-wider`}>
          {statusBadge.label}
        </span>
      </div>

      {/* READINESS BAR */}
      <ReadinessBar score={snap.readiness ?? 0} label={snap.readinessLabel ?? "NO TRADE"} hasTrade={hasTrade} />

      {/* TREND GRID: 1D and 4H */}
      <div className="mt-4 grid grid-cols-2 gap-2">
        <TrendBadge direction={snap.trend1d?.direction || null} strength={snap.trend1d?.strength || "WEAK"} label="1D Trend" />
        <TrendBadge direction={snap.trend4h?.direction || null} strength={snap.trend4h?.strength || "WEAK"} label="4H Trend" />
      </div>

      {/* ADX */}
      {snap.adx !== null && (
        <div className="mt-2 p-2 bg-gray-800/20 rounded-lg text-center">
          <span className="text-xs text-gray-500">ADX: </span>
          <span className={`text-sm font-mono font-bold ${snap.adx >= 25 ? "text-green-400" : snap.adx >= 20 ? "text-amber-400" : "text-gray-400"}`}>
            {snap.adx.toFixed(1)}
          </span>
          <span className="text-xs text-gray-600 ml-1">
            {snap.adx >= 30 ? "Strong" : snap.adx >= 25 ? "Good" : snap.adx >= 20 ? "Moderate" : "Weak"}
          </span>
        </div>
      )}

      {/* STOCH GRID */}
      <div className="grid grid-cols-3 gap-2 mt-4">
        <div className={`p-2 rounded-lg text-center border ${stochBg(snap.stoch4h?.k ?? 50)}`}>
          <div className="text-[10px] text-gray-500 mb-1 uppercase tracking-wider">4H Stoch</div>
          <div className={`text-sm font-mono font-bold ${stochColor(snap.stoch4h?.k ?? 50, snap.stoch4h?.d ?? 50)}`}>
            {(snap.stoch4h?.k ?? 0).toFixed(1)} / {(snap.stoch4h?.d ?? 0).toFixed(1)}
          </div>
        </div>
        <div className={`p-2 rounded-lg text-center border ${stochBg(snap.stoch1h?.k ?? 50)}`}>
          <div className="text-[10px] text-gray-500 mb-1 uppercase tracking-wider">1H Stoch</div>
          <div className={`text-sm font-mono font-bold ${stochColor(snap.stoch1h?.k ?? 50, snap.stoch1h?.d ?? 50)}`}>
            {(snap.stoch1h?.k ?? 0).toFixed(1)} / {(snap.stoch1h?.d ?? 0).toFixed(1)}
          </div>
        </div>
        <div className={`p-2 rounded-lg text-center border ${stochBg(snap.stoch15m?.k ?? 50)}`}>
          <div className="text-[10px] text-gray-500 mb-1 uppercase tracking-wider">15M Stoch</div>
          <div className={`text-sm font-mono font-bold ${stochColor(snap.stoch15m?.k ?? 50, snap.stoch15m?.d ?? 50)}`}>
            {(snap.stoch15m?.k ?? 0).toFixed(1)} / {(snap.stoch15m?.d ?? 0).toFixed(1)}
          </div>
        </div>
      </div>

      {/* RSI */}
      {snap.rsi !== undefined && (
        <div className="mt-2 flex items-center justify-between px-2">
          <span className="text-xs text-gray-500">RSI</span>
          <span className={`text-xs font-mono font-bold ${snap.rsi > 70 ? "text-red-400" : snap.rsi < 30 ? "text-green-400" : "text-gray-400"}`}>
            {snap.rsi.toFixed(1)}
          </span>
        </div>
      )}

      {/* STRUCTURE PANEL */}
      <StructurePanel debug={debugLines} hasSignal={hasSignal} hasTrade={hasTrade} />

      {/* TRADE DETAILS */}
      {hasTrade ? (
        <div className={`mb-4 p-4 rounded-lg border ${snap.activeTrade!.direction === "LONG" ? "bg-green-500/10 border-green-500/30" : "bg-red-500/10 border-red-500/30"}`}>
          <div className="flex items-center justify-between mb-3">
            <div className="flex items-center gap-2">
              <span className={`text-xs uppercase font-bold tracking-wider px-2 py-1 rounded ${snap.activeTrade!.direction === "LONG" ? "bg-green-500/20 text-green-400" : "bg-red-500/20 text-red-400"}`}>
                {snap.activeTrade!.direction}
              </span>
              <span className="text-xs text-gray-500">{snap.activeTrade!.entryType}</span>
            </div>
            <span className={`text-lg font-mono font-bold ${snap.activeTrade!.pnl.startsWith("-") ? "text-red-400" : "text-green-400"}`}>
              {snap.activeTrade!.pnl}
            </span>
          </div>
          <div className="grid grid-cols-2 gap-2 text-sm mb-4">
            <div><span className="text-gray-500">Entry:</span> <span className="font-mono text-gray-200">${snap.activeTrade!.entry.toFixed(2)}</span></div>
            <div><span className="text-gray-500">Stop:</span> <span className="font-mono text-red-400">${snap.activeTrade!.stop.toFixed(2)}</span></div>
            <div><span className="text-gray-500">Target:</span> <span className="font-mono text-green-400">${snap.activeTrade!.target.toFixed(2)}</span></div>
            <div><span className="text-gray-500">TL:</span> <span className="font-mono text-amber-400">${snap.activeTrade!.trendlinePrice?.toFixed(2) || "—"}</span></div>
          </div>

          {/* R-LEVEL TRACKER */}
          <div className="border-t border-gray-700/50 pt-3">
            <div className="text-[10px] uppercase text-gray-500 font-semibold tracking-wider mb-2">Stop Trail</div>
            <div className="space-y-1.5">
              {(() => {
                const entry = snap.activeTrade!.entry;
                const stop = snap.activeTrade!.stop;
                const currentPrice = snap.price;
                const risk = Math.abs(entry - stop);
                const currentR = risk > 0 ? (snap.activeTrade!.direction === "LONG" ? (currentPrice - entry) / risk : (entry - currentPrice) / risk) : 0;
                const isBreakeven = currentR >= 1;
                const is50Lock = currentR >= 2;
                const is70Lock = currentR >= 3;
                const nextR = Math.ceil(currentR + 0.01);
                const nextPrice = entry + (risk * nextR) * (snap.activeTrade!.direction === "LONG" ? 1 : -1);

                return (
                  <>
                    <div className="flex items-center justify-between text-xs">
                      <span className="text-gray-400">Current</span>
                      <span className={`font-mono font-bold ${currentR >= 1 ? "text-green-400" : currentR >= 0 ? "text-amber-400" : "text-red-400"}`}>
                        {currentR.toFixed(2)}R
                      </span>
                    </div>
                    <div className="flex items-center justify-between text-xs opacity-60">
                      <div className="flex items-center gap-1.5">
                        <div className="w-1.5 h-1.5 rounded-full bg-red-500"></div>
                        <span className="text-gray-400">Hard Stop</span>
                      </div>
                      <span className="font-mono text-red-400">${stop.toFixed(2)}</span>
                    </div>
                    <div className={`flex items-center justify-between text-xs ${isBreakeven ? "opacity-60" : ""}`}>
                      <div className="flex items-center gap-1.5">
                        <div className={`w-1.5 h-1.5 rounded-full ${isBreakeven ? "bg-green-500" : "bg-amber-500 animate-pulse"}`}></div>
                        <span className="text-gray-400">Breakeven</span>
                        {!isBreakeven && <span className="text-[9px] text-amber-400">← NEXT</span>}
                      </div>
                      <span className={`font-mono ${isBreakeven ? "text-green-400" : "text-amber-400"}`}>${entry.toFixed(2)}</span>
                    </div>
                    <div className={`flex items-center justify-between text-xs ${is50Lock ? "" : "opacity-40"}`}>
                      <div className="flex items-center gap-1.5">
                        <div className={`w-1.5 h-1.5 rounded-full ${is50Lock ? "bg-green-500" : "bg-gray-600"}`}></div>
                        <span className="text-gray-400">50% Lock</span>
                      </div>
                      <span className={`font-mono ${is50Lock ? "text-green-400" : "text-gray-500"}`}>${(entry + risk * 0.5 * (snap.activeTrade!.direction === "LONG" ? 1 : -1)).toFixed(2)}</span>
                    </div>
                    <div className={`flex items-center justify-between text-xs ${is70Lock ? "" : "opacity-40"}`}>
                      <div className="flex items-center gap-1.5">
                        <div className={`w-1.5 h-1.5 rounded-full ${is70Lock ? "bg-green-500" : "bg-gray-600"}`}></div>
                        <span className="text-gray-400">70% Lock</span>
                      </div>
                      <span className={`font-mono ${is70Lock ? "text-green-400" : "text-gray-500"}`}>${(entry + risk * 0.7 * (snap.activeTrade!.direction === "LONG" ? 1 : -1)).toFixed(2)}</span>
                    </div>
                    {!isBreakeven && (
                      <div className="mt-2 text-[10px] text-amber-400 text-center">
                        ${Math.abs(nextPrice - currentPrice).toFixed(2)} to +{nextR}R
                      </div>
                    )}
                  </>
                );
              })()}
            </div>
          </div>
        </div>
      ) : hasSignal ? (
        <div className="mb-4 p-4 bg-gray-800/50 rounded-lg border border-gray-700/50">
          <div className="text-xs uppercase text-gray-500 font-semibold tracking-wider mb-3">Trade Setup</div>
          <div className="space-y-2">
            <div className="flex justify-between">
              <span className="text-sm text-gray-400">Direction:</span>
              <span className={`text-sm font-bold ${dirColor(snap.signal!.direction)}`}>{snap.signal!.direction}</span>
            </div>
            <div className="flex justify-between">
              <span className="text-sm text-gray-400">Type:</span>
              <span className="text-sm font-bold text-amber-400">{snap.signal!.entryType}</span>
            </div>
            <div className="flex justify-between">
              <span className="text-sm text-gray-400">Entry:</span>
              <span className="text-sm font-mono font-bold text-gray-200">${snap.signal!.entry.toFixed(2)}</span>
            </div>
            <div className="flex justify-between">
              <span className="text-sm text-gray-400">SL:</span>
              <span className="text-sm font-mono font-bold text-red-400">${snap.signal!.stop.toFixed(2)}</span>
            </div>
            <div className="flex justify-between">
              <span className="text-sm text-gray-400">TP:</span>
              <span className="text-sm font-mono font-bold text-green-400">${snap.signal!.target.toFixed(2)}</span>
            </div>
            <div className="flex justify-between">
              <span className="text-sm text-gray-400">RR:</span>
              <span className="text-sm font-mono font-bold text-gray-200">{snap.signal!.rr.toFixed(2)}</span>
            </div>
            <div className="flex justify-between">
              <span className="text-sm text-gray-400">Confidence:</span>
              <span className={`text-sm font-bold ${snap.signal!.confidence >= 70 ? "text-green-400" : "text-amber-400"}`}>{snap.signal!.confidence}%</span>
            </div>
          </div>
        </div>
      ) : null}

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
            <h1 className="text-2xl md:text-3xl font-bold tracking-tight">CXSwitch v37</h1>
            <p className="text-gray-500 text-sm mt-1">
              Trend-Following | Trendline Break + Pullback Entry | Active: {activeTrades}
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
            CXSwitch v37 — Trend-Following | 1D/4H Bias &rarr; 4H Pullback &rarr; Trendline Entry &rarr; Profit Lock
          </p>
        </div>
      </div>
    </main>
  );
}
