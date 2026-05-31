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
      <div className="w-full max-w-[1600px] mx-auto px-8 md:px-12 lg:px-16 py-12">
        {/* HEADER */}

        <div className="border-b border-gray-800 pb-8 mb-10">
          <h1 className="text-4xl md:text-6xl font-bold tracking-tight">
            CX SWITCH
          </h1>

          <p className="text-gray-500 text-lg mt-3">
            Early Trend Scanner • BTC • ETH • SOL
          </p>
        </div>

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
            Last Update: {lastUpdate || "--"}
          </span>
        </div>

        {/* DASHBOARD STATS */}

        <div className="grid grid-cols-1 md:grid-cols-3 gap-5 mb-10">
          <StatCard
            label="Assets Tracked"
            value={signals.length.toString()}
          />

          <StatCard
            label="Active Setups"
            value={activeSetups.toString()}
            valueColor="text-yellow-400"
          />

          <StatCard
            label="Entry Signals"
            value={activeEntries.toString()}
            valueColor="text-green-400"
          />
        </div>

        {/* SIGNALS */}

        <div className="grid grid-cols-1 lg:grid-cols-3 gap-8">
          {signals.map((signal) => (
            <SignalCard key={signal.symbol} signal={signal} />
          ))}
        </div>
      </div>
    </main>
  );
}

function StatCard({
  label,
  value,
  valueColor = "text-white",
}: {
  label: string;
  value: string;
  valueColor?: string;
}) {
  return (
    <div className="bg-gray-900 border border-gray-800 rounded-2xl p-5">
      <p className="text-xs uppercase tracking-wider text-gray-500 mb-2">
        {label}
      </p>

      <p className={`text-3xl font-bold ${valueColor}`}>
        {value}
      </p>
    </div>
  );
}

function SignalCard({ signal }: { signal: Signal }) {
  const status = signal.isSniper
    ? "ENTRY"
    : signal.isSetupValid
    ? "SETUP"
    : "MONITOR";

  const borderColor = signal.isSniper
    ? "border-green-500/30"
    : signal.isSetupValid
    ? "border-yellow-500/30"
    : "border-gray-800";

  const statusColor = signal.isSniper
    ? "text-green-400 bg-green-500/10"
    : signal.isSetupValid
    ? "text-yellow-400 bg-yellow-500/10"
    : "text-gray-400 bg-gray-800";

  const biasColor =
    signal.bias === "Bullish"
      ? "text-green-400"
      : signal.bias === "Bearish"
      ? "text-red-400"
      : "text-gray-400";

  return (
    <div
      className={`bg-gray-950 border ${borderColor} rounded-2xl p-6`}
    >
      {/* TOP */}

      <div className="flex items-start justify-between mb-6">
        <div>
          <h2 className="text-3xl font-bold">
            {signal.symbol}
          </h2>

          <p className="text-gray-500 mt-1">
            $
            {signal.price.toLocaleString(undefined, {
              minimumFractionDigits: 2,
              maximumFractionDigits: 2,
            })}
          </p>
        </div>

        <div
          className={`px-3 py-2 rounded-lg text-xs font-semibold ${statusColor}`}
        >
          {status}
        </div>
      </div>

      {/* BIAS */}

      <div className="grid grid-cols-2 gap-4 mb-6">
        <MetricBox
          label="Bias"
          value={signal.bias}
          color={biasColor}
        />

        <MetricBox
          label="Confidence"
          value={`${signal.confidence}%`}
          color="text-white"
        />
      </div>

      {/* INDICATORS */}

      <div className="border-t border-gray-800 pt-5 mb-5">
        <h3 className="text-xs uppercase tracking-wider text-gray-500 mb-4">
          Indicators
        </h3>

        <IndicatorRow
          label="ADX"
          value={signal.adx?.toFixed(1) ?? "--"}
        />

        <IndicatorRow
          label="Stoch K"
          value={signal.stochK?.toFixed(1) ?? "--"}
        />

        <IndicatorRow
          label="Stoch D"
          value={signal.stochD?.toFixed(1) ?? "--"}
        />
      </div>

      {/* TRADE PLAN */}

      <div className="border-t border-gray-800 pt-5 mb-5">
        <h3 className="text-xs uppercase tracking-wider text-gray-500 mb-4">
          Trade Plan
        </h3>

        {signal.isSniper ? (
          <div className="space-y-3">
            <IndicatorRow
              label="Stop Loss"
              value={`$${signal.stopLoss?.toFixed(2)}`}
            />

            <IndicatorRow
              label="Take Profit"
              value={`$${signal.takeProfit?.toFixed(2)}`}
            />

            <IndicatorRow
              label="Risk / Reward"
              value={`${signal.riskRewardRatio?.toFixed(2)} : 1`}
            />
          </div>
        ) : (
          <p className="text-sm text-gray-500">
            Waiting for qualifying entry conditions.
          </p>
        )}
      </div>

      {/* REASON */}

      <div className="border-t border-gray-800 pt-5">
        <p className="text-sm text-gray-400">
          {signal.reason}
        </p>
      </div>
    </div>
  );
}

function IndicatorRow({
  label,
  value,
}: {
  label: string;
  value: string;
}) {
  return (
    <div className="flex items-center justify-between py-1">
      <span className="text-gray-500 text-sm">{label}</span>

      <span className="font-mono text-white">
        {value}
      </span>
    </div>
  );
}

function MetricBox({
  label,
  value,
  color,
}: {
  label: string;
  value: string;
  color: string;
}) {
  return (
    <div>
      <p className="text-xs uppercase tracking-wider text-gray-500 mb-1">
        {label}
      </p>

      <p className={`font-semibold ${color}`}>
        {value}
      </p>
    </div>
  );
}
