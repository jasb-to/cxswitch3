# app/page.tsx

```tsx
"use client";

import { useEffect, useState } from "react";

interface Signal {
  symbol: string;
  price: number;

  change24h: number;

  bias4H: string;
  bias1H: string;

  setup: "LONG" | "SHORT" | null;

  strength: string;

  emaCross: string;

  stochRSI: number;
  stochDirection: string;

  entry?: number;
  stopLoss?: number;
  takeProfit?: number;

  momentum: string;

  trigger: string;

  updatedAt: string;
}

function price(n?: number) {
  if (!n) return "—";

  return n.toLocaleString(undefined, {
    style: "currency",
    currency: "USD",
  });
}

export default function Home() {
  const [signals, setSignals] = useState<Signal[]>([]);

  async function load() {
    const res = await fetch("/api/signals", {
      cache: "no-store",
    });

    const data = await res.json();

    setSignals(data.signals || []);
  }

  useEffect(() => {
    load();

    const interval = setInterval(load, 60000);

    return () => clearInterval(interval);
  }, []);

  return (
    <main className="min-h-screen bg-black text-white px-6 py-10">
      <div className="max-w-7xl mx-auto">
        <div className="mb-10">
          <h1 className="text-5xl font-bold tracking-tight">
            Switch Signals
          </h1>

          <p className="text-gray-500 mt-3">
            Early momentum entries using 4H trend +
            1H confirmation + 15m execution
          </p>
        </div>

        <div className="grid grid-cols-1 md:grid-cols-3 gap-6">
          {signals.map((s) => (
            <div
              key={s.symbol}
              className="bg-zinc-950 border border-zinc-800 rounded-2xl p-6"
            >
              <div className="flex items-center justify-between">
                <div>
                  <h2 className="text-3xl font-bold">
                    {s.symbol}
                  </h2>

                  <p className="text-zinc-500 text-sm mt-1">
                    {price(s.price)}
                  </p>
                </div>

                <div
                  className={`px-4 py-2 rounded-xl text-sm font-bold ${
                    s.setup === "LONG"
                      ? "bg-green-500 text-black"
                      : s.setup === "SHORT"
                      ? "bg-red-500"
                      : "bg-zinc-800"
                  }`}
                >
                  {s.setup || "WAIT"}
                </div>
              </div>

              <div className="mt-6 space-y-4">
                <div className="flex justify-between">
                  <span className="text-zinc-500">4H Bias</span>
                  <span>{s.bias4H}</span>
                </div>

                <div className="flex justify-between">
                  <span className="text-zinc-500">1H Bias</span>
                  <span>{s.bias1H}</span>
                </div>

                <div className="flex justify-between">
                  <span className="text-zinc-500">EMA Cross</span>
                  <span>{s.emaCross}</span>
                </div>

                <div className="flex justify-between">
                  <span className="text-zinc-500">
                    StochRSI
                  </span>

                  <span>
                    {s.stochRSI} ({s.stochDirection})
                  </span>
                </div>

                <div className="flex justify-between">
                  <span className="text-zinc-500">
                    Momentum
                  </span>

                  <span>{s.momentum}</span>
                </div>

                <div className="flex justify-between">
                  <span className="text-zinc-500">
                    Strength
                  </span>

                  <span>{s.strength}</span>
                </div>
              </div>

              {s.setup && (
                <div className="mt-6 border-t border-zinc-800 pt-6">
                  <div className="space-y-3">
                    <div className="flex justify-between">
                      <span className="text-zinc-500">
                        Entry
                      </span>

                      <span>{price(s.entry)}</span>
                    </div>

                    <div className="flex justify-between">
                      <span className="text-zinc-500">
                        Stop Loss
                      </span>

                      <span className="text-red-400">
                        {price(s.stopLoss)}
                      </span>
                    </div>

                    <div className="flex justify-between">
                      <span className="text-zinc-500">
                        Take Profit
                      </span>

                      <span className="text-green-400">
                        {price(s.takeProfit)}
                      </span>
                    </div>
                  </div>
                </div>
              )}

              <div className="mt-6 pt-4 border-t border-zinc-800">
                <p className="text-xs text-zinc-600">
                  {s.trigger}
                </p>
              </div>
            </div>
          ))}
        </div>
      </div>
    </main>
  );
}
```
