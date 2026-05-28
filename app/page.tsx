"use client";

import { useState, useEffect } from "react";

interface Signal {
  symbol: string;
  price: number;
  change24h: number;
  high24h: number;
  low24h: number;
  bias: "Bullish" | "Bearish" | "Neutral";
  state: "FLAT" | "BUILDING" | "SNIPER";
  direction?: "LONG" | "SHORT";
  entry?: number;
  stopLoss?: number;
  takeProfit?: number;
  riskReward?: number;
  confidence: number;
  trigger: string;
  momentum: string;
  trendScore: number;
  rangePosition: number;
  volatilityState: string;
  moveTiming: string;
  shouldAlert: boolean;
  updatedAt: string;
}

export default function Home() {
  const [signals, setSignals] = useState<Signal[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState("");
  const [lastUpdate, setLastUpdate] = useState("");
  const [countdown, setCountdown] = useState(60);
  const [testLoading, setTestLoading] = useState(false);
  const [testResult, setTestResult] = useState("");

  async function fetchSignals() {
    try {
      setLoading(true);
      const res = await fetch("/api/signals", { cache: "no-store" });
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      const data = await res.json();
      setSignals(data.signals || []);
      setLastUpdate(new Date().toLocaleString("en-GB"));
      setError("");
      setCountdown(60);
    } catch (err: any) {
      setError(err.message || "Failed to fetch");
    } finally {
      setLoading(false);
    }
  }

  async function testAlert() {
    setTestLoading(true);
    setTestResult("");
    try {
      const res = await fetch("/api/cron?secret=abc123xyz789&test=true", { cache: "no-store" });
      const data = await res.json();
      if (data.test) {
        setTestResult("✅ Test alert sent to Telegram!");
      } else {
        setTestResult("⚠️ Test completed but no alert sent (check Telegram config)");
      }
    } catch (err: any) {
      setTestResult("❌ Test failed: " + (err.message || "Unknown error"));
    } finally {
      setTestLoading(false);
      setTimeout(() => setTestResult(""), 5000);
    }
  }

  useEffect(() => {
    const timer = setInterval(() => {
      setCountdown((prev) => (prev > 0 ? prev - 1 : 60));
    }, 1000);
    return () => clearInterval(timer);
  }, []);

  useEffect(() => {
    fetchSignals();
    const interval = setInterval(fetchSignals, 60000);
    return () => clearInterval(interval);
  }, []);

  const getStateColor = (state: string, direction?: string) => {
    if (state === "SNIPER" && direction === "LONG") return "border-green-500";
    if (state === "SNIPER" && direction === "SHORT") return "border-red-500";
    if (state === "BUILDING") return "border-amber-500";
    return "border-gray-700";
  };

  const getStateBadge = (state: string, direction?: string) => {
    if (state === "SNIPER" && direction === "LONG") return "bg-green-500 text-black font-bold";
    if (state === "SNIPER" && direction === "SHORT") return "bg-red-500 text-white font-bold";
    if (state === "BUILDING") return "bg-amber-500 text-black font-bold";
    return "bg-gray-700 text-white font-bold";
  };

  const getBiasColor = (bias: string) => {
    if (bias === "Bullish") return "text-green-400";
    if (bias === "Bearish") return "text-red-400";
    return "text-gray-400";
  };

  const getConfidenceColor = (conf: number) => {
    if (conf >= 80) return "bg-green-500";
    if (conf >= 60) return "bg-amber-500";
    if (conf >= 40) return "bg-yellow-500";
    return "bg-gray-600";
  };

  const getMomentumColor = (mom: string) => {
    if (mom === "Accelerating") return "text-green-400";
    if (mom === "Decelerating") return "text-red-400";
    return "text-gray-400";
  };

  const getRangeBarColor = (pos: number) => {
    if (pos < 0.2) return "bg-green-500"; // near bottom = long opportunity
    if (pos > 0.8) return "bg-red-500";   // near top = short opportunity
    return "bg-gray-500";
  };

  const getVerdict = (signal: Signal) => {
    if (signal.state === "SNIPER" && signal.shouldAlert) {
      if (signal.moveTiming === "Early") return { text: "✅ EARLY ENTRY — Fresh move", color: "text-green-400" };
      if (signal.moveTiming === "Mid") return { text: "⚠️ MID MOVE — Manage risk", color: "text-amber-400" };
      return { text: "❌ LATE MOVE — Consider skipping", color: "text-red-400" };
    }
    if (signal.state === "BUILDING") {
      if (signal.trendScore > 60) return { text: "👁️ WATCHING — Setup forming", color: "text-cyan-400" };
      return { text: "⏸️ NO SETUP — Wait for trigger", color: "text-gray-500" };
    }
    return { text: "⏸️ FLAT — No bias", color: "text-gray-500" };
  };

  return (
    <div className="min-h-screen w-full bg-black text-gray-100">
      <div className="w-full px-8 py-8">
        <div className="max-w-7xl mx-auto">
          
          {/* Header */}
          <div className="flex items-start justify-between mb-8">
            <div>
              <h1 className="text-4xl font-bold text-white tracking-tight">Trading Signals</h1>
              <p className="text-sm text-gray-500 mt-2">
                Last updated: {lastUpdate} 
                <span className="ml-2 text-cyan-400">({countdown}s)</span>
              </p>
            </div>
            <div className="flex items-center gap-3">
              <button
                onClick={fetchSignals}
                disabled={loading}
                className="px-6 py-3 bg-gray-900 hover:bg-gray-800 text-sm font-semibold rounded text-white disabled:opacity-50 transition border border-gray-700"
              >
                {loading ? "Refreshing..." : "Refresh"}
              </button>
              <button
                onClick={testAlert}
                disabled={testLoading}
                className="px-6 py-3 bg-gray-900 hover:bg-gray-800 text-sm font-semibold rounded text-white disabled:opacity-50 transition border border-gray-700"
              >
                {testLoading ? "Testing..." : "Test Alert"}
              </button>
            </div>
          </div>

          {/* Test Result */}
          {testResult && (
            <div className="mb-6 p-4 bg-gray-900/50 border border-gray-700 rounded text-sm">
              {testResult}
            </div>
          )}

          {/* Error Banner */}
          {error && (
            <div className="mb-6 p-4 bg-red-950/40 border border-red-800/50 rounded text-red-300 text-sm">
              Error: {error}
            </div>
          )}

          {/* Market Overview */}
          <div>
            <h2 className="text-lg font-bold text-white mb-6 uppercase tracking-wider">Market Overview</h2>
            
            <div className="grid grid-cols-1 md:grid-cols-3 gap-8">
              {signals.map((signal) => {
                const verdict = getVerdict(signal);
                return (
                <div
                  key={signal.symbol}
                  className={`rounded-xl overflow-hidden bg-gray-950 border-2 ${getStateColor(signal.state, signal.direction)} transition-all hover:opacity-95`}
                >
                  {/* Card Header */}
                  <div className="px-6 py-5 border-b border-gray-800 flex items-center justify-between bg-gray-900/50">
                    <div>
                      <h3 className="text-3xl font-bold text-white">{signal.symbol}</h3>
                      <p className="text-xs text-gray-500 mt-1">
                        {signal.state === "SNIPER" ? "🎯 SNIPER ACTIVE" : signal.state === "BUILDING" ? "📊 Building Setup" : "⏸️ Flat"}
                      </p>
                    </div>
                    <span className={`px-4 py-2 rounded-lg text-sm ${getStateBadge(signal.state, signal.direction)}`}>
                      {signal.state === "SNIPER" ? signal.direction : signal.state}
                    </span>
                  </div>

                  {/* Card Body */}
                  <div className="px-6 py-6 space-y-5">
                    
                    {/* Price Row */}
                    <div className="flex items-baseline justify-between">
                      <div>
                        <p className="text-xs text-gray-500 uppercase tracking-wider font-bold">Price</p>
                        <p className="text-3xl font-mono text-white font-bold mt-1">
                          ${signal.price.toLocaleString(undefined, { minimumFractionDigits: 2, maximumFractionDigits: 2 })}
                        </p>
                      </div>
                      <div className="text-right">
                        <p className={`text-lg font-bold ${signal.change24h > 0 ? "text-green-400" : signal.change24h < 0 ? "text-red-400" : "text-gray-400"}`}>
                          {signal.change24h > 0 ? "+" : ""}{signal.change24h.toFixed(2)}%
                        </p>
                        <p className="text-xs text-gray-500">24h change</p>
                      </div>
                    </div>

                    {/* 24h Range */}
                    <div className="bg-gray-900/50 rounded-lg p-4">
                      <div className="flex justify-between items-center mb-2">
                        <p className="text-xs text-gray-500 uppercase tracking-wider font-bold">24h Range</p>
                        <p className="text-xs text-gray-400">
                          L: ${signal.low24h.toLocaleString(undefined, {maximumFractionDigits: 0})} 
                          / H: ${signal.high24h.toLocaleString(undefined, {maximumFractionDigits: 0})}
                        </p>
                      </div>
                      <div className="w-full bg-gray-800 rounded-full h-3 overflow-hidden relative">
                        <div
                          className={`h-3 rounded-full ${getRangeBarColor(signal.rangePosition)}`}
                          style={{ width: `${Math.min(100, signal.rangePosition * 100)}%` }}
                        />
                        <div 
                          className="absolute top-0 w-1 h-3 bg-white rounded-full"
                          style={{ left: `${Math.min(100, signal.rangePosition * 100)}%` }}
                        />
                      </div>
                      <div className="flex justify-between text-xs mt-1">
                        <span className="text-green-400">Bottom</span>
                        <span className="text-gray-400">{Math.round(signal.rangePosition * 100)}% from low</span>
                        <span className="text-red-400">Top</span>
                      </div>
                    </div>

                    {/* Bias & Trigger Row */}
                    <div className="grid grid-cols-2 gap-4">
                      <div className="bg-gray-900/50 rounded-lg p-3">
                        <p className="text-xs text-gray-500 uppercase tracking-wider font-bold mb-1">4H Bias</p>
                        <p className={`text-lg font-bold ${getBiasColor(signal.bias)}`}>
                          {signal.bias}
                        </p>
                      </div>
                      <div className="bg-gray-900/50 rounded-lg p-3">
                        <p className="text-xs text-gray-500 uppercase tracking-wider font-bold mb-1">Trigger</p>
                        <p className="text-lg font-bold text-white">
                          {signal.trigger}
                        </p>
                      </div>
                    </div>

                    {/* Momentum & Direction Row */}
                    <div className="grid grid-cols-2 gap-4">
                      <div className="bg-gray-900/50 rounded-lg p-3">
                        <p className="text-xs text-gray-500 uppercase tracking-wider font-bold mb-1">Momentum</p>
                        <p className={`text-lg font-bold ${getMomentumColor(signal.momentum)}`}>
                          {signal.momentum}
                        </p>
                      </div>
                      <div className="bg-gray-900/50 rounded-lg p-3">
                        <p className="text-xs text-gray-500 uppercase tracking-wider font-bold mb-1">Direction</p>
                        <p className={`text-lg font-bold ${signal.direction === "LONG" ? "text-green-400" : signal.direction === "SHORT" ? "text-red-400" : "text-gray-400"}`}>
                          {signal.direction || "—"}
                        </p>
                      </div>
                    </div>

                    {/* Trend Health */}
                    <div className="bg-gray-900/50 rounded-lg p-4">
                      <p className="text-xs text-gray-500 uppercase tracking-wider font-bold mb-3">Trend Health</p>
                      
                      {/* Trend Score */}
                      <div className="mb-3">
                        <div className="flex justify-between items-center mb-1">
                          <span className="text-xs text-gray-400">Trend Score</span>
                          <span className="text-sm font-bold text-white">{signal.trendScore}/100</span>
                        </div>
                        <div className="w-full bg-gray-800 rounded-full h-2 overflow-hidden">
                          <div
                            className={`h-2 rounded-full ${signal.trendScore > 70 ? "bg-green-500" : signal.trendScore > 40 ? "bg-amber-500" : "bg-gray-600"}`}
                            style={{ width: `${Math.min(100, signal.trendScore)}%` }}
                          />
                        </div>
                      </div>
                      
                      {/* Move Timing & Volatility */}
                      <div className="grid grid-cols-2 gap-3 text-sm">
                        <div>
                          <span className="text-gray-500 text-xs">Move Timing</span>
                          <p className={`font-bold ${signal.moveTiming === "Early" ? "text-green-400" : signal.moveTiming === "Mid" ? "text-amber-400" : "text-red-400"}`}>
                            {signal.moveTiming}
                          </p>
                        </div>
                        <div>
                          <span className="text-gray-500 text-xs">Volatility</span>
                          <p className="text-white font-bold">{signal.volatilityState}</p>
                        </div>
                      </div>
                    </div>

                    {/* Confidence Slider */}
                    <div className="bg-gray-900/50 rounded-lg p-4">
                      <div className="flex justify-between items-center mb-2">
                        <p className="text-xs text-gray-500 uppercase tracking-wider font-bold">Confidence</p>
                        <p className="text-xl font-bold text-white">{signal.confidence}%</p>
                      </div>
                      <div className="w-full bg-gray-800 rounded-full h-3 overflow-hidden">
                        <div
                          className={`h-3 rounded-full transition-all duration-500 ${getConfidenceColor(signal.confidence)}`}
                          style={{ width: `${Math.min(100, signal.confidence)}%` }}
                        />
                      </div>
                    </div>

                    {/* Verdict */}
                    <div className={`rounded-lg p-4 text-center border ${signal.state === "SNIPER" ? "bg-gray-900/80 border-gray-700" : "bg-gray-900/50 border-gray-800"}`}>
                      <p className={`text-lg font-bold ${verdict.color}`}>
                        {verdict.text}
                      </p>
                    </div>

                    {/* Alert Status */}
                    {signal.state === "SNIPER" && (
                      <div className={`rounded-lg p-3 text-center ${signal.shouldAlert ? "bg-green-900/30 border border-green-700" : "bg-gray-900/50 border border-gray-700"}`}>
                        <p className={`text-sm font-bold ${signal.shouldAlert ? "text-green-400" : "text-gray-500"}`}>
                          {signal.shouldAlert ? "🚨 ALERT WILL FIRE" : "⏳ Alert suppressed (already sent)"}
                        </p>
                      </div>
                    )}

                    {/* Trade Setup - Only for SNIPER */}
                    {signal.state === "SNIPER" && signal.entry && (
                      <div className="border-t-2 border-gray-800 pt-5 mt-2">
                        <p className="text-xs text-gray-500 uppercase tracking-wider font-bold mb-4">Trade Setup</p>
                        <div className="space-y-3">
                          <div className="flex justify-between items-center">
                            <span className="text-gray-400 text-sm">Entry</span>
                            <span className="font-mono text-white font-bold text-lg">
                              ${signal.entry.toLocaleString(undefined, { minimumFractionDigits: 2, maximumFractionDigits: 2 })}
                            </span>
                          </div>
                          <div className="flex justify-between items-center">
                            <span className="text-gray-400 text-sm">Stop Loss</span>
                            <span className="font-mono text-red-400 font-bold">
                              ${signal.stopLoss?.toLocaleString(undefined, { minimumFractionDigits: 2, maximumFractionDigits: 2 })}
                            </span>
                          </div>
                          <div className="flex justify-between items-center">
                            <span className="text-gray-400 text-sm">Take Profit</span>
                            <span className="font-mono text-green-400 font-bold">
                              ${signal.takeProfit?.toLocaleString(undefined, { minimumFractionDigits: 2, maximumFractionDigits: 2 })}
                            </span>
                          </div>
                          <div className="flex justify-between items-center">
                            <span className="text-gray-400 text-sm">Risk:Reward</span>
                            <span className="font-mono text-white font-bold">{signal.riskReward?.toFixed(2)}:1</span>
                          </div>
                        </div>
                      </div>
                    )}
                  </div>

                  {/* Footer */}
                  <div className="px-6 py-4 border-t border-gray-800 bg-gray-900/30">
                    <p className="text-xs text-gray-600">
                      Updated: {new Date(signal.updatedAt).toLocaleTimeString("en-GB")}
                    </p>
                  </div>
                </div>
              );})}
            </div>
          </div>
        </div>
      </div>
    </div>
  );
}
