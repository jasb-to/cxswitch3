"use client";

import { useEffect, useState } from "react";

interface MarketData {
  pair: string;
  price: number;
  structure: string;
  adx: number;
  rsi: number;
  stochK: number;
  stochD: number;
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
  timestamp: number;
  expectedMove: number;
}

const PAIRS = ["BTC", "ETH", "SOL"];
const STALE_THRESHOLD = 70 * 60 * 1000;

export default function Dashboard() {
  const [signals, setSignals] = useState<Record<string, Signal | null>>({});
  const [marketData, setMarketData] = useState<Record<string, MarketData>>({});
  const [lastUpdate, setLastUpdate] = useState<number>(0);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    async function fetchData() {
      try {
        const res = await fetch("/api/signals");
        if (!res.ok) throw new Error("Failed to fetch");
        const data = await res.json();

        const signalMap: Record<string, Signal | null> = {};
        const marketMap: Record<string, MarketData> = {};
        let latestTimestamp = 0;

        for (const md of data.marketData || []) {
          marketMap[md.pair] = md;
        }

        for (const pair of PAIRS) {
          const signal = data.signals?.find((s: Signal) => s.pair === pair);
          signalMap[pair] = signal || null;
          if (signal?.timestamp > latestTimestamp) {
            latestTimestamp = signal.timestamp;
          }
        }

        setSignals(signalMap);
        setMarketData(marketMap);
        setLastUpdate(latestTimestamp || Date.now());
      } catch (err) {
        setError(err instanceof Error ? err.message : "Unknown error");
      } finally {
        setLoading(false);
      }
    }

    fetchData();
    const interval = setInterval(fetchData, 60000);
    return () => clearInterval(interval);
  }, []);

  const now = Date.now();
  const isStale = now - lastUpdate > STALE_THRESHOLD;

  if (loading) {
    return (
      <div className="min-h-screen bg-gray-900 text-white flex items-center justify-center">
        <div className="text-xl">Loading...</div>
      </div>
    );
  }

  if (error) {
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
          <h1 className="text-3xl font-bold">CX Switch</h1>
          <div className="flex items-center gap-4">
            {isStale && (
              <span className="px-3 py-1 bg-yellow-600 rounded text-sm">⚠️ Stale data</span>
            )}
            <span className="text-sm text-gray-400">
              {lastUpdate ? new Date(lastUpdate).toLocaleTimeString() : "No data"}
            </span>
          </div>
        </div>

        <div className="grid grid-cols-1 md:grid-cols-3 gap-6">
          {PAIRS.map((pair) => {
            const signal = signals[pair];
            const market = marketData[pair];
            const pairStale = !signal || (now - (signal?.timestamp ?? 0) > STALE_THRESHOLD);
            const hasSignal = !!signal && !pairStale;

            return (
              <div
                key={pair}
                className={`rounded-lg p-6 border-2 ${
                  hasSignal
                    ? signal.direction === "LONG"
                      ? "border-green-500 bg-green-900/20"
                      : "border-red-500 bg-red-900/20"
                    : "border-gray-600 bg-gray-800"
                }`}
              >
                <div className="flex justify-between items-start mb-4">
                  <div>
                    <h2 className="text-xl font-bold">{pair}/USD</h2>
                    {market && (
                      <p className="text-2xl font-mono mt-1">
                        ${market.price >= 10000 ? Math.round(market.price).toLocaleString() : market.price.toFixed(2)}
                      </p>
                    )}
                  </div>
                  {hasSignal ? (
                    <span className={`px-2 py-1 rounded text-sm font-bold ${
                      signal.type === "PRIMARY" ? "bg-yellow-500 text-black" : "bg-purple-500 text-white"
                    }`}>
                      {signal.type}
                    </span>
                  ) : (
                    <span className="px-2 py-1 rounded text-sm bg-gray-600 text-gray-300">WAIT</span>
                  )}
                </div>

                {market && (
                  <div className="grid grid-cols-2 gap-2 mb-4 p-3 bg-gray-900/50 rounded">
                    <div className="flex justify-between">
                      <span className="text-gray-400 text-sm">Structure</span>
                      <span className="text-sm font-medium">{market.structure}</span>
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
                )}

                {hasSignal ? (
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
                    <div className="flex justify-between">
                      <span className="text-gray-400">Entry</span>
                      <span className="font-mono">${signal.entry.toFixed(2)}</span>
                    </div>
                    <div className="flex justify-between">
                      <span className="text-gray-400">Stop</span>
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
                ) : (
                  <div className="text-center py-4">
                    <p className="text-gray-400 text-sm">
                      {signal ? "Signal expired — waiting for new setup" : "No trendline break detected"}
                    </p>
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
            <li>• Trade signals appear only on valid trendline breaks</li>
            <li>• PRIMARY: 4h cooldown | CHEEKY: 8h cooldown</li>
            <li>• Anti-whipsaw: opposite direction blocked for 2h</li>
            <li>• Trendlines need 10+ bars age for PRIMARY signals</li>
            <li>• Need 60%+ confidence and 1.5+ R:R</li>
          </ul>
        </div>
      </div>
    </div>
  );
}
