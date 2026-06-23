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
  distToTrendline?: number;
  ema8?: number;
  ema21?: number;
}

const PAIRS = ["BTC", "ETH", "SOL"];

const money = (n?: number) =>
  typeof n === "number" && isFinite(n)
    ? new Intl.NumberFormat("en-US", {
        style: "currency",
        currency: "USD",
        maximumFractionDigits: n >= 1000 ? 0 : 2,
      }).format(n)
    : "—";

const KRAKEN_PAIRS: Record<string, string> = {
  BTC: "XBTUSD",
  ETH: "ETHUSD",
  SOL: "SOLUSD",
};

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

function formatTtl(ageMinutes: number, maxAgeMinutes: number): string {
  const remaining = Math.max(0, maxAgeMinutes - ageMinutes);
  if (remaining >= 60) return `${Math.floor(remaining / 60)}h ${remaining % 60}m`;
  return `${remaining}m`;
}

function timeAgo(ts: number): string {
  const mins = Math.floor((Date.now() - ts) / 60000);
  if (mins < 1) return "now";
  if (mins < 60) return `${mins}m`;
  const hrs = Math.floor(mins / 60);
  if (hrs < 24) return `${hrs}h ${mins % 60}m`;
  return `${Math.floor(hrs / 24)}d`;
}

function getSignalStatus(signal: Signal, currentPrice: number): {
  status: "ACTIVE" | "TP_HIT" | "SL_HIT" | "EXPIRED" | "MISSED";
  pnl: number;
  ageMinutes: number;
  ttlRemaining: string;
} {
  const ageMinutes = Math.floor((Date.now() - signal.timestamp) / 60000);
  const maxAge = signal.type === "ACCUMULATE" ? 24 * 60 : 4 * 60;

  // TP / SL
  if (signal.direction === "LONG") {
    if (currentPrice >= signal.target) return { status: "TP_HIT", pnl: 0, ageMinutes, ttlRemaining: "0m" };
    if (currentPrice <= signal.stop) return { status: "SL_HIT", pnl: 0, ageMinutes, ttlRemaining: "0m" };
  } else {
    if (currentPrice <= signal.target) return { status: "TP_HIT", pnl: 0, ageMinutes, ttlRemaining: "0m" };
    if (currentPrice >= signal.stop) return { status: "SL_HIT", pnl: 0, ageMinutes, ttlRemaining: "0m" };
  }

  // Expired
  if (ageMinutes > maxAge) return { status: "EXPIRED", pnl: 0, ageMinutes, ttlRemaining: "0m" };

  // Missed entry (price moved past entry zone)
  const buffer = signal.type === "ACCUMULATE" ? 0.02 : 0.005;
  if (signal.direction === "LONG" && currentPrice > signal.entry * (1 + buffer)) {
    return { status: "MISSED", pnl: 0, ageMinutes, ttlRemaining: formatTtl(ageMinutes, maxAge) };
  }
  if (signal.direction === "SHORT" && currentPrice < signal.entry * (1 - buffer)) {
    return { status: "MISSED", pnl: 0, ageMinutes, ttlRemaining: formatTtl(ageMinutes, maxAge) };
  }

  // Active — calculate P&L
  const pnl = signal.direction === "LONG"
    ? ((currentPrice - signal.entry) / signal.entry) * 100
    : ((signal.entry - currentPrice) / signal.entry) * 100;

  return { status: "ACTIVE", pnl, ageMinutes, ttlRemaining: formatTtl(ageMinutes, maxAge) };
}

function Badge({ children, color }: { children: React.ReactNode; color: string }) {
  const colors: Record<string, string> = {
    green: "bg-emerald-500/20 text-emerald-400 border-emerald-500/30",
    red: "bg-rose-500/20 text-rose-400 border-rose-500/30",
    purple: "bg-purple-500/20 text-purple-300 border-purple-500/30",
    blue: "bg-blue-500/20 text-blue-300 border-blue-500/30",
    yellow: "bg-yellow-500/20 text-yellow-300 border-yellow-500/30",
    gray: "bg-slate-600/20 text-slate-400 border-slate-600/30",
  };
  return (
    <span className={`px-2 py-0.5 rounded text-xs font-bold border ${colors[color] || colors.gray}`}>
      {children}
    </span>
  );
}

function LiveBadge() {
  return <span className="w-1.5 h-1.5 rounded-full bg-emerald-500 animate-pulse inline-block ml-1" />;
}

// ─── Signal Card ─────────────────────────────────────────────────────

function SignalCard({ signal, market, livePrice }: {
  signal: Signal;
  market: MarketData | undefined;
  livePrice: number | undefined;
}) {
  const currentPrice = livePrice ?? market?.price ?? 0;
  const meta = getSignalStatus(signal, currentPrice);

  const dirColor = signal.direction === "LONG" ? "green" : "red";
  const confColor = signal.confidence >= 70 ? "green" : signal.confidence >= 50 ? "yellow" : "red";
  const ttlColor = meta.ttlRemaining.includes("0m") ? "red" : meta.ttlRemaining.includes("h") ? "gray" : "yellow";

  return (
    <div className="rounded-lg border border-slate-700 bg-slate-900/80 p-4 space-y-3">
      {/* Header */}
      <div className="flex justify-between items-start">
        <div>
          <div className="flex items-center gap-2">
            <span className="text-lg font-bold text-white">{signal.pair}/USD</span>
            {livePrice && <LiveBadge />}
          </div>
          <div className="text-2xl font-mono text-white mt-1">{money(currentPrice)}</div>
        </div>
        <div className="flex flex-col items-end gap-1">
          <Badge color={dirColor}>{signal.direction}</Badge>
          <Badge color="purple">{signal.scale || "SIGNAL"}</Badge>
        </div>
      </div>

      {/* Meta badges */}
      <div className="flex flex-wrap gap-2">
        <Badge color={confColor}>CONFIDENCE {signal.confidence}%</Badge>
        <Badge color={ttlColor}>TTL {meta.ttlRemaining}</Badge>
        <Badge color="gray">{timeAgo(signal.timestamp)} old</Badge>
      </div>

      {/* P&L */}
      {meta.status === "ACTIVE" && (
        <div className={`text-2xl font-mono font-bold ${meta.pnl >= 0 ? "text-emerald-400" : "text-rose-400"}`}>
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

      {/* Prices */}
      <div className="grid grid-cols-3 gap-3 text-sm">
        <div>
          <div className="text-slate-500 text-xs">Entry</div>
          <div className="font-mono text-white">{money(signal.entry)}</div>
        </div>
        <div>
          <div className="text-slate-500 text-xs">Stop</div>
          <div className="font-mono text-rose-400">{money(signal.stop)}</div>
        </div>
        <div>
          <div className="text-slate-500 text-xs">Target</div>
          <div className="font-mono text-emerald-400">{money(signal.target)}</div>
        </div>
      </div>

      {/* RR & Expected */}
      <div className="flex justify-between text-sm text-slate-400">
        <span>R:R <span className="font-mono text-yellow-400">{signal.rr.toFixed(2)}</span></span>
        <span>Expected <span className="font-mono text-slate-300">{signal.expectedMove.toFixed(2)}%</span></span>
      </div>

      {/* Why */}
      {signal.reason && (
        <div className="text-xs text-slate-500 border-t border-slate-700/50 pt-2 leading-relaxed">
          {signal.reason}
        </div>
      )}

      {/* Market context */}
      {market && (
        <div className="text-xs space-y-1 text-slate-500 border-t border-slate-700/50 pt-2">
          <div className="flex justify-between">
            <span>Trend</span>
            <span className={market.trend?.includes("STRONG") ? "text-emerald-400" : market.trend?.includes("MEDIUM") ? "text-yellow-400" : "text-slate-400"}>
              {market.trend || "—"}
            </span>
          </div>
          {market.distToTrendline !== undefined && (
            <div className="flex justify-between">
              <span>Trendline</span>
              <span className={Math.abs(market.distToTrendline) < 1.2 ? "text-emerald-400" : Math.abs(market.distToTrendline) < 3 ? "text-yellow-400" : "text-slate-400"}>
                {money(market.trendlinePrice)} ({market.distToTrendline > 0 ? "+" : ""}{market.distToTrendline.toFixed(2)}%)
              </span>
            </div>
          )}
          <div className="flex justify-between">
            <span>Stoch K/D</span>
            <span>{market.stochK?.toFixed(1)} / {market.stochD?.toFixed(1)}</span>
          </div>
          <div className="flex justify-between">
            <span>ADX</span>
            <span className={market.adx > 25 ? "text-emerald-400" : market.adx > 20 ? "text-yellow-400" : "text-slate-400"}>
              {market.adx?.toFixed(1)}
            </span>
          </div>
        </div>
      )}
    </div>
  );
}

// ─── Waiting Card ──────────────────────────────────────────────────────

function WaitingCard({ pair, market, livePrice }: {
  pair: string;
  market: MarketData | undefined;
  livePrice: number | undefined;
}) {
  const currentPrice = livePrice ?? market?.price ?? 0;

  return (
    <div className="rounded-lg border border-slate-700 bg-slate-900/50 p-4 space-y-3">
      <div className="flex justify-between items-start">
        <div>
          <div className="flex items-center gap-2">
            <span className="text-lg font-bold text-slate-300">{pair}/USD</span>
            {livePrice && <LiveBadge />}
          </div>
          <div className="text-2xl font-mono text-slate-300 mt-1">{money(currentPrice)}</div>
        </div>
        <Badge color="gray">NO SIGNAL</Badge>
      </div>

      <div className="text-sm text-slate-500">
        Waiting for setup...
      </div>

      {market && (
        <div className="text-xs space-y-1 text-slate-500">
          <div className="flex justify-between">
            <span>Trend</span>
            <span className={market.trend?.includes("STRONG") ? "text-emerald-400" : market.trend?.includes("MEDIUM") ? "text-yellow-400" : "text-slate-400"}>
              {market.trend || "—"}
            </span>
          </div>
          {market.distToTrendline !== undefined && (
            <div className="flex justify-between">
              <span>Trendline</span>
              <span className={Math.abs(market.distToTrendline) < 1.2 ? "text-emerald-400" : Math.abs(market.distToTrendline) < 3 ? "text-yellow-400" : "text-slate-400"}>
                {market.distToTrendline > 0 ? "+" : ""}{market.distToTrendline.toFixed(2)}%
                {Math.abs(market.distToTrendline) < 1.2 ? " ✓ near" : Math.abs(market.distToTrendline) < 3 ? " ○ approaching" : " ✗ far"}
              </span>
            </div>
          )}
          <div className="flex justify-between">
            <span>Stoch K/D</span>
            <span>
              {market.stochK?.toFixed(1) ?? "—"} / {market.stochD?.toFixed(1) ?? "—"}
              {market.stochK !== undefined && market.stochD !== undefined && (
                market.stochK < 20 ? " (oversold)" :
                market.stochK > 80 ? " (overbought)" :
                market.stochK > market.stochD ? " ↑" :
                market.stochK < market.stochD ? " ↓" :
                ""
              )}
            </span>
          </div>
          <div className="flex justify-between">
            <span>ADX</span>
            <span className={market.adx > 25 ? "text-emerald-400" : market.adx > 20 ? "text-yellow-400" : "text-slate-400"}>
              {market.adx?.toFixed(1) ?? "—"}
              {market.adx > 25 ? " strong" : market.adx > 20 ? " moderate" : " weak"}
            </span>
          </div>
          {market.ema8 !== undefined && market.ema21 !== undefined && (
            <div className="flex justify-between">
              <span>EMA 8/21</span>
              <span className={
                market.price > market.ema8 && market.price > market.ema21 ? "text-emerald-400" :
                market.price < market.ema8 && market.price < market.ema21 ? "text-rose-400" :
                "text-yellow-400"
              }>
                {market.price > market.ema8 && market.price > market.ema21 ? "above both" :
                 market.price < market.ema8 && market.price < market.ema21 ? "below both" :
                 "mixed"}
              </span>
            </div>
          )}
        </div>
      )}
    </div>
  );
}

// ─── Main Dashboard ────────────────────────────────────────────────────

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
    <div className="min-h-screen bg-slate-950 text-white p-6">
      <div className="max-w-6xl mx-auto">
        <div className="flex justify-between items-center mb-6">
          <h1 className="text-2xl font-bold">CX Switch v28</h1>
          <div className="text-xs text-slate-500">
            Fetches: {fetchCount} | Last: {lastFetch ? new Date(lastFetch).toLocaleTimeString() : "—"}
          </div>
        </div>

        <div className="grid md:grid-cols-3 gap-4">
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
    </div>
  );
}
