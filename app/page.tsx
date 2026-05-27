"use client";

import { useState, useEffect } from "react";

interface Signal {
  symbol: string;
  price: number;
  change24h: number;
  bias: "Bullish" | "Bearish" | "Neutral";
  state: "FLAT" | "BUILDING" | "SNIPER";
  direction?: "LONG" | "SHORT";
  entry?: number;
  stopLoss?: number;
  takeProfit?: number;
  riskReward?: number;
  confidence: number;
  trigger: string;
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
      console.error("Test failed:", err);
    } finally {
      setTestLoading(false);
    }
  }

  useEffect(() => {
    fetchSignals();
    const interval = setInterval(fetchSignals, 60000);
    return () => clearInterval(interval);
  }, []);

  const getCardBorderColor = (state: string, direction?: string) => {
    if (state === "BUILDING") return "border-l-4 border-l-amber-500";
    if (state === "SNIPER" && direction === "LONG") return "border-l-4 border-l-green-500";
    if (state === "SNIPER" && direction === "SHORT") return "border-l-4 border-l-red-500";
    return "border-l-4 border-l-gray-700";
  };

  const getStatusBadgeStyle = (state: string, direction?: string) => {
    if (state === "BUILDING") return "bg-amber-600/20 text-amber-400 border border-amber-500/30";
    if (state === "SNIPER" && direction === "LONG") return "bg-green-600/20 text-green-400 border border-green-500/30";
    if (state === "SNIPER" && direction === "SHORT") return "bg-red-600/20 text-red-400 border border-red-500/30";
    return "bg-gray-700/20 text-gray-400 border border-gray-600/30";
  };

  const getConfidenceBar = (state: string, direction?: string) => {
    if (state === "BUILDING") return "bg-amber-500";
    if (state === "SNIPER" && direction === "LONG") return "bg-green-500";
    if (state === "SNIPER" && direction === "SHORT") return "bg-red-500";
    return "bg-gray-600";
  };

  const getStatusLabel = (state: string, direction?: string) => {
    if (state === "SNIPER" && direction) return direction;
    return state;
  };

  return (
    <div className="min-h-screen w-full bg-black text-gray-100">
      <div className="w-screen px-20 py-16">
        <div className="max-w-7xl mx-auto">
          {/* Header */}
          <div className="flex items-start justify-between mb-14">
            <div>
              <h1 className="text-5xl font-bold text-white tracking-tight">Trading Signals</h1>
              <p className="text-sm text-gray-500 mt-3">Last updated: {lastUpdate}</p>
            </div>
            <div className="flex items-center gap-3">
              <button
                onClick={fetchSignals}
                disabled={loading}
                className="px-5 py-2.5 bg-gray-800 hover:bg-gray-700 text-sm font-semibold rounded-lg text-white disabled:opacity-50 transition-all duration-200 border border-gray-700 hover:border-gray-600 shadow-lg hover:shadow-gray-900/50"
              >
                {loading ? "Refreshing..." : "Refresh"}
              </button>
              <button
                onClick={testTelegram}
                disabled={testLoading}
                className="px-5 py-2.5 bg-gray-800 hover:bg-gray-700 text-sm font-semibold rounded-lg text-white disabled:opacity-50 transition-all duration-200 border border-gray-700 hover:border-gray-600 shadow-lg hover:shadow-gray-900/50"
              >
                {testLoading ? "Testing..." : "Test Alert"}
              </button>
            </div>
          </div>

          {/* Error Banner */}
          {error && (
            <div className="mb-8 p-4 bg-red-950/40 border border-red-800/50 rounded-lg text-red-300 text-sm">
              Error: {error}
            </div>
          )}

          {/* Market Overview */}
          <div>
            <h2 className="text-2xl font-bold text-white mb-8 tracking-tight">Market Overview</h2>
            <div className="grid grid-cols-3 gap-6">
              {signals.map((signal) => (
                <div
                  key={signal.symbol}
                  className={`relative rounded-xl overflow-hidden transition-all duration-300 hover:shadow-2xl hover:shadow-gray-950/50 border border-gray-800 hover:border-gray-700 bg-gradient-to-br from-gray-950 to-black ${getCardBorderColor(
                    signal.state,
                    signal.direction
                  )}`}
                >
                  {/* Card Header */}
                  <div className="px-6 py-5 border-b border-gray-800/50 flex items-center justify-between bg-gray-900/20 backdrop-blur-sm">
                    <span className="text-3xl font-bold text-white">{signal.symbol}</span>
                    <span
                      className={`px-3 py-1.5 rounded-lg text-xs font-bold uppercase tracking-wide ${getStatusBadgeStyle(
                        signal.state,
                        signal.direction
                      )}`}
                    >
                      {getStatusLabel(signal.state, signal.direction)}
                    </span>
                  </div>

                  {/* Card Body */}
                  <div className="px-6 py-6 space-y-5">
                    {/* Price */}
                    <div className="pb-2">
                      <p className="text-xs text-gray-600 uppercase tracking-widest font-bold mb-1.5">Price</p>
                      <p className="text-2xl font-mono font-bold text-white">
                        ${signal.price.toLocaleString(undefined, {
                          minimumFractionDigits: 2,
                          maximumFractionDigits: 2,
                        })}
                      </p>
                    </div>

                    {/* Bias Section */}
                    <div className="border-t border-gray-800/50 pt-4">
                      <p className="text-xs text-gray-600 uppercase tracking-widest font-bold mb-2.5">Bias</p>
                      <div className="flex justify-between items-center">
                        <span className="text-gray-500">24h Change</span>
                        <span
                          className={`font-bold text-sm ${
                            signal.bias === "Bullish"
                              ? "text-green-400"
                              : signal.bias === "Bearish"
                              ? "text-red-400"
                              : "text-gray-400"
                          }`}
                        >
                          {signal.bias} ({signal.change24h.toFixed(2)}%)
                        </span>
                      </div>
                    </div>

                    {/* Trigger Section */}
                    <div className="border-t border-gray-800/50 pt-4">
                      <p className="text-xs text-gray-600 uppercase tracking-widest font-bold mb-2.5">Trigger</p>
                      <div className="flex justify-between items-center">
                        <span className="text-gray-500">Status</span>
                        <span className="text-white font-bold text-sm">{signal.trigger}</span>
                      </div>
                    </div>

                    {/* Confidence */}
                    <div className="border-t border-gray-800/50 pt-4">
                      <div className="flex items-center justify-between mb-2.5">
                        <p className="text-xs text-gray-600 uppercase tracking-widest font-bold">Confidence</p>
                        <p className="text-sm font-bold text-white bg-gray-800/30 px-2.5 py-1 rounded">
                          {signal.confidence}%
                        </p>
                      </div>
                      <div className="w-full bg-gray-800/40 rounded-full h-2.5 overflow-hidden">
                        <div
                          className={`h-2.5 rounded-full transition-all duration-300 ${getConfidenceBar(
                            signal.state,
                            signal.direction
                          )}`}
                          style={{ width: `${Math.min(100, signal.confidence)}%` }}
                        />
                      </div>
                    </div>

                    {/* Trade Setup - Only for SNIPER */}
                    {signal.state === "SNIPER" && (
                      <div className="border-t border-gray-800/50 pt-4 mt-2">
                        <p className="text-xs text-gray-600 uppercase tracking-widest font-bold mb-3">Trade Setup</p>
                        <div className="space-y-2 text-sm bg-gray-900/30 rounded-lg p-3 border border-gray-800/30">
                          <div className="flex justify-between">
                            <span className="text-gray-500">Entry</span>
                            <span className="font-mono text-white font-semibold text-xs">
                              ${signal.entry?.toLocaleString(undefined, {
                                minimumFractionDigits: 2,
                                maximumFractionDigits: 2,
                              })}
                            </span>
                          </div>
                          <div className="flex justify-between">
                            <span className="text-gray-500">SL</span>
                            <span className="font-mono text-white text-xs">
                              ${signal.stopLoss?.toLocaleString(undefined, {
                                minimumFractionDigits: 2,
                                maximumFractionDigits: 2,
                              })}
                            </span>
                          </div>
                          <div className="flex justify-between">
                            <span className="text-gray-500">TP</span>
                            <span className="font-mono text-white text-xs">
                              ${signal.takeProfit?.toLocaleString(undefined, {
                                minimumFractionDigits: 2,
                                maximumFractionDigits: 2,
                              })}
                            </span>
                          </div>
                          <div className="flex justify-between">
                            <span className="text-gray-500">R:R</span>
                            <span className="font-mono text-white font-semibold text-xs">
                              {signal.riskReward?.toFixed(2)}
                            </span>
                          </div>
                        </div>
                      </div>
                    )}
                  </div>

                  {/* Footer */}
                  <div className="px-6 py-4 border-t border-gray-800/50 bg-gray-900/10 backdrop-blur-sm">
                    <p className="text-xs text-gray-600">
                      Updated: {new Date(signal.updatedAt).toLocaleTimeString("en-GB")}
                    </p>
                  </div>
                </div>
              ))}
            </div>
          </div>
        </div>
      </div>
    </div>
  );
}
