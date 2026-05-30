"use client";

import { useEffect, useState } from "react";
import type { Signal } from "@/lib/strategy";

export default function Home() {
  const [signals, setSignals] = useState<Signal[]>([]);
  const [loading, setLoading] = useState(true);
  const [lastUpdate, setLastUpdate] = useState<string>("");

  async function fetchSignals() {
    try {
      setLoading(true);
      const res = await fetch("/api/signals");
      const data = await res.json();
      setSignals(data.signals || []);
      
      // Debug logging
      console.log(`[UI] Received ${data.signals?.length || 0} signals from API:`);
      (data.signals || []).forEach((signal: Signal) => {
        console.log(
          `[UI]   ${signal.symbol}: isSetupValid=${signal.isSetupValid}, isSniper=${signal.isSniper}, ADX=${signal.adx.toFixed(1)}, bias=${signal.bias}, K=${signal.stochK.toFixed(1)}`
        );
      });
      
      setLastUpdate(new Date().toLocaleTimeString());
    } catch (err) {
      console.error("Failed to fetch signals:", err);
    } finally {
      setLoading(false);
    }
  }

  async function testTelegram() {
    try {
      const res = await fetch("/api/telegram/test", { method: "POST" });
      const data = await res.json();
      alert(data.message || "Test alert sent!");
    } catch (err) {
      alert("Failed to send test alert");
      console.error(err);
    }
  }

  // Initial load
  useEffect(() => {
    fetchSignals();
  }, []);

  // Auto-refresh every 60 seconds
  useEffect(() => {
    const interval = setInterval(fetchSignals, 60000);
    return () => clearInterval(interval);
  }, []);

  return (
    <main className="min-h-screen bg-black text-white">
      <div className="px-6 sm:px-8 md:px-10 py-12 max-w-7xl mx-auto w-full">
        {/* Header */}
        <div className="mb-12">
          <h1 className="text-5xl sm:text-6xl font-bold tracking-tight mb-2">CX Switch</h1>
          <p className="text-gray-400 text-base sm:text-lg">
            Trade Radar • 4H Structure • 1H Confirmation • 15M Entry
          </p>
        </div>

        {/* Controls */}
        <div className="flex flex-col sm:flex-row items-start sm:items-center gap-3 mb-8">
          <button
            onClick={fetchSignals}
            disabled={loading}
            className="px-6 py-2.5 bg-white text-black rounded-lg hover:bg-gray-100 disabled:opacity-50 font-semibold transition"
          >
            {loading ? "Scanning..." : "SCAN"}
          </button>
          <button
            onClick={testTelegram}
            className="px-6 py-2.5 bg-gray-800 text-white rounded-lg hover:bg-gray-700 font-semibold transition border border-gray-700"
          >
            Test Telegram
          </button>
          <span className="text-sm text-gray-500 sm:ml-auto">
            Last update: {lastUpdate || "—"}
          </span>
        </div>

        {/* Signals Grid */}
        <div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-3 gap-6">
          {signals.map((signal) => (
            <SignalCard key={signal.symbol} signal={signal} />
          ))}
        </div>
      </div>
    </main>
  );
}

function SignalCard({ signal }: { signal: Signal }) {
  const isSniper = signal.isSniper;
  const isSetupValid = signal.isSetupValid;

  // State display - ONLY from engine flags, never derived
  const borderColor = isSniper ? "border-green-500/30" : isSetupValid ? "border-yellow-500/30" : "border-gray-700";
  const bgHighlight = isSniper ? "bg-green-500/5" : isSetupValid ? "bg-yellow-500/5" : "bg-gray-900/50";
  const stateBadgeColor = isSniper ? "bg-green-500/20 text-green-400 border-green-500/30" : isSetupValid ? "bg-yellow-500/20 text-yellow-400 border-yellow-500/30" : "bg-gray-800 text-gray-400 border-gray-700";
  const stateEmoji = isSniper ? "🟢" : isSetupValid ? "🟡" : "⚪";
  // Display status label based ONLY on engine flags (no derivation)
  const stateLabel = isSniper ? "SNIPER" : isSetupValid ? "SETUP ACTIVE" : "NO SETUP";

  const biasColor = signal.bias === "Bullish" ? "text-green-400" : signal.bias === "Bearish" ? "text-red-400" : "text-gray-400";

  return (
    <div className={`border ${borderColor} ${bgHighlight} rounded-xl p-6 transition backdrop-blur-sm`}>
      {/* Header */}
      <div className="flex items-center justify-between mb-6">
        <div>
          <h2 className="text-3xl font-bold">{signal.symbol}</h2>
          <p className="text-gray-400 text-sm mt-1">${signal.price.toLocaleString(undefined, { minimumFractionDigits: 2, maximumFractionDigits: 2 })}</p>
        </div>
        <div className={`px-4 py-2 rounded-lg border text-sm font-semibold ${stateBadgeColor} flex items-center gap-2`}>
          {stateEmoji}
          <span>{stateLabel}</span>
        </div>
      </div>

      {/* Basic Metrics */}
      <div className="grid grid-cols-2 gap-4 mb-6 pb-6 border-b border-gray-800">
        <MetricBox label="Bias" value={signal.bias} color={biasColor} />
        <MetricBox label="Confidence" value={`${signal.confidence}%`} color={signal.confidence >= 60 ? "text-green-400" : signal.confidence >= 40 ? "text-yellow-400" : "text-gray-400"} />
      </div>

      {/* Indicators */}
      <div className="mb-6 pb-6 border-b border-gray-800">
        <h3 className="text-xs font-semibold text-gray-300 mb-3 uppercase tracking-wide">Indicators</h3>
        <div className="space-y-2 text-sm">
          <div className="flex justify-between">
            <span className="text-gray-400">ADX</span>
            <span className="font-mono text-white">{signal.adx.toFixed(1)}</span>
          </div>
          <div className="flex justify-between">
            <span className="text-gray-400">Stochastic K</span>
            <span className="font-mono text-white">{signal.stochK.toFixed(1)}</span>
          </div>
          <div className="flex justify-between">
            <span className="text-gray-400">Stochastic D</span>
            <span className="font-mono text-white">{signal.stochD.toFixed(1)}</span>
          </div>
        </div>
      </div>

      {/* Risk Management Section */}
      <div className="mb-6 pb-6 border-b border-gray-800">
        <h3 className="text-xs font-semibold text-gray-300 mb-3 uppercase tracking-wide">Risk Management</h3>
        <div className="grid grid-cols-3 gap-3">
          <div>
            <p className="text-xs text-gray-500 mb-1">Stop Loss</p>
            <p className="font-mono font-semibold text-red-400">${signal.stopLoss.toFixed(2)}</p>
          </div>
          <div>
            <p className="text-xs text-gray-500 mb-1">Take Profit</p>
            <p className="font-mono font-semibold text-green-400">${signal.takeProfit.toFixed(2)}</p>
          </div>
          <div>
            <p className="text-xs text-gray-500 mb-1">R/R Ratio</p>
            <p className="font-mono font-semibold text-blue-400">{signal.riskRewardRatio.toFixed(2)}:1</p>
          </div>
        </div>
      </div>

      {/* Reason */}
      <p className="text-xs text-gray-400 leading-relaxed">{signal.reason}</p>
    </div>
  );
}

function MetricBox({ label, value, color }: { label: string; value: string; color: string }) {
  return (
    <div>
      <p className="text-xs text-gray-500 mb-1">{label}</p>
      <p className={`font-mono font-semibold ${color}`}>{value}</p>
    </div>
  );
}
