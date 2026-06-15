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

interface HoldAdvice {
  shouldHold: boolean;
  reason: string;
  trailingStop: number | null;
  trendHealth: "STRONG" | "MODERATE" | "WEAK" | "NONE";
}

interface Signal extends MarketData {
  direction: "LONG" | "SHORT";
  type: "BREAKOUT" | "PULLBACK" | "CONTINUATION" | "REVERSAL" | "SWEEP" | "EARLY";
  confidence: number;
  entry: number;
  stop: number;
  target: number;
  rr: number;
  reason: string;
  timestamp: number;
  expectedMove: number;
  holdAdvice?: HoldAdvice;
}

const PAIRS = ["BTC", "ETH", "SOL"];
const SIGNAL_STALE_MS = 6 * 60 * 60 * 1000;
const MARKET_STALE_MS = 70 * 60 * 1000;

export default function Dashboard() {
  const [signals, setSignals] = useState<Record<string, Signal | null>>({});
  const [marketData, setMarketData] = useState<Record<string, MarketData>>({});
  const [lastSignalUpdate, setLastSignalUpdate] = useState<number>(0);
  const [lastMarketUpdate, setLastMarketUpdate] = useState<number>(0);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [fetchCount, setFetchCount] = useState(0);

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

        for (const md of data.marketData || []) {
          if (md && md.pair) newMarketMap[md.pair] = md;
        }

        for (const pair of PAIRS) {
          const incoming = data.signals?.find((s: Signal) => s.pair === pair);
          if (incoming && now - incoming.timestamp < SIGNAL_STALE_MS) {
            newSignalMap[pair] = incoming;
            if (incoming.timestamp > latestSignalTs) latestSignalTs = incoming.timestamp;
          } else {
            newSignalMap[pair] = null;
          }
        }

        setSignals(newSignalMap);
        setMarketData(newMarketMap);
        setLastMarketUpdate(now);
        if (latestSignalTs > 0) setLastSignalUpdate(latestSignalTs);
        setFetchCount(c => c + 1);
      } catch (err) {
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

        {/* HEADER */}
        <div className="flex justify-between items-center mb-8">
          <h1 className="text-3xl font-bold">CX Switch — THE TRAP</h1>
          <div className="flex items-center gap-4">
            {marketStale && (
              <span className="px-3 py-1 bg-yellow-600 rounded text-sm">
                ⚠️ Stale market data
              </span>
            )}
            <span className="text-xs text-gray-500">
              Fetches: {fetchCount} | Last:{" "}
              {lastMarketUpdate ? new Date(lastMarketUpdate).toLocaleTimeString() : "never"}
            </span>
          </div>
        </div>

        {/* 🔥 REMOVED ACCOUNT PANEL — SPACE PRESERVED */}
        <div className="mb-6 h-24" />

        {/* GRID */}
        <div className="grid grid-cols-1 md:grid-cols-3 gap-6">
          {PAIRS.map((pair) => {
            const signal = signals[pair];
            const market = marketData[pair];
            const hasSignal = !!signal;
            const signalFresh = signal && (now - signal.timestamp < SIGNAL_STALE_MS);

            return (
              <div key={pair} className="rounded-lg p-6 border-2 bg-gray-800 border-gray-600">
                <h2 className="text-xl font-bold">{pair}/USD</h2>

                <div className="mt-4 text-sm text-gray-400">
                  {market ? (
                    <>
                      <div>Price: ${market.price}</div>
                      <div>Structure: {market.structure}</div>
                      <div>ADX: {market.adx}</div>
                      <div>RSI: {market.rsi}</div>
                    </>
                  ) : (
                    "No market data"
                  )}
                </div>

                <div className="mt-4 border-t border-gray-700 pt-3 text-sm">
                  {hasSignal && signalFresh ? (
                    <>
                      <div className="text-green-400 font-bold">{signal.type} {signal.direction}</div>
                      <div>Confidence: {signal.confidence}%</div>
                      <div>Entry: ${signal.entry}</div>
                      <div>Target: ${signal.target}</div>
                      <div>R:R: {signal.rr}</div>
                    </>
                  ) : (
                    <div className="text-gray-400">No active setup</div>
                  )}
                </div>
              </div>
            );
          })}
        </div>
      </div>
    </div>
  );
}
