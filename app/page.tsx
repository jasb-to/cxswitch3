"use client";

import { useEffect, useState } from "react";
import type { Signal } from "@/lib/signalEngine";

export default function Home() {
  const [signals, setSignals] = useState<Signal[]>([]);
  const [loading, setLoading] = useState(true);
  const [lastUpdate, setLastUpdate] = useState("");

  async function fetchSignals() {
    try {
      setLoading(true);

      const res = await fetch("/api/signals");
      const data = await res.json();

      setSignals(data.signals ?? []);
      setLastUpdate(new Date().toLocaleTimeString());
    } catch (err) {
      console.error("fetch error", err);
    } finally {
      setLoading(false);
    }
  }

  async function testTelegram() {
    await fetch("/api/telegram/test", { method: "POST" });
  }

  useEffect(() => {
    fetchSignals();
  }, []);

  useEffect(() => {
    const interval = setInterval(fetchSignals, 30000);
    return () => clearInterval(interval);
  }, []);

  return (
    <main className="min-h-screen bg-black text-white px-6 py-8">
      {/* HEADER */}
      <div className="mb-8">
        <h1 className="text-4xl font-bold">CX Switch</h1>
        <p className="text-gray-500">
          Market Structure • Liquidity • Breakout Engine
        </p>
      </div>

      {/* CONTROLS */}
      <div className="flex gap-3 mb-6">
        <button
          onClick={fetchSignals}
          className="px-4 py-2 bg-white text-black rounded"
        >
          {loading ? "Loading..." : "Refresh"}
        </button>

        <button
          onClick={testTelegram}
          className="px-4 py-2 border border-gray-700 rounded"
        >
          Test Telegram
        </button>

        <span className="ml-auto text-gray-500 text-sm">
          Last: {lastUpdate || "—"}
        </span>
      </div>

      {/* SIGNALS */}
      <div className="grid grid-cols-1 md:grid-cols-3 gap-4">
        {signals.map((s) => (
          <div
            key={s.symbol}
            className="border border-gray-800 rounded-xl p-5 bg-white/5"
          >
            <div className="flex justify-between items-start">
              <div>
                <div className="text-2xl font-bold">{s.symbol}</div>
                <div className="text-gray-400">
                  ${(s.price ?? 0).toLocaleString()}
                </div>
              </div>

              <div className="text-sm px-2 py-1 border rounded">
                {s.state}
              </div>
            </div>

            <div className="mt-4 space-y-1 text-sm">
              <div>Bias: {s.bias}</div>
              <div>Confidence: {s.confidence}%</div>
              <div>ADX: {s.adx.toFixed(1)}</div>
              <div>Stoch: {s.stochK.toFixed(1)}</div>
            </div>

            <div className="mt-4 text-xs text-gray-500">
              {s.reason}
            </div>

            <div className="mt-3 text-sm">
              SL: {s.stopLoss ? `$${s.stopLoss.toFixed(2)}` : "—"}
            </div>

            <div className="text-sm">
              TP: {s.takeProfit ? `$${s.takeProfit.toFixed(2)}` : "—"}
            </div>
          </div>
        ))}
      </div>
    </main>
  );
}
