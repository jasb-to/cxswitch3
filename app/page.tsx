"use client";

import { useState, useEffect } from "react";
import useSWR from "swr";
import type { Signal } from "@/lib/strategy-core";

const fetcher = (url: string) => fetch(url, { cache: "no-store" }).then(res => {
  if (!res.ok) throw new Error(`API error ${res.status}`);
  return res.json();
});

export default function Dashboard() {
  const [mounted, setMounted] = useState(false);
  const [testingTelegram, setTestingTelegram] = useState(false);
  const [telegramStatus, setTelegramStatus] = useState<{ ok: boolean; error?: string } | null>(null);

  const { data: signals = [], error, isLoading, mutate } = useSWR<Signal[]>(
    "/api/signals",
    fetcher,
    {
      refreshInterval: 30000,
      revalidateOnFocus: true,
      dedupingInterval: 0,
    }
  );

  useEffect(() => {
    setMounted(true);
  }, []);

  const handleRefresh = async () => {
    await mutate();
  };

  const handleTestTelegram = async () => {
    setTestingTelegram(true);
    setTelegramStatus(null);
    try {
      const res = await fetch("/api/test-telegram", { method: "POST" });
      const json = await res.json();
      setTelegramStatus(json);
    } catch (err) {
      setTelegramStatus({ ok: false, error: String(err) });
    } finally {
      setTestingTelegram(false);
    }
  };

  if (!mounted) return null;

  return (
    <div className="min-h-screen bg-black text-gray-300 p-8">
      <div className="max-w-7xl mx-auto">
        {/* Header */}
        <div className="mb-12">
          <div className="flex items-center justify-between mb-6">
            <h1 className="text-3xl font-bold text-gray-100">Market Overview</h1>
            <div className="flex gap-3">
              <button
                onClick={handleRefresh}
                disabled={isLoading}
                className="px-4 py-2 bg-blue-900 hover:bg-blue-800 disabled:bg-gray-700 text-gray-200 rounded text-sm font-medium transition-colors"
              >
                {isLoading ? "Refreshing..." : "Refresh"}
              </button>
              <button
                onClick={handleTestTelegram}
                disabled={testingTelegram}
                className="px-4 py-2 bg-purple-900 hover:bg-purple-800 disabled:bg-gray-700 text-gray-200 rounded text-sm font-medium transition-colors"
              >
                {testingTelegram ? "Testing..." : "Test Telegram"}
              </button>
            </div>
          </div>
          
          {/* Telegram Status */}
          {telegramStatus && (
            <div className={`p-3 rounded text-sm ${
              telegramStatus.ok
                ? "bg-green-950/30 border border-green-700 text-green-300"
                : "bg-red-950/30 border border-red-700 text-red-300"
            }`}>
              {telegramStatus.ok
                ? "✓ Telegram bot is connected and working"
                : `✗ Telegram error: ${telegramStatus.error}`}
            </div>
          )}
        </div>

        {/* Status Messages */}
        {error && (
          <div className="mb-6 p-4 bg-red-950/30 border border-red-700 rounded text-red-300 text-sm">
            Error: {error.message}
          </div>
        )}

        {isLoading && (
          <div className="mb-6 p-4 bg-gray-900 border border-gray-700 rounded text-gray-400 text-sm">
            Loading signals...
          </div>
        )}

        {/* Signals Grid */}
        {signals.length > 0 && (
          <div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-3 gap-6">
            {signals.map((signal) => (
              <SignalCard key={signal.symbol} signal={signal} />
            ))}
          </div>
        )}

        {signals.length === 0 && !isLoading && (
          <div className="text-center py-12 text-gray-600">
            No signals available
          </div>
        )}
      </div>
    </div>
  );
}

function SignalCard({ signal }: { signal: Signal }) {
  const getBorderColor = () => {
    if (signal.direction === "LONG") return "border-l-4 border-l-green-500";
    if (signal.direction === "SHORT") return "border-l-4 border-l-red-500";
    
    switch (signal.state) {
      case "SNIPER": return "border-l-4 border-l-red-500";
      case "BUILDING": return "border-l-4 border-l-amber-500";
      case "WATCHING_SHIFT": return "border-l-4 border-l-cyan-500";
      default: return "border-l-4 border-l-gray-600";
    }
  };

  const getStateBadgeStyle = () => {
    switch (signal.state) {
      case "SNIPER": return "bg-red-600 text-white font-bold px-3 py-1 rounded text-sm";
      case "BUILDING": return "bg-amber-500 text-black font-bold px-3 py-1 rounded text-sm";
      case "WATCHING_SHIFT": return "bg-cyan-600 text-white font-bold px-3 py-1 rounded text-sm";
      default: return "bg-gray-600 text-white font-bold px-3 py-1 rounded text-sm";
    }
  };

  const getReadinessColor = () => {
    if (signal.confidence >= 75) return "bg-green-500";
    if (signal.confidence >= 55) return "bg-amber-500";
    if (signal.confidence >= 40) return "bg-cyan-500";
    return "bg-gray-600";
  };

  const getReadinessTextColor = () => {
    if (signal.confidence >= 75) return "text-green-400";
    if (signal.confidence >= 55) return "text-amber-400";
    if (signal.confidence >= 40) return "text-cyan-400";
    return "text-gray-400";
  };

  return (
    <div className={`bg-gray-950 border border-gray-800 rounded-lg p-6 ${getBorderColor()}`}>
      {/* Header with Symbol and Badge */}
      <div className="flex items-start justify-between mb-6">
        <div>
          <h2 className="text-2xl font-bold text-gray-100 mb-1">{signal.symbol}</h2>
          <p className="text-sm text-gray-500">Price: ${signal.price.toFixed(2)}</p>
        </div>
        <span className={getStateBadgeStyle()}>
          {signal.state}
        </span>
      </div>

      {/* 4H Trend */}
      <div className="mb-5">
        <div className="text-xs font-bold text-gray-500 uppercase tracking-wider mb-2">4H Trend</div>
        <div className="flex justify-between items-center">
          <span className={`font-bold ${
            signal.bias_4h === "Bullish" ? "text-green-400" :
            signal.bias_4h === "Bearish" ? "text-red-400" :
            "text-gray-400"
          }`}>
            {signal.bias_4h}
          </span>
          <div className="text-xs text-gray-500">{signal.structure_4h}</div>
        </div>
      </div>

      {/* 15M Structure */}
      <div className="mb-5">
        <div className="text-xs font-bold text-gray-500 uppercase tracking-wider mb-2">15M Structure</div>
        <div className={`font-bold ${
          signal.structure_15m.includes("Forming") || signal.structure_15m.includes("Shift") ? "text-amber-400" :
          signal.structure_15m.includes("Compressing") ? "text-amber-400" :
          signal.structure_15m.includes("Expanding") ? "text-green-400" :
          "text-gray-400"
        }`}>
          {signal.structure_15m}
        </div>
      </div>

      {/* Readiness Bar */}
      <div className="mb-6">
        <div className="flex justify-between items-center mb-2">
          <div className="text-xs font-bold text-gray-500 uppercase tracking-wider">Readiness</div>
          <span className={`text-sm font-bold ${getReadinessTextColor()}`}>{signal.confidence}%</span>
        </div>
        <div className="w-full bg-gray-800 rounded-full h-2">
          <div
            className={`h-2 rounded-full ${getReadinessColor()} transition-all`}
            style={{ width: `${signal.confidence}%` }}
          />
        </div>
      </div>

      {/* Trade Setup (ONLY for SNIPER state) */}
      {signal.state === "SNIPER" && signal.direction && (
        <div className="mb-6 pb-6 border-t border-gray-800">
          <div className="text-xs font-bold text-gray-500 uppercase tracking-wider mt-4 mb-3">Trade Setup</div>
          
          <div className="mb-4">
            <div className="text-xs text-gray-500 mb-1">Direction:</div>
            <div className={`text-lg font-bold ${
              signal.direction === "LONG" ? "text-green-400" : "text-red-400"
            }`}>
              {signal.direction}
            </div>
          </div>

          <div className="grid grid-cols-2 gap-3">
            <div>
              <div className="text-xs text-gray-500 mb-1">Entry:</div>
              <div className="font-mono text-sm text-gray-300 font-bold">${signal.entry?.toFixed(2)}</div>
            </div>
            <div>
              <div className="text-xs text-gray-500 mb-1">SL:</div>
              <div className="font-mono text-sm text-red-400 font-bold">${signal.stopLoss?.toFixed(2)}</div>
            </div>
            <div>
              <div className="text-xs text-gray-500 mb-1">TP:</div>
              <div className="font-mono text-sm text-green-400 font-bold">${signal.takeProfit?.toFixed(2)}</div>
            </div>
            <div>
              <div className="text-xs text-gray-500 mb-1">RR:</div>
              <div className="font-mono text-sm text-amber-400 font-bold">{signal.riskReward?.toFixed(2)}</div>
            </div>
          </div>

          <div className="mt-4">
            <div className="text-xs text-gray-500 mb-1">Confidence:</div>
            <div className={`font-bold ${
              signal.confidence >= 75 ? "text-green-400" :
              signal.confidence >= 55 ? "text-amber-400" :
              "text-cyan-400"
            }`}>
              {signal.confidence}%
            </div>
          </div>
        </div>
      )}

      {/* Timestamp */}
      <div className="text-xs text-gray-600 text-center">
        Updated: {new Date(signal.updated_at).toLocaleString()}
      </div>
    </div>
  );
}
