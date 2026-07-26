"use client";

import React, { useState, useEffect, useCallback } from "react";

interface ActiveTradeInfo {
  signalId: string;
  direction: "LONG" | "SHORT";
  pnl: string;
  entry: number;
  stop: number;
  target: number;
  currentR?: number;
  phase?: string;
}

interface MarketSnapshot {
  pair: string;
  price: number;
  timestamp: number;
  bias: string | null;
  location: string;
  locationType: string | null;
  trigger: string;
  ready: boolean;
  activeTrade?: ActiveTradeInfo | null;
}

const PAIRS = ["BTC/USD", "ETH/USD", "SOL/USD", "HYPE/USD"];

function dirColor(dir: string | null | undefined): string {
  if (!dir) return "text-gray-400";
  const d = String(dir).toUpperCase();
  if (d === "LONG") return "text-green-400";
  if (d === "SHORT") return "text-red-400";
  return "text-gray-400";
}

function dirBg(dir: string | null | undefined): string {
  if (!dir) return "bg-gray-800/30 border-gray-700/20";
  const d = String(dir).toUpperCase();
  if (d === "LONG") return "bg-green-500/5 border-green-500/15";
  if (d === "SHORT") return "bg-red-500/5 border-red-500/15";
  return "bg-gray-800/30 border-gray-700/20";
}

// ─── Status Badge ──────────────────────────────────────────

function getStatusBadge(snap: MarketSnapshot): { label: string; className: string } {
  if (snap.activeTrade) {
    const dir = snap.activeTrade.direction;
    return {
      label: dir,
      className: dir === "LONG"
        ? "bg-green-500/20 text-green-400 border-green-500/30"
        : "bg-red-500/20 text-red-400 border-red-500/30"
    };
  }
  if (snap.ready) {
    return { label: "READY", className: "bg-green-500/20 text-green-400 border-green-500/30" };
  }
  if (snap.bias && snap.bias !== "NONE") {
    return { label: snap.bias, className: "bg-amber-500/20 text-amber-400 border-amber-500/30" };
  }
  return { label: "NO BIAS", className: "bg-gray-700/50 text-gray-400 border-gray-600/30" };
}

// ─── 3-Step Progress ───────────────────────────────────────

function ProgressBar({ snap }: { snap: MarketSnapshot }) {
  const hasBias = snap.bias && snap.bias !== "NONE";
  const hasLocation = snap.location !== "No valid location" && snap.location !== "—";
  const hasTrigger = snap.ready;

  const steps = [
    { label: "Bias", met: hasBias },
    { label: "Location", met: hasLocation },
    { label: "Trigger", met: hasTrigger },
  ];

  const metCount = steps.filter(s => s.met).length;

  return (
    <div className="p-3 rounded-lg border border-gray-700/30 bg-gray-800/40">
      <div className="flex items-center justify-between mb-2">
        <span className="text-xs uppercase text-gray-500 font-semibold tracking-wider">Progress</span>
        <span className={`text-sm font-bold ${metCount === 3 ? "text-green-400" : metCount === 2 ? "text-amber-400" : "text-gray-400"}`}>
          {metCount}/3
        </span>
      </div>
      <div className="flex gap-1">
        {steps.map((step, i) => (
          <div key={i} className="flex-1">
            <div className={`h-2 rounded-full transition-all duration-500 ${step.met ? (metCount === 3 ? "bg-green-500" : "bg-amber-500") : "bg-gray-700"}`} />
            <div className={`text-[10px] mt-1 text-center ${step.met ? "text-gray-300" : "text-gray-600"}`}>{step.label}</div>
          </div>
        ))}
      </div>
    </div>
  );
}

// ─── Bias Badge ────────────────────────────────────────────

function BiasBadge({ bias }: { bias: string | null }) {
  if (!bias || bias === "NONE") {
    return (
      <div className="p-2.5 bg-gray-800/30 rounded-lg text-center border border-gray-700/20">
        <div className="text-[10px] uppercase text-gray-500 mb-1 tracking-wider">4H Bias</div>
        <div className="text-sm font-bold text-gray-500">NONE</div>
      </div>
    );
  }
  const isLong = bias === "LONG";
  return (
    <div className={`p-2.5 rounded-lg text-center border ${isLong ? "bg-green-500/5 border-green-500/15" : "bg-red-500/5 border-red-500/15"}`}>
      <div className="text-[10px] uppercase text-gray-500 mb-1 tracking-wider">4H Bias</div>
      <div className={`text-sm font-bold ${dirColor(bias)}`}>{bias}</div>
      <div className="text-[10px] mt-0.5 text-gray-500">EMA8 vs EMA21</div>
    </div>
  );
}

// ─── Location Panel ────────────────────────────────────────

function LocationPanel({ snap }: { snap: MarketSnapshot }) {
  if (!snap.bias || snap.bias === "NONE") return null;

  const isValid = snap.location !== "No valid location" && snap.location !== "—";
  const isTrendline = snap.locationType === "trendline";

  return (
    <div className={`p-3 rounded-lg border ${isValid ? (isTrendline ? "bg-amber-500/5 border-amber-500/20" : "bg-blue-500/5 border-blue-500/20") : "bg-gray-800/30 border-gray-700/20"}`}>
      <div className="flex items-center justify-between mb-1">
        <span className="text-xs uppercase text-gray-500 font-semibold tracking-wider">Location</span>
        <span className={`text-xs font-bold ${isValid ? (isTrendline ? "text-amber-400" : "text-blue-400") : "text-gray-500"}`}>
          {isValid ? (isTrendline ? "TRENDLINE" : "SWING S/R") : "WAITING"}
        </span>
      </div>
      <div className={`text-xs ${isValid ? "text-gray-300" : "text-gray-500"}`}>{snap.location}</div>
    </div>
  );
}

// ─── Trigger Panel ─────────────────────────────────────────

function TriggerPanel({ snap }: { snap: MarketSnapshot }) {
  if (!snap.bias || snap.bias === "NONE") return null;

  const isFired = snap.ready;
  const parts = snap.trigger.split(" + ");
  const primary = parts[0] || snap.trigger;
  const confirmation = parts[1] || null;

  return (
    <div className={`p-3 rounded-lg border ${isFired ? "bg-green-500/5 border-green-500/20" : "bg-gray-800/30 border-gray-700/20"}`}>
      <div className="flex items-center justify-between mb-1">
        <span className="text-xs uppercase text-gray-500 font-semibold tracking-wider">15M Trigger</span>
        <span className={`text-xs font-bold ${isFired ? "text-green-400" : "text-gray-500"}`}>
          {isFired ? "FIRED" : "WAITING"}
        </span>
      </div>
      <div className={`text-xs ${isFired ? "text-gray-300" : "text-gray-500"}`}>
        {isFired ? (
          <>
            <span className="text-amber-400 font-semibold">{primary}</span>
            <span className="text-gray-500"> + </span>
            <span className="text-blue-400 font-semibold">{confirmation}</span>
          </>
        ) : (
          snap.trigger
        )}
      </div>
    </div>
  );
}

// ─── Missing Conditions ────────────────────────────────────

function MissingPanel({ snap }: { snap: MarketSnapshot }) {
  if (snap.ready || snap.activeTrade) return null;

  const missing: string[] = [];
  if (!snap.bias || snap.bias === "NONE") {
    missing.push("4H EMA8/21 cross needed for bias");
  }
  if (snap.bias && snap.bias !== "NONE" && (snap.location === "No valid location" || snap.location === "—")) {
    missing.push("Price not near trendline or swing S/R");
  }
  if (snap.bias && snap.bias !== "NONE" && snap.location !== "No valid location" && snap.location !== "—" && !snap.ready) {
    missing.push("Waiting for Stoch cross or EMA cross on 15M");
  }

  if (missing.length === 0) return null;

  return (
    <div className="mb-4 p-3 bg-gray-800/40 rounded-lg border border-gray-700/30">
      <div className="text-xs uppercase text-gray-500 font-semibold tracking-wider mb-2">Missing</div>
      <div className="space-y-1">
        {missing.map((line, i) => (
          <div key={i} className="text-xs text-amber-400">○ {line}</div>
        ))}
      </div>
    </div>
  );
}

// ─── Active Trade Panel ────────────────────────────────────

function TradePanel({ snap }: { snap: MarketSnapshot }) {
  if (!snap.activeTrade) return null;

  const t = snap.activeTrade;
  const isLong = t.direction === "LONG";
  const currentPrice = snap.price;
  const entry = t.entry;
  const stop = t.stop;
  const risk = Math.abs(entry - stop);
  const currentR = risk > 0
    ? (isLong ? (currentPrice - entry) / risk : (entry - currentPrice) / risk)
    : 0;
  const phase = currentR >= 2 ? "TREND" : currentR >= 1 ? "BUILDING" : "ENTRY";

  return (
    <div className={`mb-4 p-4 rounded-lg border ${isLong ? "bg-green-500/10 border-green-500/30" : "bg-red-500/10 border-red-500/30"}`}>
      <div className="flex items-center justify-between mb-3">
        <div className="flex items-center gap-2">
          <span className={`text-xs uppercase font-bold tracking-wider px-2 py-1 rounded ${isLong ? "bg-green-500/20 text-green-400" : "bg-red-500/20 text-red-400"}`}>
            {t.direction}
          </span>
          <span className="text-xs text-gray-500">PULLBACK</span>
        </div>
        <span className={`text-lg font-mono font-bold ${t.pnl.startsWith("-") ? "text-red-400" : "text-green-400"}`}>
          {t.pnl}
        </span>
      </div>
      <div className="grid grid-cols-2 gap-2 text-sm mb-4">
        <div><span className="text-gray-500">Entry:</span> <span className="font-mono text-gray-200">${entry.toFixed(2)}</span></div>
        <div><span className="text-gray-500">Stop:</span> <span className="font-mono text-red-400">${stop.toFixed(2)}</span></div>
        <div><span className="text-gray-500">Target:</span> <span className="font-mono text-green-400">${t.target.toFixed(2)}</span></div>
        <div><span className="text-gray-500">RR:</span> <span className="font-mono text-gray-200">{t.currentR !== undefined ? (Math.abs(t.target - entry) / risk).toFixed(2) : "—"}</span></div>
      </div>

      {/* Trail Progress */}
      <div className="border-t border-gray-700/50 pt-3">
        <div className="text-[10px] uppercase text-gray-500 font-semibold tracking-wider mb-2">Trail Progress</div>
        <div className="space-y-1.5">
          <div className="flex items-center justify-between text-xs">
            <span className="text-gray-400">Current R</span>
            <span className={`font-mono font-bold ${currentR >= 2 ? "text-green-400" : currentR >= 1 ? "text-amber-400" : currentR >= 0 ? "text-blue-400" : "text-red-400"}`}>
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
          <div className={`flex items-center justify-between text-xs ${currentR >= 1 ? "opacity-60" : ""}`}>
            <div className="flex items-center gap-1.5">
              <div className={`w-1.5 h-1.5 rounded-full ${currentR >= 1 ? "bg-green-500" : "bg-gray-600"}`}></div>
              <span className="text-gray-400">1R — Building</span>
            </div>
            <span className={`font-mono ${currentR >= 1 ? "text-green-400" : "text-gray-500"}`}>
              ${(entry + risk * (isLong ? 1 : -1)).toFixed(2)}
            </span>
          </div>
          <div className={`flex items-center justify-between text-xs ${currentR >= 2 ? "" : "opacity-40"}`}>
            <div className="flex items-center gap-1.5">
              <div className={`w-1.5 h-1.5 rounded-full ${currentR >= 2 ? "bg-blue-500 animate-pulse" : "bg-gray-600"}`}></div>
              <span className="text-gray-400">2R — Trail Active</span>
              {currentR >= 2 && <span className="text-[9px] text-blue-400">● LOCKED</span>}
            </div>
            <span className={`font-mono ${currentR >= 2 ? "text-blue-400" : "text-gray-500"}`}>
              ${(entry + risk * 2 * (isLong ? 1 : -1)).toFixed(2)}
            </span>
          </div>
          <div className="flex items-center justify-between text-xs opacity-40">
            <div className="flex items-center gap-1.5">
              <div className="w-1.5 h-1.5 rounded-full bg-gray-600"></div>
              <span className="text-gray-400">3R — Trend</span>
            </div>
            <span className="font-mono text-gray-500">${(entry + risk * 3 * (isLong ? 1 : -1)).toFixed(2)}</span>
          </div>
          <div className="mt-2 text-[10px] text-gray-500 text-center">
            Phase: <span className="text-gray-300">{phase}</span>
          </div>
        </div>
      </div>
    </div>
  );
}

// ─── Market Card ───────────────────────────────────────────

function MarketCard({ snap }: { snap: MarketSnapshot }) {
  const badge = getStatusBadge(snap);

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
        <span className={`text-xs font-bold px-3 py-1.5 rounded-lg border ${badge.className} uppercase tracking-wider`}>
          {badge.label}
        </span>
      </div>

      {/* PROGRESS */}
      <ProgressBar snap={snap} />

      {/* BIAS */}
      <div className="mt-4">
        <BiasBadge bias={snap.bias} />
      </div>

      {/* LOCATION & TRIGGER */}
      <div className="mt-2 space-y-2">
        <LocationPanel snap={snap} />
        <TriggerPanel snap={snap} />
      </div>

      {/* MISSING CONDITIONS */}
      <MissingPanel snap={snap} />

      {/* ACTIVE TRADE */}
      <TradePanel snap={snap} />

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
            <h1 className="text-2xl md:text-3xl font-bold tracking-tight">CXSwitch v46</h1>
            <p className="text-gray-500 text-sm mt-1">
              Three Rules — 4H Bias &rarr; 1H Location &rarr; 15M Trigger | Active: {activeTrades}
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
            CXSwitch v46 "Three Rules" — 4H Bias &rarr; 1H Location (Trendline/Swing) &rarr; 15M Trigger (Stoch/EMA + Confirm)
          </p>
        </div>
      </div>
    </main>
  );
}
