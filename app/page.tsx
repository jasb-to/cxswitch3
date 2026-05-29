"use client";

import { useEffect, useState } from "react";

interface Signal {
  symbol: string;
  price: number;
  bias4H: string;
  bias1H: string;
  setup: "LONG" | "SHORT" | null;
  strength: string;
  emaCross: string;
  stochRSI: number;
  stochDirection: string;
  momentum: string;
  trigger: string;
  entry?: number;
  stopLoss?: number;
  takeProfit?: number;
  updatedAt: string;
}

export default function Home() {
  const [signals, setSignals] = useState<Signal[]>([]);

  async function load() {
    const res = await fetch("/api/signals", { cache: "no-store" });
    const data = await res.json();
    setSignals(data.signals || []);
  }

  useEffect(() => {
    load();
    const t = setInterval(load, 60000);
    return () => clearInterval(t);
  }, []);

  const badge = (s?: string) => {
    if (s === "LONG") return "bg-green-500 text-black";
    if (s === "SHORT") return "bg-red-500 text-white";
    return "bg-zinc-800 text-white";
  };

  return (
    <main className="min-h-screen bg-black text-white p-8">
      <h1 className="text-4xl font-bold mb-8">Switch Signals</h1>

      <div className="grid md:grid-cols-3 gap-6">
        {signals.map((s) => (
          <div key={s.symbol} className="bg-zinc-950 p-6 rounded-xl border border-zinc-800">
            <div className="flex justify-between items-center">
              <h2 className="text-2xl font-bold">{s.symbol}</h2>

              <div className={`px-3 py-1 rounded ${badge(s.setup)}`}>
                {s.setup || "WAIT"}
              </div>
            </div>

            <div className="mt-4 space-y-2 text-sm text-zinc-300">
              <div>Price: {s.price}</div>
              <div>4H: {s.bias4H}</div>
              <div>1H: {s.bias1H}</div>
              <div>EMA: {s.emaCross}</div>
              <div>Stoch: {s.stochRSI} ({s.stochDirection})</div>
              <div>Momentum: {s.momentum}</div>
              <div className="text-zinc-500 mt-2">{s.trigger}</div>
            </div>

            {s.setup && (
              <div className="mt-4 border-t border-zinc-800 pt-4 text-sm">
                <div>Entry: {s.entry}</div>
                <div className="text-red-400">SL: {s.stopLoss}</div>
                <div className="text-green-400">TP: {s.takeProfit}</div>
              </div>
            )}
          </div>
        ))}
      </div>
    </main>
  );
}
