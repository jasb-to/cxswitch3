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
    if (state === "BUILDING") return "bg-amber-500 text-black font-bold px-3 py-1.5 rounded text-xs uppercase tracking-wide";
    if (state === "SNIPER" && direction === "LONG") return "bg-green-500 text-black font-bold px-3 py-1.5 rounded text-xs uppercase tracking-wide";
    if (state === "SNIPER" && direction === "SHORT") return "bg-red-500 text-white font-bold px-3 py-1.5 rounded text-xs uppercase tracking-wide";
    return "bg-gray-600 text-white font-bold px-3 py-1.5 rounded text-xs uppercase tracking-wide";
  };

  const getReadinessColor = (state: string, direction?: string) => {
    if (state === "BUILDING") return "bg-amber-500";
    if (state === "SNIPER" && direction === "LONG") return "bg-green-500";
    if (state === "SNIPER" && direction === "SHORT") return "bg-red-500";
    return "bg-cyan-500";
  };

  const getAvgReadiness = () => {
    if (signals.length === 0) return 0;
    const total = signals.reduce((sum, sig) => sum + sig.confidence, 0);
    return Math.round(total / signals.length);
  };

  return (
    <div className="min-h-screen w-full bg-black">
      <div className="w-screen px-20 py-16">
        <div className="max-w-7xl mx-auto space-y-16">
          {/* Header */}
          <div className="flex items-start justify-between">
            <div>
              <h1 className="text-5xl font-bold text-white tracking-tight">Trading Signals</h1>
              <p className="text-sm text-gray-500 mt-3">Last updated: {lastUpdate}</p>
            </div>
            <div className="flex items-center gap-3">
              <button
                onClick={fetchSignals}
                disabled={loading}
                className="px-5 py-2.5 bg-gray-900 hover:bg-gray-800 text-sm font-semibold rounded text-white disabled:opacity-50 transition border border-gray-700"
              >
                {loading ? "Refreshing..." : "Refresh"}
              </button>
              <button
                onClick={testTelegram}
                disabled={testLoading}
                className="px-5 py-2.5 bg-gray-900 hover:bg-gray-800 text-sm font-semibold rounded text-white disabled:opacity-50 transition border border-gray-700"
              >
                {testLoading ? "Testing..." : "Test Alert"}
              </button>
            </div>
          </div>

          {/* Error Banner */}
          {error && (
            <div className="p-4 bg-red-950/40 border border-red-800/50 rounded text-red-300 text-sm">
              Error: {error}
            </div>
          )}

          {/* Trade Readiness */}
          <div>
            <div className="flex justify-between items-center mb-3">
              <h3 className="text-sm font-bold text-white uppercase tracking-wider">Trade Readiness</h3>
              <span className="text-cyan-400 font-bold text-xl">{getAvgReadiness()}%</span>
            </div>
            <div className="w-full bg-gray-900 rounded-full h-3 overflow-hidden mb-3">
              <div
                className="h-3 rounded-full bg-cyan-500 transition-all duration-300"
                style={{ width: `${getAvgReadiness()}%` }}
              />
            </div>
            <p className="text-xs text-gray-600">Approaching sniper condition</p>
          </div>

          {/* Market Overview */}
          <div>
            <h2 className="text-lg font-bold text-white mb-10 uppercase tracking-wider">Market Overview</h2>
            <div className="grid grid-cols-3 gap-10">
              {signals.map((signal) => (
                <div
                  key={signal.symbol}
                  className={`rounded-xl overflow-hidden bg-gray-950 border border-gray-800 ${getCardBorderColor(
                    signal.state,
                    signal.direction
                  )}`}
                >
                  {/* Card Header */}
                  <div className="px-7 py-6 border-b border-gray-800 flex items-start justify-between bg-gray-900/40">
                    <h3 className="text-4xl font-bold text-white">{signal.symbol}</h3>
                    <span className={getStatusBadgeStyle(signal.state, signal.direction)}>
                      {signal.state === "SNIPER" ? signal.direction : signal.state}
                    </span>
                  </div>

                  {/* Card Body */}
                  <div className="px-7 py-8 space-y-8">
                    {/* Price */}
                    <div>
                      <p className="text-xs text-gray-600 uppercase tracking-wider font-bold mb-2">Price</p>
                      <p className="text-2xl font-mono text-white font-bold">
                        ${signal.price.toLocaleString(undefined, {
                          minimumFractionDigits: 2,
                          maximumFractionDigits: 2,
                        })}
                      </p>
                    </div>

                    {/* 4H Trend & 15M Structure Row */}
                    <div className="flex justify-between items-start gap-8">
                      <div>
                        <p className="text-xs text-gray-600 uppercase tracking-wider font-bold mb-2">4H Trend</p>
                        <p
                          className={`text-sm font-bold ${
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
                        <p className="text-xs text-gray-600 uppercase tracking-wider font-bold mb-2">15M Structure</p>
                        <p className="text-sm font-bold text-white">{signal.trigger}</p>
                      </div>
                    </div>

                    {/* Macro Bias */}
                    <div>
                      <p className="text-xs text-gray-600 uppercase tracking-wider font-bold mb-2">Macro Bias</p>
                      <p className="text-sm text-white font-medium">{signal.bias}</p>
                    </div>

                    {/* Readiness Bar */}
                    <div>
                      <div className="flex justify-between items-center mb-3">
                        <p className="text-xs text-gray-600 uppercase tracking-wider font-bold">Readiness</p>
                        <p className="text-sm font-bold text-white">{signal.confidence}%</p>
                      </div>
                      <div className="w-full bg-gray-800 rounded-full h-2.5 overflow-hidden">
                        <div
                          className={`h-2.5 rounded-full transition-all ${getReadinessColor(
                            signal.state,
                            signal.direction
                          )}`}
                          style={{ width: `${Math.min(100, signal.confidence)}%` }}
                        />
                      </div>
                    </div>

                    {/* Trade Setup - Only for SNIPER */}
                    {signal.state === "SNIPER" && (
                      <div className="border-t border-gray-800 pt-8">
                        <p className="text-xs text-gray-600 uppercase tracking-wider font-bold mb-5">Trade Setup</p>
                        <div className="space-y-3">
                          <div className="flex justify-between text-sm">
                            <span className="text-gray-500">Direction:</span>
                            <span
                              className={`font-bold ${
                                signal.direction === "LONG" ? "text-green-400" : "text-red-400"
                              }`}
                            >
                              {signal.direction}
                            </span>
                          </div>
                          <div className="flex justify-between text-sm">
                            <span className="text-gray-500">Entry:</span>
                            <span className="font-mono text-white font-bold">
                              ${signal.entry?.toLocaleString(undefined, {
                                minimumFractionDigits: 2,
                                maximumFractionDigits: 2,
                              })}
                            </span>
                          </div>
                          <div className="flex justify-between text-sm">
                            <span className="text-gray-500">SL:</span>
                            <span className="font-mono text-white font-bold">
                              ${signal.stopLoss?.toLocaleString(undefined, {
                                minimumFractionDigits: 2,
                                maximumFractionDigits: 2,
                              })}
                            </span>
                          </div>
                          <div className="flex justify-between text-sm">
                            <span className="text-gray-500">TP:</span>
                            <span className="font-mono text-white font-bold">
                              ${signal.takeProfit?.toLocaleString(undefined, {
                                minimumFractionDigits: 2,
                                maximumFractionDigits: 2,
                              })}
                            </span>
                          </div>
                          <div className="flex justify-between text-sm">
                            <span className="text-gray-500">RR:</span>
                            <span className="font-mono text-white font-bold">
                              {signal.riskReward?.toFixed(2)}
                            </span>
                          </div>
                          <div className="flex justify-between text-sm">
                            <span className="text-gray-500">Confidence:</span>
                            <span className={`font-bold ${
                              signal.direction === "LONG" ? "text-green-400" : "text-red-400"
                            }`}>
                              {signal.confidence}%
                            </span>
                          </div>
                          <div className="flex justify-between text-sm">
                            <span className="text-gray-500">Reason:</span>
                            <span className="text-white text-right text-xs max-w-xs">{signal.reason || "4H bias confluence"}</span>
                          </div>
                        </div>
                      </div>
                    )}
                  </div>

                  {/* Footer */}
                  <div className="px-7 py-4 border-t border-gray-800 bg-gray-900/30">
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
