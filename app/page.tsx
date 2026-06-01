"use client";

import { useEffect, useState } from "react";
import type { Signal } from "@/lib/strategy";

export default function Home() {
  const [signals, setSignals] = useState<Signal[]>([]);
  const [loading, setLoading] = useState(false);
  const [lastUpdate, setLastUpdate] = useState("");

  async function fetchSignals() {
    try {
      setLoading(true);

      const res = await fetch("/api/signals");
      const data = await res.json();

      setSignals(data.signals || []);
      setLastUpdate(new Date().toLocaleTimeString());
    } finally {
      setLoading(false);
    }
  }

  useEffect(() => {
    fetchSignals();
    const i = setInterval(fetchSignals, 60000);
    return () => clearInterval(i);
  }, []);

  return (
    <main className="min-h-screen bg-black text-white">
      <div className="max-w-7xl mx-auto px-8 py-10">

        <h1 className="text-5xl font-bold mb-2">CX Switch</h1>
        <p className="text-gray-400 mb-8">
          Market Structure • Compression • Breakout Engine
        </p>

        {/* LEGEND */}
        <div className="grid grid-cols-3 gap-4 mb-10">
          <div className="p-4 border border-purple-500/30 rounded">
            🟣 EARLY
          </div>
          <div className="p-4 border border-yellow-500/30 rounded">
            🟡 SETUP
          </div>
          <div className="p-4 border border-green-500/30 rounded">
            🟢 SNIPER
          </div>
        </div>

        {/* SIGNALS */}
        <div className="grid md:grid-cols-2 lg:grid-cols-3 gap-6">
          {signals.map((s) => {
            const state = s.isSniper
              ? "SNIPER"
              : s.isSetup
              ? "SETUP"
              : s.isEarly
              ? "EARLY"
              : "WAIT";

            const color = s.isSniper
              ? "text-green-400"
              : s.isSetup
              ? "text-yellow-400"
              : s.isEarly
              ? "text-purple-400"
              : "text-gray-500";

            return (
              <div key={s.symbol} className="border p-5 rounded bg-white/5">
                <div className="flex justify-between mb-3">
                  <h2 className="text-2xl">{s.symbol}</h2>
                  <span className={color}>{state}</span>
                </div>

                <p className="text-gray-400 mb-3">
                  ${s.price.toLocaleString()}
                </p>

                <div className="text-sm space-y-1">
                  <p>Bias: {s.bias}</p>
                  <p>Confidence: {s.confidence}%</p>
                  <p>ADX: {s.adx.toFixed(1)}</p>
                  <p>Stoch: {s.stochK.toFixed(1)}</p>
                </div>

                <div className="mt-3 text-sm">
                  <p>SL: {s.stopLoss?.toFixed(2) ?? "—"}</p>
                  <p>TP: {s.takeProfit?.toFixed(2) ?? "—"}</p>
                  <p>R/R: {s.riskRewardRatio ?? "—"}</p>
                </div>

                <p className="mt-3 text-xs text-gray-500">
                  {s.reason}
                </p>
              </div>
            );
          })}
        </div>

        <p className="mt-10 text-sm text-gray-500">
          Last update: {lastUpdate}
        </p>
      </div>
    </main>
  );
}
