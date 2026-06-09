"use client";

import { useEffect, useState, useRef } from "react";

interface MarketData {
  pair: string;
  price: number;
  structure: string;
  adx: number;
  rsi: number;
  stochK: number;
  stochD: number;
  timestamp: number;
}

interface Signal extends MarketData {
  direction: "LONG" | "SHORT";
  type: "PRIMARY" | "CHEEKY";
  confidence: number;
  entry: number;
  stop: number;
  target: number;
  rr: number;
  reason: string;
  expectedMove: number;
}

const PAIRS = ["BTC", "ETH", "SOL"];
const SIGNAL_STALE_MS = 4 * 60 * 60 * 1000;
const MARKET_STALE_MS = 70 * 60 * 1000;

const ACCOUNT_BALANCE = 700;
const RISK_PER_TRADE = 0.02;

function calcPositionSize(entry: number, stop: number, direction: "LONG" | "SHORT"): number {
  const stopDistance = Math.abs(entry - stop) / entry;
  const riskAmount = ACCOUNT_BALANCE * RISK_PER_TRADE;
  const positionSize = riskAmount / stopDistance;
  return Math.round(positionSize);
}

export default function Dashboard() {
  const [signals, setSignals] = useState<Record<string, Signal | null>>({});
  const [marketData, setMarketData] = useState<Record<string, MarketData>>({});
  const [lastSignalUpdate, setLastSignalUpdate] = useState<number>(0);
  const [lastMarketUpdate, setLastMarketUpdate] = useState<number>(0);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [fetchCount, setFetchCount] = useState(0);

  const bestSignalsRef = useRef<Record<string, Signal | null>>({});

  useEffect(() => {
    async function fetchData() {
      try {
        const res = await fetch("/api/signals");
        if (!res.ok) throw new Error("Failed to fetch");
        const data = await res.json();

        const now = Date.now();
        const newSignalMap: Record<string, Signal | null> = {};
        const newMarketMap: Record<string, MarketData> = {};
        let latestSignalTs = 0;
        let latestMarketTs = 0;

        for (const md of data.marketData || []) {
          if (md && md.pair) {
            newMarketMap[md.pair] = md;
            if (md.timestamp > latestMarketTs) latestMarketTs = md.timestamp;
          }
        }

        for (const pair of PAIRS) {
          const incoming = data.signals?.find((s: Signal) => s.pair === pair);

          if (incoming) {
            newSignalMap[pair] = incoming;
            bestSignalsRef.current[pair] = incoming;
            if (incoming.timestamp > latestSignalTs) latestSignalTs = incoming.timestamp;
          } else {
            const cached = bestSignalsRef.current[pair];
            if (cached && now - cached.timestamp < SIGNAL_STALE_MS) {
              newSignalMap[pair] = cached;
            } else {
              newSignalMap[pair] = null;
              bestSignalsRef.current[pair] = null;
            }
          }
        }

        setSignals(newSignalMap);

        if (Object.keys(newMarketMap).length > 0) {
          setMarketData(prev => ({ ...prev, ...newMarketMap }));
          setLastMarketUpdate(now);
        }

        if (latestSignalTs > 0) setLastSignalUpdate(latestSignalTs);
        setFetchCount(c => c + 1);
      } catch (err) {
        console.error("[UI] Fetch error:", err);
        setError(err instanceof Error ? err.message : "Unknown error");
      } finally {
        setLoading(false);
      }
    }

    fetchData();
    const interval = setInterval(fetchData, 30000);
    return () => clearInterval(interval);
  }, []);

  const now = Date.now();
  const marketStale = now - lastMarketUpdate > MARKET_STALE_MS;

  if (loading && fetchCount === 0) {
    return (
      <div className="min-h-screen bg-gray-900 text-white flex items-center justify-center">
        <div className="text-xl">Loading signals...</div>
      </div>
    );
  }

  if (error && fetchCount === 0) {
    return (
      <div className="min-h-screen bg-gray-900 text-white flex items-center justify-center">
        <div className="text-xl text-red-400">Error: {error}</div>
      </div>
    );
  }

  return (
    <div className="min-h-screen bg-gray-900 text-white p-6">
      <div className="max-w-6xl mx-auto">
        <div className="flex justify-between items-center mb-8">
          <h1 className="text-3xl font-bold">CX Switch — Trendline Breaks</h1>
          <div className="flex items-center gap-4">
            {marketStale && (
              <span className="px-3 py-1 bg-yellow-600 rounded text-sm">⚠️ Stale market data</span>
            )}
            <span className="text-xs text-gray-500">
              Fetches: {fetchCount} | Last: {lastMarketUpdate ? new Date(lastMarketUpdate).toLocaleTimeString() : "never"}
            </span>
          </div>
        </div>

        <div className="mb-6 p-4 bg-gray-800 rounded-lg border border-gray-700">
          <div className="flex justify-between items-center">
            <div>
              <span className="text-gray-400 text-sm">Account</span>
              <p className="text-2xl font-bold">${ACCOUNT_BALANCE.toLocaleString()}</p>
            </div>
            <div>
              <span className="text-gray-400 text-sm">Risk/Trade</span>
              <p className="text-xl font-bold text-yellow-400">{(RISK_PER_TRADE * 100).toFixed(0)}%</p>
            </div>
            <div>
              <span className="text-gray-400 text-sm">Max Risk</span>
              <p className="text-xl font-bold text-red-400">${(ACCOUNT_BALANCE * RISK_PER_TRADE).toFixed(0)}</p>
            </div>
          </div>
        </div>

        <div className="grid grid-cols-1 md:grid-cols-3 gap-6">
          {PAIRS.map((pair) => {
            const signal = signals[pair];
            const market = marketData[pair];
            const hasSignal = !!signal;
            const signalFresh = signal && (now - signal.timestamp < SIGNAL_STALE_MS);

            const positionSize = hasSignal && signalFresh 
              ? calcPositionSize(signal.entry, signal.stop, signal.direction)
              : 0;
            const stopPercent = hasSignal && signalFresh
              ? (Math.abs(signal.stop - signal.entry) / signal.entry * 100).toFixed(2)
              : "0";

            return (
              <div
                key={pair}
                className={`rounded-lg p-6 border-2 transition-all ${
                  hasSignal && signalFresh
                    ? signal.direction === "LONG"
                      ? "border-green-500 bg-green-900/20"
                      : "border-red-500 bg-red-900/20"
                    : "border-gray-600 bg-gray-800"
                }`}
              >
                <div className="flex justify-between items-start mb-4">
                  <div>
                    <h2 className="text-xl font-bold">{pair}/USD</h2>
                    {market ? (
                      <p className="text-2xl font-mono mt-1">
                        ${market.price >= 10000 
                          ? Math.round(market.price).toLocaleString() 
                          : market.price.toFixed(2)}
                      </p>
                    ) : (
                      <p className="text-lg text-gray-500 mt-1">—</p>
                    )}
                  </div>
                  {hasSignal && signalFresh ? (
                    <span className={`px-2 py-1 rounded text-sm font-bold ${
                      signal.type === "PRIMARY" ? "bg-yellow-500 text-black" : "bg-purple-500 text-white"
                    }`}>
                      {signal.type}
                    </span>
                  ) : (
                    <span className="px-2 py-1 rounded text-sm bg-gray-600 text-gray-300">WAIT</span>
                  )}
                </div>

                {market ? (
                  <div className="grid grid-cols-2 gap-2 mb-4 p-3 bg-gray-900/50 rounded">
                    <div className="flex justify-between">
                      <span className="text-gray-400 text-sm">Structure</span>
                      <span className={`text-sm font-medium ${
                        market.structure === "UPTREND" ? "text-green-400" :
                        market.structure === "DOWNTREND" ? "text-red-400" : "text-yellow-400"
                      }`}>{market.structure}</span>
                    </div>
                    <div className="flex justify-between">
                      <span className="text-gray-400 text-sm">ADX</span>
                      <span className="text-sm font-medium">{market.adx.toFixed(1)}</span>
                    </div>
                    <div className="flex justify-between">
                      <span className="text-gray-400 text-sm">RSI</span>
                      <span className="text-sm font-medium">{market.rsi.toFixed(1)}</span>
                    </div>
                    <div className="flex justify-between">
                      <span className="text-gray-400 text-sm">Stoch K/D</span>
                      <span className="text-sm font-medium">{market.stochK.toFixed(1)}/{market.stochD.toFixed(1)}</span>
                    </div>
                  </div>
                ) : (
                  <div className="mb-4 p-3 bg-gray-900/50 rounded text-center text-gray-500 text-sm">
                    No market data yet
                  </div>
                )}

                {hasSignal && signalFresh ? (
                  <div className="space-y-2 border-t border-gray-700 pt-4">
                    <div className="flex justify-between">
                      <span className="text-gray-400">Direction</span>
                      <span className={`font-bold ${signal.direction === "LONG" ? "text-green-400" : "text-red-400"}`}>
                        {signal.direction}
                      </span>
                    </div>
                    <div className="flex justify-between">
                      <span className="text-gray-400">Confidence</span>
                      <span className="font-bold">{signal.confidence}%</span>
                    </div>
                    <div className="flex justify-between bg-gray-900/70 p-2 rounded">
                      <span className="text-gray-400">Position Size</span>
                      <span className="font-bold text-yellow-400">${positionSize.toLocaleString()}</span>
                    </div>
                    <div className="flex justify-between">
                      <span className="text-gray-400">Entry</span>
                      <span className="font-mono">${signal.entry.toFixed(2)}</span>
                    </div>
                    <div className="flex justify-between">
                      <span className="text-gray-400">Stop ({stopPercent}%)</span>
                      <span className="font-mono text-red-400">${signal.stop.toFixed(2)}</span>
                    </div>
                    <div className="flex justify-between">
                      <span className="text-gray-400">Target</span>
                      <span className="font-mono text-green-400">${signal.target.toFixed(2)}</span>
                    </div>
                    <div className="flex justify-between">
                      <span className="text-gray-400">R:R</span>
                      <span className="font-bold">{signal.rr.toFixed(2)}</span>
                    </div>
                    <div className="flex justify-between">
                      <span className="text-gray-400">Expected Move</span>
                      <span className={`font-bold ${signal.direction === "LONG" ? "text-green-400" : "text-red-400"}`}>
                        {signal.direction === "LONG" ? "+" : "-"}{Math.abs(signal.expectedMove).toFixed(2)}%
                      </span>
                    </div>
                    <div className="mt-3 pt-3 border-t border-gray-700">
                      <p className="text-xs text-gray-300 leading-relaxed">{signal.reason}</p>
                    </div>
                    <div className="mt-1 text-xs text-gray-500">
                      {new Date(signal.timestamp).toLocaleString()}
                    </div>
                  </div>
                ) : hasSignal && !signalFresh ? (
                  <div className="text-center py-4 border-t border-gray-700">
                    <p className="text-yellow-400 text-sm">⏳ Signal expired — waiting for new setup</p>
                    <p className="text-xs text-gray-500 mt-1">
                      Last: {signal?.direction} @ ${signal?.entry?.toFixed(2)} ({new Date(signal!.timestamp).toLocaleTimeString()})
                    </p>
                  </div>
                ) : (
                  <div className="text-center py-4 border-t border-gray-700">
                    <p className="text-gray-400 text-sm">No active trendline break</p>
                    <p className="text-xs text-gray-500 mt-1">Monitoring for setup...</p>
                  </div>
                )}
              </div>
            );
          })}
        </div>

        <div className="mt-8 p-4 bg-gray-800 rounded-lg">
          <h3 className="font-bold mb-2">How it works</h3>
          <ul className="text-sm text-gray-400 space-y-1">
            <li>• Cron runs every hour — market data always displayed</li>
            <li>• Trade signals cached in UI for 4h (survives serverless cold starts)</li>
            <li>• Stops: 2.5× ATR | PRIMARY: ADX &gt; 25 | Close confirmation required</li>
            <li>• Max 1 signal per direction per run (correlation protection)</li>
            <li>• Position size: Risk {(RISK_PER_TRADE * 100).toFixed(0)}% = ${(ACCOUNT_BALANCE * RISK_PER_TRADE).toFixed(0)} per trade</li>
          </ul>
        </div>
      </div>
    </div>
  );
}
