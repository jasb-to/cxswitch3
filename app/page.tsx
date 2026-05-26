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

  if (!mounted) return null;

  const getStateColor = (state: string) => {
    switch (state) {
      case "SNIPER": return "bg-green-950 border-green-600";
      case "BUILDING": return "bg-amber-950 border-amber-600";
      case "WATCHING_SHIFT": return "bg-slate-900 border-slate-700";
      default: return "bg-slate-900 border-slate-700";
    }
  };

  const getStateBadge = (state: string) => {
    switch (state) {
      case "SNIPER": return "bg-green-600 text-white";
      case "BUILDING": return "bg-amber-600 text-white";
      case "WATCHING_SHIFT": return "bg-slate-700 text-slate-300";
      default: return "bg-slate-700 text-slate-300";
    }
  };

  return (
    <div className="min-h-screen bg-slate-950 text-white p-8">
      <div className="max-w-7xl mx-auto">
        {/* Header */}
        <div className="mb-8">
          <h1 className="text-4xl font-bold mb-2">Trading Signals</h1>
          <p className="text-slate-400">Early Entry Mode v2 - Structural Shift Detection</p>
        </div>

        {/* Status Messages */}
        {error && (
          <div className="mb-6 p-4 bg-red-900/20 border border-red-600 rounded text-red-300">
            Error: {error.message}
          </div>
        )}

        {isLoading && (
          <div className="mb-6 p-4 bg-slate-900 border border-slate-700 rounded text-slate-300">
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
          <div className="text-center py-12 text-slate-500">
            No signals available
          </div>
        )}
      </div>
    </div>
  );
}

function SignalCard({ signal }: { signal: Signal }) {
  const getStateColor = (state: string) => {
    switch (state) {
      case "SNIPER": return "bg-green-950 border-green-600";
      case "BUILDING": return "bg-amber-950 border-amber-600";
      case "WATCHING_SHIFT": return "bg-slate-900 border-slate-700";
      default: return "bg-slate-900 border-slate-700";
    }
  };

  const getStateBadge = (state: string) => {
    switch (state) {
      case "SNIPER": return "bg-green-600";
      case "BUILDING": return "bg-amber-600";
      case "WATCHING_SHIFT": return "bg-slate-700";
      default: return "bg-slate-700";
    }
  };

  const getBiasColor = (bias: string) => {
    if (bias === "Bullish") return "text-green-400";
    if (bias === "Bearish") return "text-red-400";
    return "text-slate-400";
  };

  return (
    <div className={`border rounded-lg p-6 ${getStateColor(signal.state)}`}>
      {/* Header */}
      <div className="flex items-start justify-between mb-6">
        <div>
          <h2 className="text-3xl font-bold mb-1">{signal.symbol}</h2>
          <p className="text-sm text-slate-400">${signal.price.toFixed(2)}</p>
        </div>
        <span className={`${getStateBadge(signal.state)} text-white text-sm font-bold px-3 py-1 rounded`}>
          {signal.state}
        </span>
      </div>

      {/* Market Context - 3 Layers */}
      <div className="space-y-4 mb-6">
        {/* 4H Context */}
        <div className="border-l-2 border-slate-600 pl-3">
          <div className="text-xs text-slate-500 font-mono">4H BIAS</div>
          <div className="flex items-center gap-2 mt-1">
            <span className={`font-bold ${getBiasColor(signal.bias_4h)}`}>
              {signal.bias_4h}
            </span>
            <span className="text-xs text-slate-400">{signal.structure_4h}</span>
          </div>
        </div>

        {/* 15M Structure */}
        <div className="border-l-2 border-slate-600 pl-3">
          <div className="text-xs text-slate-500 font-mono">15M STRUCTURE</div>
          <div className="text-sm text-slate-300 mt-1">{signal.structure_15m}</div>
          {signal.shift_type !== "None" && (
            <div className="text-xs text-amber-400 mt-1">→ {signal.shift_type}</div>
          )}
        </div>

        {/* 5M Trigger */}
        <div className="border-l-2 border-slate-600 pl-3">
          <div className="text-xs text-slate-500 font-mono">5M TRIGGER</div>
          <div className="text-sm text-slate-300 mt-1">{signal.trigger_5m}</div>
        </div>
      </div>

      {/* Entry Point (if available) */}
      {signal.entry !== undefined && (
        <div className="bg-yellow-900/30 border border-yellow-600/50 rounded p-4 mb-6">
          <div className="text-xs text-yellow-400 font-bold mb-2">ENTRY ZONE</div>
          <div className="text-2xl font-bold text-yellow-300 mb-1">${signal.entry.toFixed(2)}</div>
          <div className="text-xs text-slate-400">{signal.entry_description}</div>
          <div className="mt-2 text-xs">
            <span className="text-slate-400">Current vs Entry: </span>
            <span className={signal.price > signal.entry ? "text-green-400" : "text-red-400"}>
              ${(signal.price - signal.entry).toFixed(2)}
            </span>
          </div>
        </div>
      )}

      {/* Trade Setup (if direction set) */}
      {signal.direction && (
        <div className="space-y-3 mb-6">
          <div className={`text-sm font-bold px-3 py-2 rounded ${
            signal.direction === "LONG" ? "bg-green-600/30 text-green-300" : "bg-red-600/30 text-red-300"
          }`}>
            {signal.direction} Trade
          </div>

          <div className="grid grid-cols-3 gap-2 text-sm">
            <div className="bg-slate-800/50 p-2 rounded">
              <div className="text-xs text-slate-500">SL</div>
              <div className="font-mono text-red-400">${signal.stopLoss?.toFixed(2)}</div>
            </div>
            <div className="bg-slate-800/50 p-2 rounded">
              <div className="text-xs text-slate-500">TP</div>
              <div className="font-mono text-green-400">${signal.takeProfit?.toFixed(2)}</div>
            </div>
            <div className="bg-slate-800/50 p-2 rounded">
              <div className="text-xs text-slate-500">R:R</div>
              <div className="font-mono text-amber-400">{signal.riskReward?.toFixed(2)}</div>
            </div>
          </div>
        </div>
      )}

      {/* Metadata */}
      <div className="border-t border-slate-700 pt-3 text-xs text-slate-400 space-y-1">
        <div>Confidence: <span className="text-slate-300 font-mono">{signal.confidence}%</span></div>
        {signal.hold_remaining_ms && signal.hold_remaining_ms > 0 && (
          <div className="text-amber-400">Hold: {(signal.hold_remaining_ms / 1000 / 60).toFixed(1)}m</div>
        )}
        <div className="text-slate-500">{new Date(signal.updated_at).toLocaleTimeString()}</div>
      </div>

      {/* Reason */}
      {signal.reason && (
        <div className="mt-3 p-2 bg-slate-800/50 rounded text-xs text-slate-400 italic">
          {signal.reason}
        </div>
      )}
    </div>
  );
}
