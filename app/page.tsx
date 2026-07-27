"use client";

import { useEffect, useState } from "react";

interface Signal {
  pair: string;
  direction: "LONG" | "SHORT";
  type: string;
  scale: string;
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
  trend?: string;
  location?: string;
  trigger?: string;
  meta?: {
    status: string;
    ageMinutes: number;
    actionable: boolean;
  };
}

interface MarketData {
  pair: string;
  price: number;
  trend: string;
  location: string;
  trigger: string;
  adx: number;
  rsi: number;
  stochK: number;
  stochD: number;
  timestamp: number;
  trendlinePrice: number;
  distToTrendline: number;
  ema8_15m: number;
  ema21_15m: number;
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
        <div className="text-lg">Loading CX Switch v50...</div>
      </div>
    );
  }

  return (
    <div className="min-h-screen bg-gray-900 text-white p-6">
      <div className="max-w-6xl mx-auto">
        <div className="flex justify-between items-center mb-6">
          <h1 className="text-2xl font-bold">CX Switch v50</h1>
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
            const status = signal?.meta?.status || "WAITING";

            let borderClass = "border-gray-700 bg-gray-800";
            let bannerText = "";
            let bannerClass = "";
            let statusBadge = "";

            if (hasSignal) {
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
              } else if (status === "ACTIVE") {
                borderClass =
                  signal.direction === "LONG"
                    ? "border-green-500 bg-green-900/10"
                    : "border-red-500 bg-red-900/10";
                const age = signal.meta?.ageMinutes ?? 0;
                if (age > 120) {
                  bannerText = `⏰ STALE — ${age}m old. Wait for fresh signal.`;
                  bannerClass = "bg-gray-600 text-white";
                  statusBadge = "STALE";
                } else {
                  statusBadge = "ACTIVE";
                }
              }
            } else {
              if (mkt) {
                const trendDir = mkt.trend;
                if (trendDir === "LONG") {
                  bannerText = `⏳ LONG — ${mkt.location}`;
                  bannerClass = "bg-green-600/30 text-green-300";
                } else if (trendDir === "SHORT") {
                  bannerText = `⏳ SHORT — ${mkt.location}`;
                  bannerClass = "bg-red-600/30 text-red-300";
                } else {
                  bannerText = "⏳ No trend — Waiting";
                  bannerClass = "bg-gray-600/30 text-gray-300";
                }
              } else {
                bannerText = "⏳ Loading market data...";
                bannerClass = "bg-gray-600/30 text-gray-300";
              }
              statusBadge = "WAITING";
            }

            const entry = signal?.entry ?? 0;
            const stop = signal?.stop ?? 0;
            const target = signal?.target ?? 0;

            const progress =
              hasSignal && status === "ACTIVE" && entry && target && stop
                ? signal.direction === "LONG"
                  ? Math.max(
                      0,
                      Math.min(
                        100,
                        ((currentPrice - entry) / (target - entry)) * 100
                      )
                    )
                  : Math.max(
                      0,
                      Math.min(
                        100,
                        ((entry - currentPrice) / (entry - target)) * 100
                      )
                    )
                : 0;

            const unrealizedPnL =
              hasSignal && status === "ACTIVE" && currentPrice && entry
                ? signal.direction === "LONG"
                  ? ((currentPrice - entry) / entry) * 100
                  : ((entry - currentPrice) / entry) * 100
                : 0;

            return (
              <div
                key={pair}
                className={`rounded-lg p-5 border-2 transition-all ${borderClass}`}
              >
                {bannerText && (
                  <div
                    className={`mb-3 py-2 px-3 rounded text-center font-bold text-sm ${bannerClass}`}
                  >
                    {bannerText}
                  </div>
                )}

                <div className="flex justify-between items-start mb-4">
                  <div>
                    <div className="font-bold text-lg">{pair}/USD</div>
                    <div className="flex items-center gap-2">
                      <div className="text-2xl font-mono">
                        {money(currentPrice)}
                      </div>
                      {livePrice && (
                        <span className="text-xs bg-green-600/50 text-green-300 px-1.5 py-0.5 rounded">
                          LIVE
                        </span>
                      )}
                    </div>
                  </div>
                  <div className="flex flex-col items-end gap-1">
                    {hasSignal ? (
                      <>
                        <span
                          className={`px-2 py-1 rounded text-xs font-bold ${
                            signal.direction === "LONG"
                              ? "bg-green-500/20 text-green-300"
                              : "bg-red-500/20 text-red-300"
                          }`}
                        >
                          {signal.type}
                        </span>
                        <span
                          className={`text-xs font-bold ${
                            signal.direction === "LONG"
                              ? "text-green-400"
                              : "text-red-400"
                          }`}
                        >
                          {signal.direction}
                        </span>
                        <span
                          className={`text-[10px] px-1.5 py-0.5 rounded font-bold ${
                            statusBadge === "ACTIVE"
                              ? "bg-green-500/30 text-green-300"
                              : statusBadge === "TP HIT"
                              ? "bg-purple-500/30 text-purple-300"
                              : statusBadge === "SL HIT"
                              ? "bg-red-500/30 text-red-300"
                              : statusBadge === "STALE"
                              ? "bg-gray-500/30 text-gray-300"
                              : "bg-blue-500/30 text-blue-300"
                          }`}
                        >
                          {statusBadge}
                        </span>
                      </>
                    ) : (
                      <span className="px-2 py-1 rounded text-xs bg-gray-600 text-gray-300">
                        NO SIGNAL
                      </span>
                    )}
                  </div>
                </div>

                {mkt && (
                  <div className="mb-3 p-2 rounded border bg-gray-800/50 border-gray-600/50">
                    <div className="flex justify-between items-center">
                      <span className="text-gray-400">Trend:</span>
                      <span
                        className={`font-bold ${
                          mkt.trend === "LONG"
                            ? "text-green-400"
                            : mkt.trend === "SHORT"
                            ? "text-red-400"
                            : "text-gray-400"
                        }`}
                      >
                        {mkt.trend}
                      </span>
                    </div>
                    <div className="flex justify-between items-center mt-1">
                      <span className="text-gray-400">Location:</span>
                      <span
                        className={`font-bold text-xs ${
                          mkt.location === "READY"
                            ? "text-green-400"
                            : "text-yellow-400"
                        }`}
                      >
                        {mkt.location}
                      </span>
                    </div>
                    <div className="flex justify-between items-center mt-1">
                      <span className="text-gray-400">Trigger:</span>
                      <span
                        className={`font-bold text-xs ${
                          mkt.trigger === "FIRED"
                            ? "text-purple-400"
                            : "text-gray-400"
                        }`}
                      >
                        {mkt.trigger}
                      </span>
                    </div>
                    <div className="flex justify-between mt-1 text-xs">
                      <span className="text-gray-500">
                        ADX: {mkt.adx?.toFixed(1)}
                      </span>
                      <span className="text-gray-500">
                        RSI: {mkt.rsi?.toFixed(1)}
                      </span>
                    </div>
                    <div className="flex justify-between text-xs">
                      <span className="text-gray-500">
                        Stoch K: {mkt.stochK?.toFixed(1)}
                      </span>
                      <span className="text-gray-500">
                        D: {mkt.stochD?.toFixed(1)}
                      </span>
                    </div>
                    {mkt.trendlinePrice > 0 && (
                      <div className="flex justify-between text-xs mt-1">
                        <span className="text-gray-500">TL Price:</span>
                        <span className="text-gray-400 font-mono">
                          {money(mkt.trendlinePrice)}
                        </span>
                      </div>
                    )}
                  </div>
                )}

                {hasSignal && status === "ACTIVE" && (
                  <>
                    <div className="mb-3">
                      <div className="flex justify-between text-xs text-gray-400 mb-1">
                        <span>Entry</span>
                        <span
                          className={
                            unrealizedPnL > 0
                              ? "text-green-400"
                              : unrealizedPnL < 0
                              ? "text-red-400"
                              : "text-gray-400"
                          }
                        >
                          {unrealizedPnL > 0 ? "+" : ""}
                          {unrealizedPnL.toFixed(2)}%
                        </span>
                        <span>Target</span>
                      </div>
                      <div className="h-2 bg-gray-700 rounded-full overflow-hidden">
                        <div
                          className={`h-full rounded-full transition-all ${
                            unrealizedPnL >= 0
                              ? "bg-green-500"
                              : "bg-red-500"
                          }`}
                          style={{ width: `${progress}%` }}
                        />
                      </div>
                      <div className="flex justify-between text-[10px] text-gray-500 mt-1">
                        <span>{money(entry)}</span>
                        <span>{money(target)}</span>
                      </div>
                    </div>

                    <div className="mb-4 space-y-2">
                      <div className="flex justify-between text-sm">
                        <span className="text-gray-400">Entry</span>
                        <span className="font-mono">{money(signal.entry)}</span>
                      </div>
                      <div className="flex justify-between text-sm">
                        <span className="text-gray-400">Stop</span>
                        <span className="font-mono text-red-400">
                          {money(signal.stop)}
                        </span>
                      </div>
                      <div className="flex justify-between text-sm">
                        <span className="text-gray-400">Target</span>
                        <span className="font-mono text-purple-400">
                          {money(signal.target)}
                        </span>
                      </div>
                      <div className="flex justify-between text-sm">
                        <span className="text-gray-400">R:R</span>
                        <span className="font-mono text-yellow-400">
                          {signal.rr?.toFixed(2)}
                        </span>
                      </div>
                      <div className="flex justify-between text-sm">
                        <span className="text-gray-400">Age</span>
                        <span className="font-mono text-gray-300">
                          {timeAgo(signal.timestamp)}
                        </span>
                      </div>
                    </div>

                    {signal.reason && (
                      <div className="text-xs text-gray-500 border-t border-gray-700 pt-3 mb-3">
                        <p className="leading-relaxed">{signal.reason}</p>
                      </div>
                    )}

                    <div className="text-xs text-gray-500">
                      <p>
                        <span className="text-gray-400">Expected:</span>{" "}
                        {signal.expectedMove?.toFixed(2)}%
                      </p>
                    </div>
                  </>
                )}

                {(status === "TP_HIT" || status === "SL_HIT") && (
                  <div className="mb-4 p-3 bg-gray-900/50 rounded text-sm space-y-2">
                    <div className="flex justify-between">
                      <span className="text-gray-400">Result</span>
                      <span
                        className={`font-bold ${
                          status === "TP_HIT"
                            ? "text-purple-400"
                            : "text-red-400"
                        }`}
                      >
                        {status === "TP_HIT" ? "TAKE PROFIT" : "STOP LOSS"}
                      </span>
                    </div>
                    <div className="flex justify-between">
                      <span className="text-gray-400">Entry</span>
                      <span className="font-mono">{money(signal?.entry)}</span>
                    </div>
                    <div className="flex justify-between">
                      <span className="text-gray-400">Exit</span>
                      <span className="font-mono">
                        {money(
                          status === "TP_HIT" ? signal?.target : signal?.stop
                        )}
                      </span>
                    </div>
                    <div className="flex justify-between">
                      <span className="text-gray-400">R:R</span>
                      <span className="font-mono text-yellow-400">
                        {signal?.rr?.toFixed(2)}
                      </span>
                    </div>
                  </div>
                )}

                {!hasSignal && mkt && (
                  <div className="text-sm text-gray-500 space-y-2">
                    <p className="font-semibold text-gray-400">Why no trade?</p>
                    <div className="space-y-1">
                      <div className="flex items-center gap-2">
                        <span className={mkt.trend === "LONG" || mkt.trend === "SHORT" ? "text-green-400" : "text-gray-500"}>●</span>
                        <span>Trend: {mkt.trend || "None"}</span>
                      </div>
                      <div className="flex items-center gap-2">
                        <span className={mkt.location === "READY" ? "text-green-400" : "text-gray-500"}>●</span>
                        <span>Location: {mkt.location}</span>
                      </div>
                      <div className="flex items-center gap-2">
                        <span className={mkt.trigger === "FIRED" ? "text-green-400" : "text-gray-500"}>●</span>
                        <span>Trigger: {mkt.trigger}</span>
                      </div>
                    </div>
                    {mkt.trendlinePrice > 0 && (
                      <p className="text-xs text-gray-600 mt-2">
                        TL: {money(mkt.trendlinePrice)} | Dist: {mkt.distToTrendline?.toFixed(2)}%
                      </p>
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
