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
    <main className="min-h-screen bg-background">
      <div className="px-12 py-8 max-w-7xl mx-auto">
        {/* Header */}
        <div className="mb-8">
          <h1 className="text-5xl font-bold tracking-tight mb-2">CX Switch</h1>
          <p className="text-muted-foreground">
            4H Structure • 15M Momentum • ADX Filter
          </p>
        </div>

        {/* Controls */}
        <div className="flex items-center gap-4 mb-8">
          <button
            onClick={fetchSignals}
            disabled={loading}
            className="px-4 py-2 bg-primary text-primary-foreground rounded-lg hover:bg-primary/90 disabled:opacity-50 font-medium"
          >
            {loading ? "Scanning..." : "SCAN"}
          </button>
          <button
            onClick={testTelegram}
            className="px-4 py-2 bg-blue-600 text-white rounded-lg hover:bg-blue-700 font-medium"
          >
            Test Telegram
          </button>
          <span className="text-sm text-muted-foreground ml-auto">
            Last update: {lastUpdate || "—"}
          </span>
        </div>

        {/* Signals Grid */}
        <div className="grid md:grid-cols-3 gap-6">
          {signals.map((signal) => (
            <SignalCard key={signal.symbol} signal={signal} />
          ))}
        </div>
      </div>
    </main>
  );
}

function SignalCard({ signal }: { signal: Signal }) {
  const isSignal = signal.status !== "NO_SIGNAL";
  const isBullish = signal.status === "LONG";

  const statusColor = isBullish
    ? "bg-green-500/10 border-green-500/20 text-green-400"
    : signal.status === "SHORT"
      ? "bg-red-500/10 border-red-500/20 text-red-400"
      : "bg-slate-500/10 border-slate-500/20 text-slate-400";

  const emoji = isBullish ? "🟢" : signal.status === "SHORT" ? "🔴" : "⚪";

  return (
    <div className="border border-border bg-card rounded-xl p-6 hover:border-border/80 transition">
      {/* Header */}
      <div className="flex items-center justify-between mb-6">
        <div>
          <h2 className="text-2xl font-bold">{signal.symbol}</h2>
          <p className="text-sm text-muted-foreground">${signal.price}</p>
        </div>
        <div className={`px-3 py-1 rounded-full border text-sm font-medium ${statusColor}`}>
          {emoji} {signal.status}
        </div>
      </div>

      {/* Metrics */}
      <div className="space-y-3 mb-6 pb-6 border-b border-border">
        <div className="flex justify-between text-sm">
          <span className="text-muted-foreground">4H Bias</span>
          <span className={`font-mono font-semibold ${
            signal.marketBias === "Bullish" ? "text-green-400" :
            signal.marketBias === "Bearish" ? "text-red-400" :
            "text-slate-400"
          }`}>
            {signal.marketBias}
          </span>
        </div>
        <div className="flex justify-between text-sm">
          <span className="text-muted-foreground">ADX</span>
          <span className="font-mono font-semibold">{signal.adx.toFixed(1)}</span>
        </div>
        <div className="flex justify-between text-sm">
          <span className="text-muted-foreground">Stoch K</span>
          <span className="font-mono font-semibold">{signal.stochK}</span>
        </div>
        <div className="flex justify-between text-sm">
          <span className="text-muted-foreground">Confidence</span>
          <span className="font-mono font-semibold">{signal.confidence}%</span>
        </div>
      </div>

      {/* Signal Details or Swing Levels */}
      {isSignal ? (
        <div className="space-y-3">
          <div className="grid grid-cols-2 gap-3">
            <div>
              <p className="text-xs text-muted-foreground mb-1">Entry</p>
              <p className="font-mono font-semibold">${signal.entry}</p>
            </div>
            <div>
              <p className="text-xs text-muted-foreground mb-1">R:R</p>
              <p className="font-mono font-semibold text-green-400">
                {signal.riskReward?.toFixed(2)}x
              </p>
            </div>
            <div>
              <p className="text-xs text-muted-foreground mb-1">Stop Loss</p>
              <p className="font-mono font-semibold text-red-400">${signal.stopLoss}</p>
            </div>
            <div>
              <p className="text-xs text-muted-foreground mb-1">Take Profit</p>
              <p className="font-mono font-semibold text-green-400">${signal.takeProfit}</p>
            </div>
          </div>
          <p className="text-xs text-muted-foreground pt-2">{signal.reason}</p>
        </div>
      ) : (
        <div className="space-y-2">
          <p className="text-xs text-muted-foreground mb-3">{signal.reason}</p>
          {signal.nearestSwingLevel && (
            <div>
              <p className="text-xs text-muted-foreground mb-1">Next Level</p>
              <div className="flex justify-between items-center">
                <p className="font-mono font-semibold">${signal.nearestSwingLevel}</p>
                <p className="text-sm font-semibold text-blue-400">
                  {signal.distanceToSwing}%
                </p>
              </div>
            </div>
          )}
        </div>
      )}
    </div>
  );
}
