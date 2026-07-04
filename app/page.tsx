"use client";

import { useEffect, useState } from "react";

// ─── Types (v29.2) ──────────────────────────────────────────────────────

interface Signal {
  id: string;
  pair: string;
  direction: "LONG" | "SHORT";
  stage: "WATCHING" | "ACCUMULATION" | "READY" | "CONFIRMED";
  entry: number;
  stop: number;
  target: number;
  trail: number;
  confidence: number;
  rr: number;
  adx: number;
  zoneTop: number;
  zoneBottom: number;
  explanation: string;
  timestamp: number;
  version: number;
}

interface Zone {
  top: number;
  bottom: number;
  left: number;
  right: number;
  active: boolean;
  volumeClimax: number;
  type: "ACCUMULATION" | "DISTRIBUTION";
}

interface ZoneQuality {
  age: number;
  widthATR: number;
  compression: number;
  volumeDecay: number;
  touches: number;
  breakAttempts: number;
  label: "EXCELLENT" | "GOOD" | "AVERAGE" | "WEAK";
}

interface MarketData {
  pair: string;
  price: number;
  timestamp: number;
  phase: "NONE" | "WATCHING" | "ACCUMULATION" | "READY" | "CONFIRMED" | "EXPANSION" | "EXHAUSTION";
  trend: string;
  htfBias?: "BULLISH" | "BEARISH" | "NEUTRAL";
  adx: number;
  rsi: number;
  stochK: number;
  stochD: number;
  zoneTop: number | null;
  zoneBottom: number | null;
  zoneScore: number;
  zoneQuality?: ZoneQuality;
  closes4h?: number[];
}

const PAIRS = ["BTC", "ETH", "SOL", "HYPE"];

const KRAKEN_PAIRS: Record<string, string> = {
  BTC: "XBTUSD",
  ETH: "ETHUSD",
  SOL: "SOLUSD",
  HYPE: "HYPEUSD",
};

// ─── Helpers ────────────────────────────────────────────────────────────

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

function calcEMA(values: number[], period: number): number[] {
  const k = 2 / (period + 1);
  const result: number[] = [values[0]];
  for (let i = 1; i < values.length; i++) {
    result.push(values[i] * k + result[i - 1] * (1 - k));
  }
  return result;
}

function getSignalStatus(signal: Signal, currentPrice: number) {
  const ageMinutes = Math.floor((Date.now() - signal.timestamp) / 60000);
  const maxAge = 24 * 60;

  if (signal.direction === "LONG") {
    if (currentPrice >= signal.target) return { status: "TP_HIT" as const, pnl: 0, ageMinutes, ttlRemaining: "0m" };
    if (currentPrice <= signal.stop) return { status: "SL_HIT" as const, pnl: 0, ageMinutes, ttlRemaining: "0m" };
  } else {
    if (currentPrice <= signal.target) return { status: "TP_HIT" as const, pnl: 0, ageMinutes, ttlRemaining: "0m" };
    if (currentPrice >= signal.stop) return { status: "SL_HIT" as const, pnl: 0, ageMinutes, ttlRemaining: "0m" };
  }

  if (ageMinutes > maxAge) return { status: "EXPIRED" as const, pnl: 0, ageMinutes, ttlRemaining: "0m" };

  const pnl = signal.direction === "LONG"
    ? ((currentPrice - signal.entry) / signal.entry) * 100
    : ((signal.entry - currentPrice) / signal.entry) * 100;

  return { status: "ACTIVE" as const, pnl, ageMinutes, ttlRemaining: `${Math.max(0, maxAge - ageMinutes)}m` };
}

function StatusBadge({ status, direction }: { status: string; direction?: "LONG" | "SHORT" }) {
  const configs: Record<string, { bg: string; text: string; label: string }> = {
    ACTIVE_LONG: { bg: "bg-emerald-500", text: "text-white", label: "ACTIVE" },
    ACTIVE_SHORT: { bg: "bg-rose-500", text: "text-white", label: "ACTIVE" },
    TP_HIT: { bg: "bg-purple-500", text: "text-white", label: "TP HIT" },
    SL_HIT: { bg: "bg-red-600", text: "text-white", label: "SL HIT" },
    EXPIRED: { bg: "bg-slate-600", text: "text-white", label: "EXPIRED" },
    WATCHING: { bg: "bg-yellow-600", text: "text-white", label: "WATCHING" },
    ACCUMULATION: { bg: "bg-blue-600", text: "text-white", label: "ACCUMULATING" },
    READY: { bg: "bg-cyan-600", text: "text-white", label: "READY" },
    CONFIRMED: { bg: "bg-emerald-600", text: "text-white", label: "CONFIRMED" },
    NONE: { bg: "bg-slate-700", text: "text-slate-300", label: "SCANNING" },
  };

  const key = status === "ACTIVE" ? `ACTIVE_${direction}` : status;
  const config = configs[key] || configs.NONE;

  return (
    <span className={`px-4 py-1.5 rounded-lg text-sm font-bold ${config.bg} ${config.text}`}>
      {config.label}
    </span>
  );
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

// ─── Phase Color Helper ─────────────────────────────────────────────────

function phaseColor(phase: string): { text: string; bg: string; border: string; label: string } {
  switch (phase) {
    case "IMPULSE":
      return { text: "text-orange-400", bg: "bg-orange-950/30", border: "border-orange-500/30", label: "🔥 IMPULSE" };
    case "ACCUMULATION":
      return { text: "text-blue-400", bg: "bg-blue-950/30", border: "border-blue-500/30", label: "📦 ACCUMULATION" };
    case "READY":
      return { text: "text-cyan-400", bg: "bg-cyan-950/30", border: "border-cyan-500/30", label: "⚡ READY" };
    case "CONFIRMED":
      return { text: "text-emerald-400", bg: "bg-emerald-950/30", border: "border-emerald-500/30", label: "✅ CONFIRMED" };
    case "EXPANSION":
      return { text: "text-purple-400", bg: "bg-purple-950/30", border: "border-purple-500/30", label: "🚀 EXPANSION" };
    case "EXHAUSTION":
      return { text: "text-red-400", bg: "bg-red-950/30", border: "border-red-500/30", label: "😮‍💨 EXHAUSTION" };
    default:
      return { text: "text-slate-500", bg: "bg-slate-800/50", border: "border-slate-600/30", label: "SCANNING" };
  }
}

// ─── Zone Mini-Chart ──────────────────────────────────────────────────

function ZoneMiniChart({ market, signal }: { market: MarketData | undefined; signal: Signal | null }) {
  if (!market?.closes4h || market.closes4h.length < 10) return null;

  const closes = market.closes4h.slice(-30);
  const min = Math.min(...closes);
  const max = Math.max(...closes);
  const range = max - min || 1;
  const width = 200;
  const height = 60;
  const padding = 4;

  const points = closes.map((c, i) => {
    const x = padding + (i / (closes.length - 1)) * (width - padding * 2);
    const y = height - padding - ((c - min) / range) * (height - padding * 2);
    return `${x},${y}`;
  }).join(" ");

  const zoneTopY = market.zoneTop ? height - padding - ((market.zoneTop - min) / range) * (height - padding * 2) : null;
  const zoneBottomY = market.zoneBottom ? height - padding - ((market.zoneBottom - min) / range) * (height - padding * 2) : null;
  const entryY = signal ? height - padding - ((signal.entry - min) / range) * (height - padding * 2) : null;
  const stopY = signal ? height - padding - ((signal.stop - min) / range) * (height - padding * 2) : null;
  const targetY = signal ? height - padding - ((signal.target - min) / range) * (height - padding * 2) : null;
  const trailY = signal ? height - padding - ((signal.trail - min) / range) * (height - padding * 2) : null;

  return (
    <svg viewBox={`0 0 ${width} ${height}`} className="w-full h-16 mt-3">
      {zoneTopY !== null && zoneBottomY !== null && (
        <rect
          x={padding}
          y={Math.min(zoneTopY, zoneBottomY)}
          width={width - padding * 2}
          height={Math.abs(zoneBottomY - zoneTopY)}
          fill="rgba(59, 130, 246, 0.15)"
          stroke="rgba(59, 130, 246, 0.4)"
          strokeWidth="1"
          strokeDasharray="4 2"
        />
      )}
      <polyline
        fill="none"
        stroke={signal?.direction === "SHORT" ? "#f43f5e" : "#10b981"}
        strokeWidth="1.5"
        points={points}
      />
      {entryY !== null && <circle cx={width - padding} cy={entryY} r="3" fill="#fbbf24" />}
      {stopY !== null && <line x1={padding} y1={stopY} x2={width - padding} y2={stopY} stroke="#f43f5e" strokeWidth="1" strokeDasharray="3 2" opacity="0.7" />}
      {targetY !== null && <line x1={padding} y1={targetY} x2={width - padding} y2={targetY} stroke="#10b981" strokeWidth="1" strokeDasharray="3 2" opacity="0.7" />}
      {trailY !== null && <line x1={padding} y1={trailY} x2={width - padding} y2={trailY} stroke="#a78bfa" strokeWidth="1.5" strokeDasharray="5 3" />}
    </svg>
  );
}

// ─── Trend Display (4H + 1D) ──────────────────────────────────────────

function TrendDisplay({ market }: { market: MarketData | undefined }) {
  if (!market?.closes4h || market.closes4h.length < 30) {
    return (
      <div className="grid grid-cols-2 gap-4 border-t border-slate-700/50 pt-4">
        <div>
          <p className="text-xs text-slate-500 uppercase tracking-wider mb-1">4H Trend</p>
          <p className="text-sm text-slate-600">—</p>
        </div>
        <div>
          <p className="text-xs text-slate-500 uppercase tracking-wider mb-1">1D Trend</p>
          <p className="text-sm text-slate-600">—</p>
        </div>
      </div>
    );
  }

  const closes = market.closes4h;
  const ema8 = calcEMA(closes, 8);
  const ema21 = calcEMA(closes, 21);
  const price = closes[closes.length - 1];

  const ema8Last = ema8[ema8.length - 1];
  const ema21Last = ema21[ema21.length - 1];
  let trend4hDir: string | null = null;
  let trend4hStrength = "WEAK";
  if (ema8Last !== undefined && ema21Last !== undefined) {
    trend4hDir = price > ema8Last && price > ema21Last ? "LONG" : price < ema8Last && price < ema21Last ? "SHORT" : null;
    const spread = Math.abs(ema8Last - ema21Last) / ema21Last;
    trend4hStrength = spread > 0.02 ? "STRONG" : spread > 0.01 ? "MEDIUM" : "WEAK";
  }
  const trend4h = trend4hDir ? `${trend4hDir} (${trend4hStrength})` : "MIXED";

  const trend1d = market.trend || "—";
  const trend1dDir = trend1d.split(" ")[0];

  return (
    <div className="grid grid-cols-2 gap-4 border-t border-slate-700/50 pt-4">
      <div>
        <p className="text-xs text-slate-500 uppercase tracking-wider mb-1">4H Trend</p>
        <p className={`text-sm font-semibold ${
          trend4h.includes("SHORT") ? "text-rose-400" :
          trend4h.includes("LONG") ? "text-emerald-400" : "text-yellow-400"
        }`}>
          {trend4h}
        </p>
        <p className="text-xs text-slate-600 font-mono mt-0.5">
          EMA8: {ema8Last?.toFixed(1) ?? "—"} | EMA21: {ema21Last?.toFixed(1) ?? "—"}
        </p>
      </div>
      <div>
        <p className="text-xs text-slate-500 uppercase tracking-wider mb-1">1D Trend</p>
        <p className={`text-sm font-semibold ${
          trend1dDir === "SHORT" ? "text-rose-400" :
          trend1dDir === "LONG" ? "text-emerald-400" : "text-slate-400"
        }`}>
          {trend1d}
        </p>
        <p className="text-xs text-slate-600 font-mono mt-0.5">
          HTF Bias: {market.htfBias || "—"}
        </p>
      </div>
    </div>
  );
}

// ─── Market State Summary ───────────────────────────────────────────────

function MarketStateSummary({ market, signal }: { market: MarketData | undefined; signal: Signal | null }) {
  if (!market) return null;

  const phase = phaseColor(market.phase);
  const stochK = market.stochK;
  const stochD = market.stochD;
  const adx = market.adx;

  const stochState = stochK < 20 ? "OVERSOLD" : stochK > 80 ? "OVERBOUGHT" : "NEUTRAL";
  const stochColor = stochK < 20 ? "text-emerald-400" : stochK > 80 ? "text-rose-400" : "text-slate-500";

  return (
    <div className={`rounded-xl border p-4 space-y-3 ${phase.bg} ${phase.border}`}>
      <div className="flex items-center justify-between">
        <span className={`text-xs font-bold uppercase tracking-wider ${phase.text}`}>
          {phase.label}
        </span>
        {signal && (
          <span className={`text-xs font-mono ${signal.direction === "LONG" ? "text-emerald-400" : "text-rose-400"}`}>
            {signal.direction} {signal.stage}
          </span>
        )}
      </div>

      {market.zoneTop !== null && market.zoneBottom !== null && (
        <div className="flex items-center justify-between text-xs">
          <span className="text-slate-500">Zone</span>
          <span className="font-mono text-blue-400">
            {money(market.zoneBottom)} — {money(market.zoneTop)}
            {market.zoneScore > 0 && <span className="text-slate-500 ml-1">({market.zoneScore})</span>}
          </span>
        </div>
      )}

      {market.zoneQuality && (
        <div className="flex items-center justify-between text-xs">
          <span className="text-slate-500">Zone Quality</span>
          <span className={`font-mono font-bold ${
            market.zoneQuality.label === "EXCELLENT" ? "text-emerald-400" :
            market.zoneQuality.label === "GOOD" ? "text-cyan-400" :
            market.zoneQuality.label === "AVERAGE" ? "text-yellow-400" : "text-rose-400"
          }`}>
            {market.zoneQuality.label}
          </span>
        </div>
      )}

      <div className="grid grid-cols-3 gap-3 text-sm">
        <div className="text-center">
          <p className="text-xs text-slate-500 uppercase tracking-wider mb-1">ADX</p>
          <p className={`font-mono font-bold ${adx > 25 ? "text-emerald-400" : adx > 20 ? "text-yellow-400" : "text-slate-500"}`}>
            {adx.toFixed(1)}
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

      <ZoneMiniChart market={market} signal={signal} />
    </div>
  );
}

// ─── Signal Explanation ─────────────────────────────────────────────────

function SignalExplanation({ signal }: { signal: Signal }) {
  return (
    <div className="rounded-xl border border-slate-700/50 bg-slate-800/30 p-3">
      <div className="flex items-center justify-between mb-1">
        <p className="text-xs text-slate-500 uppercase tracking-wider">Explanation</p>
        <span className={`text-xs font-bold px-2 py-0.5 rounded ${
          signal.confidence >= 70 ? "bg-emerald-500/20 text-emerald-400" :
          signal.confidence >= 50 ? "bg-yellow-500/20 text-yellow-400" :
          "bg-rose-500/20 text-rose-400"
        }`}>
          {signal.confidence}% confidence
        </span>
      </div>
      <p className="text-sm text-slate-300 font-medium leading-relaxed">
        {signal.explanation || "No explanation provided"}
      </p>
      <div className="flex gap-3 mt-2 text-xs text-slate-500">
        <span>ADX: {signal.adx?.toFixed(1) ?? "—"}</span>
        <span>R:R: {signal.rr?.toFixed(2) ?? "—"}</span>
        <span>Zone: {money(signal.zoneBottom)} — {money(signal.zoneTop)}</span>
      </div>
    </div>
  );
}

// ─── Signal Card ────────────────────────────────────────────────────────

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

  const confColor =
    signal.confidence >= 70 ? "text-emerald-400" :
    signal.confidence >= 50 ? "text-yellow-400" :
    "text-rose-400";

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
      <SignalExplanation signal={signal} />
      <TrendDisplay market={market} />

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
            <span className="text-slate-400 text-sm">Trail</span>
            <span className="font-mono text-purple-400 font-semibold">{money(signal.trail)}</span>
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
           "⚠️ UNKNOWN"}
        </div>
      )}

      <div className="flex gap-3 text-xs">
        <span className="px-2 py-1 rounded bg-slate-800 text-slate-400">TTL {meta.ttlRemaining}</span>
        <span className="px-2 py-1 rounded bg-slate-800 text-slate-400">{timeAgo(signal.timestamp)} old</span>
        <span className="px-2 py-1 rounded bg-slate-800 text-slate-400">v{signal.version}</span>
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

  return (
    <div className="rounded-2xl border border-slate-700/50 bg-slate-900/40 p-6 space-y-5 backdrop-blur-sm">
      <div className="flex justify-between items-start">
        <div>
          <h2 className="text-2xl font-bold text-slate-300 tracking-tight">{pair}</h2>
          <p className="text-slate-500 text-sm mt-1">Price: {money(currentPrice)}</p>
        </div>
        <StatusBadge status={market?.phase || "NONE"} />
      </div>

      <MarketStateSummary market={market} signal={null} />
      <TrendDisplay market={market} />

      {market?.phase === "ACCUMULATION" && market.zoneTop !== null && market.zoneBottom !== null && (
        <div className="rounded-lg bg-blue-950/20 border border-blue-500/20 p-3">
          <p className="text-xs text-blue-400 font-semibold uppercase tracking-wider mb-1">Accumulation Zone</p>
          <p className="text-sm text-slate-300">
            Range: {money(market.zoneBottom)} — {money(market.zoneTop)}
          </p>
          {market.zoneQuality && (
            <p className="text-xs text-slate-500 mt-1">
              Quality: <span className={
                market.zoneQuality.label === "EXCELLENT" ? "text-emerald-400" :
                market.zoneQuality.label === "GOOD" ? "text-cyan-400" :
                market.zoneQuality.label === "AVERAGE" ? "text-yellow-400" : "text-rose-400"
              }>{market.zoneQuality.label}</span>
              {' '}• Age: {market.zoneQuality.age} candles
              {' '}• Compression: {market.zoneQuality.compression}%
            </p>
          )}
          <p className="text-xs text-slate-500 mt-1">
            Waiting for breakout with momentum confirmation...
          </p>
        </div>
      )}

      {market?.phase === "READY" && (
        <div className="rounded-lg bg-cyan-950/20 border border-cyan-500/20 p-3 animate-pulse">
          <p className="text-xs text-cyan-400 font-semibold uppercase tracking-wider mb-1">⚡ Ready for Breakout</p>
          <p className="text-xs text-slate-400">
            Zone matured. One breakout candle away from entry.
          </p>
        </div>
      )}

      {market?.phase === "WATCHING" && (
        <div className="rounded-lg bg-yellow-950/20 border border-yellow-500/20 p-3">
          <p className="text-xs text-yellow-400 font-semibold uppercase tracking-wider mb-1">👀 Watching</p>
          <p className="text-xs text-slate-400">
            Volume climax detected. Waiting for range compression to confirm accumulation.
          </p>
        </div>
      )}
    </div>
  );
}

// ─── Main Dashboard ─────────────────────────────────────────────────────

export default function Dashboard() {
  const [signals, setSignals] = useState<Record<string, Signal | null>>({});
  const [marketData, setMarketData] = useState<Record<string, MarketData>>({});
  const [livePrices, setLivePrices] = useState<Record<string, number>>({});
  const [loading, setLoading] = useState(true);
  const [fetchCount, setFetchCount] = useState(0);
  const [lastFetch, setLastFetch] = useState<number>(0);

  useEffect(() => {
    async function load() {
      try {
        const res = await fetch("/api/signals", { cache: "no-store" });
        const data = await res.json();

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

  if (loading) {
    return (
      <div className="min-h-screen bg-slate-950 text-white flex items-center justify-center">
        <div className="text-lg">Loading CX Switch v29...</div>
      </div>
    );
  }

  return (
    <div className="min-h-screen bg-slate-950 p-6 space-y-8">
      <div className="flex justify-between items-center">
        <div>
          <h1 className="text-3xl font-bold text-white tracking-tight">CX Switch v29</h1>
          <p className="text-slate-500 text-sm mt-1">
            Phase-Based Accumulation → Expansion
          </p>
          <p className="text-slate-600 text-xs">
            Fetches: {fetchCount} | Last: {lastFetch ? new Date(lastFetch).toLocaleTimeString() : "—"}
          </p>
        </div>
      </div>

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
