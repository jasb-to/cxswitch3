"use client";

import { useEffect, useState } from "react";

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
}

interface UIAlertData {
  type: "SHORT_ALERT_OVERSOLD_CROSS" | "LONG_ALERT_OVERBOUGHT_CROSS";
  message: string;
  stochK: number;
  stochD: number;
  timestamp: number;
  pair: string;
}

const PAIRS = ["BTC", "ETH", "SOL", "HYPE"];

const KRAKEN_PAIRS: Record<string, string> = {
  BTC: "XBTUSD",
  ETH: "ETHUSD",
  SOL: "SOLUSD",
  HYPE: "HYPEUSD",
};

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
    if (currentPrice >= signal.target) return { status: "TP_HIT", pnl: 0, ageMinutes, ttlRemaining: "0m" };
    if (currentPrice <= signal.stop) return { status: "SL_HIT", pnl: 0, ageMinutes, ttlRemaining: "0m" };
  } else {
    if (currentPrice <= signal.target) return { status: "TP_HIT", pnl: 0, ageMinutes, ttlRemaining: "0m" };
    if (currentPrice >= signal.stop) return { status: "SL_HIT", pnl: 0, ageMinutes, ttlRemaining: "0m" };
  }

  if (ageMinutes > maxAge) return { status: "EXPIRED", pnl: 0, ageMinutes, ttlRemaining: "0m" };

  const buffer = signal.type === "ACCUMULATE" ? 0.02 : 0.005;
  if (signal.direction === "LONG" && currentPrice > signal.entry * (1 + buffer)) {
    return { status: "MISSED", pnl: 0, ageMinutes, ttlRemaining: `${Math.max(0, maxAge - ageMinutes)}m` };
  }
  if (signal.direction === "SHORT" && currentPrice < signal.entry * (1 - buffer)) {
    return { status: "MISSED", pnl: 0, ageMinutes, ttlRemaining: `${Math.max(0, maxAge - ageMinutes)}m` };
  }

  const pnl = signal.direction === "LONG"
    ? ((currentPrice - signal.entry) / signal.entry) * 100
    : ((signal.entry - currentPrice) / signal.entry) * 100;

  return { status: "ACTIVE", pnl, ageMinutes, ttlRemaining: `${Math.max(0, maxAge - ageMinutes)}m` };
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

function SignalCard({ signal, market, livePrice }: {
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
        <span className="px-2 py-1 rounded bg-slate-800 text-slate-400">
          TTL {meta.ttlRemaining}
        </span>
        <span className="px-2 py-1 rounded bg-slate-800 text-slate-400">
          {timeAgo(signal.timestamp)} old
        </span>
      </div>

      {market && (
        <div className="text-sm space-y-2 text-slate-500 border-t border-slate-700/50 pt-4">
          <div className="flex justify-between items-center">
            <span className="text-slate-400">Trendline</span>
            <span className={
              typeof market.distToTrendline === "number" && Math.abs(market.distToTrendline) < 1.2 ? "text-emerald-400" : 
              typeof market.distToTrendline === "number" && Math.abs(market.distToTrendline) < 3 ? "text-yellow-400" : "text-slate-400"
            }>
              {money(market.trendlinePrice)} <span className="text-slate-500">({formatDist(market.distToTrendline)})</span>
            </span>
          </div>

          <div className="flex justify-between items-center">
            <span className="text-slate-400">Stoch K/D</span>
            <span className="font-mono">{market.stochK?.toFixed(1)} / {market.stochD?.toFixed(1)}</span>
          </div>

          <div className="flex justify-between items-center">
            <span className="text-slate-400">ADX</span>
            <span className={
              market.adx > 25 ? "text-emerald-400" : market.adx > 20 ? "text-yellow-400" : "text-slate-400"
            }>
              {market.adx?.toFixed(1)}
            </span>
          </div>
        </div>
      )}
    </div>
  );
}

function WaitingCard({ pair, market, livePrice }: {
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

      {market && (
        <div className="text-sm space-y-2 text-slate-600 border-t border-slate-800/50 pt-4">
          <div className="flex justify-between items-center">
            <span className="text-slate-500">Trendline</span>
            <span className={
              typeof market.distToTrendline === "number" && Math.abs(market.distToTrendline) < 1.2 ? "text-emerald-400/60" : 
              typeof market.distToTrendline === "number" && Math.abs(market.distToTrendline) < 3 ? "text-yellow-400/60" : "text-slate-500"
            }>
              {formatDist(market.distToTrendline)}
            </span>
          </div>

          <div className="flex justify-between items-center">
            <span className="text-slate-500">Stoch K/D</span>
            <span className="font-mono">{market.stochK?.toFixed(1) ?? "—"} / {market.stochD?.toFixed(1) ?? "—"}</span>
          </div>

          <div className="flex justify-between items-center">
            <span className="text-slate-500">ADX</span>
            <span className={
              market.adx > 25 ? "text-emerald-400/60" : market.adx > 20 ? "text-yellow-400/60" : "text-slate-500"
            }>
              {market.adx?.toFixed(1) ?? "—"}
            </span>
          </div>
        </div>
      )}
    </div>
  );
}

export default function Dashboard() {
  const [signals, setSignals] = useState<Record<string, Signal | null>>({});
  const [marketData, setMarketData] = useState<Record<string, MarketData>>({});
  const [livePrices, setLivePrices] = useState<Record<string, number>>({});
  const [uiAlerts, setUIAlerts] = useState<UIAlertData[]>([]);
  const [loading, setLoading] = useState(true);
  const [fetchCount, setFetchCount] = useState(0);
  const [lastFetch, setLastFetch] = useState<number>(0);

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
          <p className="text-slate-500 text-sm mt-1">
            Fetches: {fetchCount} | Last: {lastFetch ? new Date(lastFetch).toLocaleTimeString() : "—"}
          </p>
        </div>
      </div>

      {uiAlerts.length > 0 && (
        <div className="space-y-2">
          {uiAlerts.map((alert, i) => (
            <UIAlertBanner key={`${alert.pair}-${alert.type}-${i}`} alert={alert} />
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
