"use client";

import { useEffect, useState, useRef, useCallback } from "react";

interface Signal {
  pair: string;
  direction: "LONG" | "SHORT";
  type: "ACCUMULATE" | "BREAKOUT" | "EXIT";
  scale: "ENTRY_1" | "ENTRY_2" | "ADD" | null;
  confidence: number;
  entry: number;
  stop: number;
  target: number;
  rr: number;
  timestamp: number;
  expectedMove: number;
  reason?: string;
  version?: number;
  adx?: number;
  rsi?: number;
  stochK?: number;
  stochD?: number;
}

interface MarketData {
  pair: string;
  price: number;
  trend: string;
  adx: number;
  rsi: number;
  stochK: number;
  stochD: number;
  timestamp: number;
  trendlinePrice?: number;
  distToTrendline?: number | null;
  ema8?: number;
  ema21?: number;
  // NEW: historical closes for client-side StochRSI calc
  closes4h?: number[];
}

interface UIAlertData {
  type: "SHORT_ALERT_OVERSOLD_CROSS" | "LONG_ALERT_OVERBOUGHT_CROSS";
  message: string;
  stochK: number;
  stochD: number;
  timestamp: number;
  pair: string;
}

// NEW: Real-time client-side alert
interface RealtimeAlert {
  pair: string;
  type: "STOCH_CROSS_EXIT_LONG" | "STOCH_CROSS_EXIT_SHORT" | "STOCH_EXTREME";
  message: string;
  stochK: number;
  stochD: number;
  timestamp: number;
}

const PAIRS = ["BTC", "ETH", "SOL", "HYPE"];

const KRAKEN_PAIRS: Record<string, string> = {
  BTC: "XBTUSD",
  ETH: "ETHUSD",
  SOL: "SOLUSD",
  HYPE: "HYPEUSD",
};

// ─── StochRSI Calculator (client-side, lightweight) ───────────────────────

function calcStochRSI(closes: number[]): { k: number; d: number } {
  if (closes.length < 30) return { k: 50, d: 50 };

  // RSI
  const rsiPeriod = 14;
  const rsiValues: number[] = [];
  for (let i = rsiPeriod; i < closes.length; i++) {
    const window = closes.slice(i - rsiPeriod + 1, i + 1);
    let gains = 0, losses = 0;
    for (let j = 1; j < window.length; j++) {
      const change = window[j] - window[j - 1];
      if (change > 0) gains += change;
      else losses += Math.abs(change);
    }
    const avgGain = gains / rsiPeriod;
    const avgLoss = losses / rsiPeriod;
    rsiValues.push(avgLoss === 0 ? 100 : 100 - (100 / (1 + avgGain / avgLoss)));
  }

  // Stoch of RSI
  const stochPeriod = 14;
  const kSmooth = 3;
  const dSmooth = 3;
  const rawK: number[] = [];

  for (let i = stochPeriod - 1; i < rsiValues.length; i++) {
    const window = rsiValues.slice(i - stochPeriod + 1, i + 1);
    const lowest = Math.min(...window);
    const highest = Math.max(...window);
    rawK.push(highest === lowest ? 50 : ((rsiValues[i] - lowest) / (highest - lowest)) * 100);
  }

  const kValues: number[] = [];
  for (let i = kSmooth - 1; i < rawK.length; i++) {
    kValues.push(rawK.slice(i - kSmooth + 1, i + 1).reduce((a, b) => a + b, 0) / kSmooth);
  }

  if (kValues.length < dSmooth) return { k: 50, d: 50 };

  const currentK = kValues[kValues.length - 1];
  const currentD = kValues.slice(-dSmooth).reduce((a, b) => a + b, 0) / dSmooth;

  return { k: Math.round(currentK * 10) / 10, d: Math.round(currentD * 10) / 10 };
}

// ─── Helpers ──────────────────────────────────────────────────────────────

function money(n?: number): string {
  if (typeof n !== "number" || !isFinite(n)) return "—";
  return new Intl.NumberFormat("en-US", {
    style: "currency",
    currency: "USD",
    maximumFractionDigits: n >= 1000 ? 0 : 2,
  }).format(n);
}

function timeAgo(ts: number): string {
  const mins = Math.floor((Date.now() - ts) / 60000);
  if (mins < 1) return "now";
  if (mins < 60) return `${mins}m`;
  const hrs = Math.floor(mins / 60);
  if (hrs < 24) return `${hrs}h ${mins % 60}m`;
  return `${Math.floor(hrs / 24)}d`;
}

function getSignalStatus(signal: Signal, currentPrice: number) {
  const ageMinutes = Math.floor((Date.now() - signal.timestamp) / 60000);
  const maxAge = signal.type === "ACCUMULATE" ? 24 * 60 : 4 * 60;

  if (signal.direction === "LONG") {
    if (currentPrice >= signal.target) return { status: "TP_HIT" as const, pnl: 0, ageMinutes, ttlRemaining: "0m" };
    if (currentPrice <= signal.stop) return { status: "SL_HIT" as const, pnl: 0, ageMinutes, ttlRemaining: "0m" };
  } else {
    if (currentPrice <= signal.target) return { status: "TP_HIT" as const, pnl: 0, ageMinutes, ttlRemaining: "0m" };
    if (currentPrice >= signal.stop) return { status: "SL_HIT" as const, pnl: 0, ageMinutes, ttlRemaining: "0m" };
  }

  if (ageMinutes > maxAge) return { status: "EXPIRED" as const, pnl: 0, ageMinutes, ttlRemaining: "0m" };

  const buffer = signal.type === "ACCUMULATE" ? 0.02 : 0.005;
  if (signal.direction === "LONG" && currentPrice > signal.entry * (1 + buffer)) {
    return { status: "MISSED" as const, pnl: 0, ageMinutes, ttlRemaining: `${Math.max(0, maxAge - ageMinutes)}m` };
  }
  if (signal.direction === "SHORT" && currentPrice < signal.entry * (1 - buffer)) {
    return { status: "MISSED" as const, pnl: 0, ageMinutes, ttlRemaining: `${Math.max(0, maxAge - ageMinutes)}m` };
  }

  const pnl = signal.direction === "LONG"
    ? ((currentPrice - signal.entry) / signal.entry) * 100
    : ((signal.entry - currentPrice) / signal.entry) * 100;

  return { status: "ACTIVE" as const, pnl, ageMinutes, ttlRemaining: `${Math.max(0, maxAge - ageMinutes)}m` };
}

function parseTrend(trend?: string) {
  if (!trend) return { full: "—" };
  const parts = trend.split(" ");
  if (parts.length >= 2) {
    return { direction: parts[0], strength: parts[1], full: trend };
  }
  return { full: trend };
}

function StatusBadge({ status, direction }: { status: string; direction: "LONG" | "SHORT" }) {
  const configs: Record<string, { bg: string; text: string; label: string }> = {
    ACTIVE_LONG: { bg: "bg-emerald-500", text: "text-white", label: "ACTIVE" },
    ACTIVE_SHORT: { bg: "bg-rose-500", text: "text-white", label: "ACTIVE" },
    TP_HIT: { bg: "bg-purple-500", text: "text-white", label: "TP HIT" },
    SL_HIT: { bg: "bg-red-600", text: "text-white", label: "SL HIT" },
    EXPIRED: { bg: "bg-slate-600", text: "text-white", label: "EXPIRED" },
    MISSED: { bg: "bg-yellow-600", text: "text-white", label: "MISSED" },
    WAITING: { bg: "bg-slate-700", text: "text-slate-300", label: "BUILDING" },
  };

  const key = status === "ACTIVE" ? `ACTIVE_${direction}` : status;
  const config = configs[key] || configs.WAITING;

  return (
    <span className={`px-4 py-1.5 rounded-lg text-sm font-bold ${config.bg} ${config.text}`}>
      {config.label}
    </span>
  );
}

function formatDist(dist: number | null | undefined): string {
  if (dist === null || dist === undefined) return "—";
  const sign = dist > 0 ? "+" : "";
  return `${sign}${dist.toFixed(2)}%`;
}

async function fetchKrakenPrice(pair: string): Promise<number | null> {
  try {
    const res = await fetch(
      `https://api.kraken.com/0/public/Ticker?pair=${KRAKEN_PAIRS[pair]}`,
      { cache: "no-store" }
    );
    const data = await res.json();
    if (data.error?.length) return null;
    const ticker = data.result[Object.keys(data.result)[0]];
    return parseFloat(ticker.c[0]);
  } catch {
    return null;
  }
}

// ─── NEW: Real-time Alert Banner ──────────────────────────────────────────

function RealtimeAlertBanner({ alert, onDismiss }: { alert: RealtimeAlert; onDismiss: () => void }) {
  const isExitLong = alert.type === "STOCH_CROSS_EXIT_LONG";
  const isExitShort = alert.type === "STOCH_CROSS_EXIT_SHORT";
  const color = isExitLong
    ? "border-rose-500 bg-rose-950/40 animate-pulse"
    : isExitShort
    ? "border-emerald-500 bg-emerald-950/40 animate-pulse"
    : "border-yellow-500 bg-yellow-950/40";
  const icon = isExitLong ? "🔴" : isExitShort ? "🟢" : "⚠️";
  const title = isExitLong
    ? "EXIT LONG — Stoch Cross Detected"
    : isExitShort
    ? "EXIT SHORT — Stoch Cross Detected"
    : "Stoch Extreme";

  return (
    <div className={`rounded-xl border-2 ${color} p-4 mb-4 relative`}>
      <button
        onClick={onDismiss}
        className="absolute top-2 right-2 text-slate-400 hover:text-white text-xs"
      >
        ✕
      </button>
      <div className="flex items-center gap-3">
        <span className="text-2xl">{icon}</span>
        <div className="flex-1">
          <p className="text-sm font-bold text-white uppercase tracking-wider">
            {alert.pair} — {title}
          </p>
          <p className="text-xs text-slate-300 mt-1">{alert.message}</p>
          <p className="text-xs text-slate-500 mt-1">
            Stoch K={alert.stochK.toFixed(1)} D={alert.stochD.toFixed(1)} • {timeAgo(alert.timestamp)} ago
          </p>
        </div>
      </div>
    </div>
  );
}

// ─── Market State Summary ─────────────────────────────────────────────────

function MarketStateSummary({ market, signal }: { market: MarketData | undefined; signal: Signal | null }) {
  if (!market) return null;

  const adx = market.adx;
  const stochK = market.stochK;
  const stochD = market.stochD;
  const dist = market.distToTrendline;

  let readiness = "Scanning...";
  let readinessColor = "text-slate-500";
  let readinessBg = "bg-slate-800/50";

  if (signal) {
    readiness = `${signal.direction} ${signal.type} ${signal.scale || ""} IN PLAY`;
    readinessColor = signal.direction === "LONG" ? "text-emerald-400" : "text-rose-400";
    readinessBg = signal.direction === "LONG" ? "bg-emerald-950/30 border-emerald-500/30" : "bg-rose-950/30 border-rose-500/30";
  } else if (typeof dist === "number") {
    const nearTL = Math.abs(dist) < 1.2;
    const extremeOversold = stochK < 20 && stochD < 20;
    const extremeOverbought = stochK > 80 && stochD > 80;

    if (nearTL && extremeOversold) {
      readiness = "LONG accumulation zone — near trendline + oversold";
      readinessColor = "text-emerald-400";
      readinessBg = "bg-emerald-950/20 border-emerald-500/20";
    } else if (nearTL && extremeOverbought) {
      readiness = "SHORT accumulation zone — near trendline + overbought";
      readinessColor = "text-rose-400";
      readinessBg = "bg-rose-950/20 border-rose-500/20";
    } else if (nearTL) {
      readiness = "Near trendline — waiting for Stoch extreme";
      readinessColor = "text-yellow-400";
      readinessBg = "bg-yellow-950/20 border-yellow-500/20";
    } else if (Math.abs(dist) > 3 && adx > 32) {
      readiness = "Extended move — exhaustion risk, avoid new entries";
      readinessColor = "text-orange-400";
      readinessBg = "bg-orange-950/20 border-orange-500/20";
    } else if (stochK > 80 || stochK < 20) {
      readiness = `Stoch extreme (${stochK.toFixed(1)}) — watch for reversal`;
      readinessColor = "text-purple-400";
      readinessBg = "bg-purple-950/20 border-purple-500/20";
    } else {
      readiness = "No setup — price away from trendline";
      readinessColor = "text-slate-500";
      readinessBg = "bg-slate-800/50";
    }
  }

  const adxStrength = adx > 25 ? "STRONG" : adx > 20 ? "BUILDING" : "WEAK";
  const adxColor = adx > 25 ? "text-emerald-400" : adx > 20 ? "text-yellow-400" : "text-slate-500";
  const stochState = stochK < 20 ? "OVERSOLD" : stochK > 80 ? "OVERBOUGHT" : "NEUTRAL";
  const stochColor = stochK < 20 ? "text-emerald-400" : stochK > 80 ? "text-rose-400" : "text-slate-500";

  return (
    <div className={`rounded-xl border p-4 space-y-3 ${readinessBg}`}>
      <div className="flex items-center gap-2">
        <span className={`text-xs font-bold uppercase tracking-wider ${readinessColor}`}>
          {readiness}
        </span>
      </div>

      <div className="grid grid-cols-3 gap-3 text-sm">
        <div className="text-center">
          <p className="text-xs text-slate-500 uppercase tracking-wider mb-1">ADX</p>
          <p className={`font-mono font-bold ${adxColor}`}>
            {adx.toFixed(1)} <span className="text-xs font-normal text-slate-600">{adxStrength}</span>
          </p>
        </div>
        <div className="text-center">
          <p className="text-xs text-slate-500 uppercase tracking-wider mb-1">Stoch K</p>
          <p className={`font-mono font-bold ${stochColor}`}>{stochK.toFixed(1)}</p>
        </div>
        <div className="text-center">
          <p className="text-xs text-slate-500 uppercase tracking-wider mb-1">Stoch D</p>
          <p className={`font-mono font-bold ${stochColor}`}>{stochD.toFixed(1)}</p>
        </div>
      </div>

      <div className="flex items-center justify-between text-xs">
        <span className="text-slate-500">Stoch Cross</span>
        <span className={`font-mono ${stochK > stochD ? "text-emerald-400" : "text-rose-400"}`}>
          {stochK > stochD ? "K ↑ D" : "K ↓ D"} ({Math.abs(stochK - stochD).toFixed(1)} spread)
        </span>
      </div>

      {typeof dist === "number" && (
        <div className="flex items-center justify-between text-xs">
          <span className="text-slate-500">Trendline Distance</span>
          <span className={`font-mono ${Math.abs(dist) < 1.2 ? "text-emerald-400" : Math.abs(dist) < 3 ? "text-yellow-400" : "text-slate-500"}`}>
            {formatDist(dist)}
          </span>
        </div>
      )}
    </div>
  );
}

// ─── Signal Reason Summary ──────────────────────────────────────────────

function SignalReasonSummary({ signal }: { signal: Signal }) {
  return (
    <div className="rounded-xl border border-slate-700/50 bg-slate-800/30 p-3">
      <p className="text-xs text-slate-500 uppercase tracking-wider mb-1">Signal Reason</p>
      <p className="text-sm text-slate-300 font-medium leading-relaxed">
        {signal.reason || "No reason provided"}
      </p>
      <div className="flex gap-3 mt-2 text-xs text-slate-500">
        <span>ADX: {signal.adx?.toFixed(1) ?? "—"}</span>
        <span>RSI: {signal.rsi?.toFixed(1) ?? "—"}</span>
        <span>Stoch K: {signal.stochK?.toFixed(1) ?? "—"}</span>
        <span>Stoch D: {signal.stochD?.toFixed(1) ?? "—"}</span>
      </div>
    </div>
  );
}

// ─── UI Alert Banner (from cron) ────────────────────────────────────────

function UIAlertBanner({ alert }: { alert: UIAlertData }) {
  const isShortAlert = alert.type === "SHORT_ALERT_OVERSOLD_CROSS";
  const color = isShortAlert
    ? "border-emerald-500/50 bg-emerald-950/20"
    : "border-rose-500/50 bg-rose-950/20";
  const icon = isShortAlert ? "↗️" : "↘️";
  const title = isShortAlert ? "Potential Bounce" : "Potential Pullback";

  return (
    <div className={`rounded-xl border ${color} p-4 mb-4`}>
      <div className="flex items-center gap-3">
        <span className="text-xl">{icon}</span>
        <div className="flex-1">
          <p className="text-sm font-semibold text-white">
            {alert.pair} — {title}
          </p>
          <p className="text-xs text-slate-400 mt-1">{alert.message}</p>
          <p className="text-xs text-slate-500 mt-1">
            Stoch K={alert.stochK.toFixed(1)} D={alert.stochD.toFixed(1)} • {timeAgo(alert.timestamp)} ago
          </p>
        </div>
      </div>
    </div>
  );
}

// ─── Signal Card ─────────────────────────────────────────────────────────

function SignalCard({
  signal,
  market,
  livePrice,
}: {
  signal: Signal;
  market: MarketData | undefined;
  livePrice: number | undefined;
}) {
  const currentPrice = livePrice ?? market?.price ?? 0;
  const meta = getSignalStatus(signal, currentPrice);
  const trend1d = parseTrend(market?.trend);

  const ema8 = market?.ema8;
  const ema21 = market?.ema21;
  const price = market?.price ?? currentPrice;
  let trend4hDir: string | null = null;
  let trend4hStrength = "WEAK";

  if (ema8 !== undefined && ema21 !== undefined) {
    trend4hDir =
      price > ema8 && price > ema21
        ? "LONG"
        : price < ema8 && price < ema21
        ? "SHORT"
        : null;
    const spread = Math.abs(ema8 - ema21) / ema21;
    trend4hStrength = spread > 0.02 ? "STRONG" : spread > 0.01 ? "MEDIUM" : "WEAK";
  }
  const trend4h = trend4hDir ? `${trend4hDir} (${trend4hStrength})` : "MIXED";

  const confColor =
    signal.confidence >= 70
      ? "text-emerald-400"
      : signal.confidence >= 50
      ? "text-yellow-400"
      : "text-rose-400";

  return (
    <div className="rounded-2xl border border-slate-700/50 bg-slate-900/60 p-6 space-y-5 backdrop-blur-sm">
      <div className="flex justify-between items-start">
        <div>
          <h2 className="text-2xl font-bold text-white tracking-tight">{signal.pair}</h2>
          <p className="text-slate-400 text-sm mt-1">Price: {money(currentPrice)}</p>
        </div>
        <StatusBadge status={meta.status} direction={signal.direction} />
      </div>

      <MarketStateSummary market={market} signal={signal} />
      <SignalReasonSummary signal={signal} />

      <div className="grid grid-cols-2 gap-4">
        <div>
          <p className="text-xs text-slate-500 uppercase tracking-wider mb-1">4H Trend</p>
          <p className={`text-sm font-semibold ${
            trend4h.includes("SHORT") ? "text-rose-400" : 
            trend4h.includes("LONG") ? "text-emerald-400" : "text-yellow-400"
          }`}>
            {trend4h}
          </p>
        </div>
        <div>
          <p className="text-xs text-slate-500 uppercase tracking-wider mb-1">1D Trend</p>
          <p className={`text-sm font-semibold ${
            trend1d.direction === "SHORT" ? "text-rose-400" : 
            trend1d.direction === "LONG" ? "text-emerald-400" : "text-slate-400"
          }`}>
            {trend1d.direction || "—"} <span className="text-slate-500 font-normal">({trend1d.strength || "—"})</span>
          </p>
        </div>
      </div>

      <div>
        <div className="flex justify-between items-center mb-2">
          <span className="text-xs text-slate-500 uppercase tracking-wider">Confidence</span>
          <span className={`text-sm font-bold ${confColor}`}>{signal.confidence}%</span>
        </div>
        <div className="h-2 bg-slate-800 rounded-full overflow-hidden">
          <div 
            className={`h-full rounded-full transition-all duration-500 ${
              signal.confidence >= 70 ? "bg-emerald-500" : 
              signal.confidence >= 50 ? "bg-yellow-500" : "bg-rose-500"
            }`}
            style={{ width: `${signal.confidence}%` }}
          />
        </div>
      </div>

      <div className="border-t border-slate-700/50 pt-4">
        <p className="text-xs text-slate-500 uppercase tracking-wider mb-3">Trade Setup</p>
        <div className="space-y-3">
          <div className="flex justify-between">
            <span className="text-slate-400 text-sm">Direction</span>
            <span className={`font-bold ${signal.direction === "LONG" ? "text-emerald-400" : "text-rose-400"}`}>
              {signal.direction}
            </span>
          </div>
          <div className="flex justify-between">
            <span className="text-slate-400 text-sm">Entry</span>
            <span className="font-mono text-white font-semibold">{money(signal.entry)}</span>
          </div>
          <div className="flex justify-between">
            <span className="text-slate-400 text-sm">Stop</span>
            <span className="font-mono text-rose-400 font-semibold">{money(signal.stop)}</span>
          </div>
          <div className="flex justify-between">
            <span className="text-slate-400 text-sm">Target</span>
            <span className="font-mono text-emerald-400 font-semibold">{money(signal.target)}</span>
          </div>
          <div className="flex justify-between">
            <span className="text-slate-400 text-sm">R:R</span>
            <span className="font-mono text-yellow-400 font-bold">{signal.rr.toFixed(2)}</span>
          </div>
        </div>
      </div>

      {meta.status === "ACTIVE" && (
        <div className={`text-3xl font-mono font-bold ${meta.pnl >= 0 ? "text-emerald-400" : "text-rose-400"}`}>
          {meta.pnl >= 0 ? "+" : ""}{meta.pnl.toFixed(2)}%
        </div>
      )}

      {meta.status !== "ACTIVE" && (
        <div className={`text-lg font-bold ${
          meta.status === "TP_HIT" ? "text-purple-400" :
          meta.status === "SL_HIT" ? "text-rose-400" :
          meta.status === "EXPIRED" ? "text-slate-400" :
          "text-yellow-400"
        }`}>
          {meta.status === "TP_HIT" ? "🎯 TARGET HIT" :
           meta.status === "SL_HIT" ? "🛑 STOP HIT" :
           meta.status === "EXPIRED" ? "⏰ EXPIRED" :
           "⚠️ MISSED ENTRY"}
        </div>
      )}

      <div className="flex gap-3 text-xs">
        <span className="px-2 py-1 rounded bg-slate-800 text-slate-400">TTL {meta.ttlRemaining}</span>
        <span className="px-2 py-1 rounded bg-slate-800 text-slate-400">{timeAgo(signal.timestamp)} old</span>
      </div>
    </div>
  );
}

// ─── Waiting Card ───────────────────────────────────────────────────────

function WaitingCard({
  pair,
  market,
  livePrice,
}: {
  pair: string;
  market: MarketData | undefined;
  livePrice: number | undefined;
}) {
  const currentPrice = livePrice ?? market?.price ?? 0;
  const trend1d = parseTrend(market?.trend);

  const ema8 = market?.ema8;
  const ema21 = market?.ema21;
  const price = market?.price ?? currentPrice;
  let trend4hDir: string | null = null;
  let trend4hStrength = "WEAK";

  if (ema8 !== undefined && ema21 !== undefined) {
    trend4hDir =
      price > ema8 && price > ema21
        ? "LONG"
        : price < ema8 && price < ema21
        ? "SHORT"
        : null;
    const spread = Math.abs(ema8 - ema21) / ema21;
    trend4hStrength = spread > 0.02 ? "STRONG" : spread > 0.01 ? "MEDIUM" : "WEAK";
  }
  const trend4h = trend4hDir ? `${trend4hDir} (${trend4hStrength})` : "MIXED";

  return (
    <div className="rounded-2xl border border-slate-700/50 bg-slate-900/40 p-6 space-y-5 backdrop-blur-sm">
      <div className="flex justify-between items-start">
        <div>
          <h2 className="text-2xl font-bold text-slate-300 tracking-tight">{pair}</h2>
          <p className="text-slate-500 text-sm mt-1">Price: {money(currentPrice)}</p>
        </div>
        <StatusBadge status="WAITING" direction="LONG" />
      </div>

      <MarketStateSummary market={market} signal={null} />

      <div className="grid grid-cols-2 gap-4">
        <div>
          <p className="text-xs text-slate-500 uppercase tracking-wider mb-1">4H Trend</p>
          <p className={`text-sm font-semibold ${
            trend4h.includes("SHORT") ? "text-rose-400/60" : 
            trend4h.includes("LONG") ? "text-emerald-400/60" : "text-yellow-400/60"
          }`}>
            {trend4h}
          </p>
        </div>
        <div>
          <p className="text-xs text-slate-500 uppercase tracking-wider mb-1">1D Trend</p>
          <p className={`text-sm font-semibold ${
            trend1d.direction === "SHORT" ? "text-rose-400/60" : 
            trend1d.direction === "LONG" ? "text-emerald-400/60" : "text-slate-500"
          }`}>
            {trend1d.direction || "—"} <span className="text-slate-600 font-normal">({trend1d.strength || "—"})</span>
          </p>
        </div>
      </div>

      <div>
        <div className="flex justify-between items-center mb-2">
          <span className="text-xs text-slate-500 uppercase tracking-wider">Readiness</span>
          <span className="text-sm font-bold text-slate-500">Waiting...</span>
        </div>
        <div className="h-2 bg-slate-800 rounded-full overflow-hidden">
          <div className="h-full w-0 bg-slate-600 rounded-full" />
        </div>
      </div>
    </div>
  );
}

// ─── Main Dashboard ─────────────────────────────────────────────────────

export default function Dashboard() {
  const [signals, setSignals] = useState<Record<string, Signal | null>>({});
  const [marketData, setMarketData] = useState<Record<string, MarketData>>({});
  const [livePrices, setLivePrices] = useState<Record<string, number>>({});
  const [uiAlerts, setUIAlerts] = useState<UIAlertData[]>([]);
  const [realtimeAlerts, setRealtimeAlerts] = useState<RealtimeAlert[]>([]);
  const [loading, setLoading] = useState(true);
  const [fetchCount, setFetchCount] = useState(0);
  const [lastFetch, setLastFetch] = useState<number>(0);

  // Track previous Stoch values for crossover detection
  const prevStochRef = useRef<Record<string, { k: number; d: number }>>({});

  // NEW: Real-time StochRSI monitoring
  const checkRealtimeCrossovers = useCallback(() => {
    const newAlerts: RealtimeAlert[] = [];
    const now = Date.now();

    for (const pair of PAIRS) {
      const market = marketData[pair];
      const signal = signals[pair];
      if (!market || !signal) continue;

      const closes = market.closes4h;
      if (!closes || closes.length < 30) continue;

      const stoch = calcStochRSI(closes);
      const prev = prevStochRef.current[pair];

      if (prev) {
        // LONG trade: alert when K crosses below D (momentum exhaustion)
        if (signal.direction === "LONG" && prev.k >= prev.d && stoch.k < stoch.d && stoch.k > 60) {
          newAlerts.push({
            pair,
            type: "STOCH_CROSS_EXIT_LONG",
            message: `K crossed below D at ${stoch.k.toFixed(1)} — consider taking profit or tightening stop`,
            stochK: stoch.k,
            stochD: stoch.d,
            timestamp: now,
          });
        }

        // SHORT trade: alert when K crosses above D (momentum exhaustion)
        if (signal.direction === "SHORT" && prev.k <= prev.d && stoch.k > stoch.d && stoch.k < 40) {
          newAlerts.push({
            pair,
            type: "STOCH_CROSS_EXIT_SHORT",
            message: `K crossed above D at ${stoch.k.toFixed(1)} — consider taking profit or tightening stop`,
            stochK: stoch.k,
            stochD: stoch.d,
            timestamp: now,
          });
        }

        // Extreme alert: Stoch hits opposite extreme (auto-exit territory)
        if (signal.direction === "LONG" && stoch.k < 20) {
          newAlerts.push({
            pair,
            type: "STOCH_EXTREME",
            message: `Stoch deeply oversold (${stoch.k.toFixed(1)}) — system will auto-exit on next cron`,
            stochK: stoch.k,
            stochD: stoch.d,
            timestamp: now,
          });
        }
        if (signal.direction === "SHORT" && stoch.k > 80) {
          newAlerts.push({
            pair,
            type: "STOCH_EXTREME",
            message: `Stoch deeply overbought (${stoch.k.toFixed(1)}) — system will auto-exit on next cron`,
            stochK: stoch.k,
            stochD: stoch.d,
            timestamp: now,
          });
        }
      }

      prevStochRef.current[pair] = { k: stoch.k, d: stoch.d };
    }

    if (newAlerts.length > 0) {
      setRealtimeAlerts((prev) => [...newAlerts, ...prev].slice(0, 20));
    }
  }, [marketData, signals]);

  // Run real-time check every 10 seconds
  useEffect(() => {
    const interval = setInterval(checkRealtimeCrossovers, 10000);
    return () => clearInterval(interval);
  }, [checkRealtimeCrossovers]);

  // Data fetching
  useEffect(() => {
    async function load() {
      try {
        const res = await fetch("/api/signals", { cache: "no-store" });
        const data = await res.json();

        let alertData: { alerts?: UIAlertData[] } = { alerts: [] };
        try {
          const alertRes = await fetch("/api/alerts", { cache: "no-store" });
          alertData = await alertRes.json();
        } catch {
          // Alerts endpoint optional
        }

        const sigMap: Record<string, Signal | null> = {};
        const mktMap: Record<string, MarketData> = {};

        for (const p of PAIRS) {
          const s = data.signals?.find((sig: Signal) => sig.pair === p);
          sigMap[p] = s || null;
        }
        for (const m of data.marketData || []) {
          if (m?.pair) mktMap[m.pair] = m;
        }

        setSignals(sigMap);
        setMarketData(mktMap);
        setUIAlerts(alertData.alerts || []);
        setFetchCount((c) => c + 1);
        setLastFetch(Date.now());
      } catch (e) {
        console.error(e);
      } finally {
        setLoading(false);
      }
    }
    load();
    const i = setInterval(load, 30000);
    return () => clearInterval(i);
  }, []);

  // Live prices
  useEffect(() => {
    async function loadPrices() {
      const liveMap: Record<string, number> = {};
      await Promise.all(
        PAIRS.map(async (pair) => {
          const price = await fetchKrakenPrice(pair);
          if (price) liveMap[pair] = price;
        })
      );
      setLivePrices(liveMap);
    }
    loadPrices();
    const i = setInterval(loadPrices, 10000);
    return () => clearInterval(i);
  }, []);

  const dismissAlert = (index: number) => {
    setRealtimeAlerts((prev) => prev.filter((_, i) => i !== index));
  };

  if (loading) {
    return (
      <div className="min-h-screen bg-slate-950 text-white flex items-center justify-center">
        <div className="text-lg">Loading CX Switch v28...</div>
      </div>
    );
  }

  return (
    <div className="min-h-screen bg-slate-950 p-6 space-y-8">
      <div className="flex justify-between items-center">
        <div>
          <h1 className="text-3xl font-bold text-white tracking-tight">CX Switch v28</h1>
          <p className="text-slate-500 text-sm mt-1">
            Fetches: {fetchCount} | Last: {lastFetch ? new Date(lastFetch).toLocaleTimeString() : "—"}
          </p>
        </div>
      </div>

      {/* REAL-TIME ALERTS — Pulsing, dismissible */}
      {realtimeAlerts.length > 0 && (
        <div className="space-y-2">
          {realtimeAlerts.map((alert, i) => (
            <RealtimeAlertBanner key={`rt-${alert.pair}-${alert.timestamp}`} alert={alert} onDismiss={() => dismissAlert(i)} />
          ))}
        </div>
      )}

      {/* Cron-based UI alerts */}
      {uiAlerts.length > 0 && (
        <div className="space-y-2">
          {uiAlerts.map((alert, i) => (
            <UIAlertBanner key={`ui-${alert.pair}-${alert.type}-${i}`} alert={alert} />
          ))}
        </div>
      )}

      <div className="grid md:grid-cols-2 gap-6">
        {PAIRS.map((pair) => {
          const signal = signals[pair];
          const mkt = marketData[pair];
          const livePrice = livePrices[pair];

          return signal ? (
            <SignalCard key={pair} signal={signal} market={mkt} livePrice={livePrice} />
          ) : (
            <WaitingCard key={pair} pair={pair} market={mkt} livePrice={livePrice} />
          );
        })}
      </div>
    </div>
  );
}
