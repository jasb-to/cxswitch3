"use client";

import { useEffect, useState } from "react";

// ==================== TYPES ====================

interface Signal {
  id: string;
  pair: string;
  direction: "LONG" | "SHORT";
  type: "ENTRY";
  scale: "ENTRY_1" | null;
  entry: number;
  stop: number;
  target: number;
  confidence: number;
  rr: number;
  adx: number;
  rsi: number;
  stochK: number;
  stochD: number;
  expectedMove: number;
  reason: string;
  timestamp: number;
  version: number;
  exited?: boolean;
  exitReason?: string;
  exitPrice?: number;
  exitTimestamp?: number;
}

interface MarketData {
  pair: string;
  price: number;
  timestamp: number;
  phase: "NONE" | "WATCHING" | "READY" | "EARLY_ENTRY" | "EXHAUSTION";
  trend: string;
  htfBias?: "BULLISH" | "BEARISH" | "NEUTRAL";
  adx: number;
  rsi: number;
  stochK: number;
  stochD: number;
  closes4h?: number[];
}

// ==================== CONFIG ====================

const PAIRS = ["BTC", "ETH", "SOL", "HYPE"];

const KRAKEN_PAIRS: Record<string, string> = {
  BTC: "XBTUSD",
  ETH: "ETHUSD",
  SOL: "SOLUSD",
  HYPE: "HYPEUSD",
};

// StochRSI exhaustion warning thresholds (warning only, no auto-exit)
const WARN_LONG = 80;
const WARN_SHORT = 20;

// ==================== HELPERS ====================

function money(n?: number | null): string {
  if (n === null || n === undefined || typeof n !== "number" || !isFinite(n)) return "—";
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
  const maxAge = 12 * 60;

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

// ==================== BADGES (NO STRING CONCAT IN JSX) ====================

function StatusBadge({ status, direction }: { status: string; direction?: "LONG" | "SHORT" }) {
  let bg = "bg-slate-700";
  let text = "text-slate-300";
  let label = "SCANNING";

  if (status === "ACTIVE" && direction === "LONG") {
    bg = "bg-emerald-500"; text = "text-white"; label = "ACTIVE LONG";
  } else if (status === "ACTIVE" && direction === "SHORT") {
    bg = "bg-rose-500"; text = "text-white"; label = "ACTIVE SHORT";
  } else if (status === "TP_HIT") {
    bg = "bg-purple-500"; text = "text-white"; label = "TP HIT";
  } else if (status === "SL_HIT") {
    bg = "bg-red-600"; text = "text-white"; label = "SL HIT";
  } else if (status === "EXPIRED") {
    bg = "bg-slate-600"; text = "text-white"; label = "EXPIRED";
  } else if (status === "WATCHING") {
    bg = "bg-yellow-600"; text = "text-white"; label = "WATCHING";
  } else if (status === "READY") {
    bg = "bg-cyan-600"; text = "text-white"; label = "READY";
  } else if (status === "EARLY_ENTRY") {
    bg = "bg-emerald-600"; text = "text-white"; label = "ENTRY";
  }

  const className = `px-3 py-1.5 rounded-lg text-sm font-bold ${bg} ${text}`;
  return <span className={className}>{label}</span>;
}

function PhaseBadge({ phase }: { phase: string }) {
  let bg = "bg-slate-800/50";
  let border = "border-slate-600/30";
  let text = "text-slate-500";

  if (phase === "READY") {
    bg = "bg-cyan-950/50"; border = "border-cyan-500/40"; text = "text-cyan-400";
  } else if (phase === "EARLY_ENTRY") {
    bg = "bg-emerald-950/50"; border = "border-emerald-500/40"; text = "text-emerald-400";
  } else if (phase === "EXHAUSTION") {
    bg = "bg-red-950/50"; border = "border-red-500/40"; text = "text-red-400";
  } else if (phase === "WATCHING") {
    bg = "bg-yellow-950/50"; border = "border-yellow-500/40"; text = "text-yellow-400";
  }

  const className = `inline-flex items-center gap-1.5 px-2.5 py-1 rounded-md text-xs font-bold border ${bg} ${border} ${text}`;
  return (
    <span className={className}>
      <span>*</span>{phase}
    </span>
  );
}

// ==================== DATA FETCHING ====================

async function fetchKrakenPrice(pair: string): Promise<number | null> {
  try {
    const url = `https://api.kraken.com/0/public/Ticker?pair=${KRAKEN_PAIRS[pair]}`;
    const res = await fetch(url, { cache: "no-store" });
    const data = await res.json();
    if (data.error?.length) return null;
    const ticker = data.result[Object.keys(data.result)[0]];
    return parseFloat(ticker.c[0]);
  } catch {
    return null;
  }
}

// ==================== WARNING BANNER (WARNING ONLY, NO AUTO-EXIT) ====================

function WarningBanner({ market, signal }: { market: MarketData | undefined; signal?: Signal }) {
  if (!market) return null;
  const warnings: { type: "danger" | "warning" | "info"; text: string }[] = [];

  // 1. 1D/4H mismatch
  const hasCloses = market.closes4h && market.closes4h.length >= 30;
  let trend4hDir: string | null = null;
  if (hasCloses) {
    const closes = market.closes4h!;
    const ema8 = calcEMA(closes, 8);
    const ema21 = calcEMA(closes, 21);
    const price = closes[closes.length - 1];
    const ema8Last = ema8[ema8.length - 1];
    const ema21Last = ema21[ema21.length - 1];
    if (ema8Last !== undefined && ema21Last !== undefined) {
      trend4hDir = price > ema8Last && price > ema21Last ? "LONG" : price < ema8Last && price < ema21Last ? "SHORT" : null;
    }
  }
  const trend1d = market.htfBias === "BULLISH" ? "LONG" : market.htfBias === "BEARISH" ? "SHORT" : null;
  if (trend4hDir && trend1d && trend4hDir !== trend1d) {
    warnings.push({ type: "warning", text: `1D ${trend1d} vs 4H ${trend4hDir} — entries blocked until alignment` });
  }

  // 2. EXHAUSTION WARNING (NOT EXIT) — big red banner when StochRSI hits extremes
  if (signal && signal.direction === "LONG" && market.stochK >= WARN_LONG) {
    warnings.push({
      type: "danger",
      text: `⚠️ EXHAUSTION WARNING: StochRSI K=${market.stochK.toFixed(1)} ≥ ${WARN_LONG} — Consider closing LONG to lock gains before pullback!`
    });
  }
  if (signal && signal.direction === "SHORT" && market.stochK <= WARN_SHORT) {
    warnings.push({
      type: "danger",
      text: `⚠️ EXHAUSTION WARNING: StochRSI K=${market.stochK.toFixed(1)} ≤ ${WARN_SHORT} — Consider closing SHORT to lock gains before bounce!`
    });
  }

  // 3. ADX dropping
  if (signal && market.adx < 20) {
    warnings.push({ type: "warning", text: `ADX ${market.adx.toFixed(1)} < 20 — trend weakening, monitor closely` });
  }

  // 4. TTL running low
  if (signal) {
    const ageMin = Math.floor((Date.now() - signal.timestamp) / 60000);
    const ttlLeft = 12 * 60 - ageMin;
    if (ttlLeft < 120) {
      warnings.push({ type: "info", text: `TTL ${Math.floor(ttlLeft / 60)}h ${ttlLeft % 60}m remaining` });
    }
  }

  if (warnings.length === 0) return null;

  return (
    <div className="space-y-1.5">
      {warnings.map((w, i) => {
        let styleClass = "";
        let emoji = "";
        if (w.type === "danger") {
          styleClass = "bg-rose-950/60 border-rose-500/50 text-rose-200";
          emoji = "🚨";
        } else if (w.type === "warning") {
          styleClass = "bg-yellow-950/40 border-yellow-500/40 text-yellow-300";
          emoji = "🟡";
        } else {
          styleClass = "bg-blue-950/40 border-blue-500/40 text-blue-300";
          emoji = "🔵";
        }
        const className = `rounded-lg border px-3 py-2.5 text-xs font-semibold ${styleClass}`;
        return (
          <div key={i} className={className}>
            {emoji} {w.text}
          </div>
        );
      })}
    </div>
  );
}

// ==================== PROGRESS BANNER ====================

function ProgressBanner({ market, exhausted }: { market: MarketData | undefined; exhausted?: boolean }) {
  if (!market) return null;
  const phase = market.phase;

  let bg = "bg-slate-800/30";
  let border = "border-slate-600/20";
  let text = "text-slate-500";
  let title = "Scanning Market";
  let desc = "No clear HTF trend alignment. Price may be ranging or indecisive.";

  if (exhausted) {
    bg = "bg-red-950/30"; border = "border-red-500/30"; text = "text-red-400";
    title = "EXHAUSTION WARNING";
    desc = "StochRSI at extreme. Signal still active — YOU decide when to close. Consider taking profits.";
  } else if (phase === "WATCHING") {
    bg = "bg-yellow-950/30"; border = "border-yellow-500/30"; text = "text-yellow-400";
    title = "Watching";
    desc = "1D trend aligned. Waiting for 1H StochRSI cross entry. Monitoring K/D for momentum shift.";
  } else if (phase === "READY") {
    bg = "bg-cyan-950/30"; border = "border-cyan-500/30"; text = "text-cyan-400";
    title = "Ready";
    desc = "HTF trend confirmed. StochRSI approaching crossover zone. One 1H candle away from potential entry.";
  } else if (phase === "EARLY_ENTRY") {
    bg = "bg-emerald-950/30"; border = "border-emerald-500/30"; text = "text-emerald-400";
    title = "Entry Triggered";
    desc = "1H StochRSI cross confirmed with HTF alignment. Signal active. SL and TP set.";
  } else if (phase === "EXHAUSTION") {
    bg = "bg-red-950/30"; border = "border-red-500/30"; text = "text-red-400";
    title = "StochRSI Exhaustion";
    desc = "StochRSI extreme reached. New entries blocked. Waiting for pullback/reset.";
  }

  const className = `rounded-lg border ${bg} ${border} p-3`;
  const titleClass = `text-xs font-bold uppercase tracking-wider ${text} mb-1`;

  return (
    <div className={className}>
      <p className={titleClass}>{title}</p>
      <p className="text-xs text-slate-400 leading-relaxed">{desc}</p>
    </div>
  );
}

// ==================== INDICATOR GRID ====================

function IndicatorGrid({ market, signal }: { market: MarketData | undefined; signal?: Signal }) {
  if (!market) return null;

  const adxColor = market.adx > 25 ? "text-emerald-400" : market.adx > 20 ? "text-yellow-400" : "text-slate-500";
  const stochColor = market.stochK < 20 ? "text-emerald-400" : market.stochK > 80 ? "text-rose-400" : "text-slate-500";
  const crossDir = market.stochK > market.stochD ? "up" : "down";
  const crossColor = market.stochK > market.stochD ? "text-emerald-400" : "text-rose-400";

  let entryStochK: number | null = null;
  let entryStochD: number | null = null;
  if (signal?.reason) {
    const matchK = signal.reason.match(/StochRSI K(\d+\.?\d*)/);
    const matchD = signal.reason.match(/D(\d+\.?\d*) cross/);
    if (matchK) entryStochK = parseFloat(matchK[1]);
    if (matchD) entryStochD = parseFloat(matchD[1]);
  }

  const adxClass = `font-mono font-bold text-sm ${adxColor}`;
  const stochKClass = `font-mono font-bold text-sm ${stochColor}`;
  const stochDClass = `font-mono font-bold text-sm ${stochColor}`;
  const crossClass = `font-mono font-bold text-sm ${crossColor}`;

  return (
    <div className="space-y-2">
      <div className="grid grid-cols-4 gap-2">
        <div className="bg-slate-800/40 rounded-lg p-2 text-center">
          <p className="text-[10px] text-slate-500 uppercase tracking-wider mb-1">ADX</p>
          <p className={adxClass}>{market.adx.toFixed(1)}</p>
          <p className="text-[10px] text-slate-600">{market.adx > 25 ? "STRONG" : market.adx > 20 ? "BUILDING" : "WEAK"}</p>
        </div>
        <div className="bg-slate-800/40 rounded-lg p-2 text-center">
          <p className="text-[10px] text-slate-500 uppercase tracking-wider mb-1">StochRSI K</p>
          <p className={stochKClass}>{market.stochK.toFixed(1)}</p>
          <p className="text-[10px] text-slate-600">{market.stochK < 20 ? "OVERSOLD" : market.stochK > 80 ? "OVERBOUGHT" : "NEUTRAL"}</p>
        </div>
        <div className="bg-slate-800/40 rounded-lg p-2 text-center">
          <p className="text-[10px] text-slate-500 uppercase tracking-wider mb-1">StochRSI D</p>
          <p className={stochDClass}>{market.stochD.toFixed(1)}</p>
        </div>
        <div className="bg-slate-800/40 rounded-lg p-2 text-center">
          <p className="text-[10px] text-slate-500 uppercase tracking-wider mb-1">Cross</p>
          <p className={crossClass}>K {crossDir} D</p>
          <p className="text-[10px] text-slate-600">{Math.abs(market.stochK - market.stochD).toFixed(1)} spread</p>
        </div>
      </div>
      {entryStochK !== null && (
        <div className="bg-slate-800/30 rounded-lg p-2 flex justify-between items-center text-xs border border-slate-700/30">
          <span className="text-slate-500">Entry StochRSI:</span>
          <span className="font-mono text-slate-300">
            K{entryStochK.toFixed(1)} D{entryStochD?.toFixed(1) || "—"}
            <span className="text-slate-600 ml-2">→ now K{market.stochK.toFixed(1)}</span>
            <span className={market.stochK > entryStochK + 50 ? "text-rose-400 ml-1" : market.stochK > entryStochK + 25 ? "text-yellow-400 ml-1" : "text-emerald-400 ml-1"}>
              ({market.stochK > entryStochK ? "+" : ""}{(market.stochK - entryStochK).toFixed(1)})
            </span>
          </span>
        </div>
      )}
    </div>
  );
}

// ==================== TREND DISPLAY ====================

function TrendDisplay({ market }: { market: MarketData | undefined }) {
  const hasCloses = market?.closes4h && market.closes4h.length >= 30;
  let trend4h = "—";
  let trend4hClass = "text-sm font-bold text-slate-600";
  let trend1d = "—";
  let trend1dClass = "text-sm font-bold text-slate-600";
  let htfLabel = market?.htfBias || "unknown";

  if (hasCloses) {
    const closes = market.closes4h!;
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
    trend4h = trend4hDir ? `${trend4hDir} ${trend4hStrength}` : "MIXED";
    trend4hClass = trend4h.includes("SHORT") ? "text-sm font-bold text-rose-400" :
      trend4h.includes("LONG") ? "text-sm font-bold text-emerald-400" : "text-sm font-bold text-yellow-400";
  }

  if (market?.htfBias) {
    trend1d = market.htfBias === "BULLISH" ? "LONG" : market.htfBias === "BEARISH" ? "SHORT" : "NEUTRAL";
    trend1dClass = trend1d === "SHORT" ? "text-sm font-bold text-rose-400" :
      trend1d === "LONG" ? "text-sm font-bold text-emerald-400" : "text-sm font-bold text-yellow-400";
  }

  return (
    <div className="grid grid-cols-2 gap-3">
      <div className="bg-slate-800/40 rounded-lg p-3">
        <p className="text-[10px] text-slate-500 uppercase tracking-wider mb-1">4H Trend</p>
        <p className={trend4hClass}>{trend4h}</p>
        {!hasCloses && <p className="text-[10px] text-slate-600 mt-0.5">No 4H data from API</p>}
      </div>
      <div className="bg-slate-800/40 rounded-lg p-3">
        <p className="text-[10px] text-slate-500 uppercase tracking-wider mb-1">1D Trend</p>
        <p className={trend1dClass}>{trend1d}</p>
        <p className="text-[10px] text-slate-600 mt-0.5">HTF: {htfLabel}</p>
      </div>
    </div>
  );
}

// ==================== SIGNAL CARD (WARNING ONLY, NO AUTO-EXIT) ====================

function SignalCard({ signal, market, livePrice }: { signal: Signal; market: MarketData | undefined; livePrice: number | undefined }) {
  const currentPrice = livePrice ?? market?.price ?? 0;
  const meta = getSignalStatus(signal, currentPrice);

  // Check if we should show exhaustion warning (but NOT exit)
  const isExhausted = signal.direction === "LONG" && (market?.stochK ?? 0) >= WARN_LONG
    || signal.direction === "SHORT" && (market?.stochK ?? 0) <= WARN_SHORT;

  const confColor = signal.confidence >= 70 ? "text-emerald-400" : signal.confidence >= 50 ? "text-yellow-400" : "text-rose-400";
  const confBarColor = signal.confidence >= 70 ? "bg-emerald-500" : signal.confidence >= 50 ? "bg-yellow-500" : "bg-rose-500";
  const dirColor = signal.direction === "LONG" ? "text-emerald-400" : "text-rose-400";
  const pnlClass = meta.pnl >= 0 ? "text-2xl font-mono font-bold text-emerald-400" : "text-2xl font-mono font-bold text-rose-400";

  const confClass = `text-sm font-bold ${confColor}`;
  const barClass = `h-full rounded-full transition-all duration-500 ${confBarColor}`;
  const dirClass = `font-bold ${dirColor}`;

  // Card border changes to red when exhausted (visual cue only)
  const cardBorder = isExhausted ? "border-red-500/50" : "border-slate-700/50";
  const cardBg = isExhausted ? "bg-red-950/10" : "bg-slate-900/60";

  return (
    <div className={`rounded-2xl border ${cardBorder} ${cardBg} p-5 space-y-4 backdrop-blur-sm`}>
      <div className="flex justify-between items-start">
        <div>
          <h2 className="text-2xl font-bold text-white tracking-tight">{signal.pair}</h2>
          <p className="text-slate-400 text-sm mt-0.5">Price: {money(currentPrice)}</p>
        </div>
        <div className="flex flex-col items-end gap-2">
          <StatusBadge status={meta.status} direction={signal.direction} />
          <PhaseBadge phase={isExhausted ? "EXHAUSTION" : (market?.phase || "NONE")} />
        </div>
      </div>

      <WarningBanner market={market} signal={signal} />
      <ProgressBanner market={market} exhausted={isExhausted} />
      <IndicatorGrid market={market} signal={signal} />
      <TrendDisplay market={market} />

      {isExhausted && (
        <div className="bg-red-950/30 border border-red-500/30 rounded-lg p-3">
          <p className="text-[10px] text-red-400 font-bold uppercase tracking-wider mb-1">🚨 EXHAUSTION ZONE — MANUAL CLOSE RECOMMENDED</p>
          <p className="text-xs text-slate-300">
            StochRSI K is at extreme ({market?.stochK?.toFixed(1)}). Signal is still ACTIVE.
            Consider closing to lock gains. You decide.
          </p>
        </div>
      )}

      <div>
        <div className="flex justify-between items-center mb-1.5">
          <span className="text-xs text-slate-500 uppercase tracking-wider">Confidence</span>
          <span className={confClass}>{signal.confidence}%</span>
        </div>
        <div className="h-2 bg-slate-800 rounded-full overflow-hidden">
          <div className={barClass} style={{ width: `${signal.confidence}%` }} />
        </div>
      </div>

      <div className="bg-slate-800/40 rounded-lg p-3 space-y-2">
        <p className="text-[10px] text-slate-500 uppercase tracking-wider mb-1">Trade Setup</p>
        <div className="grid grid-cols-2 gap-x-4 gap-y-1.5 text-sm">
          <div className="flex justify-between">
            <span className="text-slate-400">Direction</span>
            <span className={dirClass}>{signal.direction}</span>
          </div>
          <div className="flex justify-between">
            <span className="text-slate-400">Type</span>
            <span className="font-mono text-slate-300">{signal.type}</span>
          </div>
          <div className="flex justify-between">
            <span className="text-slate-400">Entry</span>
            <span className="font-mono text-white font-semibold">{money(signal.entry)}</span>
          </div>
          <div className="flex justify-between">
            <span className="text-slate-400">Stop</span>
            <span className="font-mono text-rose-400 font-semibold">{money(signal.stop)}</span>
          </div>
          <div className="flex justify-between">
            <span className="text-slate-400">Target</span>
            <span className="font-mono text-emerald-400 font-semibold">{money(signal.target)}</span>
          </div>
          <div className="flex justify-between">
            <span className="text-slate-400">R:R</span>
            <span className="font-mono text-yellow-400 font-bold">{signal.rr?.toFixed(2) || "—"}</span>
          </div>
          <div className="flex justify-between">
            <span className="text-slate-400">Expected</span>
            <span className="font-mono text-cyan-400 font-bold">{signal.expectedMove?.toFixed(1) || "—"}%</span>
          </div>
        </div>
      </div>

      <div className="bg-slate-800/40 rounded-lg p-3">
        <p className="text-[10px] text-slate-500 uppercase tracking-wider mb-1.5">Reason</p>
        <p className="text-xs text-slate-300 leading-relaxed font-mono">{signal.reason || "No reason provided."}</p>
      </div>

      {meta.status === "ACTIVE" && <div className={pnlClass}>{meta.pnl >= 0 ? "+" : ""}{meta.pnl.toFixed(2)}%</div>}

      <div className="flex gap-2 text-[10px]">
        <span className="px-2 py-1 rounded bg-slate-800 text-slate-400">TTL {meta.ttlRemaining}</span>
        <span className="px-2 py-1 rounded bg-slate-800 text-slate-400">{timeAgo(signal.timestamp)} old</span>
        <span className="px-2 py-1 rounded bg-slate-800 text-slate-400">v{signal.version}</span>
      </div>
    </div>
  );
}

// ==================== WAITING CARD ====================

function WaitingCard({ pair, market, livePrice }: { pair: string; market: MarketData | undefined; livePrice: number | undefined }) {
  const currentPrice = livePrice ?? market?.price ?? 0;
  const phase = market?.phase || "NONE";

  return (
    <div className="rounded-2xl border border-slate-700/50 bg-slate-900/40 p-5 space-y-4 backdrop-blur-sm">
      <div className="flex justify-between items-start">
        <div>
          <h2 className="text-2xl font-bold text-slate-300 tracking-tight">{pair}</h2>
          <p className="text-slate-500 text-sm mt-0.5">Price: {money(currentPrice)}</p>
        </div>
        <PhaseBadge phase={phase} />
      </div>

      <WarningBanner market={market} />
      <ProgressBanner market={market} />
      <IndicatorGrid market={market} />
      <TrendDisplay market={market} />

      {phase === "EXHAUSTION" && (
        <div className="bg-red-950/20 border border-red-500/20 rounded-lg p-3">
          <p className="text-[10px] text-red-400 font-bold uppercase tracking-wider mb-1">StochRSI Exhaustion</p>
          <p className="text-xs text-slate-400">
            StochRSI at extreme ({market?.stochK?.toFixed(1) || "—"}). New signals paused until pullback resets momentum.
          </p>
        </div>
      )}

      {phase === "NONE" && (
        <div className="bg-slate-800/40 rounded-lg p-3">
          <p className="text-[10px] text-slate-500 uppercase tracking-wider mb-1">No Setup</p>
          <p className="text-xs text-slate-400">
            No clear HTF trend alignment. Price may be ranging or indecisive.
            HTF bias: {market?.htfBias || "unknown"}.
          </p>
        </div>
      )}

      {phase === "WATCHING" && (
        <div className="bg-yellow-950/20 border border-yellow-500/20 rounded-lg p-3">
          <p className="text-[10px] text-yellow-400 font-bold uppercase tracking-wider mb-1">Watching</p>
          <p className="text-xs text-slate-400">
            1D trend aligned. Waiting for 1H StochRSI cross entry. ADX: {market?.adx?.toFixed(1) || "—"}.
          </p>
        </div>
      )}
    </div>
  );
}

// ==================== MAIN DASHBOARD ====================

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
        <div className="text-lg">Loading CX Switch v28...</div>
      </div>
    );
  }

  return (
    <div className="min-h-screen bg-slate-950 p-6 space-y-8">
      <div className="flex justify-between items-center">
        <div>
          <h1 className="text-3xl font-bold text-white tracking-tight">CX Switch v28</h1>
          <p className="text-slate-500 text-sm mt-1">1H StochRSI Entry + HTF Direction Filter + Exhaustion Warning</p>
          <p className="text-slate-600 text-xs">Fetches: {fetchCount} | Last: {lastFetch ? new Date(lastFetch).toLocaleTimeString() : "—"}</p>
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
