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
  // New fields you might be using
  timeframe?: string;
  volume24h?: number;
  atr?: number;
  ema20?: number;
  ema50?: number;
  rsi?: number;
  macd?: number;
  support?: number;
  resistance?: number;
  trendStrength?: number;
  volatility?: number;
  marketCap?: number;
  change24h?: number;
  change7d?: number;
}

export default function Home() {
  const [signals, setSignals] = useState<Signal[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState("");
  const [lastUpdate, setLastUpdate] = useState("");
  const [testLoading, setTestLoading] = useState(false);
  const [selectedTimeframe, setSelectedTimeframe] = useState("1H");
  const [sortBy, setSortBy] = useState<"confidence" | "symbol" | "price" | "change24h">("confidence");
  const [filterState, setFilterState] = useState<"ALL" | "FLAT" | "BUILDING" | "SNIPER">("ALL");

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
    if (state === "BUILDING") return "bg-amber-500 text-black font-bold px-4 py-2 rounded-md text-sm uppercase tracking-wide";
    if (state === "SNIPER" && direction === "LONG") return "bg-green-500 text-black font-bold px-4 py-2 rounded-md text-sm uppercase tracking-wide";
    if (state === "SNIPER" && direction === "SHORT") return "bg-red-500 text-white font-bold px-4 py-2 rounded-md text-sm uppercase tracking-wide";
    return "bg-gray-600 text-white font-bold px-4 py-2 rounded-md text-sm uppercase tracking-wide";
  };

  const getConfidenceColor = (confidence: number, state: string, direction?: string) => {
    if (state === "BUILDING") return "bg-amber-500";
    if (state === "SNIPER" && direction === "LONG") return "bg-green-500";
    if (state === "SNIPER" && direction === "SHORT") return "bg-red-500";
    if (confidence >= 70) return "bg-emerald-400";
    if (confidence >= 40) return "bg-yellow-400";
    return "bg-gray-500";
  };

  const getConfidenceLabel = (confidence: number) => {
    if (confidence >= 85) return "High Conviction";
    if (confidence >= 60) return "Moderate";
    if (confidence >= 40) return "Developing";
    return "Weak";
  };

  const getBiasColor = (bias: string) => {
    if (bias === "Bullish") return "text-green-400";
    if (bias === "Bearish") return "text-red-400";
    return "text-gray-400";
  };

  const getChangeColor = (change?: number) => {
    if (!change) return "text-gray-400";
    return change >= 0 ? "text-green-400" : "text-red-400";
  };

  const filteredAndSortedSignals = signals
    .filter((sig) => filterState === "ALL" || sig.state === filterState)
    .sort((a, b) => {
      if (sortBy === "confidence") return b.confidence - a.confidence;
      if (sortBy === "symbol") return a.symbol.localeCompare(b.symbol);
      if (sortBy === "price") return b.price - a.price;
      if (sortBy === "change24h") return (b.change24h || 0) - (a.change24h || 0);
      return 0;
    });

  const sniperCount = signals.filter((s) => s.state === "SNIPER").length;
  const buildingCount = signals.filter((s) => s.state === "BUILDING").length;
  const flatCount = signals.filter((s) => s.state === "FLAT").length;

  return (
    <div className="min-h-screen w-full bg-black">
      <div className="w-full px-6 py-8 md:px-12 md:py-12 lg:px-16 lg:py-16">
        <div className="max-w-[1600px] mx-auto space-y-10">
          {/* Header */}
          <div className="flex flex-col lg:flex-row lg:items-start lg:justify-between gap-6">
            <div>
              <h1 className="text-4xl md:text-5xl font-bold text-white tracking-tight">Trading Signals</h1>
              <p className="text-sm text-gray-500 mt-3">Last updated: {lastUpdate || "—"}</p>
            </div>
            <div className="flex flex-wrap items-center gap-3">
              <div className="flex items-center gap-2 bg-gray-900 rounded-lg border border-gray-800 px-3 py-2">
                <span className="text-xs text-gray-500 uppercase font-bold">Sort:</span>
                <select
                  value={sortBy}
                  onChange={(e) => setSortBy(e.target.value as any)}
                  className="bg-transparent text-sm text-white font-semibold outline-none cursor-pointer"
                >
                  <option value="confidence">Confidence</option>
                  <option value="symbol">Symbol</option>
                  <option value="price">Price</option>
                  <option value="change24h">24h Change</option>
                </select>
              </div>
              <div className="flex items-center gap-2 bg-gray-900 rounded-lg border border-gray-800 px-3 py-2">
                <span className="text-xs text-gray-500 uppercase font-bold">Filter:</span>
                <select
                  value={filterState}
                  onChange={(e) => setFilterState(e.target.value as any)}
                  className="bg-transparent text-sm text-white font-semibold outline-none cursor-pointer"
                >
                  <option value="ALL">All ({signals.length})</option>
                  <option value="SNIPER">Sniper ({sniperCount})</option>
                  <option value="BUILDING">Building ({buildingCount})</option>
                  <option value="FLAT">Flat ({flatCount})</option>
                </select>
              </div>
              <button
                onClick={fetchSignals}
                disabled={loading}
                className="px-5 py-2.5 bg-gray-900 hover:bg-gray-800 text-sm font-semibold rounded-lg text-white disabled:opacity-50 transition border border-gray-700"
              >
                {loading ? "Refreshing..." : "Refresh"}
              </button>
              <button
                onClick={testTelegram}
                disabled={testLoading}
                className="px-5 py-2.5 bg-gray-900 hover:bg-gray-800 text-sm font-semibold rounded-lg text-white disabled:opacity-50 transition border border-gray-700"
              >
                {testLoading ? "Testing..." : "Test Alert"}
              </button>
            </div>
          </div>

          {/* Stats Bar */}
          <div className="grid grid-cols-3 gap-4">
            <div className="bg-gray-950 border border-gray-800 rounded-xl p-5 text-center">
              <p className="text-3xl font-bold text-green-400">{sniperCount}</p>
              <p className="text-xs text-gray-500 uppercase tracking-wider font-bold mt-1">Sniper</p>
            </div>
            <div className="bg-gray-950 border border-gray-800 rounded-xl p-5 text-center">
              <p className="text-3xl font-bold text-amber-400">{buildingCount}</p>
              <p className="text-xs text-gray-500 uppercase tracking-wider font-bold mt-1">Building</p>
            </div>
            <div className="bg-gray-950 border border-gray-800 rounded-xl p-5 text-center">
              <p className="text-3xl font-bold text-gray-400">{flatCount}</p>
              <p className="text-xs text-gray-500 uppercase tracking-wider font-bold mt-1">Flat</p>
            </div>
          </div>

          {/* Error Banner */}
          {error && (
            <div className="p-4 bg-red-950/40 border border-red-800/50 rounded-lg text-red-300 text-sm">
              Error: {error}
            </div>
          )}

          {/* Market Overview */}
          <div>
            <div className="flex items-center justify-between mb-8">
              <h2 className="text-lg font-bold text-white uppercase tracking-wider">Market Overview</h2>
              <div className="flex items-center gap-2">
                {["1H", "4H", "1D"].map((tf) => (
                  <button
                    key={tf}
                    onClick={() => setSelectedTimeframe(tf)}
                    className={`px-3 py-1.5 rounded-md text-xs font-bold uppercase tracking-wide transition ${
                      selectedTimeframe === tf
                        ? "bg-white text-black"
                        : "bg-gray-900 text-gray-400 hover:text-white border border-gray-800"
                    }`}
                  >
                    {tf}
                  </button>
                ))}
              </div>
            </div>

            {filteredAndSortedSignals.length === 0 ? (
              <div className="text-center py-20 text-gray-500">
                <p className="text-lg font-semibold">No signals match your filter</p>
                <p className="text-sm mt-2">Try changing your filter criteria</p>
              </div>
            ) : (
              <div className="grid grid-cols-1 md:grid-cols-2 xl:grid-cols-3 gap-8">
                {filteredAndSortedSignals.map((signal) => (
                  <div
                    key={signal.symbol}
                    className={`rounded-2xl overflow-hidden bg-gray-950 border border-gray-800 ${getCardBorderColor(
                      signal.state,
                      signal.direction
                    )} hover:border-gray-700 transition-colors`}
                  >
                    {/* Card Header */}
                    <div className="px-8 py-7 border-b border-gray-800 flex items-start justify-between bg-gray-900/40">
                      <div>
                        <h3 className="text-5xl font-bold text-white tracking-tight">{signal.symbol}</h3>
                        {signal.change24h !== undefined && (
                          <p className={`text-sm font-bold mt-1 ${getChangeColor(signal.change24h)}`}>
                            {signal.change24h >= 0 ? "+" : ""}
                            {signal.change24h.toFixed(2)}% (24h)
                          </p>
                        )}
                      </div>
                      <span className={getStatusBadgeStyle(signal.state, signal.direction)}>
                        {signal.state === "SNIPER" ? signal.direction : signal.state}
                      </span>
                    </div>

                    {/* Card Body */}
                    <div className="px-8 py-8 space-y-8">
                      {/* Price & Market Cap Row */}
                      <div className="flex justify-between items-start gap-6">
                        <div className="flex-1">
                          <p className="text-xs text-gray-500 uppercase tracking-wider font-bold mb-2">Price</p>
                          <p className="text-3xl font-mono text-white font-bold">
                            ${signal.price.toLocaleString(undefined, {
                              minimumFractionDigits: 2,
                              maximumFractionDigits: 6,
                            })}
                          </p>
                        </div>
                        {signal.marketCap && (
                          <div className="text-right">
                            <p className="text-xs text-gray-500 uppercase tracking-wider font-bold mb-2">Market Cap</p>
                            <p className="text-lg font-mono text-white font-bold">
                              ${(signal.marketCap / 1e9).toFixed(2)}B
                            </p>
                          </div>
                        )}
                      </div>

                      {/* 4H Trend & Trigger Row */}
                      <div className="flex justify-between items-start gap-6">
                        <div className="flex-1">
                          <p className="text-xs text-gray-500 uppercase tracking-wider font-bold mb-2">4H Trend</p>
                          <p className={`text-lg font-bold ${getBiasColor(signal.bias)}`}>
                            {signal.bias}
                          </p>
                        </div>
                        <div className="text-right flex-1">
                          <p className="text-xs text-gray-500 uppercase tracking-wider font-bold mb-2">15M Structure</p>
                          <p className="text-lg font-bold text-white">{signal.trigger}</p>
                        </div>
                      </div>

                      {/* Technical Indicators Grid */}
                      {(signal.rsi !== undefined || signal.macd !== undefined || signal.atr !== undefined) && (
                        <div className="grid grid-cols-3 gap-4 bg-gray-900/30 rounded-xl p-5">
                          {signal.rsi !== undefined && (
                            <div className="text-center">
                              <p className="text-xs text-gray-500 uppercase tracking-wider font-bold mb-1">RSI</p>
                              <p className={`text-xl font-bold font-mono ${
                                signal.rsi > 70 ? "text-red-400" : signal.rsi < 30 ? "text-green-400" : "text-white"
                              }`}>
                                {signal.rsi.toFixed(1)}
                              </p>
                            </div>
                          )}
                          {signal.macd !== undefined && (
                            <div className="text-center">
                              <p className="text-xs text-gray-500 uppercase tracking-wider font-bold mb-1">MACD</p>
                              <p className={`text-xl font-bold font-mono ${signal.macd > 0 ? "text-green-400" : "text-red-400"}`}>
                                {signal.macd > 0 ? "+" : ""}
                                {signal.macd.toFixed(3)}
                              </p>
                            </div>
                          )}
                          {signal.atr !== undefined && (
                            <div className="text-center">
                              <p className="text-xs text-gray-500 uppercase tracking-wider font-bold mb-1">ATR</p>
                              <p className="text-xl font-bold font-mono text-white">
                                {signal.atr.toFixed(4)}
                              </p>
                            </div>
                          )}
                        </div>
                      )}

                      {/* EMAs */}
                      {(signal.ema20 !== undefined || signal.ema50 !== undefined) && (
                        <div className="flex justify-between items-center gap-6 bg-gray-900/30 rounded-xl p-5">
                          {signal.ema20 !== undefined && (
                            <div>
                              <p className="text-xs text-gray-500 uppercase tracking-wider font-bold mb-1">EMA 20</p>
                              <p className="text-lg font-bold font-mono text-white">
                                ${signal.ema20.toLocaleString(undefined, { maximumFractionDigits: 4 })}
                              </p>
                            </div>
                          )}
                          {signal.ema50 !== undefined && (
                            <div className="text-right">
                              <p className="text-xs text-gray-500 uppercase tracking-wider font-bold mb-1">EMA 50</p>
                              <p className="text-lg font-bold font-mono text-white">
                                ${signal.ema50.toLocaleString(undefined, { maximumFractionDigits: 4 })}
                              </p>
                            </div>
                          )}
                        </div>
                      )}

                      {/* Support / Resistance */}
                      {(signal.support !== undefined || signal.resistance !== undefined) && (
                        <div className="space-y-3 bg-gray-900/30 rounded-xl p-5">
                          {signal.support !== undefined && (
                            <div className="flex justify-between items-center">
                              <span className="text-xs text-gray-500 uppercase tracking-wider font-bold">Support</span>
                              <span className="text-lg font-bold font-mono text-green-400">
                                ${signal.support.toLocaleString(undefined, { maximumFractionDigits: 4 })}
                              </span>
                            </div>
                          )}
                          {signal.resistance !== undefined && (
                            <div className="flex justify-between items-center">
                              <span className="text-xs text-gray-500 uppercase tracking-wider font-bold">Resistance</span>
                              <span className="text-lg font-bold font-mono text-red-400">
                                ${signal.resistance.toLocaleString(undefined, { maximumFractionDigits: 4 })}
                              </span>
                            </div>
                          )}
                        </div>
                      )}

                      {/* Volume */}
                      {signal.volume24h !== undefined && (
                        <div>
                          <p className="text-xs text-gray-500 uppercase tracking-wider font-bold mb-2">24h Volume</p>
                          <p className="text-lg font-bold font-mono text-white">
                            ${(signal.volume24h / 1e6).toFixed(2)}M
                          </p>
                        </div>
                      )}

                      {/* Confidence Slider */}
                      <div className="bg-gray-900/50 rounded-xl p-6">
                        <div className="flex justify-between items-center mb-4">
                          <div>
                            <p className="text-xs text-gray-500 uppercase tracking-wider font-bold">Confidence</p>
                            <p className="text-xs text-gray-600 mt-0.5">{getConfidenceLabel(signal.confidence)}</p>
                          </div>
                          <p className="text-2xl font-bold text-white">{signal.confidence}%</p>
                        </div>
                        <div className="w-full bg-gray-800 rounded-full h-3 overflow-hidden">
                          <div
                            className={`h-3 rounded-full transition-all duration-500 ${getConfidenceColor(
                              signal.confidence,
                              signal.state,
                              signal.direction
                            )}`}
                            style={{ width: `${Math.min(100, signal.confidence)}%` }}
                          />
                        </div>
                        <div className="flex justify-between mt-2">
                          <span className="text-[10px] text-gray-600 font-bold">0%</span>
                          <span className="text-[10px] text-gray-600 font-bold">50%</span>
                          <span className="text-[10px] text-gray-600 font-bold">100%</span>
                        </div>
                      </div>

                      {/* Trade Setup - Only for SNIPER */}
                      {signal.state === "SNIPER" && (
                        <div className="border-t-2 border-gray-800 pt-8 space-y-5">
                          <p className="text-xs text-gray-500 uppercase tracking-wider font-bold">Trade Setup</p>
                          
                          <div className="space-y-4">
                            <div className="flex justify-between items-center py-2 border-b border-gray-800/50">
                              <span className="text-sm text-gray-500 font-medium">Direction</span>
                              <span
                                className={`text-lg font-bold ${
                                  signal.direction === "LONG" ? "text-green-400" : "text-red-400"
                                }`}
                              >
                                {signal.direction}
                              </span>
                            </div>
                            
                            <div className="flex justify-between items-center py-2 border-b border-gray-800/50">
                              <span className="text-sm text-gray-500 font-medium">Entry</span>
                              <span className="text-lg font-mono text-white font-bold">
                                ${signal.entry?.toLocaleString(undefined, {
                                  minimumFractionDigits: 2,
                                  maximumFractionDigits: 6,
                                })}
                              </span>
                            </div>
                            
                            <div className="flex justify-between items-center py-2 border-b border-gray-800/50">
                              <span className="text-sm text-gray-500 font-medium">Stop Loss</span>
                              <span className="text-lg font-mono text-red-400 font-bold">
                                ${signal.stopLoss?.toLocaleString(undefined, {
                                  minimumFractionDigits: 2,
                                  maximumFractionDigits: 6,
                                })}
                              </span>
                            </div>
                            
                            <div className="flex justify-between items-center py-2 border-b border-gray-800/50">
                              <span className="text-sm text-gray-500 font-medium">Take Profit</span>
                              <span className="text-lg font-mono text-green-400 font-bold">
                                ${signal.takeProfit?.toLocaleString(undefined, {
                                  minimumFractionDigits: 2,
                                  maximumFractionDigits: 6,
                                })}
                              </span>
                            </div>
                            
                            <div className="flex justify-between items-center py-2 border-b border-gray-800/50">
                              <span className="text-sm text-gray-500 font-medium">Risk/Reward</span>
                              <span className="text-lg font-mono text-white font-bold">
                                1:{signal.riskReward?.toFixed(2)}
                              </span>
                            </div>
                            
                            <div className="flex justify-between items-center py-2 border-b border-gray-800/50">
                              <span className="text-sm text-gray-500 font-medium">Confidence</span>
                              <span className={`text-lg font-bold ${
                                signal.direction === "LONG" ? "text-green-400" : "text-red-400"
                              }`}>
                                {signal.confidence}%
                              </span>
                            </div>
                            
                            <div className="pt-2">
                              <span className="text-sm text-gray-500 font-medium block mb-2">Reason</span>
                              <p className="text-sm text-gray-300 leading-relaxed bg-gray-900/50 rounded-lg p-4">
                                {signal.reason || "4H bias confluence with 15M structure alignment"}
                              </p>
                            </div>
                          </div>
                        </div>
                      )}
                    </div>

                    {/* Footer */}
                    <div className="px-8 py-5 border-t border-gray-800 bg-gray-900/30 flex justify-between items-center">
                      <p className="text-xs text-gray-600">
                        Updated: {new Date(signal.updatedAt).toLocaleTimeString("en-GB")}
                      </p>
                      {signal.timeframe && (
                        <span className="text-xs text-gray-600 font-bold uppercase tracking-wider">
                          {signal.timeframe}
                        </span>
                      )}
                    </div>
                  </div>
                ))}
              </div>
            )}
          </div>
        </div>
      </div>
    </div>
  );
}
