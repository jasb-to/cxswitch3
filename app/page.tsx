"use client";

import { useEffect, useState } from "react";
import type { Signal } from "@/lib/strategy";

type SignalState = "EARLY" | "SETUP" | "ARMED" | "SNIPER" | "WAIT";

export default function Home() {
  const [signals, setSignals] = useState<Signal[]>([]);
  const [loading, setLoading] = useState(true);
  const [lastUpdate, setLastUpdate] = useState("");

  async function fetchSignals() {
    try {
      setLoading(true);

      const res = await fetch("/api/signals");
      const data = await res.json();

      setSignals(data.signals || []);
      setLastUpdate(new Date().toLocaleTimeString());
    } catch (err) {
      console.error("Failed to fetch signals:", err);
    } finally {
      setLoading(false);
    }
  }

  useEffect(() => {
    fetchSignals();
    const interval = setInterval(fetchSignals, 60000);
    return () => clearInterval(interval);
  }, []);

  return (
    <main className="min-h-screen bg-black text-white">
      <div className="max-w-7xl mx-auto px-6 sm:px-10 lg:px-12 py-10">
        {/* HEADER */}
        <div className="mb-10">
          <h1 className="text-4xl sm:text-5xl font-bold tracking-tight">
            CX Switch
          </h1>
          <p className="text-gray-400 mt-2">
            Market Structure • Momentum • Execution Flow
          </p>
        </div>

        {/* CONTROLS */}
        <div className="flex items-center gap-3 mb-8">
          <button
            onClick={fetchSignals}
            disabled={loading}
            className="px-5 py-2 bg-white text-black rounded-lg font-semibold hover:bg-gray-200 transition disabled:opacity-50"
          >
            {loading ? "Scanning..." : "Refresh"}
          </button>

          <span className="text-sm text-gray-500 ml-auto">
            Last update: {lastUpdate || "—"}
          </span>
        </div>

        {/* FEED */}
        <div className="space-y-4">
          {signals.map((signal) => (
            <SignalRow key={signal.symbol} signal={signal} />
          ))}
        </div>
      </div>
    </main>
  );
}

/* =========================
   SIGNAL ROW
========================= */

function SignalRow({ signal }: { signal: Signal }) {
  const state = resolveState(signal);

  const border =
    state === "SNIPER"
      ? "border-green-500/40"
      : state === "ARMED"
      ? "border-blue-500/30"
      : state === "SETUP"
      ? "border-yellow-500/30"
      : state === "EARLY"
      ? "border-purple-500/30"
      : "border-gray-800";

  const glow =
    state === "SNIPER"
      ? "shadow-[0_0_25px_rgba(34,197,94,0.08)]"
      : "";

  const badge =
    state === "SNIPER"
      ? "bg-green-500/10 text-green-400 border-green-500/30"
      : state === "ARMED"
      ? "bg-blue-500/10 text-blue-400 border-blue-500/30"
      : state === "SETUP"
      ? "bg-yellow-500/10 text-yellow-400 border-yellow-500/30"
      : state === "EARLY"
      ? "bg-purple-500/10 text-purple-400 border-purple-500/30"
      : "bg-gray-800 text-gray-400 border-gray-700";

  return (
    <div
      className={`border ${border} ${glow} rounded-xl p-5 bg-gray-950/30 backdrop-blur-sm transition`}
    >
      {/* TOP ROW */}
      <div className="flex items-start justify-between mb-4">
        <div>
          <h2 className="text-2xl font-semibold">{signal.symbol}</h2>
          <p className="text-gray-400 text-sm">
            ${signal.price.toLocaleString(undefined, {
              minimumFractionDigits: 2,
              maximumFractionDigits: 2,
            })}
          </p>
        </div>

        <div className={`px-3 py-1 rounded-lg border text-xs ${badge}`}>
          {state}
        </div>
      </div>

      {/* CORE METRICS */}
      <div className="grid grid-cols-3 gap-4 text-sm mb-4">
        <Metric label="Bias" value={signal.bias} />
        <Metric label="ADX" value={signal.adx.toFixed(1)} />
        <Metric label="Confidence" value={`${signal.confidence}%`} />
      </div>

      {/* INDICATORS */}
      <div className="text-xs text-gray-400 space-y-1 border-t border-gray-800 pt-3">
        <div className="flex justify-between">
          <span>Stoch K</span>
          <span className="text-white">{signal.stochK.toFixed(1)}</span>
        </div>

        <div className="flex justify-between">
          <span>Stoch D</span>
          <span className="text-white">{signal.stochD.toFixed(1)}</span>
        </div>
      </div>

      {/* RISK (only if exists) */}
      {signal.stopLoss && signal.takeProfit && (
        <div className="mt-4 pt-3 border-t border-gray-800 grid grid-cols-3 text-xs">
          <div>
            <p className="text-gray-500">SL</p>
            <p className="text-red-400">
              ${signal.stopLoss.toFixed(2)}
            </p>
          </div>

          <div>
            <p className="text-gray-500">TP</p>
            <p className="text-green-400">
              ${signal.takeProfit.toFixed(2)}
            </p>
          </div>

          <div>
            <p className="text-gray-500">R/R</p>
            <p className="text-blue-400">
              {signal.riskRewardRatio?.toFixed(2) ?? "—"}
            </p>
          </div>
        </div>
      )}
    </div>
  );
}

/* =========================
   SMALL METRIC
========================= */

function Metric({
  label,
  value,
}: {
  label: string;
  value: string;
}) {
  return (
    <div>
      <p className="text-gray-500 text-xs">{label}</p>
      <p className="font-mono text-white">{value}</p>
    </div>
  );
}

/* =========================
   STATE RESOLVER (UI SIDE)
   Mirrors engine but safe for display
========================= */

function resolveState(signal: Signal): SignalState {
  if (signal.isSniper) return "SNIPER";
  if (signal.isSetupValid) return "SETUP";
  if (signal.adx > 18 && signal.bias !== "Neutral")
    return "EARLY";
  return "WAIT";
}
