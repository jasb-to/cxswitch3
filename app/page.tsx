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
  adx?: number;
  rsi?: number;
  stochK?: number;
  stochD?: number;
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

function timeAgo(ts: number): string {
  const mins = Math.floor((Date.now() - ts) / 60000);
  if (mins < 1) return "just now";
  if (mins < 60) return `${mins}m ago`;
  const hrs = Math.floor(mins / 60);
  if (hrs < 24) return `${hrs}h ${mins % 60}m ago`;
  return `${Math.floor(hrs / 24)}d ago`;
}

// ─── FIXED: getSignalStatus ─────────────────────────────────────────────

function getSignalStatus(signal: Signal, currentPrice: number): { 
  status: string; 
  actionable: boolean; 
  ageMinutes: number;
  ttlMinutesRemaining: number;
} {
  const ageMinutes = Math.floor((Date.now() - signal.timestamp) / 60000);
  const maxAge = signal.type === "ACCUMULATE" ? 24 * 60 : 4 * 60;
  const ttlMinutesRemaining = Math.max(0, maxAge - ageMinutes);
  
  // TP / SL checks first
  if (signal.direction === "LONG") {
    if (currentPrice >= signal.target) return { status: "TP_HIT", actionable: false, ageMinutes, ttlMinutesRemaining: 0 };
    if (currentPrice <= signal.stop) return { status: "SL_HIT", actionable: false, ageMinutes, ttlMinutesRemaining: 0 };
  } else {
    if (currentPrice <= signal.target) return { status: "TP_HIT", actionable: false, ageMinutes, ttlMinutesRemaining: 0 };
    if (currentPrice >= signal.stop) return { status: "SL_HIT", actionable: false, ageMinutes, ttlMinutesRemaining: 0 };
  }
  
  // TTL expiry
  if (ageMinutes > maxAge) return { status: "EXPIRED", actionable: false, ageMinutes, ttlMinutesRemaining: 0 };
  
  // ─── FIXED: Entry buffer logic ─────────────────────────────────────
  // For LONG: "missed" means price ran ABOVE entry without us (chasing)
  // For SHORT: "missed" means price ran BELOW entry without us (chasing)
  // Buffer: 0.5% for breakout, 2% for accumulate
  
  const buffer = signal.type === "ACCUMULATE" ? 0.02 : 0.005;
  
  if (signal.direction === "LONG") {
    // Price moved up past entry + buffer = we missed the long entry
    if (currentPrice > signal.entry * (1 + buffer)) {
      return { status: "MISSED", actionable: false, ageMinutes, ttlMinutesRemaining };
    }
  } else {
    // Price moved down past entry - buffer = we missed the short entry
    if (currentPrice < signal.entry * (1 - buffer)) {
      return { status: "MISSED", actionable: false, ageMinutes, ttlMinutesRemaining };
    }
  }
  
  // Active signal
  const actionable = signal.confidence >= 50 && ttlMinutesRemaining > 0;
  return { status: "ACTIVE", actionable, ageMinutes, ttlMinutesRemaining };
}

function scaleBadgeClass(scale: string | null): string {
  switch (scale) {
    case "ENTRY_1": return "bg-blue-500/20 text-blue-300 border-blue-500/30";
    case "ENTRY_2": return "bg-indigo-500/20 text-indigo-300 border-indigo-500/30";
    case "ADD": return "bg-purple-500/20 text-purple-300 border-purple-500/30";
    default: return "bg-gray-500/20 text-gray-300";
  }
}

function scaleName(scale: string | null): string {
  switch (scale) {
    case "ENTRY_1": return "ENTRY 1";
    case "ENTRY_2": return "ENTRY 2";
    case "ADD": return "ADD";
    default: return scale || "NONE";
  }
}

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
      <div className="min-h-screen bg-gray-900 text-white flex items-center justify-center">
        <div className="text-lg">Loading CX Switch v28...</div>
      </div>
    );
  }

  return (
    <div className="min-h-screen bg-gray-900 text-white p-6">
      <div className="max-w-6xl mx-auto">
        <div className="flex justify-between items-center mb-6">
          <h1 className="text-2xl font-bold">CX Switch v28</h1>
          <div className="text-xs text-gray-400">
            Fetches: {fetchCount} | Last:{" "}
            {lastFetch ? new Date(lastFetch).toLocaleTimeString() : "—"}
          </div>
        </div>

        <div className="grid md:grid-cols-3 gap-6">
          {PAIRS.map((pair) => {
            const signal = signals[pair];
            const mkt = marketData[pair];
            const livePrice = livePrices[pair];
            const currentPrice = livePrice ?? mkt?.price ?? 0;
            const hasSignal = !!signal;
            
            const meta = hasSignal ? getSignalStatus(signal, currentPrice) : null;
            const status = meta?.status || "WAITING";

            let borderClass = "border-gray-700 bg-gray-800";
            let bannerText = "";
            let bannerClass = "";
            let statusBadge = "";

            if (hasSignal && meta) {
              if (status === "TP_HIT") {
                borderClass = "border-purple-500 bg-purple-900/10";
                bannerText = "🎯 TARGET HIT — CLOSED";
                bannerClass = "bg-purple-500 text-white";
                statusBadge = "TP HIT";
              } else if (status === "SL_HIT") {
                borderClass = "border-red-500 bg-red-900/10";
                bannerText = "🛑 STOP HIT — CLOSED";
                bannerClass = "bg-red-500 text-white";
                statusBadge = "SL HIT";
              } else if (status === "EXPIRED") {
                borderClass = "border-gray-600 bg-gray-800/50";
                bannerText = "⏰ EXPIRED — Signal too old";
                bannerClass = "bg-gray-600 text-white";
                statusBadge = "EXPIRED";
              } else if (status === "MISSED") {
                borderClass = "border-yellow-600 bg-yellow-900/10";
                bannerText = "⚠️ MISSED — Price moved past entry zone";
                bannerClass = "bg-yellow-600 text-white";
                statusBadge = "MISSED";
              } else if (status === "ACTIVE") {
                borderClass =
                  signal.direction === "LONG"
                    ? "border-green-500 bg-green-900/10"
                    : "border-red-500 bg-red-900/10";
                
                // ─── FIXED: Removed "STALE" override ───────────────────
                // Signal stays ACTIVE until TP, SL, or true TTL expiry.
                // Show TTL remaining instead of "STALE" guilt trip.
                
                if (!meta.actionable) {
                  bannerText = `⚠️ Low confidence (${signal.confidence}%). Skip or reduce size.`;
                  bannerClass = "bg-yellow-500 text-black";
                  statusBadge = "LOW CONF";
                } else {
                  statusBadge = "ACTIVE";
                }
              }
            } else {
              if (mkt) {
                const trendDir = mkt.trend?.split(" ")[0];
                const trendHealth = mkt.trend?.split(" ")[1];
                if (trendHealth === "STRONG") {
                  bannerText = `⏳ ${trendDir} STRONG — Watching for setup`;
                  bannerClass = "bg-blue-600/50 text-blue-200";
                } else if (trendHealth === "MEDIUM") {
                  bannerText = `⏳ ${trendDir} MEDIUM — Watching for setup`;
                  bannerClass = "bg-yellow-600/30 text-yellow-200";
                } else {
                  bannerText = "⏳ No trend — Waiting";
                  bannerClass = "bg-gray-600/50 text-gray-300";
                }
              } else {
                bannerText = "⏳ Loading market data...";
                bannerClass = "bg-gray-600/50 text-gray-300";
              }
              statusBadge = "WAITING";
            }

            const entry = signal?.entry ?? 0;
            const stop = signal?.stop ?? 0;
            const target = signal?.target ?? 0;

            const progress =
              hasSignal && status === "ACTIVE" && entry && target && stop
                ? signal.direction === "LONG"
                  ? Math.max(0, Math.min(100, ((currentPrice - entry) / (target - entry)) * 100))
                  : Math.max(0, Math.min(100, ((entry - currentPrice) / (entry - target)) * 100))
                : 0;

            const unrealizedPnL =
              hasSignal && status === "ACTIVE" && currentPrice && entry
                ? signal.direction === "LONG"
                  ? ((currentPrice - entry) / entry) * 100
                  : ((entry - currentPrice) / entry) * 100
                : 0;

            const scaleProgress = signal?.scale
              ? signal.scale === "ENTRY_1"
                ? 33
                : signal.scale === "ENTRY_2"
                ? 66
                : signal.scale === "ADD"
                ? 100
                : 0
              : 0;

            return (
              <div
                key={pair}
                className={`rounded-lg p-5 border-2 transition-all ${borderClass}`}
              >
                {bannerText && (
                  <div className={`mb-3 py-2 px-3 rounded text-center font-bold text-sm ${bannerClass}`}>
                    {bannerText}
                  </div>
                )}

                <div className="flex justify-between items-start mb-4">
                  <div>
                    <div className="font-bold text-lg">{pair}/USD</div>
                    <div className="flex items-center gap-2">
                      <div className="text-2xl font-mono">{money(currentPrice)}</div>
                      {livePrice && (
                        <span className="text-xs bg-green-600/50 text-green-300 px-1.5 py-0.5 rounded">LIVE</span>
                      )}
                    </div>
                  </div>
                  <div className="flex flex-col items-end gap-1">
                    {hasSignal ? (
                      <>
                        <span className={`px-2 py-1 rounded text-xs font-bold border ${scaleBadgeClass(signal.scale)}`}>
                          {scaleName(signal.scale)}
                        </span>
                        <span className={`text-xs font-bold ${signal.direction === "LONG" ? "text-green-400" : "text-red-400"}`}>
                          {signal.direction}
                        </span>
                        <span className={`text-[10px] px-1.5 py-0.5 rounded font-bold ${
                          statusBadge === "ACTIVE" ? "bg-green-500/30 text-green-300" :
                          statusBadge === "TP HIT" ? "bg-purple-500/30 text-purple-300" :
                          statusBadge === "SL HIT" ? "bg-red-500/30 text-red-300" :
                          statusBadge === "EXPIRED" ? "bg-gray-500/30 text-gray-300" :
                          statusBadge === "MISSED" ? "bg-yellow-500/30 text-yellow-300" :
                          statusBadge === "LOW CONF" ? "bg-yellow-500/30 text-yellow-300" :
                          "bg-blue-500/30 text-blue-300"
                        }`}>
                          {statusBadge}
                        </span>
                      </>
                    ) : (
                      <span className="px-2 py-1 rounded text-xs bg-gray-600 text-gray-300">NO SIGNAL</span>
                    )}
                  </div>
                </div>

                {/* Market Context */}
                {mkt && (
                  <div className="mb-3 p-2 rounded border bg-gray-800/50 border-gray-600/50">
                    <div className="flex justify-between items-center">
                      <span className="text-gray-400">1D Trend:</span>
                      <span className={`font-bold ${
                        mkt.trend?.includes("STRONG") ? "text-green-400" :
                        mkt.trend?.includes("MEDIUM") ? "text-yellow-400" :
                        "text-gray-400"
                      }`}>
                        {mkt.trend || "NONE"}
                      </span>
                    </div>
                    
                    {mkt.trendlinePrice !== undefined && (
                      <div className="flex justify-between mt-1 text-xs">
                        <span className="text-gray-500">Trendline</span>
                        <span className="text-gray-400 font-mono">
                          {money(mkt.trendlinePrice)}
                          {mkt.distToTrendline !== undefined && (
                            <span className={`ml-1 ${
                              Math.abs(mkt.distToTrendline) < 1.2 ? "text-green-400" :
                              Math.abs(mkt.distToTrendline) < 3 ? "text-yellow-400" :
                              "text-red-400"
                            }`}>
                              ({mkt.distToTrendline > 0 ? "+" : ""}{mkt.distToTrendline?.toFixed(2)}%)
                            </span>
                          )}
                        </span>
                      </div>
                    )}
                    
                    {mkt.ema8 !== undefined && mkt.ema21 !== undefined && (
                      <div className="flex justify-between text-xs">
                        <span className="text-gray-500">EMA 8/21</span>
                        <span className={`font-mono ${
                          mkt.price > mkt.ema8 && mkt.price > mkt.ema21 ? "text-green-400" :
                          mkt.price < mkt.ema8 && mkt.price < mkt.ema21 ? "text-red-400" :
                          "text-yellow-400"
                        }`}>
                          {money(mkt.ema8)} / {money(mkt.ema21)}
                        </span>
                      </div>
                    )}
                    
                    <div className="flex justify-between mt-1 text-xs">
                      <span className="text-gray-500">ADX: {mkt.adx?.toFixed(1)}</span>
                      <span className="text-gray-500">RSI: {mkt.rsi?.toFixed(1)}</span>
                    </div>
                    <div className="flex justify-between text-xs">
                      <span className="text-gray-500">Stoch K: {mkt.stochK?.toFixed(1)}</span>
                      <span className="text-gray-500">D: {mkt.stochD?.toFixed(1)}</span>
                    </div>
                  </div>
                )}

                {/* Active Signal Details */}
                {hasSignal && status === "ACTIVE" && (
                  <>
                    {signal.scale && (
                      <div className="mb-3">
                        <div className="flex justify-between text-xs text-gray-400 mb-1">
                          <span>Position Build</span>
                          <span className="text-purple-400">{signal.scale}</span>
                        </div>
                        <div className="h-2 bg-gray-700 rounded-full overflow-hidden">
                          <div className="h-full rounded-full bg-purple-500 transition-all" style={{ width: `${scaleProgress}%` }} />
                        </div>
                        <div className="flex justify-between text-[10px] text-gray-500 mt-1">
                          <span>ENTRY 1</span>
                          <span>ENTRY 2</span>
                          <span>ADD</span>
                        </div>
                      </div>
                    )}

                    <div className="mb-3">
                      <div className="flex justify-between text-xs text-gray-400 mb-1">
                        <span>Entry</span>
                        <span className={unrealizedPnL > 0 ? "text-green-400" : unrealizedPnL < 0 ? "text-red-400" : "text-gray-400"}>
                          {unrealizedPnL > 0 ? "+" : ""}{unrealizedPnL.toFixed(2)}%
                        </span>
                        <span>Target</span>
                      </div>
                      <div className="h-2 bg-gray-700 rounded-full overflow-hidden">
                        <div className={`h-full rounded-full transition-all ${unrealizedPnL >= 0 ? "bg-green-500" : "bg-red-500"}`} style={{ width: `${progress}%` }} />
                      </div>
                      <div className="flex justify-between text-[10px] text-gray-500 mt-1">
                        <span>{money(entry)}</span>
                        <span>{money(target)}</span>
                      </div>
                    </div>

                    {/* ─── NEW: TTL remaining indicator ─────────────────── */}
                    {meta && meta.ttlMinutesRemaining > 0 && (
                      <div className="mb-3 flex justify-between items-center text-xs">
                        <span className="text-gray-500">TTL Remaining</span>
                        <span className={`font-mono ${
                          meta.ttlMinutesRemaining < 30 ? "text-red-400" :
                          meta.ttlMinutesRemaining < 120 ? "text-yellow-400" :
                          "text-green-400"
                        }`}>
                          {meta.ttlMinutesRemaining >= 60 
                            ? `${Math.floor(meta.ttlMinutesRemaining / 60)}h ${meta.ttlMinutesRemaining % 60}m`
                            : `${meta.ttlMinutesRemaining}m`
                          }
                        </span>
                      </div>
                    )}

                    <div className="mb-4 space-y-2">
                      <div className="flex justify-between text-sm">
                        <span className="text-gray-400">Entry</span>
                        <span className="font-mono">{money(signal.entry)}</span>
                      </div>
                      <div className="flex justify-between text-sm">
                        <span className="text-gray-400">Stop</span>
                        <span className="font-mono text-red-400">{money(signal.stop)}</span>
                      </div>
                      <div className="flex justify-between text-sm">
                        <span className="text-gray-400">Target</span>
                        <span className="font-mono text-purple-400">{money(signal.target)}</span>
                      </div>
                      <div className="flex justify-between text-sm">
                        <span className="text-gray-400">R:R</span>
                        <span className="font-mono text-yellow-400">{signal.rr?.toFixed(2)}</span>
                      </div>
                      <div className="flex justify-between text-sm">
                        <span className="text-gray-400">Confidence</span>
                        <span className={`font-mono font-bold ${signal.confidence >= 60 ? "text-green-400" : signal.confidence >= 40 ? "text-yellow-400" : "text-red-400"}`}>
                          {signal.confidence}%
                        </span>
                      </div>
                      <div className="flex justify-between text-sm">
                        <span className="text-gray-400">Age</span>
                        <span className="font-mono text-gray-300">{timeAgo(signal.timestamp)}</span>
                      </div>
                      {signal.version && (
                        <div className="flex justify-between text-sm">
                          <span className="text-gray-400">Version</span>
                          <span className="font-mono text-gray-500">v{signal.version}</span>
                        </div>
                      )}
                    </div>

                    {signal.reason && (
                      <div className="text-xs text-gray-500 border-t border-gray-700 pt-3 mb-3">
                        <p className="leading-relaxed">{signal.reason}</p>
                      </div>
                    )}

                    <div className="text-xs text-gray-500">
                      <p><span className="text-gray-400">Expected:</span> {signal.expectedMove?.toFixed(2)}%</p>
                    </div>
                  </>
                )}

                {/* Closed/Expired Signal Summary */}
                {(status === "TP_HIT" || status === "SL_HIT" || status === "EXPIRED" || status === "MISSED") && (
                  <div className="mb-4 p-3 bg-gray-900/50 rounded text-sm space-y-2">
                    <div className="flex justify-between">
                      <span className="text-gray-400">Result</span>
                      <span className={`font-bold ${
                        status === "TP_HIT" ? "text-purple-400" :
                        status === "SL_HIT" ? "text-red-400" :
                        status === "EXPIRED" ? "text-gray-400" :
                        "text-yellow-400"
                      }`}>
                        {status === "TP_HIT" ? "TAKE PROFIT" : status === "SL_HIT" ? "STOP LOSS" : status === "EXPIRED" ? "EXPIRED" : "MISSED ENTRY"}
                      </span>
                    </div>
                    <div className="flex justify-between">
                      <span className="text-gray-400">Entry</span>
                      <span className="font-mono">{money(signal?.entry)}</span>
                    </div>
                    {status === "TP_HIT" && (
                      <div className="flex justify-between">
                        <span className="text-gray-400">Exit</span>
                        <span className="font-mono text-purple-400">{money(signal?.target)}</span>
                      </div>
                    )}
                    {status === "SL_HIT" && (
                      <div className="flex justify-between">
                        <span className="text-gray-400">Exit</span>
                        <span className="font-mono text-red-400">{money(signal?.stop)}</span>
                      </div>
                    )}
                    <div className="flex justify-between">
                      <span className="text-gray-400">R:R</span>
                      <span className="font-mono text-yellow-400">{signal?.rr?.toFixed(2)}</span>
                    </div>
                    {signal?.scale && (
                      <div className="flex justify-between">
                        <span className="text-gray-400">Scale</span>
                        <span className="font-mono text-purple-400">{scaleName(signal.scale)}</span>
                      </div>
                    )}
                  </div>
                )}

                {/* Waiting State */}
                {!hasSignal && mkt && (
                  <div className="text-sm text-gray-500 space-y-2">
                    <p className="text-gray-400 font-medium">Waiting for setup:</p>
                    
                    <div className="flex justify-between items-center">
                      <span>1D Trend</span>
                      <span className={mkt.trend?.includes("STRONG") ? "text-green-400" : mkt.trend?.includes("MEDIUM") ? "text-yellow-400" : "text-gray-500"}>
                        {mkt.trend || "None"}
                      </span>
                    </div>
                    
                    {mkt.distToTrendline !== undefined && (
                      <div className="flex justify-between items-center">
                        <span>Trendline distance</span>
                        <span className={Math.abs(mkt.distToTrendline) < 1.2 ? "text-green-400" : Math.abs(mkt.distToTrendline) < 3 ? "text-yellow-400" : "text-red-400"}>
                          {mkt.distToTrendline > 0 ? "+" : ""}{mkt.distToTrendline.toFixed(2)}%
                          {Math.abs(mkt.distToTrendline) < 1.2 ? " ✓ near" : Math.abs(mkt.distToTrendline) < 3 ? " ○ approaching" : " ✗ far"}
                        </span>
                      </div>
                    )}
                    
                    <div className="flex justify-between items-center">
                      <span>StochRSI K/D</span>
                      <span className={mkt.stochK !== undefined && mkt.stochD !== undefined ? (
                        mkt.stochK < 20 ? "text-green-400" :
                        mkt.stochK > 80 ? "text-red-400" :
                        Math.abs(mkt.stochK - mkt.stochD) > 10 ? "text-yellow-400" :
                        "text-gray-500"
                      ) : "text-gray-500"}>
                        {mkt.stochK?.toFixed(1) ?? "—"} / {mkt.stochD?.toFixed(1) ?? "—"}
                        {mkt.stochK !== undefined && mkt.stochD !== undefined && (
                          mkt.stochK < 20 ? " (oversold)" :
                          mkt.stochK > 80 ? " (overbought)" :
                          mkt.stochK > mkt.stochD ? " ↑" :
                          mkt.stochK < mkt.stochD ? " ↓" :
                          ""
                        )}
                      </span>
                    </div>
                    
                    <div className="flex justify-between items-center">
                      <span>ADX</span>
                      <span className={mkt.adx > 25 ? "text-green-400" : mkt.adx > 20 ? "text-yellow-400" : "text-gray-500"}>
                        {mkt.adx?.toFixed(1) ?? "—"}
                        {mkt.adx > 25 ? " strong" : mkt.adx > 20 ? " moderate" : " weak"}
                      </span>
                    </div>
                    
                    {mkt.ema8 !== undefined && mkt.ema21 !== undefined && (
                      <div className="flex justify-between items-center">
                        <span>EMA 8/21</span>
                        <span className={
                          mkt.price > mkt.ema8 && mkt.price > mkt.ema21 ? "text-green-400" :
                          mkt.price < mkt.ema8 && mkt.price < mkt.ema21 ? "text-red-400" :
                          "text-yellow-400"
                        }>
                          {mkt.price > mkt.ema8 && mkt.price > mkt.ema21 ? "above both" :
                           mkt.price < mkt.ema8 && mkt.price < mkt.ema21 ? "below both" :
                           "mixed"}
                        </span>
                      </div>
                    )}
                  </div>
                )}
              </div>
            );
          })}
        </div>
      </div>
    </div>
  );
}
