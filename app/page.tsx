"use client";

import { useEffect, useMemo, useState } from "react";

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

interface Signal {
  pair: string;
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

const ACCOUNT_BALANCE = 850;
const RISK_PER_TRADE = 0.02;

const money = (n: number) =>
  new Intl.NumberFormat("en-US", {
    style: "currency",
    currency: "USD",
    maximumFractionDigits: 2,
  }).format(n);

const round = (n: number, d = 2) => {
  if (!isFinite(n)) return 0;
  const m = Math.pow(10, d);
  return Math.round(n * m) / m;
};

function calcPositionSize(entry: number, stop: number): number {
  const riskAmount = ACCOUNT_BALANCE * RISK_PER_TRADE;
  const stopDistance = Math.abs(entry - stop);
  if (stopDistance === 0) return 0;
  return Math.round(riskAmount / stopDistance);
}

export default function Dashboard() {
  const [signals, setSignals] = useState<Record<string, Signal | null>>({});
  const [marketData, setMarketData] = useState<Record<string, MarketData>>({});
  const [fetchCount, setFetchCount] = useState(0);
  const [lastUpdate, setLastUpdate] = useState(0);
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    async function load() {
      try {
        const res = await fetch("/api/signals");
        const data = await res.json();

        const signalMap: Record<string, Signal | null> = {};
        const marketMap: Record<string, MarketData> = {};

        for (const m of data.marketData || []) {
          if (m?.pair) marketMap[m.pair] = m;
        }

        for (const p of PAIRS) {
          const sig = data.signals?.find((s: Signal) => s.pair === p);
          signalMap[p] = sig || null;
        }

        setSignals(signalMap);
        setMarketData(marketMap);
        setFetchCount((c) => c + 1);
        setLastUpdate(Date.now());
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

  const fmtPrice = (n?: number) =>
    n ? money(round(n, 2)) : "—";

  const now = Date.now();

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

        {/* HEADER */}
        <div className="flex justify-between mb-6">
          <h1 className="text-2xl font-bold">CX Switch v3</h1>
          <div className="text-xs text-gray-400">
            Fetches: {fetchCount} | Last:{" "}
            {lastUpdate ? new Date(lastUpdate).toLocaleTimeString() : "never"}
          </div>
        </div>

        {/* CARDS */}
        <div className="grid md:grid-cols-3 gap-6">

          {PAIRS.map((pair) => {
            const signal = signals[pair];
            const market = marketData[pair];

            const hasSignal = !!signal;

            const entry = signal ? round(signal.entry) : 0;
            const stop = signal ? round(signal.stop) : 0;
            const target = signal ? round(signal.target) : 0;

            const positionSize =
              signal ? calcPositionSize(entry, stop) : 0;

            return (
              <div key={pair} className="bg-gray-800 p-5 rounded-lg border border-gray-700">

                {/* TOP */}
                <div className="flex justify-between">
                  <div>
                    <div className="text-lg font-bold">{pair}/USD</div>
                    <div className="text-xl font-mono">
                      {fmtPrice(market?.price)}
                    </div>
                  </div>

                  <div className="text-sm px-2 py-1 bg-gray-700 rounded">
                    {signal ? signal.type : "WAIT"}
                  </div>
                </div>

                {/* MARKET */}
                <div className="mt-4 text-sm text-gray-300 space-y-1">
                  <div>Structure: {market?.structure ?? "—"}</div>
                  <div>ADX: {market ? round(market.adx) : "—"}</div>
                  <div>RSI: {market ? round(market.rsi) : "—"}</div>
                  <div>
                    Stoch:{" "}
                    {market
                      ? `${round(market.stochK)}/${round(market.stochD)}`
                      : "—"}
                  </div>
                </div>

                {/* SIGNAL (ALWAYS SHOW IF EXISTS) */}
                {signal ? (
                  <div className="mt-5 border-t border-gray-700 pt-4 space-y-2">

                    <div className="flex justify-between">
                      <span>Direction</span>
                      <span className={signal.direction === "LONG" ? "text-green-400" : "text-red-400"}>
                        {signal.direction}
                      </span>
                    </div>

                    <div className="flex justify-between">
                      <span>Confidence</span>
                      <span>{round(signal.confidence)}%</span>
                    </div>

                    <div className="flex justify-between">
                      <span>Entry</span>
                      <span>{money(entry)}</span>
                    </div>

                    <div className="flex justify-between">
                      <span>Stop</span>
                      <span className="text-red-400">{money(stop)}</span>
                    </div>

                    <div className="flex justify-between">
                      <span>Target</span>
                      <span className="text-green-400">{money(target)}</span>
                    </div>

                    <div className="flex justify-between">
                      <span>R:R</span>
                      <span>{round(signal.rr, 2)}</span>
                    </div>

                    <div className="flex justify-between bg-gray-900 p-2 rounded">
                      <span>Position Size</span>
                      <span className="text-yellow-400">
                        ${positionSize.toLocaleString()}
                      </span>
                    </div>

                    <div className="text-xs text-gray-400 mt-2">
                      {signal.reason}
                    </div>

                    <div className="text-xs text-gray-500">
                      {new Date(signal.timestamp).toLocaleString()}
                    </div>
                  </div>
                ) : (
                  <div className="mt-5 text-gray-500 text-sm border-t border-gray-700 pt-4">
                    No active setup — monitoring 4H + 1H structure
                  </div>
                )}

              </div>
            );
          })}

        </div>

        {/* FOOTER */}
        <div className="mt-8 text-xs text-gray-500">
          Risk per trade: {(RISK_PER_TRADE * 100).toFixed(0)}% • Account: {money(ACCOUNT_BALANCE)}
        </div>

      </div>
    </div>
  );
}
