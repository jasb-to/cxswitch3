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

const round = (n?: number, d = 2) =>
  typeof n === "number" && isFinite(n)
    ? Math.round(n * Math.pow(10, d)) / Math.pow(10, d)
    : undefined;

function calcPositionSize(entry: number, stop: number) {
  const risk = ACCOUNT_BALANCE * RISK_PER_TRADE;
  const dist = Math.abs(entry - stop);
  if (!dist) return 0;
  return Math.round(risk / dist);
}

export default function Dashboard() {
  const [signals, setSignals] = useState<Record<string, Signal | null>>({});
  const [market, setMarket] = useState<Record<string, MarketData>>({});
  const [loading, setLoading] = useState(true);
  const [fetchCount, setFetchCount] = useState(0);

  useEffect(() => {
    async function load() {
      try {
        const res = await fetch("/api/signals");
        const data = await res.json();

        const sigMap: Record<string, Signal | null> = {};
        const mktMap: Record<string, MarketData> = {};

        for (const m of data.marketData || []) {
          if (m?.pair) mktMap[m.pair] = m;
        }

        for (const p of PAIRS) {
          sigMap[p] =
            data.signals?.find((s: Signal) => s.pair === p) || null;
        }

        setSignals(sigMap);
        setMarket(mktMap);
        setFetchCount((c) => c + 1);
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

        <div className="flex justify-between mb-6">
          <h1 className="text-2xl font-bold">CX Switch v3</h1>
          <div className="text-xs text-gray-400">
            Fetches: {fetchCount}
          </div>
        </div>

        <div className="grid md:grid-cols-3 gap-6">

          {PAIRS.map((pair) => {
            const signal = signals[pair];
            const m = market[pair];

            const hasSignal = !!signal;

            // 🔥 SIGNAL IS SOURCE OF TRUTH
            const price = m?.price ?? signal?.entry;
            const structure = m?.structure ?? signal?.type ?? "—";
            const adx = m?.adx;
            const rsi = m?.rsi;
            const stoch = m ? `${round(m.stochK)}/${round(m.stochD)}` : "—";

            const entry = signal?.entry ?? 0;
            const stop = signal?.stop ?? 0;
            const target = signal?.target ?? 0;

            const size = signal ? calcPositionSize(entry, stop) : 0;

            return (
              <div key={pair} className="bg-gray-800 p-5 rounded-lg">

                {/* HEADER */}
                <div className="flex justify-between">
                  <div>
                    <div className="font-bold">{pair}/USD</div>
                    <div className="text-xl font-mono">
                      {price ? money(price) : "—"}
                    </div>
                  </div>

                  <div className="px-2 py-1 bg-gray-700 rounded text-sm">
                    {signal ? signal.type : "WAIT"}
                  </div>
                </div>

                {/* MARKET (FIXED FALLBACKS) */}
                <div className="mt-3 text-sm space-y-1 text-gray-300">
                  <div>Structure: {structure}</div>
                  <div>ADX: {adx !== undefined ? round(adx) : "—"}</div>
                  <div>RSI: {rsi !== undefined ? round(rsi) : "—"}</div>
                  <div>Stoch: {stoch}</div>
                </div>

                {/* SIGNAL ALWAYS COMPLETE */}
                {signal ? (
                  <div className="mt-4 border-t border-gray-700 pt-4 space-y-2">

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

                    <div className="flex justify-between bg-gray-900 p-2 rounded">
                      <span>Position Size</span>
                      <span className="text-yellow-400">
                        ${size.toLocaleString()}
                      </span>
                    </div>

                    <div className="text-xs text-gray-400">
                      {signal.reason}
                    </div>

                    <div className="text-xs text-gray-500">
                      {new Date(signal.timestamp).toLocaleString()}
                    </div>

                  </div>
                ) : (
                  <div className="mt-4 text-gray-500 text-sm border-t border-gray-700 pt-4">
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
