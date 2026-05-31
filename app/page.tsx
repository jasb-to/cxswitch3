"use client";

import { useEffect, useState } from "react";
import type { Signal } from "@/lib/strategy";

export default function Home() {
  const [signals, setSignals] = useState<Signal[]>([]);
  const [loading, setLoading] = useState(true);
  const [lastUpdate, setLastUpdate] = useState("");

  async function fetchSignals() {
    try {
      const res = await fetch("/api/signals");
      const data = await res.json();

      setSignals(data.signals || []);
      setLastUpdate(new Date().toLocaleTimeString());
    } catch (err) {
      console.error(err);
    } finally {
      setLoading(false);
    }
  }

  useEffect(() => {
    fetchSignals();
    const interval = setInterval(fetchSignals, 60000);
    return () => clearInterval(interval);
  }, []);

  const activeSetups = signals.filter((s) => s.isSetupValid).length;
  const activeEntries = signals.filter((s) => s.isSniper).length;

  return (
    <main className="min-h-screen bg-black text-white">
      {/* SINGLE RESPONSIBLE CONTAINER (FIXES LEFT EDGE ISSUE) */}
      <div className="mx-auto w-full max-w-[1600px] px-6 md:px-10 lg:px-16 xl:px-24 py-12">
        
        {/* HEADER */}
        <header className="mb-10 border-b border-gray-800 pb-8">
          <h1 className="text-4xl md:text-6xl font-bold tracking-tight">
            CX SWITCH
          </h1>
          <p className="text-gray-500 text-lg mt-3">
            Early Trend Scanner • 4H Structure • 1H Confirmation • 15M Entry
          </p>
        </header>

        {/* CONTROLS */}
        <div className="flex flex-wrap items-center gap-3 mb-8">
          <button
            onClick={fetchSignals}
            disabled={loading}
            className="px-6 py-3 rounded-xl bg-white text-black font-semibold hover:bg-gray-200 transition"
          >
            {loading ? "Scanning..." : "Refresh"}
          </button>

          <span className="text-sm text-gray-500 ml-auto">
            Last update: {lastUpdate || "--"}
          </span>
        </div>

        {/* STATS */}
        <div className="grid grid-cols-1 md:grid-cols-3 gap-6 mb-10">
          <StatCard label="Assets Tracked" value={signals.length} />
          <StatCard
            label="Active Setups"
            value={activeSetups}
            highlight="text-yellow-400"
          />
          <StatCard
            label="Entry Signals"
            value={activeEntries}
            highlight="text-green-400"
          />
        </div>

        {/* SIGNAL GRID */}
        <div className="grid grid-cols-1 lg:grid-cols-3 gap-8">
          {signals.map((signal) => (
            <SignalCard key={signal.symbol} signal={signal} />
          ))}
        </div>
      </div>
    </main>
  );
}

/* =========================
   STATS CARD
========================= */

function StatCard({
  label,
  value,
  highlight = "text-white",
}: {
  label: string;
  value: number;
  highlight?: string;
}) {
  return (
    <div className="bg-gray-900 border border-gray-800 rounded-2xl p-6">
      <p className="text-xs uppercase tracking-wider text-gray-500">
        {label}
      </p>
      <p className={`text-3xl font-bold mt-2 ${highlight}`}>
        {value}
      </p>
    </div>
  );
}

/* =========================
   SIGNAL CARD
========================= */

function SignalCard({ signal }: { signal: Signal }) {
  const isEntry = signal.isSniper;
  const isSetup = signal.isSetupValid;

  const status = isEntry ? "ENTRY" : isSetup ? "SETUP" : "MONITOR";

  const border = isEntry
    ? "border-green-500/30"
    : isSetup
    ? "border-yellow-500/30"
    : "border-gray-800";

  const badge = isEntry
    ? "text-green-400 bg-green-500/10"
    : isSetup
    ? "text-yellow-400 bg-yellow-500/10"
    : "text-gray-400 bg-gray-800";

  const biasColor =
    signal.bias === "Bullish"
      ? "text-green-400"
      : signal.bias === "Bearish"
      ? "text-red-400"
      : "text-gray-400";

  return (
    <div className={`bg-gray-950 border ${border} rounded-2xl p-6`}>
      
      {/* HEADER */}
      <div className="flex justify-between items-start mb-6">
        <div>
          <h2 className="text-3xl font-bold">{signal.symbol}</h2>
          <p className="text-gray-500 mt-1">
            $
            {signal.price.toLocaleString(undefined, {
              minimumFractionDigits: 2,
              maximumFractionDigits: 2,
            })}
          </p>
        </div>

        <div className={`px-3 py-2 rounded-lg text-xs font-semibold ${badge}`}>
          {status}
        </div>
      </div>

      {/* CORE METRICS */}
      <div className="grid grid-cols-2 gap-4 mb-6">
        <div>
          <p className="text-xs text-gray-500">Bias</p>
          <p className={`font-semibold ${biasColor}`}>{signal.bias}</p>
        </div>

        <div>
          <p className="text-xs text-gray-500">Confidence</p>
          <p className="font-semibold">{signal.confidence}%</p>
        </div>
      </div>

      {/* INDICATORS */}
      <div className="border-t border-gray-800 pt-5 mb-5">
        <h3 className="text-xs uppercase tracking-wider text-gray-500 mb-3">
          Indicators
        </h3>

        <Row label="ADX" value={signal.adx?.toFixed(1)} />
        <Row label="Stoch K" value={signal.stochK?.toFixed(1)} />
        <Row label="Stoch D" value={signal.stochD?.toFixed(1)} />
      </div>

      {/* TRADE PLAN */}
      <div className="border-t border-gray-800 pt-5 mb-5">
        <h3 className="text-xs uppercase tracking-wider text-gray-500 mb-3">
          Trade Plan
        </h3>

        {isEntry ? (
          <>
            <Row
              label="Stop Loss"
              value={`$${signal.stopLoss?.toFixed(2)}`}
            />
            <Row
              label="Take Profit"
              value={`$${signal.takeProfit?.toFixed(2)}`}
            />
            <Row
              label="R / R"
              value={`${signal.riskRewardRatio?.toFixed(2)} : 1`}
            />
          </>
        ) : (
          <p className="text-sm text-gray-500">
            Waiting for valid entry conditions...
          </p>
        )}
      </div>

      {/* REASON */}
      <p className="text-sm text-gray-400">{signal.reason}</p>
    </div>
  );
}

/* =========================
   ROW COMPONENT
========================= */

function Row({
  label,
  value,
}: {
  label: string;
  value?: string;
}) {
  return (
    <div className="flex justify-between py-1">
      <span className="text-gray-500 text-sm">{label}</span>
      <span className="font-mono text-white">{value ?? "--"}</span>
    </div>
  );
}
