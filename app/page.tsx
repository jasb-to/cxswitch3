"use client";

import { useEffect, useState } from "react";

interface Signal {
  pair: string;
  direction: "LONG" | "SHORT";
  type: "PRIMARY" | "CHEEKY";
  confidence: number;
  entry: number;
  stop: number;
  target: number;
  rr: number;
  reason: string;
  timestamp: number;
  structure: string;
  adx: number;
}

const PAIRS = ["BTC", "ETH", "SOL"];
const STALE_THRESHOLD = 70 * 60 * 1000;

export default function Dashboard() {
  const [signals, setSignals] = useState<Record<string, Signal | null>>({});
  const [lastUpdate, setLastUpdate] = useState<number>(0);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    async function fetchSignals() {
      try {
        const res = await fetch("/api/signals");
        if (!res.ok) throw new Error("Failed to fetch signals");
        const data = await res.json();

        const signalMap: Record<string, Signal | null> = {};
        let latestTimestamp = 0;

        for (const pair of PAIRS) {
          const signal = data.signals?.find((s: Signal) => s.pair === pair);
          signalMap[pair] = signal || null;
          if (signal?.timestamp > latestTimestamp) {
            latestTimestamp = signal.timestamp;
          }
        }

        setSignals(signalMap);
        setLastUpdate(latestTimestamp);
      } catch (err) {
        setError(err instanceof Error ? err.message : "Unknown error");
      } finally {
        setLoading(false);
      }
    }

    fetchSignals();
    const interval = setInterval(fetchSignals, 60000);
    return () => clearInterval(interval);
  }, []);

  const now = Date.now();
  const isStale = now - lastUpdate > STALE_THRESHOLD;

  if (loading) {
    return (
      <div className="min-h-screen bg-gray-900 text-white flex items-center justify-center">
        <div className="text-xl">Loading signals...</div>
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
          <h1 className="text-3xl font-bold">Trendline Break Signals</h1>
          <div className="flex items-center gap-4">
            {isStale && (
              <span className="px-3 py-1 bg-yellow-600 rounded text-sm">
                ⚠️ Stale data
              </span>
            )}
            <span className="text-sm text-gray-400">
              {lastUpdate ? new Date(lastUpdate).toLocaleTimeString() : "No data"}
            </span>
          </div>
        </div>

        <div className="grid grid-cols-1 md:grid-cols-3 gap-6">
          {PAIRS.map((pair) => {
            const signal = signals[pair];
            const pairStale = !signal || (now - signal.timestamp > STALE_THRESHOLD);

            return (
              <div
                key={pair}
                className={`rounded-lg p-6 border-2 ${
                  pairStale
                    ? "border-gray-600 bg-gray-800 opacity-60"
                    : signal?.direction === "LONG"
                    ? "border-green-500 bg-green-900/20"
                    : "border-red-500 bg-red-900/20"
                }`}
              >
                <div className="flex justify-between items-start mb-4">
                  <h2 className="text-xl font-bold">{pair}/USD</h2>
                  {signal ? (
                    <span className={`px-2 py-1 rounded text-sm font-bold ${
                      signal.type === "PRIMARY" ? "bg-yellow-500 text-black" : "bg-purple-500 text-white"
                    }`}>
                      {signal.type}
                    </span>
                  ) : (
                    <span className="px-2 py-1 rounded text-sm bg-gray-600 text-gray-300">WAIT</span>
                  )}
                </div>

                {signal && !pairStale ? (
                  <div className="space-y-2">
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
                    <div className="mt-4 pt-4 border-t border-gray-700">
                      <p className="text-sm text-gray-300">{signal.reason}</p>
                    </div>
                  </div>
                ) : (
                  <div className="text-center py-8">
                    <div className="text-4xl mb-2">⏳</div>
                    <p className="text-gray-400">
                      {pairStale && signal ? "Signal expired" : "No active signal"}
                    </p>
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
