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

/* -----------------------------
   FORMAT HELPERS
------------------------------*/
function fmtPrice(n: number) {
  return `$${Number(n.toFixed(2)).toLocaleString()}`;
}

function fmtNum(n: number) {
  return Number(n.toFixed(2));
}

function fmtInd(n: number) {
  return Number(n.toFixed(1));
}

/* -----------------------------
   MAIN DASHBOARD
------------------------------*/
export default function Dashboard() {
  const [signals, setSignals] = useState<Record<string, Signal | null>>({});
  const [marketData, setMarketData] = useState<Record<string, MarketData>>({});
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

        const newSignals: Record<string, Signal | null> = {};
        const newMarket: Record<string, MarketData> = {};

        for (const md of data.marketData || []) {
          if (md?.pair) newMarket[md.pair] = md;
        }

        for (const pair of PAIRS) {
          const sig = data.signals?.find((s: Signal) => s.pair === pair);

          if (sig && now - sig.timestamp < SIGNAL_STALE_MS) {
            newSignals[pair] = sig;
          } else {
            newSignals[pair] = null;
          }
        }

        setSignals(newSignals);
        setMarketData(newMarket);
        setLastMarketUpdate(now);
        setFetchCount((c) => c + 1);
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
        Loading signals...
      </div>
    );
  }

  if (error && fetchCount === 0) {
    return (
      <div className="min-h-screen bg-gray-900 text-white flex items-center justify-center text-red-400">
        Error: {error}
      </div>
    );
  }

  return (
    <div className="min-h-screen bg-gray-900 text-white p-6">
      <div className="max-w-6xl mx-auto">

        {/* HEADER */}
        <div className="flex justify-between items-center mb-8">
          <h1 className="text-3xl font-bold">CX Switch</h1>

          <div className="text-xs text-gray-500">
            Fetches: {fetchCount} | Last:{" "}
            {lastMarketUpdate
              ? new Date(lastMarketUpdate).toLocaleTimeString()
              : "never"}
          </div>
        </div>

        {/* SPACER (replaces removed account panel) */}
        <div className="h-24 mb-6" />

        {/* GRID */}
        <div className="grid grid-cols-1 md:grid-cols-3 gap-6">
          {PAIRS.map((pair) => {
            const signal = signals[pair];
            const market = marketData[pair];
            const active = !!signal;

            return (
              <div
                key={pair}
                className="rounded-lg p-6 border bg-gray-800 border-gray-700"
              >
                {/* TOP */}
                <div className="flex justify-between items-start">
                  <div>
                    <h2 className="text-xl font-bold">{pair}/USD</h2>
                    <p className="text-2xl font-mono mt-1">
                      {market ? fmtPrice(market.price) : "—"}
                    </p>
                  </div>

                  <span className="px-2 py-1 text-xs rounded bg-gray-700 text-gray-300">
                    {active ? signal!.type : "WAIT"}
                  </span>
                </div>

                {/* MARKET */}
                <div className="mt-4 p-3 bg-gray-900/50 rounded text-sm">
                  {market ? (
                    <>
                      <div>Structure: {market.structure}</div>
                      <div>ADX: {fmtInd(market.adx)}</div>
                      <div>RSI: {fmtInd(market.rsi)}</div>
                      <div>Stoch: {fmtInd(market.stochK)}/{fmtInd(market.stochD)}</div>
                    </>
                  ) : (
                    <div className="text-gray-500">No market data</div>
                  )}
                </div>

                {/* SIGNAL */}
                {active ? (
                  <div className="mt-4 border-t border-gray-700 pt-4 space-y-2 text-sm">

                    <div className="flex justify-between">
                      <span className="text-gray-400">Direction</span>
                      <span className={signal!.direction === "LONG" ? "text-green-400 font-bold" : "text-red-400 font-bold"}>
                        {signal!.direction}
                      </span>
                    </div>

                    <div className="flex justify-between">
                      <span className="text-gray-400">Confidence</span>
                      <span>{fmtInd(signal!.confidence)}%</span>
                    </div>

                    <div className="flex justify-between">
                      <span className="text-gray-400">Entry</span>
                      <span>{fmtPrice(signal!.entry)}</span>
                    </div>

                    <div className="flex justify-between">
                      <span className="text-gray-400">Stop</span>
                      <span className="text-red-400">{fmtPrice(signal!.stop)}</span>
                    </div>

                    <div className="flex justify-between">
                      <span className="text-gray-400">Target</span>
                      <span className="text-green-400">{fmtPrice(signal!.target)}</span>
                    </div>

                    <div className="flex justify-between">
                      <span className="text-gray-400">R:R</span>
                      <span>{fmtNum(signal!.rr)}</span>
                    </div>

                    <div className="flex justify-between">
                      <span className="text-gray-400">Expected</span>
                      <span>
                        {signal!.direction === "LONG" ? "+" : "-"}
                        {fmtInd(signal!.expectedMove)}%
                      </span>
                    </div>

                    <div className="text-xs text-gray-400 mt-2">
                      {signal!.reason}
                    </div>

                    <div className="text-xs text-gray-500">
                      {new Date(signal!.timestamp).toLocaleString()}
                    </div>
                  </div>
                ) : (
                  <div className="mt-4 border-t border-gray-700 pt-4 text-sm text-gray-400">
                    No active setup — monitoring 4H + 1H structure
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
