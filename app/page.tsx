"use client";

import { useState, useEffect } from "react";

interface LayerStatus {
  status: string;
  detail: string;
  met: boolean;
}

interface Signal {
  symbol: string;
  price: number;
  state: "FLAT" | "LONG" | "SHORT";
  entry?: number;
  stopLoss?: number;
  takeProfit?: number;
  riskReward?: number;
  confidence: number;
  layer1: LayerStatus;
  layer2: LayerStatus;
  layer3: LayerStatus;
  bias4h: string;
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
    const interval = setInterval(fetchSignals, 5000);
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
    <div className="min-h-screen w-full bg-black text-gray-100">
      {/* Main Container */}
      <div className="w-full max-w-screen-xl mx-auto px-8 py-8">
        {/* Header */}
        <div className="flex items-start justify-between mb-12">
          <div>
            <h1 className="text-4xl font-bold text-white">Trading Signals</h1>
            <p className="text-sm text-gray-400 mt-2">Last updated: {lastUpdate}</p>
          </div>
          <div className="flex items-center gap-4">
            <button
              onClick={fetchSignals}
              disabled={loading}
              className="px-6 py-2.5 bg-gray-900 hover:bg-gray-800 text-sm font-medium rounded text-white disabled:opacity-50 transition-colors"
            >
              {loading ? "Refresh..." : "Refresh"}
            </button>
            <button
              onClick={testTelegram}
              disabled={testLoading}
              className="px-6 py-2.5 bg-gray-900 hover:bg-gray-800 text-sm font-medium rounded text-white disabled:opacity-50 transition-colors"
            >
              {testLoading ? "Test..." : "Test Alert"}
            </button>
          </div>
        </div>

        {/* Trade Readiness Section */}
        <div className="mb-16">
          <div className="flex items-center justify-between mb-4">
            <h2 className="text-xl font-semibold text-white">Trade Readiness</h2>
            <span className="text-3xl font-bold text-cyan-400">{overallConfidence}%</span>
          </div>
          <div className="w-full bg-gray-900 rounded h-3 mb-3 overflow-hidden">
            <div
              className="h-3 bg-cyan-500 transition-all duration-500 rounded"
              style={{ width: `${Math.min(100, overallConfidence)}%` }}
            />
          </div>
          <p className="text-sm text-gray-400">Approaching sniper condition</p>
        </div>

        {/* Error Banner */}
        {error && (
          <div className="mb-8 p-4 bg-red-950/50 border border-red-800 rounded text-red-300 text-sm">
            Error: {error}
          </div>
        )}

        {/* Market Overview */}
        <div>
          <h2 className="text-xl font-semibold text-white mb-6">Market Overview</h2>
          <div className="grid grid-cols-3 gap-6">
            {signals.map((signal) => {
              const badge = getStatusBadge(signal.confidence);
              return (
                <div
                  key={signal.symbol}
                  className={`rounded-lg border border-gray-800 bg-gray-950 overflow-hidden transition-all hover:border-gray-700 ${getCardBorder(signal.confidence)}`}
                >
                  {/* Card Header */}
                  <div className="px-6 py-4 border-b border-gray-800 flex items-center justify-between bg-gray-900/30">
                    <span className="text-2xl font-bold text-white">{signal.symbol}</span>
                    <span className={`px-3 py-1.5 rounded text-xs font-bold text-white ${badge.bg}`}>
                      {badge.text}
                    </span>
                  </div>

                  {/* Card Body */}
                  <div className="px-6 py-5 space-y-4">
                    {/* Price */}
                    <div>
                      <p className="text-xs text-gray-500 uppercase tracking-widest font-semibold">Price</p>
                      <p className="text-lg font-mono text-white mt-1">{formatPrice(signal.price)}</p>
                    </div>

                    {/* Market Info Grid */}
                    <div className="grid grid-cols-2 gap-4 py-2">
                      <div>
                        <p className="text-xs text-gray-600 uppercase tracking-widest font-semibold">4H Trend</p>
                        <p className={`text-sm font-bold mt-1 ${signal.bias4h.includes("Bullish") ? "text-green-400" : signal.bias4h.includes("Bearish") ? "text-red-400" : "text-gray-400"}`}>
                          {signal.bias4h.split(" ")[0]}
                        </p>
                      </div>
                      <div>
                        <p className="text-xs text-gray-600 uppercase tracking-widest font-semibold">15M Structure</p>
                        <p className="text-sm font-bold text-white mt-1">{signal.layer2?.status || "--"}</p>
                      </div>
                      <div>
                        <p className="text-xs text-gray-600 uppercase tracking-widest font-semibold">Macro Bias</p>
                        <p className="text-sm font-bold text-white mt-1">{signal.layer1?.status?.split(" ")[0] || "Neutral"}</p>
                      </div>
                    </div>

                    {/* Readiness Bar */}
                    <div className="py-2">
                      <div className="flex items-center justify-between mb-2">
                        <p className="text-xs text-gray-600 uppercase tracking-widest font-semibold">Readiness</p>
                        <p className="text-xs font-bold text-white">{signal.confidence}%</p>
                      </div>
                      <div className="w-full bg-gray-800 rounded-full h-2 overflow-hidden">
                        <div
                          className={`h-2 rounded-full transition-all ${getReadinessBar(signal.confidence)}`}
                          style={{ width: `${Math.min(100, signal.confidence)}%` }}
                        />
                      </div>
                    </div>

                    {/* Trade Setup - Only show when active signal */}
                    {signal.state !== "FLAT" && (
                      <div className="border-t border-gray-800 pt-4 mt-4">
                        <p className="text-xs text-gray-600 uppercase tracking-widest font-semibold mb-3">Trade Setup</p>
                        <div className="space-y-2 text-sm">
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
                            <span className="text-gray-400 text-right text-xs">{signal.layer1?.detail || "Multi-layer alignment"}</span>
                          </div>
                        </div>
                      </div>
                    )}
                  </div>

                  {/* Footer */}
                  <div className="px-6 py-3 border-t border-gray-800 bg-gray-900/30">
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

