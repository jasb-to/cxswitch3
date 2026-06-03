"use client";

import { useEffect, useState } from "react";

export default function Home() {
  const [signals, setSignals] = useState<any[]>([]);

  async function load() {
    const res = await fetch("/api/signals", { cache: "no-store" });
    const data = await res.json();
    setSignals(data.signals || []);
  }

  useEffect(() => {
    load();
    const t = setInterval(load, 30000);
    return () => clearInterval(t);
  }, []);

  const statusColor = (state: string) => {
    if (state === "SNIPER") return "border-rose-500";
    if (state === "EARLY") return "border-orange-500";
    return "border-neutral-700";
  };

  const readiness = (c: number) => Math.min(100, Math.max(20, c || 20));

  return (
    <main className="min-h-screen bg-black text-white px-10 py-8">
      {/* HEADER */}
      <h1 className="text-2xl font-bold mb-6">CX Switch</h1>

      {/* GRID */}
      <div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-3 gap-6">
        {signals.map((s) => (
          <div
            key={s.symbol}
            className={`bg-[#111] border-l-4 ${statusColor(
              s.state
            )} rounded-xl p-5 hover:brightness-110 transition`}
          >
            {/* TOP */}
            <div className="flex justify-between items-center">
              <h2 className="text-xl font-bold">
                {s.symbol} — ${s.price}
              </h2>

              <span className="text-xs px-2 py-1 rounded bg-neutral-800 text-neutral-300">
                {s.state}
              </span>
            </div>

            {/* CORE METRICS */}
            <div className="mt-4 space-y-1 text-sm text-neutral-300">

              <div>Bias: <span className="text-white">{s.bias}</span></div>

              <div>
                Confidence:{" "}
                <span className="text-white">{s.confidence}%</span>
              </div>

              <div>
                RSI: <span className="text-white">{s.rsi}</span>
              </div>

              <div>
                Stoch K/D:{" "}
                <span className="text-white">
                  {s.stochK} / {s.stochD}
                </span>
              </div>

              <div>
                ADX: <span className="text-white">{s.adx}</span>
              </div>

              <div>
                Reason: <span className="text-white">{s.reason}</span>
              </div>
            </div>

            {/* READINESS BAR */}
            <div className="mt-4">
              <div className="flex justify-between text-xs text-neutral-400">
                <span>READINESS</span>
                <span>{readiness(s.confidence)}%</span>
              </div>

              <div className="w-full bg-neutral-800 h-1.5 rounded mt-2">
                <div
                  className={`h-1.5 rounded ${
                    s.state === "SNIPER"
                      ? "bg-rose-500"
                      : s.state === "EARLY"
                      ? "bg-orange-500"
                      : "bg-neutral-600"
                  }`}
                  style={{ width: `${readiness(s.confidence)}%` }}
                />
              </div>
            </div>

            {/* TRADE DETAILS */}
            {s.state !== "WAIT" && (
              <div className="mt-5 border-t border-neutral-700 pt-4 space-y-1 text-sm">

                <div>
                  Entry: <span className="text-white">${s.price}</span>
                </div>

                <div>
                  SL: <span className="text-white">{s.stopLoss ?? "-"}</span>
                </div>

                <div>
                  TP: <span className="text-white">{s.takeProfit ?? "-"}</span>
                </div>

                <div>
                  RR: <span className="text-white">{s.rr ?? "-"}</span>
                </div>

                <div>
                  Expected Move:{" "}
                  <span className="text-white">{s.expectedMove}%</span>
                </div>
              </div>
            )}

            {/* TIMESTAMP */}
            <div className="text-xs text-neutral-600 mt-4 text-right">
              {s.updatedAt}
            </div>
          </div>
        ))}
      </div>
    </main>
  );
}
