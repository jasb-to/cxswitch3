"use client";

import { useState, useEffect } from "react";

interface Signal {
  symbol: string;
  price: number;
  bias: "Bullish" | "Bearish" | "Neutral";
  state: "FLAT" | "BUILDING" | "SNIPER";
  direction?: "LONG" | "SHORT";
  entry?: number;
  stopLoss?: number;
  takeProfit?: number;
  riskReward?: number;
  confidence: number;
  reason?: string;
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
    if (state === "BUILDING") return "border-l-8 border-l-amber-500";
    if (state === "SNIPER" && direction === "LONG") return "border-l-8 border-l-green-500";
    if (state === "SNIPER" && direction === "SHORT") return "border-l-8 border-l-red-500";
    return "border-l-8 border-l-gray-700";
  };

  const getStatusBadgeStyle = (state: string, direction?: string) => {
    if (state === "BUILDING") return "bg-amber-600 text-black font-bold px-3 py-1 rounded text-xs uppercase tracking-wide";
    if (state === "SNIPER" && direction === "LONG") return "bg-green-600 text-black font-bold px-3 py-1 rounded text-xs uppercase tracking-wide";
    if (state === "SNIPER" && direction === "SHORT") return "bg-red-600 text-black font-bold px-3 py-1 rounded text-xs uppercase tracking-wide";
    return "bg-gray-600 text-black font-bold px-3 py-1 rounded text-xs uppercase tracking-wide";
  };

  const getReadinessColor = (state: string, direction?: string) => {
    if (state === "BUILDING") return "bg-amber-500";
    if (state === "SNIPER" && direction === "LONG") return "bg-green-500";
    if (state === "SNIPER" && direction === "SHORT") return "bg-red-500";
    return "bg-cyan-500";
  };

  const getConfidenceColor = (confidence: number, state: string, direction?: string) => {
    if (state === "SNIPER" && direction === "SHORT") return "text-red-400";
    if (state === "SNIPER" && direction === "LONG") return "text-green-400";
    return "text-white";
  };

  const getAvgReadiness = () => {
    if (signals.length === 0) return 0;
    const total = signals.reduce((sum, sig) => sum + sig.confidence, 0);
    return Math.round(total / signals.length);
  };

  return (
    <div className="min-h-screen w-full bg-black text-gray-100">
      <div className="w-screen px-20 py-16">
        <div className="max-w-7xl mx-auto">
          {/* Header */}
          <div className="flex items-start justify-between mb-12">
            <div>
              <h1 className="text-4xl font-bold text-white">Trading Signals</h1>
              <p className="text-sm text-gray-500 mt-2">Last updated: {lastUpdate}</p>
            </div>
            <div className="flex items-center gap-2">
              <button
                onClick={fetchSignals}
                disabled={loading}
                className="px-4 py-2 bg-gray-900 hover:bg-gray-800 text-sm font-semibold rounded text-white disabled:opacity-50 transition border border-gray-700"
              >
                {loading ? "Refreshing..." : "Refresh"}
              </button>
              <button
                onClick={testTelegram}
                disabled={testLoading}
                className="px-4 py-2 bg-gray-900 hover:bg-gray-800 text-sm font-semibold rounded text-white disabled:opacity-50 transition border border-gray-700"
              >
                {testLoading ? "Testing..." : "Test Alert"}
              </button>
            </div>
          </div>

          {/* Error Banner */}
          {error && (
            <div className="mb-8 p-3 bg-red-950/40 border border-red-800/50 rounded text-red-300 text-sm">
              Error: {error}
            </div>
          )}

          {/* Trade Readiness Section */}
          <div className="mb-12">
            <div className="flex justify-between items-center mb-3">
              <h3 className="text-sm font-bold text-white uppercase tracking-wide">Trade Readiness</h3>
              <span className="text-cyan-400 font-bold text-lg">{getAvgReadiness()}%</span>
            </div>
            <div className="w-full bg-gray-900 rounded-full h-3 overflow-hidden mb-2">
              <div
                className="h-3 rounded-full bg-cyan-500 transition-all duration-300"
                style={{ width: `${getAvgReadiness()}%` }}
              />
            </div>
            <p className="text-xs text-gray-500">Approaching sniper condition</p>
          </div>

          {/* Market Overview */}
          <div>
            <h2 className="text-lg font-bold text-white mb-8 uppercase tracking-wide">Market Overview</h2>
            <div className="grid grid-cols-3 gap-8">
              {signals.map((signal) => (
                <div
                  key={signal.symbol}
                  className={`rounded-lg overflow-hidden bg-gray-950 border border-gray-800 transition-all ${getCardBorderColor(
                    signal.state,
                    signal.direction
                  )}`}
                >
                  {/* Card Header */}
                  <div className="px-6 py-5 border-b border-gray-800 flex items-start justify-between">
                    <h3 className="text-2xl font-bold text-white">{signal.symbol}</h3>
                    <span className={getStatusBadgeStyle(signal.state, signal.direction)}>
                      {signal.state === "SNIPER" ? signal.direction : signal.state}
                    </span>
                  </div>

                  {/* Card Body */}
                  <div className="px-6 py-6 space-y-6">
                    {/* Price */}
                    <div>
                      <p className="text-xs text-gray-500 uppercase tracking-wide font-semibold mb-2">Price</p>
                      <p className="text-xl font-mono text-white">
                        ${signal.price.toLocaleString(undefined, {
                          minimumFractionDigits: 2,
                          maximumFractionDigits: 2,
                        })}
                      </p>
                    </div>

                    {/* 4H Trend Row */}
                    <div className="flex justify-between items-start">
                      <div>
                        <p className="text-xs text-gray-500 uppercase tracking-wide font-semibold mb-1">4H Trend</p>
                        <p
                          className={`font-bold text-sm ${
                            signal.bias === "Bullish"
                              ? "text-green-400"
                              : signal.bias === "Bearish"
                              ? "text-red-400"
                              : "text-white"
                          }`}
                        >
                          {signal.bias}
                        </p>
                      </div>
                      <div className="text-right">
                        <p className="text-xs text-gray-500 uppercase tracking-wide font-semibold mb-1">15M Structure</p>
                        <p className="font-bold text-sm text-white">{signal.trigger}</p>
                      </div>
                    </div>

                    {/* Macro Bias */}
                    <div>
                      <p className="text-xs text-gray-500 uppercase tracking-wide font-semibold mb-2">Macro Bias</p>
                      <p className="text-sm text-white">{signal.bias}</p>
                    </div>

                    {/* Readiness Bar */}
                    <div>
                      <div className="flex justify-between items-center mb-2">
                        <p className="text-xs text-gray-500 uppercase tracking-wide font-semibold">Readiness</p>
                        <p className="text-sm font-bold text-white">{signal.confidence}%</p>
                      </div>
                      <div className="w-full bg-gray-800 rounded-full h-2 overflow-hidden">
                        <div
                          className={`h-2 rounded-full transition-all ${getReadinessColor(
                            signal.state,
                            signal.direction
                          )}`}
                          style={{ width: `${Math.min(100, signal.confidence)}%` }}
                        />
                      </div>
                    </div>

                    {/* Trade Setup - Only for SNIPER */}
                    {signal.state === "SNIPER" && (
                      <div className="border-t border-gray-800 pt-5">
                        <p className="text-xs text-gray-500 uppercase tracking-wide font-semibold mb-4">Trade Setup</p>
                        <div className="space-y-3 text-sm">
                          <div className="flex justify-between">
                            <span className="text-gray-500">Direction:</span>
                            <span
                              className={`font-bold ${
                                signal.direction === "LONG" ? "text-green-400" : "text-red-400"
                              }`}
                            >
                              {signal.direction}
                            </span>
                          </div>
                          <div className="flex justify-between">
                            <span className="text-gray-500">Entry:</span>
                            <span className="font-mono text-white font-bold">
                              ${signal.entry?.toLocaleString(undefined, {
                                minimumFractionDigits: 2,
                                maximumFractionDigits: 2,
                              })}
                            </span>
                          </div>
                          <div className="flex justify-between">
                            <span className="text-gray-500">SL:</span>
                            <span className="font-mono text-white">
                              ${signal.stopLoss?.toLocaleString(undefined, {
                                minimumFractionDigits: 2,
                                maximumFractionDigits: 2,
                              })}
                            </span>
                          </div>
                          <div className="flex justify-between">
                            <span className="text-gray-500">TP:</span>
                            <span className="font-mono text-white">
                              ${signal.takeProfit?.toLocaleString(undefined, {
                                minimumFractionDigits: 2,
                                maximumFractionDigits: 2,
                              })}
                            </span>
                          </div>
                          <div className="flex justify-between">
                            <span className="text-gray-500">RR:</span>
                            <span className="font-mono text-white font-bold">
                              {signal.riskReward?.toFixed(2)}
                            </span>
                          </div>
                          <div className="flex justify-between">
                            <span className="text-gray-500">Confidence:</span>
                            <span className={`font-bold ${getConfidenceColor(signal.confidence, signal.state, signal.direction)}`}>
                              {signal.confidence}%
                            </span>
                          </div>
                          <div className="flex justify-between">
                            <span className="text-gray-500">Reason:</span>
                            <span className="text-white text-xs">{signal.reason || "Multi-layer alignment"}</span>
                          </div>
                        </div>
                      </div>
                    )}
                  </div>

                  {/* Footer */}
                  <div className="px-6 py-3 border-t border-gray-800 bg-gray-900/30">
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
