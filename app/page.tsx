"use client";

import { useEffect, useState } from "react";

interface SignalMeta {
  status: "ACTIVE" | "TP_HIT" | "SL_HIT" | "EXPIRED";
  ageMinutes: number;
  pnl: number;
  actionable: boolean;
}

interface Signal {
  id: string;
  pair: string;
  direction: "LONG" | "SHORT";
  type: "ENTRY" | "ACCUMULATE" | "BREAKOUT";
  scale: "ENTRY_1" | "ENTRY_2" | null;
  entry: number;
  stop: number;
  target: number;
  confidence: number;
  rr: number;
  adx: number;
  rsi: number;
  stochK: number;
  stochD: number;
  stoch1hK?: number;
  stoch1hD?: number;
  expectedMove: number;
  reason: string;
  timestamp: number;
  version: number;
  exited?: boolean;
  exitReason?: string;
  exitPrice?: number;
  exitTimestamp?: number;
  tradeState?: "OPEN" | "BREAK_EVEN" | "LOCKED" | "RUNNER" | "EXITED";
  lockedStop?: number | null;
  highestPrice?: number;
  lowestPrice?: number;
  profitLockActive?: boolean;
  meta: SignalMeta;
}

interface MarketData {
  pair: string;
  price: number;
  timestamp: number;
  phase: "NONE" | "WATCHING" | "READY" | "EARLY_ENTRY" | "EXHAUSTION" | "EXPANSION";
  trend: string;
  htfBias?: "BULLISH" | "BEARISH" | "NEUTRAL";
  adx: number;
  rsi: number;
  stochK: number;
  stochD: number;
  stoch1hK?: number;
  stoch1hD?: number;
}

const PAIRS = ["BTC", "ETH", "SOL", "HYPE"] as const;

function money(n?: number | null): string {
  if (n === null || n === undefined || typeof n !== "number" || !isFinite(n)) return "—";
  return new Intl.NumberFormat("en-US", { style: "currency", currency: "USD", maximumFractionDigits: n >= 1000 ? 0 : 2 }).format(n);
}

function timeAgo(ts: number): string {
  const mins = Math.floor((Date.now() - ts) / 60000);
  if (mins < 1) return "now";
  if (mins < 60) return `${mins}m`;
  const hrs = Math.floor(mins / 60);
  if (hrs < 24) return `${hrs}h ${mins % 60}m`;
  return `${Math.floor(hrs / 24)}d`;
}

function formatPercent(n: number): string {
  const sign = n >= 0 ? "+" : "";
  return `${sign}${n.toFixed(2)}%`;
}

function StatusBadge({ status, direction }: { status: string; direction?: "LONG" | "SHORT" }) {
  const configs: Record<string, { bg: string; text: string; label: string }> = {
    ACTIVE_LONG: { bg: "bg-emerald-500", text: "text-white", label: "ACTIVE LONG" },
    ACTIVE_SHORT: { bg: "bg-rose-500", text: "text-white", label: "ACTIVE SHORT" },
    TP_HIT: { bg: "bg-purple-500", text: "text-white", label: "TP HIT" },
    SL_HIT: { bg: "bg-red-600", text: "text-white", label: "SL HIT" },
    EXPIRED: { bg: "bg-slate-600", text: "text-white", label: "EXPIRED" },
    OPEN: { bg: "bg-blue-500", text: "text-white", label: "OPEN" },
    BREAK_EVEN: { bg: "bg-cyan-500", text: "text-white", label: "BREAK EVEN" },
    LOCKED: { bg: "bg-amber-500", text: "text-white", label: "LOCKED" },
    RUNNER: { bg: "bg-emerald-500", text: "text-white", label: "RUNNER" },
    EXITED: { bg: "bg-slate-500", text: "text-white", label: "EXITED" },
  };
  const key = status === "ACTIVE" && direction ? `ACTIVE_${direction}` : status;
  const cfg = configs[key] || { bg: "bg-slate-700", text: "text-slate-300", label: status };
  return <span className={`px-3 py-1.5 rounded-lg text-sm font-bold ${cfg.bg} ${cfg.text}`}>{cfg.label}</span>;
}

function PhaseBadge({ phase }: { phase: string }) {
  const configs: Record<string, { bg: string; border: string; text: string }> = {
    NONE: { bg: "bg-slate-800/50", border: "border-slate-600/30", text: "text-slate-500" },
    WATCHING: { bg: "bg-yellow-950/50", border: "border-yellow-500/40", text: "text-yellow-400" },
    READY: { bg: "bg-cyan-950/50", border: "border-cyan-500/40", text: "text-cyan-400" },
    EARLY_ENTRY: { bg: "bg-emerald-950/50", border: "border-emerald-500/40", text: "text-emerald-400" },
    EXHAUSTION: { bg: "bg-red-950/50", border: "border-red-500/40", text: "text-red-400" },
    EXPANSION: { bg: "bg-purple-950/50", border: "border-purple-500/40", text: "text-purple-400" },
  };
  const cfg = configs[phase] || configs.NONE;
  return <span className={`inline-flex items-center gap-1.5 px-2.5 py-1 rounded-md text-xs font-bold border ${cfg.bg} ${cfg.border} ${cfg.text}`}><span className="w-1.5 h-1.5 rounded-full bg-current" />{phase}</span>;
}

function TradeManagerPanel({ signal }: { signal: Signal }) {
  if (!signal.tradeState) return null;
  const stateColors: Record<string, string> = { OPEN: "text-blue-400", BREAK_EVEN: "text-cyan-400", LOCKED: "text-amber-400", RUNNER: "text-emerald-400", EXITED: "text-slate-400" };
  return (
    <div className="bg-slate-800/40 rounded-lg p-3 space-y-2 border border-slate-700/30">
      <p className="text-[10px] text-slate-500 uppercase tracking-wider">Trade Manager</p>
      <div className="grid grid-cols-2 gap-2 text-sm">
        <div><span className="text-slate-500 text-xs">State</span><p className={`font-bold ${stateColors[signal.tradeState] || "text-slate-400"}`}>{signal.tradeState}</p></div>
        {signal.lockedStop !== undefined && signal.lockedStop !== null && <div><span className="text-slate-500 text-xs">Managed Stop</span><p className="font-mono font-bold text-amber-400">{money(signal.lockedStop)}</p></div>}
        {signal.highestPrice !== undefined && <div><span className="text-slate-500 text-xs">Highest Price</span><p className="font-mono text-emerald-400">{money(signal.highestPrice)}</p></div>}
        {signal.lowestPrice !== undefined && <div><span className="text-slate-500 text-xs">Lowest Price</span><p className="font-mono text-rose-400">{money(signal.lowestPrice)}</p></div>}
        {signal.profitLockActive && <div className="col-span-2"><span className="inline-flex items-center gap-1.5 px-2 py-1 rounded bg-emerald-950/50 border border-emerald-500/30 text-emerald-400 text-xs font-bold">🔒 Profit Lock Active</span></div>}
      </div>
    </div>
  );
}

function IndicatorGrid({ market, signal }: { market: MarketData | undefined; signal?: Signal }) {
  if (!market) return null;
  const adxColor = market.adx > 25 ? "text-emerald-400" : market.adx > 20 ? "text-yellow-400" : "text-slate-500";
  const stochColor = market.stochK < 20 ? "text-emerald-400" : market.stochK > 80 ? "text-rose-400" : "text-slate-500";
  const crossDir = market.stochK > market.stochD ? "up" : "down";
  const crossColor = market.stochK > market.stochD ? "text-emerald-400" : "text-rose-400";
  return (
    <div className="space-y-2">
      <div className="grid grid-cols-5 gap-2">
        <div className="bg-slate-800/40 rounded-lg p-2 text-center"><p className="text-[10px] text-slate-500 uppercase tracking-wider mb-1">ADX</p><p className={`font-mono font-bold text-sm ${adxColor}`}>{market.adx.toFixed(1)}</p><p className="text-[10px] text-slate-600">{market.adx > 25 ? "STRONG" : market.adx > 20 ? "BUILDING" : "WEAK"}</p></div>
        <div className="bg-slate-800/40 rounded-lg p-2 text-center"><p className="text-[10px] text-slate-500 uppercase tracking-wider mb-1">RSI</p><p className="font-mono font-bold text-sm text-slate-300">{market.rsi?.toFixed(1) || "—"}</p></div>
        <div className="bg-slate-800/40 rounded-lg p-2 text-center"><p className="text-[10px] text-slate-500 uppercase tracking-wider mb-1">Stoch K</p><p className={`font-mono font-bold text-sm ${stochColor}`}>{market.stochK.toFixed(1)}</p><p className="text-[10px] text-slate-600">{market.stochK < 20 ? "OVERSOLD" : market.stochK > 80 ? "OVERBOUGHT" : "NEUTRAL"}</p></div>
        <div className="bg-slate-800/40 rounded-lg p-2 text-center"><p className="text-[10px] text-slate-500 uppercase tracking-wider mb-1">Stoch D</p><p className={`font-mono font-bold text-sm ${stochColor}`}>{market.stochD.toFixed(1)}</p></div>
        <div className="bg-slate-800/40 rounded-lg p-2 text-center"><p className="text-[10px] text-slate-500 uppercase tracking-wider mb-1">Cross</p><p className={`font-mono font-bold text-sm ${crossColor}`}>K {crossDir} D</p><p className="text-[10px] text-slate-600">{Math.abs(market.stochK - market.stochD).toFixed(1)} spread</p></div>
      </div>
      {market.stoch1hK !== undefined && (
        <div className="bg-blue-950/20 rounded-lg p-2 flex justify-between items-center text-xs border border-blue-500/20">
          <span className="text-blue-400 font-semibold">1H StochRSI (Entry TF):</span>
          <span className="font-mono text-slate-300">K{market.stoch1hK.toFixed(1)} D{market.stoch1hD?.toFixed(1) || "—"}</span>
        </div>
      )}
      {signal?.stoch1hK !== undefined && (
        <div className="bg-slate-800/30 rounded-lg p-2 flex justify-between items-center text-xs border border-slate-700/30">
          <span className="text-slate-500">Entry 1H StochRSI:</span>
          <span className="font-mono text-slate-300">K{signal.stoch1hK.toFixed(1)} D{signal.stoch1hD?.toFixed(1) || "—"}<span className="text-slate-600 ml-2">→ now 4H K{market.stochK.toFixed(1)}</span></span>
        </div>
      )}
    </div>
  );
}

function TrendDisplay({ market }: { market: MarketData | undefined }) {
  if (!market) return null;
  const trend1d = market.htfBias === "BULLISH" ? "LONG" : market.htfBias === "BEARISH" ? "SHORT" : "NEUTRAL";
  const trend1dClass = trend1d === "SHORT" ? "text-rose-400" : trend1d === "LONG" ? "text-emerald-400" : "text-yellow-400";
  return (
    <div className="grid grid-cols-2 gap-3">
      <div className="bg-slate-800/40 rounded-lg p-3"><p className="text-[10px] text-slate-500 uppercase tracking-wider mb-1">4H Trend</p><p className="text-sm font-bold text-slate-300">{market.trend || "—"}</p></div>
      <div className="bg-slate-800/40 rounded-lg p-3"><p className="text-[10px] text-slate-500 uppercase tracking-wider mb-1">1D Trend</p><p className={`text-sm font-bold ${trend1dClass}`}>{trend1d}</p><p className="text-[10px] text-slate-600 mt-0.5">HTF: {market.htfBias || "unknown"}</p></div>
    </div>
  );
}

function SignalCard({ signal, market }: { signal: Signal; market: MarketData | undefined }) {
  const meta = signal.meta;
  const confColor = signal.confidence >= 70 ? "text-emerald-400" : signal.confidence >= 50 ? "text-yellow-400" : "text-rose-400";
  const confBarColor = signal.confidence >= 70 ? "bg-emerald-500" : signal.confidence >= 50 ? "bg-yellow-500" : "bg-rose-500";
  const dirColor = signal.direction === "LONG" ? "text-emerald-400" : "text-rose-400";
  const pnlClass = meta.pnl >= 0 ? "text-2xl font-mono font-bold text-emerald-400" : "text-2xl font-mono font-bold text-rose-400";
  return (
    <div className="rounded-2xl border border-slate-700/50 bg-slate-900/60 p-5 space-y-4 backdrop-blur-sm">
      <div className="flex justify-between items-start">
        <div>
          <h2 className="text-2xl font-bold text-white tracking-tight">{signal.pair}</h2>
          <p className="text-slate-400 text-sm mt-0.5">Price: {money(market?.price)}</p>
        </div>
        <div className="flex flex-col items-end gap-2">
          <StatusBadge status={meta.status} direction={signal.direction} />
          <PhaseBadge phase={market?.phase || "NONE"} />
          {signal.tradeState && <StatusBadge status={signal.tradeState} />}
        </div>
      </div>
      <IndicatorGrid market={market} signal={signal} />
      <TrendDisplay market={market} />
      <TradeManagerPanel signal={signal} />
      <div>
        <div className="flex justify-between items-center mb-1.5">
          <span className="text-xs text-slate-500 uppercase tracking-wider">Confidence</span>
          <span className={`text-sm font-bold ${confColor}`}>{signal.confidence}%</span>
        </div>
        <div className="h-2 bg-slate-800 rounded-full overflow-hidden">
          <div className={`h-full rounded-full transition-all duration-500 ${confBarColor}`} style={{ width: `${signal.confidence}%` }} />
        </div>
      </div>
      <div className="bg-slate-800/40 rounded-lg p-3 space-y-2">
        <p className="text-[10px] text-slate-500 uppercase tracking-wider mb-1">Trade Setup</p>
        <div className="grid grid-cols-2 gap-x-4 gap-y-1.5 text-sm">
          <div className="flex justify-between"><span className="text-slate-400">Direction</span><span className={`font-bold ${dirColor}`}>{signal.direction}</span></div>
          <div className="flex justify-between"><span className="text-slate-400">Type</span><span className="font-mono text-slate-300">{signal.type}</span></div>
          <div className="flex justify-between"><span className="text-slate-400">Scale</span><span className="font-mono text-slate-300">{signal.scale || "—"}</span></div>
          <div className="flex justify-between"><span className="text-slate-400">Entry</span><span className="font-mono text-white font-semibold">{money(signal.entry)}</span></div>
          <div className="flex justify-between"><span className="text-slate-400">Stop</span><span className="font-mono text-rose-400 font-semibold">{money(signal.stop)}</span></div>
          <div className="flex justify-between"><span className="text-slate-400">Target</span><span className="font-mono text-emerald-400 font-semibold">{money(signal.target)}</span></div>
          <div className="flex justify-between"><span className="text-slate-400">R:R</span><span className="font-mono text-yellow-400 font-bold">{signal.rr?.toFixed(2) || "—"}</span></div>
          <div className="flex justify-between"><span className="text-slate-400">Expected</span><span className="font-mono text-cyan-400 font-bold">{signal.expectedMove?.toFixed(1) || "—"}%</span></div>
        </div>
      </div>
      <div className="bg-slate-800/40 rounded-lg p-3">
        <p className="text-[10px] text-slate-500 uppercase tracking-wider mb-1.5">Reason</p>
        <p className="text-xs text-slate-300 leading-relaxed font-mono">{signal.reason || "No reason provided."}</p>
      </div>
      {meta.status === "ACTIVE" && <div className={pnlClass}>{formatPercent(meta.pnl)}</div>}
      <div className="flex gap-2 text-[10px]">
        <span className="px-2 py-1 rounded bg-slate-800 text-slate-400">{timeAgo(signal.timestamp)} old</span>
        <span className="px-2 py-1 rounded bg-slate-800 text-slate-400">v{signal.version}</span>
      </div>
    </div>
  );
}

function WaitingCard({ pair, market }: { pair: string; market: MarketData | undefined }) {
  const phase = market?.phase || "NONE";
  return (
    <div className="rounded-2xl border border-slate-700/50 bg-slate-900/40 p-5 space-y-4 backdrop-blur-sm">
      <div className="flex justify-between items-start">
        <div>
          <h2 className="text-2xl font-bold text-slate-300 tracking-tight">{pair}</h2>
          <p className="text-slate-500 text-sm mt-0.5">Price: {money(market?.price)}</p>
        </div>
        <PhaseBadge phase={phase} />
      </div>
      <IndicatorGrid market={market} />
      <TrendDisplay market={market} />
      {phase === "NONE" && (
        <div className="bg-slate-800/40 rounded-lg p-3">
          <p className="text-[10px] text-slate-500 uppercase tracking-wider mb-1">No Setup</p>
          <p className="text-xs text-slate-400">No clear HTF trend alignment. Price may be ranging or indecisive. HTF bias: {market?.htfBias || "unknown"}.</p>
        </div>
      )}
      {phase === "WATCHING" && (
        <div className="bg-yellow-950/20 border border-yellow-500/20 rounded-lg p-3">
          <p className="text-[10px] text-yellow-400 font-bold uppercase tracking-wider mb-1">Watching</p>
          <p className="text-xs text-slate-400">1D trend aligned. Waiting for 1H StochRSI cross entry. ADX: {market?.adx?.toFixed(1) || "—"}.</p>
        </div>
      )}
      {phase === "READY" && (
        <div className="bg-cyan-950/20 border border-cyan-500/20 rounded-lg p-3">
          <p className="text-[10px] text-cyan-400 font-bold uppercase tracking-wider mb-1">Ready</p>
          <p className="text-xs text-slate-400">HTF trend confirmed. StochRSI approaching crossover zone. Monitoring for entry.</p>
        </div>
      )}
    </div>
  );
}

export default function Dashboard() {
  const [signals, setSignals] = useState<Record<string, Signal | null>>({});
  const [marketData, setMarketData] = useState<Record<string, MarketData>>({});
  const [loading, setLoading] = useState(true);
  const [fetchCount, setFetchCount] = useState(0);
  const [lastFetch, setLastFetch] = useState<number>(0);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    async function load() {
      try {
        setError(null);
        const res = await fetch("/api/signals", { cache: "no-store" });
        if (!res.ok) throw new Error(`HTTP ${res.status}`);
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
      } catch (e: any) {
        console.error(e);
        setError(e.message);
      } finally {
        setLoading(false);
      }
    }
    load();
    const i = setInterval(load, 30000);
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
          <p className="text-slate-500 text-sm mt-1">1H Entry + HTF Filter + Per-Asset Stops + Trade Manager</p>
          <p className="text-slate-600 text-xs">Fetches: {fetchCount} | Last: {lastFetch ? new Date(lastFetch).toLocaleTimeString() : "—"}{error && <span className="text-red-400 ml-2">Error: {error}</span>}</p>
        </div>
      </div>
      <div className="grid md:grid-cols-2 gap-6">
        {PAIRS.map((pair) => {
          const signal = signals[pair];
          const mkt = marketData[pair];
          return signal ? <SignalCard key={pair} signal={signal} market={mkt} /> : <WaitingCard key={pair} pair={pair} market={mkt} />;
        })}
      </div>
    </div>
  );
}
