"use client";

import { useState, useEffect } from "react";

interface Signal {
  symbol: string;
  price: number;
  state: "FLAT" | "LONG" | "SHORT";
  entry?: number;
  stopLoss?: number;
  takeProfit?: number;
  riskReward?: number;
  confidence: number;
  candle4h?: { open: number; high: number; low: number; close: number };
  candle15m?: { open: number; high: number; low: number; close: number };
  bias4h?: string;
  structure15m?: string;
  updatedAt: string;
}

export default function Home() {
  const [signals, setSignals] = useState<Signal[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState("");
  const [lastUpdate, setLastUpdate] = useState("");
  const [testLoading, setTestLoading] = useState(false);

  async function fetchSignals() {
    try {
      setLoading(true);
      const res = await fetch("/api/signals", { cache: "no-store" });
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      const data = await res.json();
      setSignals(data.signals || []);
      setLastUpdate(new Date().toLocaleString("en-GB"));
      setError("");
    } catch (err: any) {
      setError(err.message || "Failed to fetch");
    } finally {
      setLoading(false);
    }
  }

  async function testTelegram() {
    setTestLoading(true);
    try {
      const res = await fetch("/api/telegram?action=test", { cache: "no-store" });
      const data = await res.json();
      console.log("Test alert result:", data);
    } catch (err: any) {
      console.error("Test alert failed:", err.message);
    } finally {
      setTestLoading(false);
    }
  }

  useEffect(() => {
    fetchSignals();
    const interval = setInterval(fetchSignals, 60000); // 60 second refresh
    return () => clearInterval(interval);
  }, []);

  const getReadinessBar = (confidence: number) => {
    if (confidence >= 90) return "bg-green-500";
    if (confidence >= 70) return "bg-cyan-500";
    if (confidence >= 50) return "bg-yellow-500";
    return "bg-gray-600";
  };

  const getCardBorder = (confidence: number) => {
    if (confidence >= 80) return "border-l-4 border-l-red-500"; // Ready/Sniper
    if (confidence >= 60) return "border-l-4 border-l-cyan-500"; // Building
    return "border-l-4 border-l-amber-500"; // Neutral
  };

  const getStatusBadge = (confidence: number) => {
    if (confidence >= 90) return { text: "SNIPER", bg: "bg-red-600" };
    if (confidence >= 60) return { text: "BUILDING", bg: "bg-amber-500" };
    return { text: "SCANNING", bg: "bg-gray-700" };
  };

  const formatPrice = (price?: number) => {
    if (!price) return "--";
    return price >= 1000 
      ? `$${price.toLocaleString(undefined, { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`
      : `$${price.toFixed(2)}`;
  };

  const overallConfidence = signals.length > 0 
    ? Math.round(signals.reduce((sum, s) => sum + s.confidence, 0) / signals.length)
    : 0;

  return (
    <div className="min-h-screen bg-black text-gray-100">
      {/* Header */}
      <div className="px-6 py-6">
        <div className="flex items-start justify-between mb-8">
          <div>
            <h1 className="text-3xl font-bold text-white">Trading Signals</h1>
            <p className="text-xs text-gray-500 mt-1">Last updated: {lastUpdate}</p>
          </div>
          <div className="flex items-center gap-3">
            <button
              onClick={fetchSignals}
              disabled={loading}
              className="px-4 py-2 bg-gray-800 hover:bg-gray-700 text-sm rounded text-white disabled:opacity-50"
            >
              {loading ? "Refresh..." : "Refresh"}
            </button>
            <button
              onClick={testTelegram}
              disabled={testLoading}
              className="px-4 py-2 bg-gray-800 hover:bg-gray-700 text-sm rounded text-white disabled:opacity-50"
            >
              {testLoading ? "Test..." : "Test Alert"}
            </button>
          </div>
        </div>

        {/* Trade Readiness Section */}
        <div className="mb-12">
          <div className="flex items-center justify-between mb-2">
            <h2 className="text-lg font-semibold text-white">Trade Readiness</h2>
            <span className="text-2xl font-bold text-cyan-400">{overallConfidence}%</span>
          </div>
          <div className="w-full bg-gray-900 rounded-full h-2 mb-2">
            <div
              className="h-2 rounded-full bg-cyan-500 transition-all duration-300"
              style={{ width: `${Math.min(100, overallConfidence)}%` }}
            />
          </div>
          <p className="text-xs text-gray-500">Approaching sniper condition</p>
        </div>

        {/* Error Banner */}
        {error && (
          <div className="mb-6 p-3 bg-red-950/50 border border-red-800 rounded text-red-300 text-sm">
            Error: {error}
          </div>
        )}

        {/* Market Overview */}
        <div>
          <h2 className="text-lg font-semibold text-white mb-4">Market Overview</h2>
          <div className="grid grid-cols-3 gap-4 pl-[30px]">
            {signals.map((signal) => {
              const badge = getStatusBadge(signal.confidence);
              return (
                <div
                  key={signal.symbol}
                  className={`rounded-lg border border-gray-800 bg-gray-950 overflow-hidden ${getCardBorder(signal.confidence)}`}
                >
                  {/* Card Header */}
                  <div className="px-4 py-3 border-b border-gray-800 flex items-center justify-between">
                    <span className="text-xl font-bold text-white">{signal.symbol}</span>
                    <span className={`px-2.5 py-1 rounded text-xs font-bold text-white ${badge.bg}`}>
                      {badge.text}
                    </span>
                  </div>

                  {/* Card Body */}
                  <div className="px-4 py-4 space-y-3">
                    {/* Price */}
                    <div>
                      <p className="text-xs text-gray-500 uppercase tracking-wider">Price</p>
                      <p className="text-sm font-mono text-white">{formatPrice(signal.price)}</p>
                    </div>

                    {/* Market Info Grid */}
                    <div className="grid grid-cols-2 gap-3 py-2 border-b border-gray-800 pb-3 text-xs">
                      <div>
                        <p className="text-gray-600 uppercase font-semibold">4H Trend</p>
                        <p className={`font-bold mt-1 ${signal.bias4h?.includes("Bullish") ? "text-green-400" : signal.bias4h?.includes("Bearish") ? "text-red-400" : "text-gray-400"}`}>
                          {signal.bias4h || "Unknown"}
                        </p>
                      </div>
                      <div>
                        <p className="text-gray-600 uppercase font-semibold">15M Structure</p>
                        <p className="font-bold text-white mt-1">{signal.structure15m || "Unknown"}</p>
                      </div>
                    </div>

                    {/* Readiness Bar */}
                    <div>
                      <div className="flex items-center justify-between mb-1">
                        <p className="text-xs text-gray-600 uppercase">Readiness</p>
                        <p className="text-xs font-bold text-white">{signal.confidence}%</p>
                      </div>
                      <div className="w-full bg-gray-800 rounded-full h-1.5">
                        <div
                          className={`h-1.5 rounded-full transition-all ${getReadinessBar(signal.confidence)}`}
                          style={{ width: `${Math.min(100, signal.confidence)}%` }}
                        />
                      </div>
                    </div>

                    {/* Trade Setup - Only show when active signal */}
                    {signal.state !== "FLAT" && (
                      <div className="border-t border-gray-800 pt-3 mt-3">
                        <p className="text-xs text-gray-600 uppercase mb-2">Trade Setup</p>
                        <div className="space-y-1.5 text-xs">
                          <div className="flex justify-between">
                            <span className="text-gray-500">Direction:</span>
                            <span className={`font-bold ${signal.state === "LONG" ? "text-green-400" : "text-red-400"}`}>
                              {signal.state}
                            </span>
                          </div>
                          <div className="flex justify-between">
                            <span className="text-gray-500">Entry:</span>
                            <span className="font-mono text-white font-semibold">{formatPrice(signal.entry)}</span>
                          </div>
                          <div className="flex justify-between">
                            <span className="text-gray-500">SL:</span>
                            <span className="font-mono text-white">{formatPrice(signal.stopLoss)}</span>
                          </div>
                          <div className="flex justify-between">
                            <span className="text-gray-500">TP:</span>
                            <span className="font-mono text-white">{formatPrice(signal.takeProfit)}</span>
                          </div>
                          <div className="flex justify-between">
                            <span className="text-gray-500">RR:</span>
                            <span className="font-mono text-white font-semibold">{signal.riskReward?.toFixed(2)}</span>
                          </div>
                          <div className="flex justify-between">
                            <span className="text-gray-500">Confidence:</span>
                            <span className={`font-bold ${signal.confidence >= 80 ? "text-red-400" : signal.confidence >= 60 ? "text-cyan-400" : "text-gray-400"}`}>
                              {signal.confidence}%
                            </span>
                          </div>
                          <div className="flex justify-between pt-1">
                            <span className="text-gray-500">Reason:</span>
                            <span className="text-gray-400 text-right">4H Bias + 15M Structure</span>
                          </div>
                        </div>
                      </div>
                    )}
                  </div>

                  {/* Footer */}
                  <div className="px-4 py-2 border-t border-gray-800 bg-gray-900/50">
                    <p className="text-xs text-gray-600">
                      Updated: {signal.updatedAt ? new Date(signal.updatedAt).toLocaleString("en-GB") : "--"}
                    </p>
                  </div>
                </div>
              );
            })}
          </div>
        </div>
      </div>
    </div>
  );
}

