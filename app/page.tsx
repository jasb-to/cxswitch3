"use client";

import { useEffect, useState } from "react";

export default function Home() {
  const [signals, setSignals] = useState<any[]>([]);
  const [lastUpdated, setLastUpdated] = useState<string>("");

  async function load() {
    const res = await fetch("/api/signals", { cache: "no-store" });
    const data = await res.json();
    setSignals(data.signals || []);
    setLastUpdated(new Date().toLocaleString());
  }

  useEffect(() => {
    load();
    const t = setInterval(load, 30000);
    return () => clearInterval(t);
  }, []);

  const statusBorder = (state: string) => {
    if (state === "SNIPER") return "border-rose-500";
    if (state === "EARLY") return "border-orange-500";
    return "border-neutral-700";
  };

  const badge = (state: string) => {
    if (state === "SNIPER") return "bg-rose-500/20 text-rose-400";
    if (state === "EARLY") return "bg-orange-500/20 text-orange-400";
    return "bg-neutral-700/30 text-neutral-400";
  };

  const readiness = (c: number) => Math.min(100, Math.max(20, c || 20));

  return (
    <main className="min-h-screen bg-[#0a0a0a] text-white p-6 font-sans">
      {/* HEADER */}
      <div className="flex justify-between items-start mb-8">
        <div>
          <h1 className="text-2xl font-bold">Trading Signals</h1>
          <p className="text-sm text-neutral-500">
            Last updated: {lastUpdated || "—"}
          </p>
        </div>

        <div className="flex gap-3">
          <button
            onClick={load}
            className="px-4 py-2 rounded-full bg-neutral-800 hover:bg-neutral-700 text-sm"
          >
            Refresh
          </button>

          <button className="px-4 py-2 rounded-full bg-neutral-900 border border-neutral-700 hover:border-neutral-500 text-sm">
            Test Alert
          </button>
        </div>
      </div>

      {/* GRID TITLE */}
      <h2 className="text-lg font-semibold mb-4">Market Overview</h2>

      {/* GRID */}
      <div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-3 gap-5">
        {signals.map((s) => (
          <div
            key={s.symbol}
            className={`bg-[#18181b] border-l-4 ${statusBorder(
              s.state
            )} rounded-xl p-5 hover:brightness-110 transition`}
          >
            {/* TOP */}
            <div className="flex justify-between items-center">
              <h2 className="text-xl font-bold">{s.symbol}</h2>

              <span className={`text-xs px-2 py-1 rounded-full ${badge(s.state)}`}>
                {s.state}
              </span>
            </div>

            <div className="text-sm text-neutral-400 mt-1">
              ${s.price}
            </div>

            {/* METRICS */}
            <div className="grid grid-cols-3 gap-3 mt-4 text-center">
              <div>
                <div className="text-xs text-neutral-500">RSI</div>
                <div className="text-sm">{s.rsi}</div>
              </div>

              <div>
                <div className="text-xs text-neutral-500">STOCH</div>
                <div className="text-sm">
                  {s.stochK} / {s.stochD}
                </div>
              </div>

              <div>
                <div className="text-xs text-neutral-500">ADX</div>
                <div className="text-sm">{s.adx}</div>
              </div>
            </div>

            {/* READINESS */}
            <div className="mt-4">
              <div className="flex justify-between text-xs text-neutral-400">
                <span>READINESS</span>
                <span>{readiness(s.confidence)}%</span>
              </div>

              <div className="w-full bg-neutral-800 h-1.5 rounded-full mt-2">
                <div
                  className={`h-1.5 rounded-full ${
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

            {/* TRADE SETUP (ONLY SNIPER) */}
            {s.state === "SNIPER" && (
              <div className="mt-5 border-t border-neutral-700 pt-4 space-y-1">
                <div className="text-sm font-semibold text-rose-400">
                  TRADE SETUP
                </div>

                <div className="text-sm">
                  <span className="text-neutral-500">Direction:</span>{" "}
                  <span
                    className={
                      s.bias === "LONG"
                        ? "text-emerald-400"
                        : "text-rose-400"
                    }
                  >
                    {s.bias}
                  </span>
                </div>

                <div className="text-sm">
                  <span className="text-neutral-500">Entry:</span>{" "}
                  <span>${s.price}</span>
                </div>

                <div className="text-sm">
                  <span className="text-neutral-500">SL:</span>{" "}
                  <span>{s.stopLoss ?? "-"}</span>
                </div>

                <div className="text-sm">
                  <span className="text-neutral-500">TP:</span>{" "}
                  <span>{s.takeProfit ?? "-"}</span>
                </div>

                <div className="text-sm">
                  <span className="text-neutral-500">RR:</span>{" "}
                  <span>{s.rr ?? "-"}</span>
                </div>

                <div className="text-sm">
                  <span className="text-neutral-500">Confidence:</span>{" "}
                  <span className="text-rose-400">
                    {s.confidence}%
                  </span>
                </div>

                <div className="text-sm text-neutral-300 mt-2">
                  {s.reason}
                </div>
              </div>
            )}

            {/* FOOTER */}
            <div className="text-[10px] text-neutral-600 mt-4 text-right">
              {s.updatedAt}
            </div>
          </div>
        ))}
      </div>
    </main>
  );
}
