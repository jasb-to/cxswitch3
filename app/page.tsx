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
    if (state === "BUILDING") return "border-l-[6px] border-l-amber-500";
    if (state === "SNIPER" && direction === "LONG") return "border-l-[6px] border-l-green-500";
    if (state === "SNIPER" && direction === "SHORT") return "border-l-[6px] border-l-red-500";
    return "border-l-[6px] border-l-gray-700";
  };

  const getStatusBadgeStyle = (state: string, direction?: string) => {
    if (state === "BUILDING") return "bg-amber-500 text-black font-bold px-4 py-1.5 rounded text-xs uppercase tracking-wider";
    if (state === "SNIPER" && direction === "LONG") return "bg-green-500 text-black font-bold px-4 py-1.5 rounded text-xs uppercase tracking-wider";
    if (state === "SNIPER" && direction === "SHORT") return "bg-red-500 text-white font-bold px-4 py-1.5 rounded text-xs uppercase tracking-wider";
    return "bg-gray-600 text-white font-bold px-4 py-1.5 rounded text-xs uppercase tracking-wider";
  };

  const getConfidenceColor = (state: string, direction?: string) => {
    if (state === "BUILDING") return "bg-amber-500";
    if (state === "SNIPER" && direction === "LONG") return "bg-green-500";
    if (state === "SNIPER" && direction === "SHORT") return "bg-red-500";
    return "bg-cyan-500";
  };

  const getBiasColor = (bias: string) => {
    if (bias === "Bullish") return "text-green-400";
    if (bias === "Bearish") return "text-red-400";
    return "text-gray-300";
  };

  const getDirectionColor = (direction?: string) => {
    if (direction === "LONG") return "text-green-400";
    if (direction === "SHORT") return "text-red-400";
    return "text-gray-300";
  };

  return (
    <div className="min-h-screen w-full bg-black">
      <div className="w-full px-8 py-10 md:px-12 md:py-12 lg:px-16 lg:py-14">
        <div className="max-w-[1400px] mx-auto space-y-10">
          {/* Header */}
          <div className="flex items-start justify-between">
            <div>
              <h1 className="text-4xl font-bold text-white tracking-tight">Trading Signals</h1>
              <p className="text-sm text-gray-500 mt-2">Last updated: {lastUpdate || "—"}</p>
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

          {/* Market Overview */}
          <div>
            <h2 className="text-base font-bold text-white mb-6 uppercase tracking-wider">Market Overview</h2>
            <div className="grid grid-cols-1 md:grid-cols-2 xl:grid-cols-3 gap-6">
              {signals.map((signal) => (
                <div
                  key={signal.symbol}
                  className={`rounded-lg overflow-hidden bg-[#111] border border-gray-800 ${getCardBorderColor(
                    signal.state,
                    signal.direction
                  )}`}
                >
                  {/* Card Header */}
                  <div className="px-6 py-5 border-b border-gray-800 flex items-start justify-between bg-[#0d0d0d]">
                    <h3 className="text-2xl font-bold text-white tracking-tight">{signal.symbol}</h3>
                    <span className={getStatusBadgeStyle(signal.state, signal.direction)}>
                      {signal.state === "SNIPER" ? signal.direction : signal.state}
                    </span>
                  </div>

                  {/* Card Body */}
                  <div className="px-6 py-5 space-y-5">
                    {/* Price */}
                    <div>
                      <p className="text-sm text-gray-400">
                        Price: {" "}
                        <span className="font-mono text-white font-semibold">
                          ${signal.price.toLocaleString(undefined, {
                            minimumFractionDigits: 2,
                            maximumFractionDigits: 2,
                          })}
                        </span>
                      </p>
                    </div>

                    {/* 4H Trend & 15M Structure Row */}
                    <div className="flex justify-between items-start gap-4">
                      <div>
                        <p className="text-[11px] text-gray-500 uppercase tracking-wider font-bold mb-1">4H Trend</p>
                        <p className={`text-sm font-bold ${getBiasColor(signal.bias)}`}>
                          {signal.bias}
                        </p>
                      </div>
                      <div className="text-right">
                        <p className="text-[11px] text-gray-500 uppercase tracking-wider font-bold mb-1">15M Structure</p>
                        <p className="text-sm font-bold text-white">{signal.trigger}</p>
                      </div>
                    </div>

                    {/* Macro Bias */}
                    <div>
                      <p className="text-[11px] text-gray-500 uppercase tracking-wider font-bold mb-1">Macro Bias</p>
                      <p className={`text-sm font-bold ${getBiasColor(signal.bias)}`}>{signal.bias}</p>
                    </div>

                    {/* Confidence Bar */}
                    <div>
                      <div className="flex justify-between items-center mb-2">
                        <p className="text-[11px] text-gray-500 uppercase tracking-wider font-bold">Confidence</p>
                        <p className={`text-sm font-bold ${getDirectionColor(signal.direction)}`}>
                          {signal.confidence}%
                        </p>
                      </div>
                      <div className="w-full bg-gray-800 rounded-full h-2 overflow-hidden">
                        <div
                          className={`h-2 rounded-full transition-all duration-300 ${getConfidenceColor(
                            signal.state,
                            signal.direction
                          )}`}
                          style={{ width: `${Math.min(100, signal.confidence)}%` }}
                        />
                      </div>
                    </div>

                    {/* Trade Setup — Only for SNIPER, displayed inline */}
                    {signal.state === "SNIPER" && (
                      <div className="space-y-3 pt-2">
                        <p className="text-[11px] text-gray-500 uppercase tracking-wider font-bold">Trade Setup</p>
                        
                        <div className="space-y-2.5">
                          <div className="flex justify-between text-sm">
                            <span className="text-gray-400">Direction:</span>
                            <span className={`font-bold ${getDirectionColor(signal.direction)}`}>
                              {signal.direction}
                            </span>
                          </div>
                          
                          <div className="flex justify-between text-sm">
                            <span className="text-gray-400">Entry:</span>
                            <span className="font-mono text-white font-bold">
                              ${signal.entry?.toLocaleString(undefined, {
                                minimumFractionDigits: 2,
                                maximumFractionDigits: 2,
                              })}
                            </span>
                          </div>
                          
                          <div className="flex justify-between text-sm">
                            <span className="text-gray-400">SL:</span>
                            <span className="font-mono text-white font-bold">
                              ${signal.stopLoss?.toLocaleString(undefined, {
                                minimumFractionDigits: 2,
                                maximumFractionDigits: 2,
                              })}
                            </span>
                          </div>
                          
                          <div className="flex justify-between text-sm">
                            <span className="text-gray-400">TP:</span>
                            <span className="font-mono text-white font-bold">
                              ${signal.takeProfit?.toLocaleString(undefined, {
                                minimumFractionDigits: 2,
                                maximumFractionDigits: 2,
                              })}
                            </span>
                          </div>
                          
                          <div className="flex justify-between text-sm">
                            <span className="text-gray-400">RR:</span>
                            <span className="font-mono text-white font-bold">
                              {signal.riskReward?.toFixed(2)}
                            </span>
                          </div>
                          
                          <div className="flex justify-between text-sm">
                            <span className="text-gray-400">Confidence:</span>
                            <span className={`font-bold ${getDirectionColor(signal.direction)}`}>
                              {signal.confidence}%
                            </span>
                          </div>
                          
                          <div className="flex justify-between text-sm items-start gap-2">
                            <span className="text-gray-400 shrink-0">Reason:</span>
                            <span className="text-gray-300 text-right text-xs leading-relaxed">
                              {signal.reason || "4H bias confluence"}
                            </span>
                          </div>
                        </div>
                      </div>
                    )}
                  </div>

                  {/* Footer */}
                  <div className="px-6 py-3 border-t border-gray-800 bg-[#0d0d0d]">
                    <p className="text-xs text-gray-600 text-right">
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
