"use client";

import { useState, useEffect } from "react";
import useSWR from "swr";
import type { Signal } from "@/lib/strategy-core";

const fetcher = (url: string) => fetch(url, { cache: "no-store" }).then(res => {
  if (!res.ok) throw new Error(`API returned ${res.status}`);
  return res.json();
});

export default function Dashboard() {
  const [mounted, setMounted] = useState(false);
  const [isRefreshing, setIsRefreshing] = useState(false);
  const [isTesting, setIsTesting] = useState(false);

  const { data: signals = [], error, isLoading, mutate } = useSWR<Signal[]>(
    "/api/signals",
    fetcher,
    {
      revalidateOnFocus: true,
      revalidateOnReconnect: true,
      focusThrottleInterval: 0,
      dedupingInterval: 0,
      refreshInterval: 30000,
      errorRetryInterval: 10000,
      errorRetryCount: 3,
      compare: (a, b) => JSON.stringify(a) === JSON.stringify(b),
    }
  );

  useEffect(() => {
    setMounted(true);
  }, []);

  const handleRefresh = async () => {
    setIsRefreshing(true);
    await mutate();
    setIsRefreshing(false);
  };

  const handleTestTelegram = async () => {
    setIsTesting(true);
    try {
      const response = await fetch("/api/test-telegram", { method: "POST" });
      const data = await response.json();
      alert(data.message || "Test message sent");
    } catch (err) {
      alert("Error sending test message");
    } finally {
      setIsTesting(false);
    }
  };

  if (!mounted) return null;

  const getStateColor = (state: string) => {
    switch (state) {
      case "SNIPER": return "bg-green-900/20 border-green-600";
      case "BUILDING": return "bg-orange-900/20 border-orange-600";
      case "WATCHING_SHIFT": return "bg-slate-900/20 border-slate-600";
      default: return "bg-slate-900/20 border-slate-600";
    }
  };

  const getStateBadge = (state: string) => {
    switch (state) {
      case "SNIPER": return "text-green-400 font-bold";
      case "BUILDING": return "text-orange-400 font-bold";
      case "WATCHING_SHIFT": return "text-slate-400";
      default: return "text-slate-400";
    }
  };

  return (
    <div className="min-h-screen bg-slate-950 text-slate-100 p-8">
      <div className="max-w-7xl mx-auto">
        {/* Header */}
        <div className="flex items-center justify-between mb-8">
          <div>
            <h1 className="text-4xl font-bold text-white mb-2">Trading Signals</h1>
            <p className="text-slate-400">Early Entry Mode v2 - Real-time structure detection</p>
          </div>
          <div className="flex gap-2">
            <button
              onClick={handleRefresh}
              disabled={isRefreshing || isLoading}
              className="px-4 py-2 bg-cyan-600 hover:bg-cyan-700 disabled:bg-slate-700 text-white rounded font-medium transition"
            >
              {isRefreshing ? "Refreshing..." : "Refresh Signals"}
            </button>
            <button
              onClick={handleTestTelegram}
              disabled={isTesting}
              className="px-4 py-2 border border-slate-600 hover:border-slate-500 text-slate-300 rounded font-medium transition"
            >
              {isTesting ? "Testing..." : "Test Telegram"}
            </button>
          </div>
        </div>

        {/* Status */}
        {isLoading && !mounted && (
          <div className="text-center py-12 text-slate-400">
            Loading signals...
          </div>
        )}

        {error && (
          <div className="bg-red-900/20 border border-red-600 p-4 rounded mb-6 text-red-300">
            Error loading signals: {error.message}
          </div>
        )}

        {/* Signals Grid */}
        <div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-3 gap-6">
          {signals.map((signal) => (
            <div
              key={signal.symbol}
              className={`border rounded-lg p-6 ${getStateColor(signal.state)}`}
            >
              {/* Header: Symbol & State */}
              <div className="flex items-start justify-between mb-4">
                <div>
                  <h2 className="text-2xl font-bold text-white">{signal.symbol}</h2>
                  <p className="text-sm text-slate-400">${signal.price.toFixed(2)}</p>
                </div>
                <div className={`text-sm font-bold px-3 py-1 rounded ${getStateBadge(signal.state)}`}>
                  {signal.state}
                </div>
              </div>

              {/* Market Context (3-Layer) */}
              <div className="bg-slate-900/40 rounded p-4 mb-4 space-y-2">
                <div className="text-xs text-slate-400">4H BIAS</div>
                <div className="text-sm font-mono">
                  <span className={
                    signal.bias_4h === "Bullish" ? "text-green-400" :
                    signal.bias_4h === "Bearish" ? "text-red-400" :
                    "text-slate-400"
                  }>
                    {signal.bias_4h}
                  </span>
                  {" · "}
                  <span className="text-slate-300">{signal.structure_4h}</span>
                </div>

                <div className="text-xs text-slate-400 mt-2">15M STRUCTURE</div>
                <div className="text-sm font-mono text-slate-300">
                  {signal.structure_15m}
                  {signal.shift_type !== "None" && (
                    <span className="text-amber-400 ml-1">({signal.shift_type})</span>
                  )}
                </div>

                <div className="text-xs text-slate-400 mt-2">5M TRIGGER</div>
                <div className="text-sm font-mono text-slate-300">
                  {signal.trigger_5m}
                </div>
              </div>

              {/* Entry Point */}
              {signal.entry !== undefined && (
                <div className="bg-yellow-900/20 border border-yellow-600/50 rounded p-3 mb-4">
                  <div className="text-xs text-yellow-400 font-semibold mb-1">🟡 ENTRY POINT</div>
                  <div className="text-lg font-bold text-yellow-300">${signal.entry.toFixed(2)}</div>
                  <div className="text-xs text-slate-400 mt-1">{signal.entry_description}</div>
                  <div className="text-xs text-slate-400 mt-1">
                    Current: <span className="text-slate-300">${(signal.price - signal.entry).toFixed(2)}</span>
                    {" "}
                    <span className={signal.price > signal.entry ? "text-green-400" : "text-red-400"}>
                      ({((signal.price - signal.entry) / signal.entry * 100).toFixed(2)}%)
                    </span>
                  </div>
                </div>
              )}

              {/* Trade Setup (when active) */}
              {signal.direction && (
                <div className="space-y-2 mb-4">
                  <div className={`text-sm font-bold px-3 py-1 rounded inline-block ${
                    signal.direction === "LONG" ? "bg-green-600/30 text-green-300" : "bg-red-600/30 text-red-300"
                  }`}>
                    {signal.direction} @ {signal.entry?.toFixed(2)}
                  </div>

                  <div className="grid grid-cols-2 gap-2 text-sm font-mono">
                    <div className="bg-slate-900/40 p-2 rounded">
                      <div className="text-xs text-slate-400">SL</div>
                      <div className="text-red-400">${signal.stopLoss?.toFixed(2)}</div>
                    </div>
                    <div className="bg-slate-900/40 p-2 rounded">
                      <div className="text-xs text-slate-400">TP</div>
                      <div className="text-green-400">${signal.takeProfit?.toFixed(2)}</div>
                    </div>
                  </div>

                  <div className="bg-slate-900/40 p-2 rounded text-sm">
                    <div className="text-xs text-slate-400">Risk/Reward</div>
                    <div className="font-mono text-amber-300">{signal.riskReward?.toFixed(2)} : 1</div>
                  </div>
                </div>
              )}

              {/* Metadata */}
              <div className="space-y-1 text-xs text-slate-400 border-t border-slate-700 pt-3">
                <div>Confidence: <span className="text-slate-300 font-mono">{signal.confidence}%</span></div>
                {signal.hold_remaining_ms && signal.hold_remaining_ms > 0 && (
                  <div className="text-amber-500">Hold: {(signal.hold_remaining_ms / 1000 / 60).toFixed(1)}m remaining</div>
                )}
                <div className="text-slate-500 text-xs">
                  {new Date(signal.updated_at).toLocaleTimeString()}
                </div>
              </div>

              {/* Reason */}
              {signal.reason && (
                <div className="mt-3 p-2 bg-slate-900/40 rounded text-xs text-slate-400">
                  {signal.reason}
                </div>
              )}
            </div>
          ))}
        </div>

        {/* Empty State */}
        {signals.length === 0 && mounted && !isLoading && (
          <div className="text-center py-12 text-slate-400">
            No signals available. Check API connection.
          </div>
        )}
      </div>
    </div>
  );
}
