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
    const t = setInterval(load, 120000);
    return () => clearInterval(t);
  }, []);

  const statusColor = (state: string) => {
    if (state === "PRIMARY") return "border-emerald-500";
    if (state === "CHEEKY") return "border-amber-500";
    return "border-neutral-700";
  };

  const readiness = (c: number) => Math.min(100, Math.max(20, c || 20));

  const tierBadge = (state: string) => {
    if (state === "PRIMARY") {
      return { label: "PRIMARY", color: "bg-emerald-500/20 text-emerald-400 border-emerald-500/30" };
    }
    if (state === "CHEEKY") {
      return { label: "CHEEKY", color: "bg-amber-500/20 text-amber-400 border-amber-500/30" };
    }
    return { label: "WAIT", color: "bg-neutral-700 text-neutral-400 border-neutral-600" };
  };

  const confidenceColor = (c: number) => {
    if (c >= 80) return "text-emerald-400";
    if (c >= 60) return "text-yellow-400";
    if (c >= 40) return "text-orange-400";
    return "text-red-400";
  };

  const barColor = (state: string) => {
    if (state === "PRIMARY") return "bg-emerald-500";
    if (state === "CHEEKY") return "bg-amber-500";
    return "bg-neutral-600";
  };

  return (
    <main className="min-h-screen bg-black text-white px-4 sm:px-6 lg:px-10 py-8">
      {/* HEADER */}
      <div className="flex items-center justify-between mb-6">
        <h1 className="text-2xl font-bold">CX Switch</h1>
        <span className="text-xs text-neutral-500">
          {signals.length} pairs · {signals.filter(s => s.state !== "WAIT").length} active
        </span>
      </div>

      {/* GRID */}
      <div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-3 gap-6">
        {signals.map((s) => {
          const tier = tierBadge(s.state);
          const isWait = s.state === "WAIT";
          
          return (
            <div
              key={s.symbol}
              className={`bg-[#111] border-l-4 ${statusColor(
                s.state
              )} rounded-xl p-5 hover:brightness-110 transition`}
            >
              {/* TOP */}
              <div className="flex justify-between items-center">
                <div className="flex items-center gap-2">
                  <h2 className="text-xl font-bold">
                    {s.symbol}
                  </h2>
                  {!isWait && (
                    <span className={`text-[10px] px-1.5 py-0.5 rounded border ${tier.color}`}>
                      {tier.label}
                    </span>
                  )}
                </div>

                <span className="text-xs px-2 py-1 rounded bg-neutral-800 text-neutral-300">
                  {s.state}
                </span>
              </div>

              <div className="mt-1 text-lg font-mono text-neutral-400">
                ${s.price}
              </div>

              {/* CORE METRICS */}
              <div className="mt-4 space-y-1.5 text-sm text-neutral-300">

                <div className="flex justify-between">
                  <span>Bias</span>
                  <span className={`font-medium ${s.bias === "LONG" ? "text-emerald-400" : s.bias === "SHORT" ? "text-rose-400" : "text-neutral-400"}`}>
                    {s.bias}
                  </span>
                </div>

                <div className="flex justify-between">
                  <span>Confidence</span>
                  <span className={`font-bold ${confidenceColor(s.confidence)}`}>
                    {s.confidence}%
                  </span>
                </div>

                <div className="flex justify-between">
                  <span>RSI</span>
                  <span className="text-white">{s.rsi}</span>
                </div>

                <div className="flex justify-between">
                  <span>Stoch K/D</span>
                  <span className="text-white">
                    {s.stochK} / {s.stochD}
                  </span>
                </div>

                <div className="flex justify-between">
                  <span>ADX</span>
                  <span className="text-white">{s.adx}</span>
                </div>

                <div className="pt-1">
                  <span className="text-neutral-500 text-xs">Reason</span>
                  <p className="text-white text-xs leading-relaxed mt-0.5 font-mono">
                    {s.reason}
                  </p>
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
                    className={`h-1.5 rounded ${barColor(s.state)}`}
                    style={{ width: `${readiness(s.confidence)}%` }}
                  />
                </div>
              </div>

              {/* TRADE DETAILS */}
              {!isWait && (
                <div className="mt-5 border-t border-neutral-700 pt-4 space-y-1.5 text-sm">

                  <div className="flex justify-between">
                    <span className="text-neutral-400">Entry</span>
                    <span className="text-white font-mono">${s.price}</span>
                  </div>

                  <div className="flex justify-between">
                    <span className="text-neutral-400">SL</span>
                    <span className="text-rose-400 font-mono">{s.stopLoss ?? "-"}</span>
                  </div>

                  <div className="flex justify-between">
                    <span className="text-neutral-400">TP</span>
                    <span className="text-emerald-400 font-mono">{s.takeProfit ?? "-"}</span>
                  </div>

                  <div className="flex justify-between">
                    <span className="text-neutral-400">RR</span>
                    <span className={`font-mono font-bold ${(s.rr ?? 0) >= 2 ? "text-emerald-400" : "text-yellow-400"}`}>
                      {s.rr ?? "-"}
                    </span>
                  </div>

                  <div className="flex justify-between">
                    <span className="text-neutral-400">Expected Move</span>
                    <span className="text-white font-mono">{s.expectedMove}%</span>
                  </div>
                </div>
              )}

              {/* TIMESTAMP */}
              <div className="text-xs text-neutral-600 mt-4 text-right">
                {s.updatedAt}
              </div>
            </div>
          );
        })}
      </div>
    </main>
  );
}
