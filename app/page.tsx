"use client";

import React, { useState, useEffect, useCallback } from "react";

// ─── Safe Access Helpers ─────────────────────────────────
function safeBool(val: any): boolean { return val === true; }
function safeStr(val: any): string { return typeof val === "string" ? val : ""; }
function safeNum(val: any): number { return typeof val === "number" && isFinite(val) ? val : 0; }
function safeArr(val: any): string[] { return Array.isArray(val) ? val : []; }

interface TriggerDiagnostics {
  stochCross?: { passed?: boolean; detail?: string };
  emaCross?: { passed?: boolean; detail?: string };
  reclaimEma21?: { passed?: boolean; detail?: string };
  volumeSpike?: { passed?: boolean; detail?: string };
  primaryPassed?: string[];
  confirmationPassed?: string[];
  fired?: boolean;
  summary?: string;
}

interface ActiveTradeInfo {
  signalId?: string;
  direction?: "LONG" | "SHORT";
  pnl?: string;
  entry?: number;
  currentPrice?: number;
  stop?: number;
  target?: number;
  currentR?: string;
  phase?: string;
  nextMilestone?: string;
}

interface MarketSnapshot {
  pair?: string;
  price?: number;
  timestamp?: number;
  bias?: string | null;
  biasScore?: number;
  biasDetail?: string;
  location?: string;
  locationType?: string | null;
  trigger?: string;
  triggerDiagnostics?: TriggerDiagnostics;
  ready?: boolean;
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

function scoreColor(score: number): string {
  if (score >= 70) return "text-green-400";
  if (score <= 30) return "text-red-400";
  return "text-amber-400";
}

function scoreBg(score: number): string {
  if (score >= 70) return "bg-green-500/10 border-green-500/20";
  if (score <= 30) return "bg-red-500/10 border-red-500/20";
  return "bg-amber-500/10 border-amber-500/20";
}

// ─── Status Badge ──────────────────────────────────────────

function getStatusBadge(snap: MarketSnapshot): { label: string; className: string } {
  if (snap.activeTrade) {
    const dir = snap.activeTrade.direction;
    return {
      label: "ACTIVE TRADE",
      className: dir === "LONG"
        ? "bg-green-500/20 text-green-400 border-green-500/30"
        : "bg-red-500/20 text-red-400 border-red-500/30"
    };
  }
  if (snap.ready) {
    return { label: "SIGNAL READY", className: "bg-green-500/20 text-green-400 border-green-500/30" };
  }
  if (snap.bias && snap.bias !== "NEUTRAL" && snap.location !== "No valid location" && snap.location !== "—") {
    return { label: "READY – Waiting for Trigger", className: "bg-amber-500/20 text-amber-400 border-amber-500/30" };
  }
  if (snap.bias && snap.bias !== "NEUTRAL") {
    return { label: "Waiting for Location", className: "bg-blue-500/20 text-blue-400 border-blue-500/30" };
  }
  return { label: "NEUTRAL — No Trade", className: "bg-gray-700/50 text-gray-400 border-gray-600/30" };
}

// ─── Bias Score Badge ──────────────────────────────────────

function BiasScoreBadge({ bias, score, detail }: { bias: string | null | undefined; score?: number; detail?: string }) {
  const s = safeNum(score);

  if (!bias || bias === "NEUTRAL") {
    return (
      <div className="p-2.5 bg-gray-800/30 rounded-lg text-center border border-gray-700/20">
        <div className="text-[10px] uppercase text-gray-500 mb-1 tracking-wider">4H Bias Score</div>
        <div className="text-sm font-bold text-gray-500">NEUTRAL</div>
        <div className="text-[10px] mt-0.5 text-gray-600">Score: {s > 0 ? s : "—"}/100</div>
      </div>
    );
  }

  const isLong = bias === "LONG";
  return (
    <div className={`p-2.5 rounded-lg text-center border ${scoreBg(s)}`}>
      <div className="text-[10px] uppercase text-gray-500 mb-1 tracking-wider">4H Bias Score</div>
      <div className={`text-sm font-bold ${dirColor(bias)}`}>{bias}</div>
      <div className={`text-lg font-mono font-bold ${scoreColor(s)}`}>{s}</div>
      {detail && (
        <div className="text-[9px] mt-1 text-gray-500 leading-tight">{detail}</div>
      )}
    </div>
  );
}

// ─── Location Panel ────────────────────────────────────────

function LocationPanel({ snap }: { snap: MarketSnapshot }) {
  if (!snap.bias || snap.bias === "NEUTRAL") return null;

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
      <div className={`text-xs ${isValid ? "text-gray-300" : "text-gray-500"}`}>{snap.location || "—"}</div>
    </div>
  );
}

// ─── Trigger Panel ─────────────────────────────────────────

function TriggerPanel({ snap }: { snap: MarketSnapshot }) {
  if (!snap.bias || snap.bias === "NEUTRAL") return null;

  const diag = snap.triggerDiagnostics;
  if (!diag) {
    return (
      <div className="p-3 rounded-lg border bg-gray-800/30 border-gray-700/20">
        <div className="text-xs uppercase text-gray-500 font-semibold tracking-wider">15M Trigger</div>
        <div className="text-xs text-gray-500 mt-1">{snap.trigger || "—"}</div>
      </div>
    );
  }

  const isFired = safeBool(diag.fired);
  const stochPassed = safeBool(diag.stochCross?.passed);
  const emaCrossPassed = safeBool(diag.emaCross?.passed);
  const reclaimPassed = safeBool(diag.reclaimEma21?.passed);
  const volPassed = safeBool(diag.volumeSpike?.passed);
  const primary = safeArr(diag.primaryPassed);
  const confirmation = safeArr(diag.confirmationPassed);

  return (
    <div className={`p-3 rounded-lg border ${isFired ? "bg-green-500/5 border-green-500/20" : "bg-gray-800/30 border-gray-700/20"}`}>
      <div className="flex items-center justify-between mb-2">
        <span className="text-xs uppercase text-gray-500 font-semibold tracking-wider">15M Trigger</span>
        <span className={`text-xs font-bold ${isFired ? "text-green-400" : "text-gray-500"}`}>
          {isFired ? "FIRED" : "WAITING"}
        </span>
      </div>

      {/* Primary triggers */}
      <div className="space-y-1 mb-2">
        <div className="text-[10px] uppercase text-gray-600 tracking-wider">Primary</div>
        <div className="flex items-center gap-2 text-xs">
          <span className={stochPassed ? "text-green-400" : "text-gray-500"}>
            {stochPassed ? "✓" : "✗"} Stoch Cross
          </span>
        </div>
        <div className="flex items-center gap-2 text-xs">
          <span className={emaCrossPassed ? "text-green-400" : "text-gray-500"}>
            {emaCrossPassed ? "✓" : "✗"} EMA Cross
          </span>
        </div>
      </div>

      {/* Confirmations */}
      <div className="space-y-1 mb-2">
        <div className="text-[10px] uppercase text-gray-600 tracking-wider">Confirmation</div>
        <div className="flex items-center gap-2 text-xs">
          <span className={reclaimPassed ? "text-green-400" : "text-gray-500"}>
            {reclaimPassed ? "✓" : "✗"} EMA21 Reclaim
          </span>
        </div>
        <div className="flex items-center gap-2 text-xs">
          <span className={volPassed ? "text-green-400" : "text-gray-500"}>
            {volPassed ? "✓" : "✗"} Volume Spike
          </span>
        </div>
      </div>

      {/* Result */}
      <div className={`text-xs ${isFired ? "text-green-400" : "text-amber-400"}`}>
        {primary.length > 0 && confirmation.length > 0
          ? `${primary[0]} + ${confirmation[0]} ✓`
          : primary.length > 0
            ? `Primary ready (${primary[0]}). Waiting for confirmation.`
            : confirmation.length > 0
              ? `Confirmation ready (${confirmation[0]}). Waiting for primary trigger.`
              : `No primary trigger. ${safeStr(diag.stochCross?.detail)}`}
      </div>
    </div>
  );
}

// ─── Missing Panel ─────────────────────────────────────────

function MissingPanel({ snap }: { snap: MarketSnapshot }) {
  if (snap.ready || snap.activeTrade) return null;

  const missing: string[] = [];
  if (!snap.bias || snap.bias === "NEUTRAL") {
    missing.push("Bias score neutral (30-70). Waiting for strong trend.");
  }
  if (snap.bias && snap.bias !== "NEUTRAL" && (snap.location === "No valid location" || snap.location === "—")) {
    missing.push("Price not near trendline or swing S/R");
  }
  if (snap.bias && snap.bias !== "NEUTRAL" && snap.location !== "No valid location" && snap.location !== "—" && !snap.ready) {
    const diag = snap.triggerDiagnostics;
    const primary = safeArr(diag?.primaryPassed);
    const confirmation = safeArr(diag?.confirmationPassed);
    if (primary.length === 0) {
      missing.push("Waiting for Stoch cross or EMA cross on 15M");
    } else if (confirmation.length === 0) {
      missing.push("Primary trigger detected. Waiting for volume or EMA reclaim confirmation.");
    }
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
  const entry = safeNum(t.entry);
  const current = safeNum(t.currentPrice);
  const stop = safeNum(t.stop);
  const target = safeNum(t.target);
  const pnl = safeStr(t.pnl);

  return (
    <div className={`mb-4 p-4 rounded-lg border ${isLong ? "bg-green-500/10 border-green-500/30" : "bg-red-500/10 border-red-500/30"}`}>
      <div className="flex items-center justify-between mb-4">
        <div className="flex items-center gap-2">
          <span className={`text-xs uppercase font-bold tracking-wider px-2 py-1 rounded ${isLong ? "bg-green-500/20 text-green-400" : "bg-red-500/20 text-red-400"}`}>
            {t.direction || "UNKNOWN"}
          </span>
          <span className="text-xs text-gray-500">PULLBACK</span>
        </div>
        <span className={`text-lg font-mono font-bold ${pnl.startsWith("-") ? "text-red-400" : "text-green-400"}`}>
          {pnl || "0.00%"}
        </span>
      </div>

      <div className="grid grid-cols-2 gap-x-4 gap-y-2 text-sm mb-4">
        <div><span className="text-gray-500">Entry:</span> <span className="font-mono text-gray-200">${entry.toFixed(2)}</span></div>
        <div><span className="text-gray-500">Current:</span> <span className="font-mono text-gray-200">${current.toFixed(2)}</span></div>
        <div><span className="text-gray-500">Stop:</span> <span className="font-mono text-red-400">${stop.toFixed(2)}</span></div>
        <div><span className="text-gray-500">Target:</span> <span className="font-mono text-green-400">${target.toFixed(2)}</span></div>
        <div><span className="text-gray-500">Current R:</span> <span className="font-mono text-blue-400">{safeStr(t.currentR)}R</span></div>
        <div><span className="text-gray-500">Phase:</span> <span className="font-mono text-amber-400">{safeStr(t.phase)}</span></div>
      </div>

      {t.nextMilestone && (
        <div className="p-2 bg-gray-800/40 rounded border border-gray-700/30">
          <div className="flex items-center justify-between text-xs">
            <span className="text-gray-500">Next Milestone</span>
            <span className="font-mono font-bold text-blue-400">{t.nextMilestone}</span>
          </div>
        </div>
      )}
    </div>
  );
}

// ─── Market Card ───────────────────────────────────────────

function MarketCard({ snap }: { snap: MarketSnapshot }) {
  const badge = getStatusBadge(snap);
  const price = safeNum(snap.price);
  const score = safeNum(snap.biasScore);

  return (
    <div className="p-5 bg-gray-900 rounded-xl border border-gray-800 hover:border-gray-600 transition shadow-lg">
      {/* HEADER */}
      <div className="flex items-center justify-between mb-4">
        <div>
          <span className="font-mono font-bold text-xl tracking-tight">{(snap.pair || "???").replace("/USD", "")}</span>
          <div className="text-sm text-gray-500 mt-0.5">
            ${price > 0 ? price.toLocaleString(undefined, { minimumFractionDigits: 2, maximumFractionDigits: 2 }) : "—"}
          </div>
        </div>
        <span className={`text-xs font-bold px-3 py-1.5 rounded-lg border ${badge.className} uppercase tracking-wider`}>
          {badge.label}
        </span>
      </div>

      {/* BIAS SCORE */}
      <div className="mb-2">
        <BiasScoreBadge bias={snap.bias} score={score} detail={snap.biasDetail} />
      </div>

      {/* LOCATION & TRIGGER */}
      <div className="space-y-2">
        <LocationPanel snap={snap} />
        <TriggerPanel snap={snap} />
      </div>

      {/* MISSING CONDITIONS */}
      <MissingPanel snap={snap} />

      {/* ACTIVE TRADE */}
      <TradePanel snap={snap} />

      <div className="text-xs text-gray-600 text-right mt-2">
        Updated: {snap.timestamp ? new Date(snap.timestamp).toLocaleString() : "—"}
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
            <h1 className="text-2xl md:text-3xl font-bold tracking-tight">CXSwitch v46.2</h1>
            <p className="text-gray-500 text-sm mt-1">
              Bias Score → 1H Location → 15M Trigger | Active: {activeTrades}
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
            CXSwitch v46.2 — Bias Score (Slope + Price + Structure) → 1H Location → 15M Trigger (Stoch Extreme + Confirm)
          </p>
        </div>
      </div>
    </main>
  );
}
