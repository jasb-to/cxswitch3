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
  const isBuilding = signal.isBuilding;

  // State colors - only show green for SNIPER, yellow for BUILDING
  const borderColor = isSniper ? "border-green-500/30" : isBuilding ? "border-yellow-500/30" : "border-gray-700";
  const bgHighlight = isSniper ? "bg-green-500/5" : isBuilding ? "bg-yellow-500/5" : "bg-gray-900/50";
  const stateBadgeColor = isSniper ? "bg-green-500/20 text-green-400 border-green-500/30" : isBuilding ? "bg-yellow-500/20 text-yellow-400 border-yellow-500/30" : "bg-gray-800 text-gray-400 border-gray-700";
  const stateEmoji = isSniper ? "🟢" : isBuilding ? "🟡" : "⚪";
  const stateLabel = isSniper ? "SNIPER" : isBuilding ? "BUILDING" : "WATCHING";

  const biasColor = signal.bias === "Bullish" ? "text-green-400" : signal.bias === "Bearish" ? "text-red-400" : "text-gray-400";

  // Compute Trade Brewing Radar metrics
  const adxStrength = getAdxStrength(signal.adx);
  const stochZone = getStochZone(signal.stochK);
  const entryReadiness = calculateEntryReadiness(signal);
  const readinessLabel = getReadinessLabel(entryReadiness);
  const trendPressure = getTrendPressure(signal);
  const distanceToEntry = getDistanceToEntry(entryReadiness);

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

      {/* Trade Pressure Section */}
      <div className="mb-6 pb-6 border-b border-gray-800">
        <h3 className="text-xs font-semibold text-gray-300 mb-3 uppercase tracking-wide">Trade Pressure</h3>
        <div className="space-y-3">
          {/* ADX Strength */}
          <div className="flex items-center justify-between">
            <span className="text-xs text-gray-400">ADX Strength</span>
            <span className={`text-sm font-mono font-semibold ${adxStrength.color}`}>
              {adxStrength.label} ({signal.adx.toFixed(1)})
            </span>
          </div>

          {/* Stochastic Zone */}
          <div className="flex items-center justify-between">
            <span className="text-xs text-gray-400">Stochastic Zone</span>
            <span className={`text-sm font-mono font-semibold ${stochZone.color}`}>
              {stochZone.emoji} {stochZone.label} (K: {signal.stochK.toFixed(1)})
            </span>
          </div>

          {/* Trend Pressure Indicator */}
          <div className="flex items-center justify-between">
            <span className="text-xs text-gray-400">Momentum</span>
            <span className={`text-2xl ${trendPressure.color}`}>{trendPressure.arrow}</span>
          </div>
        </div>
      </div>

      {/* Entry Readiness Section */}
      <div className="mb-6">
        <h3 className="text-xs font-semibold text-gray-300 mb-3 uppercase tracking-wide">Entry Readiness</h3>
        <div className="space-y-3">
          {/* Readiness Score Bar */}
          <div>
            <div className="flex items-center justify-between mb-2">
              <span className="text-xs text-gray-400">Score</span>
              <span className={`text-sm font-mono font-semibold ${readinessLabel.color}`}>
                {entryReadiness} / 100 • {readinessLabel.status}
              </span>
            </div>
            <div className="w-full bg-gray-800 rounded-full h-2">
              <div
                className={`h-2 rounded-full transition-all ${readinessLabel.barColor}`}
                style={{ width: `${entryReadiness}%` }}
              />
            </div>
          </div>

          {/* Distance to Entry */}
          <div className="flex items-center justify-between">
            <span className="text-xs text-gray-400">Status</span>
            <span className="text-sm font-mono font-semibold text-blue-400">{distanceToEntry}</span>
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

// Trade Brewing Radar Helpers

function getAdxStrength(adx: number): { label: string; color: string } {
  if (adx < 23) return { label: "Weak", color: "text-blue-400" };
  if (adx < 35) return { label: "Building", color: "text-yellow-400" };
  if (adx < 50) return { label: "Strong", color: "text-orange-400" };
  return { label: "Explosive", color: "text-red-400" };
}

function getStochZone(k: number): { label: string; emoji: string; color: string } {
  if (k < 20) return { label: "Oversold", emoji: "🧊", color: "text-cyan-400" };
  if (k < 40) return { label: "Early", emoji: "🌱", color: "text-green-400" };
  if (k < 60) return { label: "Mid", emoji: "⚖️", color: "text-gray-300" };
  if (k < 80) return { label: "High", emoji: "🔥", color: "text-orange-400" };
  return { label: "Overheated", emoji: "⚠️", color: "text-red-400" };
}

function calculateEntryReadiness(signal: Signal): number {
  let score = 0;

  // +25 if isBuilding flag is true
  if (signal.isBuilding) {
    score += 25;
  }

  // +25 if ADX > 22
  if (signal.adx > 22) {
    score += 25;
  }

  // +25 if stochastic is in entry zone
  const isStochEntry = (signal.bias === "Bullish" && signal.stochK < 45) || (signal.bias === "Bearish" && signal.stochK > 55);
  if (isStochEntry) {
    score += 25;
  }

  // +25 if isSniper flag is true
  if (signal.isSniper) {
    score += 25;
  }

  return Math.min(score, 100);
}

function getReadinessLabel(score: number): { status: string; color: string; barColor: string } {
  if (score < 40) return { status: "Cold", color: "text-blue-400", barColor: "bg-blue-500" };
  if (score < 70) return { status: "Warming", color: "text-yellow-400", barColor: "bg-yellow-500" };
  if (score < 90) return { status: "Heating", color: "text-orange-400", barColor: "bg-orange-500" };
  return { status: "SNIPER Imminent", color: "text-red-400", barColor: "bg-red-500" };
}

function getTrendPressure(signal: Signal): { arrow: string; color: string } {
  const isBullish = signal.bias === "Bullish" && signal.adx > 20;
  const isBearish = signal.bias === "Bearish" && signal.adx > 20;

  if (isBullish) return { arrow: "↑", color: "text-green-400" };
  if (isBearish) return { arrow: "↓", color: "text-red-400" };
  return { arrow: "→", color: "text-gray-400" };
}

function getDistanceToEntry(score: number): string {
  if (score >= 90) return "🎯 Ready to trigger";
  if (score >= 70) return "1 condition away";
  if (score >= 40) return "2 conditions away";
  return "Monitoring...";
}
