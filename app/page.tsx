"use client";

import { useEffect, useState } from "react";

interface MarketData {
  pair: string;
  price?: number;
  structure?: string;
  adx?: number;
  rsi?: number;
  stochK?: number;
  stochD?: number;
}

interface HoldAdvice {
  shouldHold: boolean;
  reason: string;
  trailingStop: number | null;
  trendHealth: "STRONG" | "MODERATE" | "WEAK" | "NONE";
}

interface Signal {
  pair: string;
  direction: "LONG" | "SHORT";
  type: string;
  confidence: number;
  entry: number;
  stop: number;
  target: number;
  rr: number;
  reason: string;
  timestamp: number;
  expectedMove: number;
  adx?: number;
  rsi?: number;
  stochK?: number;
  stochD?: number;
  holdAdvice?: HoldAdvice;
}

const PAIRS = ["BTC", "ETH", "SOL"];
const SIGNAL_STALE_MS = 6 * 60 * 60 * 1000;

const ACCOUNT_BALANCE = 850;
const RISK_PER_TRADE = 0.02;

const money = (n?: number) =>
  typeof n === "number" && isFinite(n)
    ? new Intl.NumberFormat("en-US", {
        style: "currency",
        currency: "USD",
        maximumFractionDigits: n >= 1000 ? 0 : 2,
      }).format(n)
    : "—";

const round = (n?: number, d = 2) =>
  typeof n === "number" && isFinite(n)
    ? Math.round(n * Math.pow(10, d)) / Math.pow(10, d)
    : undefined;

function calcPositionSize(entry: number, stop: number) {
  const risk = ACCOUNT_BALANCE * RISK_PER_TRADE;
  const dist = Math.abs(entry - stop);
  if (!dist || dist <= 0) return { units: 0, notional: 0 };
  const units = risk / dist;
  const notional = units * entry;
  return { units: Math.round(units), notional: Math.round(notional) };
}

function getTypeColor(type: string) {
  switch (type) {
    case "BREAKOUT": return "bg-orange-500 text-white";
    case "PULLBACK": return "bg-blue-500 text-white";
    case "CONTINUATION": return "bg-cyan-500 text-black";
    case "REVERSAL": return "bg-purple-500 text-white";
    case "SWEEP": return "bg-yellow-500 text-black";
    case "EARLY": return "bg-pink-500 text-white";
    default: return "bg-gray-600 text-gray-300";
  }
}

function getHealthColor(health: string) {
  switch (health) {
    case "STRONG": return "text-green-400 border-green-600 bg-green-900/30";
    case "MODERATE": return "text-yellow-400 border-yellow-600 bg-yellow-900/30";
    case "WEAK": return "text-orange-400 border-orange-600 bg-orange-900/30";
    case "NONE": return "text-red-400 border-red-600 bg-red-900/30";
    default: return "text-gray-400 border-gray-600 bg-gray-900/30";
  }
}

const KRAKEN_PAIRS: Record<string, string> = {
  BTC: "XBTUSD",
  ETH: "ETHUSD",
  SOL: "SOLUSD",
};

async function fetchKrakenPrice(pair: string): Promise<number | null> {
  try {
    const krakenPair = KRAKEN_PAIRS[pair];
    const res = await fetch(`https://api.kraken.com/0/public/Ticker?pair=${krakenPair}`, {
      cache: "no-store",
    });
    const data = await res.json();
    if (data.error?.length) return null;
    const ticker = data.result[Object.keys(data.result)[0]];
    return parseFloat(ticker.c[0]);
  } catch {
    return null;
  }
}

export default function Dashboard() {
  const [signals, setSignals] = useState<Record<string, Signal | null>>({});
  const [market, setMarket] = useState<Record<string, MarketData>>({});
  const [livePrices, setLivePrices] = useState<Record<string, number>>({});
  const [loading, setLoading] = useState(true);
  const [fetchCount, setFetchCount] = useState(0);
  const [lastSignalFetch, setLastSignalFetch] = useState<number>(0);
  const [lastPriceFetch, setLastPriceFetch] = useState<number>(0);

  // 1. Fetch signals + market data from backend every 30s
  useEffect(() => {
    async function loadSignals() {
      try {
        const res = await fetch("/api/signals");
        const data = await res.json();

        const sigMap: Record<string, Signal | null> = {};
        const mktMap: Record<string, MarketData> = {};

        for (const m of data.marketData || []) {
          if (m?.pair) mktMap[m.pair] = m;
        }

        for (const p of PAIRS) {
          const s = data.signals?.find((sig: Signal) => sig.pair === p);
          sigMap[p] = s || null;
        }

        setSignals(sigMap);
        setMarket(mktMap);
        setFetchCount((c) => c + 1);
        setLastSignalFetch(Date.now());
      } catch (e) {
        console.error(e);
      } finally {
        setLoading(false);
      }
    }

    loadSignals();
    const i = setInterval(loadSignals, 30000);
    return () => clearInterval(i);
  }, []);

  // 2. Fetch LIVE prices from Kraken every 10s (independent of signals)
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
      setLastPriceFetch(Date.now());
    }

    loadPrices();
    const i = setInterval(loadPrices, 10000);
    return () => clearInterval(i);
  }, []);

  if (loading) {
    return (
      <div className="min-h-screen bg-gray-900 text-white flex items-center justify-center">
        Loading...
      </div>
    );
  }

  return (
    <div className="min-h-screen bg-gray-900 text-white p-6">
      <div className="max-w-6xl mx-auto">
        <div className="flex justify-between items-center mb-6">
          <h1 className="text-2xl font-bold">CX Switch v20 — LIVE</h1>
          <div className="text-xs text-gray-400">
            Fetches: {fetchCount} | Signals: {lastSignalFetch ? new Date(lastSignalFetch).toLocaleTimeString() : "—"} | Price: {lastPriceFetch ? new Date(lastPriceFetch).toLocaleTimeString() : "—"}
          </div>
        </div>

        <div className="mb-6 p-4 bg-gray-800 rounded-lg border border-gray-700">
          <div className="flex justify-between items-center">
            <div>
              <span className="text-gray-400 text-sm">Account</span>
              <p className="text-2xl font-bold">{money(ACCOUNT_BALANCE)}</p>
            </div>
            <div>
              <span className="text-gray-400 text-sm">Risk/Trade</span>
              <p className="text-xl font-bold text-yellow-400">{(RISK_PER_TRADE * 100).toFixed(0)}%</p>
            </div>
            <div>
              <span className="text-gray-400 text-sm">Max Risk</span>
              <p className="text-xl font-bold text-red-400">{money(ACCOUNT_BALANCE * RISK_PER_TRADE)}</p>
            </div>
          </div>
        </div>

        <div className="grid md:grid-cols-3 gap-6">
          {PAIRS.map((pair) => {
            const signal = signals[pair];
            const m = market[pair];
            const livePrice = livePrices[pair];
            const now = Date.now();

            const hasSignal = !!signal;
            const signalFresh = signal && (now - signal.timestamp < SIGNAL_STALE_MS);

            // LIVE PRICE: Kraken first, then backend market, then signal entry
            const currentPrice = livePrice ?? m?.price ?? signal?.entry;
            const priceLive = !!livePrice;

            const structure = m?.structure ?? signal?.reason?.match(/4H:(\w+)/)?.[1] ?? "—";

            const adx = m?.adx ?? signal?.adx;
            const rsi = m?.rsi ?? signal?.rsi;
            const stochK = m?.stochK ?? signal?.stochK;
            const stochD = m?.stochD ?? signal?.stochD;
            const stoch = stochK !== undefined && stochD !== undefined
              ? `${round(stochK)}/${round(stochD)}`
              : "—";

            const entry = signal?.entry ?? 0;
            const stop = signal?.stop ?? 0;
            const target = signal?.target ?? 0;

            const { units, notional } = signal ? calcPositionSize(entry, stop) : { units: 0, notional: 0 };

            const unrealizedPnL = hasSignal && signalFresh && currentPrice && entry
              ? signal.direction === "LONG"
                ? ((currentPrice - entry) / entry) * 100
                : ((entry - currentPrice) / entry) * 100
              : 0;

            // TARGET HIT detection
            const targetHit = hasSignal && signalFresh && currentPrice && target
              ? signal.direction === "LONG"
                ? currentPrice >= target
                : currentPrice <= target
              : false;

            // STOP HIT detection
            const stopHit = hasSignal && signalFresh && currentPrice && stop
              ? signal.direction === "LONG"
                ? currentPrice <= stop
                : currentPrice >= stop
              : false;

            return (
              <div
                key={pair}
                className={`rounded-lg p-5 border-2 transition-all ${
                  targetHit
                    ? "border-purple-500 bg-purple-900/10"
                    : stopHit
                    ? "border-red-500 bg-red-900/10"
                    : hasSignal && signalFresh
                    ? signal?.direction === "LONG"
                      ? "border-green-500 bg-green-900/10"
                      : "border-red-500 bg-red-900/10"
                    : "border-gray-700 bg-gray-800"
                }`}>
                <div className="flex justify-between items-start mb-4">
                  <div>
                    <div className="font-bold text-lg">{pair}/USD</div>
                    <div className="flex items-center gap-2">
                      <div className="text-2xl font-mono">{money(currentPrice)}</div>
                      {priceLive && (
                        <span className="text-xs bg-green-600/50 text-green-300 px-1.5 py-0.5 rounded animate-pulse">
                          LIVE
                        </span>
                      )}
                    </div>
                  </div>

                  {targetHit ? (
                    <span className="px-2 py-1 rounded text-xs bg-purple-500 text-white font-bold">🎯 TARGET HIT</span>
                  ) : stopHit ? (
                    <span className="px-2 py-1 rounded text-xs bg-red-500 text-white font-bold">🛑 STOP HIT</span>
                  ) : hasSignal && signalFresh ? (
                    <div className="flex flex-col items-end gap-1">
                      <span className={`px-2 py-1 rounded text-xs font-bold ${getTypeColor(signal.type)}`}>
                        {signal.type}
                      </span>
                      <span className={`text-xs font-bold ${signal.direction === "LONG" ? "text-green-400" : "text-red-400"}`}>
                        {signal.direction}
                      </span>
                    </div>
                  ) : hasSignal && !signalFresh ? (
                    <span className="px-2 py-1 rounded text-xs bg-yellow-600 text-white">EXPIRED</span>
                  ) : (
                    <span className="px-2 py-1 rounded text-xs bg-gray-600 text-gray-300">WAIT</span>
                  )}
                </div>

                <div className="mb-4 p-3 bg-gray-900/50 rounded text-sm space-y-1">
                  <div className="flex justify-between">
                    <span className="text-gray-400">Structure</span>
                    <span className={`font-medium ${
                      structure === "UPTREND" ? "text-green-400" :
                      structure === "DOWNTREND" ? "text-red-400" :
                      structure === "RANGE" ? "text-yellow-400" : "text-gray-300"
                    }`}>{structure}</span>
                  </div>
                  <div className="flex justify-between">
                    <span className="text-gray-400">ADX</span>
                    <span className="font-medium">{adx !== undefined ? round(adx) : "—"}</span>
                  </div>
                  <div className="flex justify-between">
                    <span className="text-gray-400">RSI</span>
                    <span className="font-medium">{rsi !== undefined ? round(rsi) : "—"}</span>
                  </div>
                  <div className="flex justify-between">
                    <span className="text-gray-400">Stoch K/D</span>
                    <span className="font-medium">{stoch}</span>
                  </div>
                </div>

                {hasSignal && signalFresh ? (
                  <div className="space-y-2 border-t border-gray-700 pt-4 text-sm">
                    {targetHit && (
                      <div className="bg-purple-900/50 border border-purple-500 p-3 rounded text-center">
                        <p className="text-purple-300 font-bold text-lg">🎯 TARGET HIT</p>
                        <p className="text-purple-400 text-xs">Take profit now or let it run</p>
                      </div>
                    )}

                    {stopHit && (
                      <div className="bg-red-900/50 border border-red-500 p-3 rounded text-center">
                        <p className="text-red-300 font-bold text-lg">🛑 STOP HIT</p>
                        <p className="text-red-400 text-xs">Exit position</p>
                      </div>
                    )}

                    {!targetHit && !stopHit && currentPrice && entry && (
                      <div className="flex justify-between bg-gray-900 p-2 rounded">
                        <span className="text-gray-400">Unrealized P&L</span>
                        <span className={`font-bold ${unrealizedPnL >= 0 ? "text-green-400" : "text-red-400"}`}>
                          {unrealizedPnL >= 0 ? "+" : ""}{unrealizedPnL.toFixed(2)}%
                        </span>
                      </div>
                    )}

                    <div className="flex justify-between">
                      <span className="text-gray-400">Confidence</span>
                      <span className="font-bold">{round(signal.confidence)}%</span>
                    </div>

                    <div className="flex justify-between">
                      <span className="text-gray-400">Entry</span>
                      <span className="font-mono">{money(entry)}</span>
                    </div>

                    <div className="flex justify-between">
                      <span className="text-gray-400">Stop</span>
                      <span className="font-mono text-red-400">{money(stop)}</span>
                    </div>

                    <div className="flex justify-between">
                      <span className="text-gray-400">Target</span>
                      <span className="font-mono text-green-400">{money(target)}</span>
                    </div>

                    <div className="flex justify-between">
                      <span className="text-gray-400">R:R</span>
                      <span className="font-bold">{round(signal.rr)}</span>
                    </div>

                    <div className="flex justify-between">
                      <span className="text-gray-400">Expected Move</span>
                      <span className={`font-bold ${signal.direction === "LONG" ? "text-green-400" : "text-red-400"}`}>
                        {signal.direction === "LONG" ? "+" : "—"}{round(Math.abs(signal.expectedMove))}%
                      </span>
                    </div>

                    <div className="flex justify-between bg-gray-900 p-2 rounded">
                      <span className="text-gray-400">Position</span>
                      <span className="text-yellow-400 font-bold">
                        {units} units ≈ {money(notional)}
                      </span>
                    </div>

                    {signal.holdAdvice && !targetHit && !stopHit && (
                      <div className={`mt-3 p-3 rounded border ${getHealthColor(signal.holdAdvice.trendHealth)}`}>
                        <div className="flex justify-between items-center mb-1">
                          <span className="text-sm font-bold">4H Trend Health</span>
                          <span className="text-sm font-bold">{signal.holdAdvice.trendHealth}</span>
                        </div>
                        <div className="flex justify-between items-center">
                          <span className="text-sm font-bold">
                            {signal.holdAdvice.shouldHold ? "✅ HOLD" : "❌ EXIT"}
                          </span>
                        </div>
                        {signal.holdAdvice.trailingStop && (
                          <div className="flex justify-between items-center mt-1 pt-1 border-t border-white/10">
                            <span className="text-xs">🔒 Trail</span>
                            <span className="text-xs font-mono">{money(signal.holdAdvice.trailingStop)}</span>
                          </div>
                        )}
                        <p className="text-xs mt-1 opacity-80">{signal.holdAdvice.reason}</p>
                      </div>
                    )}

                    <div className="mt-3 pt-3 border-t border-gray-700">
                      <p className="text-xs text-gray-400 leading-relaxed">{signal.reason}</p>
                    </div>

                    <div className="text-xs text-gray-500">
                      {new Date(signal.timestamp).toLocaleString()}
                    </div>
                  </div>
                ) : hasSignal && !signalFresh ? (
                  <div className="mt-4 text-center border-t border-gray-700 pt-4">
                    <p className="text-yellow-400 text-sm">⏳ Signal expired</p>
                    <p className="text-xs text-gray-500 mt-1">
                      Last: {signal?.type} {signal?.direction} @ {money(signal?.entry)} ({new Date(signal!.timestamp).toLocaleTimeString()})
                    </p>
                  </div>
                ) : (
                  <div className="mt-4 text-gray-500 text-sm border-t border-gray-700 pt-4 text-center">
                    <p>No active setup</p>
                    <p className="text-xs text-gray-600 mt-1">Monitoring 4H trend + 1H multi-setup</p>
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
