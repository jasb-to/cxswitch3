"use client";

import { useState, useEffect } from "react";

interface Signal {
  symbol: string;
  price?: number;
  change24h?: number;
  high24h?: number;
  low24h?: number;
  bias?: "Bullish" | "Bearish" | "Neutral";
  state?: "FLAT" | "BUILDING" | "SNIPER";
  direction?: "LONG" | "SHORT";
  entry?: number;
  stopLoss?: number;
  takeProfit?: number;
  riskReward?: number;
  confidence?: number;
  trigger?: string;
  momentum?: string;
  trendScore?: number;
  rangePosition?: number;
  volatilityState?: string;
  moveTiming?: string;
  stochRSI?: number;
  stochRSIState?: string;
  stochRSIPeak?: { peakValue: number; dropFromPeak: number } | null;
  stochRSITrough?: { troughValue: number; riseFromTrough: number } | null;
  stochRSIDirection?: "rising" | "falling" | "neutral";
  tradeType?: string;
  dataQuality?: string;
  shouldAlert?: boolean;
  updatedAt?: string;
}

function fmtPrice(n?: number) {
  if (n == null || Number.isNaN(n)) return "—";
  return "$" + n.toLocaleString(undefined, { minimumFractionDigits: 2, maximumFractionDigits: 2 });
}

function fmtWhole(n?: number) {
  if (n == null || Number.isNaN(n)) return "—";
  return n.toLocaleString(undefined, { maximumFractionDigits: 0 });
}

function fmtPct(n?: number) {
  if (n == null || Number.isNaN(n)) return "0.00";
  return (n > 0 ? "+" : "") + n.toFixed(2);
}

export default function Home() {
  const [signals, setSignals] = useState<<Signal[]>([]);
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

  const getStateColor = (state?: string, direction?: string) => {
    if (state === "SNIPER" && direction === "LONG") return "border-green-500";
    if (state === "SNIPER" && direction === "SHORT") return "border-red-500";
    if (state === "BUILDING") return "border-amber-500";
    return "border-gray-700";
  };

  const getStateBadge = (state?: string, direction?: string) => {
    if (state === "SNIPER" && direction === "LONG") return "bg-green-500 text-black font-bold";
    if (state === "SNIPER" && direction === "SHORT") return "bg-red-500 text-white font-bold";
    if (state === "BUILDING") return "bg-amber-500 text-black font-bold";
    return "bg-gray-700 text-white font-bold";
  };

  const getBiasColor = (bias?: string) => {
    if (bias === "Bullish") return "text-green-400";
    if (bias === "Bearish") return "text-red-400";
    return "text-gray-400";
  };

  const getConfidenceColor = (conf?: number) => {
    if (conf == null) return "bg-gray-600";
    if (conf >= 80) return "bg-green-500";
    if (conf >= 60) return "bg-amber-500";
    if (conf >= 40) return "bg-yellow-500";
    return "bg-gray-600";
  };

  const getMomentumColor = (mom?: string) => {
    if (mom === "Accelerating") return "text-green-400";
    if (mom === "Decelerating") return "text-red-400";
    return "text-gray-400";
  };

  const getRangeBarColor = (pos?: number) => {
    if (pos == null) return "bg-gray-500";
    if (pos < 0.2) return "bg-green-500";
    if (pos > 0.8) return "bg-red-500";
    return "bg-gray-500";
  };

  const getStochColor = (stoch?: number) => {
    if (stoch == null) return "text-gray-400";
    if (stoch < 20) return "text-green-400";
    if (stoch > 80) return "text-red-400";
    return "text-amber-400";
  };

  const getStochDirectionColor = (dir?: string) => {
    if (dir === "rising") return "text-green-400";
    if (dir === "falling") return "text-red-400";
    return "text-gray-400";
  };

  const getVerdict = (signal: Signal) => {
    if (signal.state === "SNIPER" && signal.shouldAlert) {
      if (signal.moveTiming === "Early") return { text: "✅ EARLY ENTRY", color: "text-green-400" };
      if (signal.moveTiming === "Mid") return { text: "⚠️ MID MOVE", color: "text-amber-400" };
      return { text: "❌ LATE MOVE", color: "text-red-400" };
    }
    if (signal.state === "BUILDING") {
      if ((signal.trendScore ?? 0) > 60) return { text: "👁️ WATCHING", color: "text-cyan-400" };
      return { text: "⏸️ NO SETUP", color: "text-gray-500" };
    }
    return { text: "⏸️ FLAT", color: "text-gray-500" };
  };

  return (
    <div className="min-h-screen w-full bg-black text-gray-100">
      <div className="w-full px-4 py-6">
        <div className="max-w-7xl mx-auto">

          {/* Header */}
          <div className="flex items-start justify-between mb-6">
            <div>
              <h1 className="text-3xl font-bold text-white tracking-tight">Trading Signals</h1>
              <p className="text-xs text-gray-500 mt-1">
                Last updated: {lastUpdate}
                <span className="ml-2 text-cyan-400">({countdown}s)</span>
              </p>
            </div>
            <div className="flex items-center gap-2">
              <button
                onClick={fetchSignals}
                disabled={loading}
                className="px-4 py-2 bg-gray-900 hover:bg-gray-800 text-xs font-semibold rounded text-white disabled:opacity-50 transition border border-gray-700"
              >
                {loading ? "Refreshing..." : "Refresh"}
              </button>
              <button
                onClick={testAlert}
                disabled={testLoading}
                className="px-4 py-2 bg-gray-900 hover:bg-gray-800 text-xs font-semibold rounded text-white disabled:opacity-50 transition border border-gray-700"
              >
                {testLoading ? "Testing..." : "Test Alert"}
              </button>
            </div>
          </div>

          {testResult && (
            <div className="mb-4 p-3 bg-gray-900/50 border border-gray-700 rounded text-xs">
              {testResult}
            </div>
          )}

          {error && (
            <div className="mb-4 p-3 bg-red-950/40 border border-red-800/50 rounded text-red-300 text-xs">
              Error: {error}
            </div>
          )}

          <div>
            <h2 className="text-sm font-bold text-gray-400 mb-4 uppercase tracking-wider">Market Overview</h2>

            {signals.length === 0 && !loading && (
              <div className="text-gray-500 text-xs">No signals available.</div>
            )}

            <div className="grid grid-cols-1 md:grid-cols-3 gap-4">
              {signals.map((signal) => {
                const verdict = getVerdict(signal);
                const rangePos = signal.rangePosition ?? 0.5;
                const trendScore = signal.trendScore ?? 0;
                const confidence = signal.confidence ?? 0;
                const stoch = signal.stochRSI ?? 50;
                const isCounter = signal.tradeType === "Counter Trend";
                const hasPeak = signal.stochRSIPeak != null;
                const hasTrough = signal.stochRSITrough != null;
                return (
                  <div
                    key={signal.symbol || Math.random()}
                    className={`rounded-lg overflow-hidden bg-gray-950 border-2 ${getStateColor(signal.state, signal.direction)} transition-all hover:opacity-95`}
                  >
                    {/* Card Header */}
                    <div className="px-4 py-3 border-b border-gray-800 flex items-center justify-between bg-gray-900/50">
                      <div>
                        <h3 className="text-2xl font-bold text-white">{signal.symbol || "???"}</h3>
                        <p className="text-[10px] text-gray-500 mt-0.5">
                          {signal.state === "SNIPER" ? "🎯 SNIPER" : signal.state === "BUILDING" ? "📊 Building" : "⏸️ Flat"}
                          {signal.dataQuality && signal.dataQuality !== "OHLC" && (
                            <span className="ml-1 text-amber-500">[{signal.dataQuality}]</span>
                          )}
                        </p>
                      </div>
                      <div className="text-right">
                        <span className={`px-3 py-1 rounded text-xs ${getStateBadge(signal.state, signal.direction)}`}>
                          {signal.state === "SNIPER" ? signal.direction : (signal.state || "—")}
                        </span>
                        {isCounter && (
                          <p className="text-[10px] text-amber-400 mt-1 font-bold">⚡ COUNTER</p>
                        )}
                      </div>
                    </div>

                    {/* Card Body */}
                    <div className="px-4 py-4 space-y-3">

                      {/* Price Row */}
                      <div className="flex items-baseline justify-between">
                        <div>
                          <p className="text-[10px] text-gray-500 uppercase tracking-wider font-bold">Price</p>
                          <p className="text-2xl font-mono text-white font-bold">
                            {fmtPrice(signal.price)}
                          </p>
                        </div>
                        <div className="text-right">
                          <p className={`text-base font-bold ${(signal.change24h ?? 0) > 0 ? "text-green-400" : (signal.change24h ?? 0) < 0 ? "text-red-400" : "text-gray-400"}`}>
                            {fmtPct(signal.change24h)}%
                          </p>
                        </div>
                      </div>

                      {/* Trade Type Banner */}
                      {signal.tradeType && signal.tradeType !== "—" && (
                        <div className={`rounded p-2 text-center border ${isCounter ? "bg-amber-950/30 border-amber-700" : "bg-green-950/30 border-green-700"}`}>
                          <p className={`text-xs font-bold ${isCounter ? "text-amber-400" : "text-green-400"}`}>
                            {isCounter ? "⚡ " : "✅ "}{signal.tradeType}
                          </p>
                        </div>
                      )}

                      {/* 24h Range */}
                      <div className="bg-gray-900/50 rounded p-3">
                        <div className="flex justify-between items-center mb-1">
                          <p className="text-[10px] text-gray-500 uppercase tracking-wider font-bold">24h Range</p>
                          <p className="text-[10px] text-gray-400">
                            {fmtWhole(signal.low24h)} — {fmtWhole(signal.high24h)}
                          </p>
                        </div>
                        <div className="w-full bg-gray-800 rounded-full h-2 overflow-hidden relative">
                          <div
                            className={`h-2 rounded-full ${getRangeBarColor(rangePos)}`}
                            style={{ width: `${Math.min(100, rangePos * 100)}%` }}
                          />
                          <div
                            className="absolute top-0 w-0.5 h-2 bg-white rounded-full"
                            style={{ left: `${Math.min(100, rangePos * 100)}%` }}
                          />
                        </div>
                        <div className="flex justify-between text-[10px] mt-1">
                          <span className="text-green-400">Bottom</span>
                          <span className="text-gray-400">{Math.round(rangePos * 100)}%</span>
                          <span className="text-red-400">Top</span>
                        </div>
                      </div>

                      {/* StochRSI Compact */}
                      <div className="bg-gray-900/50 rounded p-3">
                        <div className="flex justify-between items-center mb-1">
                          <p className="text-[10px] text-gray-500 uppercase tracking-wider font-bold">StochRSI</p>
                          <div className="flex items-center gap-2">
                            {signal.stochRSIDirection && (
                              <span className={`text-[10px] font-bold ${getStochDirectionColor(signal.stochRSIDirection)}`}>
                                {signal.stochRSIDirection === "rising" ? "↗" : signal.stochRSIDirection === "falling" ? "↘" : "→"} {signal.stochRSIDirection}
                              </span>
                            )}
                            <p className={`text-lg font-bold ${getStochColor(stoch)}`}>
                              {stoch.toFixed(0)}
                            </p>
                          </div>
                        </div>

                        {hasPeak && (
                          <div className="mb-1.5 p-1.5 bg-red-950/40 border border-red-800/50 rounded">
                            <p className="text-[10px] text-red-400 font-bold">
                              ↘ PEAK {signal.stochRSIPeak?.peakValue} (‑{signal.stochRSIPeak?.dropFromPeak})
                            </p>
                          </div>
                        )}

                        {hasTrough && (
                          <div className="mb-1.5 p-1.5 bg-green-950/40 border border-green-800/50 rounded">
                            <p className="text-[10px] text-green-400 font-bold">
                              ↗ TROUGH {signal.stochRSITrough?.troughValue} (+{signal.stochRSITrough?.riseFromTrough})
                            </p>
                          </div>
                        )}

                        <div className="w-full bg-gray-800 rounded-full h-2 overflow-hidden relative">
                          <div className="absolute left-0 h-2 bg-green-900/30" style={{ width: "20%" }} />
                          <div className="absolute right-0 h-2 bg-red-900/30" style={{ width: "20%" }} />
                          <div
                            className="absolute top-0 w-1.5 h-2 bg-white rounded-full"
                            style={{ left: `${Math.min(100, stoch)}%` }}
                          />
                        </div>
                        <div className="flex justify-between text-[10px] mt-1">
                          <span className="text-green-400">Oversold</span>
                          <span className={`font-bold ${getStochColor(stoch)}`}>{signal.stochRSIState || "—"}</span>
                          <span className="text-red-400">Overbought</span>
                        </div>
                      </div>

                      {/* Compact Info Grid */}
                      <div className="grid grid-cols-4 gap-2 text-xs">
                        <div className="bg-gray-900/50 rounded p-2">
                          <p className="text-[10px] text-gray-500 uppercase font-bold">Bias</p>
                          <p className={`font-bold ${getBiasColor(signal.bias)}`}>{signal.bias || "—"}</p>
                        </div>
                        <div className="bg-gray-900/50 rounded p-2">
                          <p className="text-[10px] text-gray-500 uppercase font-bold">Trigger</p>
                          <p className="font-bold text-white">{signal.trigger || "—"}</p>
                        </div>
                        <div className="bg-gray-900/50 rounded p-2">
                          <p className="text-[10px] text-gray-500 uppercase font-bold">Mom</p>
                          <p className={`font-bold ${getMomentumColor(signal.momentum)}`}>{signal.momentum || "—"}</p>
                        </div>
                        <div className="bg-gray-900/50 rounded p-2">
                          <p className="text-[10px] text-gray-500 uppercase font-bold">Dir</p>
                          <p className={`font-bold ${signal.direction === "LONG" ? "text-green-400" : signal.direction === "SHORT" ? "text-red-400" : "text-gray-400"}`}>
                            {signal.direction || "—"}
                          </p>
                        </div>
                      </div>

                      {/* Trend Health Compact */}
                      <div className="bg-gray-900/50 rounded p-3">
                        <div className="flex justify-between items-center mb-2">
                          <span className="text-[10px] text-gray-500 uppercase font-bold">Trend Score</span>
                          <span className="text-xs font-bold text-white">{trendScore}/100</span>
                        </div>
                        <div className="w-full bg-gray-800 rounded-full h-1.5 overflow-hidden mb-2">
                          <div
                            className={`h-1.5 rounded-full ${trendScore > 70 ? "bg-green-500" : trendScore > 40 ? "bg-amber-500" : "bg-gray-600"}`}
                            style={{ width: `${Math.min(100, trendScore)}%` }}
                          />
                        </div>
                        <div className="flex justify-between text-xs">
                          <div>
                            <span className="text-gray-500 text-[10px]">Timing</span>
                            <p className={`font-bold ${signal.moveTiming === "Early" ? "text-green-400" : signal.moveTiming === "Mid" ? "text-amber-400" : "text-red-400"}`}>
                              {signal.moveTiming || "—"}
                            </p>
                          </div>
                          <div className="text-right">
                            <span className="text-gray-500 text-[10px]">Vol</span>
                            <p className="text-white font-bold">{signal.volatilityState || "—"}</p>
                          </div>
                        </div>
                      </div>

                      {/* Confidence */}
                      <div className="bg-gray-900/50 rounded p-3">
                        <div className="flex justify-between items-center mb-1">
                          <p className="text-[10px] text-gray-500 uppercase font-bold">Confidence</p>
                          <p className="text-lg font-bold text-white">{confidence}%</p>
                        </div>
                        <div className="w-full bg-gray-800 rounded-full h-2 overflow-hidden">
                          <div
                            className={`h-2 rounded-full transition-all duration-500 ${getConfidenceColor(confidence)}`}
                            style={{ width: `${Math.min(100, confidence)}%` }}
                          />
                        </div>
                      </div>

                      {/* Verdict */}
                      <div className={`rounded p-3 text-center border ${signal.state === "SNIPER" ? "bg-gray-900/80 border-gray-700" : "bg-gray-900/50 border-gray-800"}`}>
                        <p className={`text-sm font-bold ${verdict.color}`}>
                          {verdict.text}
                        </p>
                      </div>

                      {/* Alert Status */}
                      {signal.state === "SNIPER" && (
                        <div className={`rounded p-2 text-center ${signal.shouldAlert ? "bg-green-900/30 border border-green-700" : "bg-gray-900/50 border border-gray-700"}`}>
                          <p className={`text-xs font-bold ${signal.shouldAlert ? "text-green-400" : "text-gray-500"}`}>
                            {signal.shouldAlert ? "🚨 ALERT WILL FIRE" : "⏳ Suppressed"}
                          </p>
                        </div>
                      )}

                      {/* Trade Setup */}
                      {signal.state === "SNIPER" && signal.entry != null && (
                        <div className="border-t border-gray-800 pt-3 mt-1">
                          <p className="text-[10px] text-gray-500 uppercase font-bold mb-2">Trade Setup</p>
                          <div className="space-y-1.5 text-sm">
                            <div className="flex justify-between">
                              <span className="text-gray-400 text-xs">Entry</span>
                              <span className="font-mono text-white font-bold">{fmtPrice(signal.entry)}</span>
                            </div>
                            <div className="flex justify-between">
                              <span className="text-gray-400 text-xs">SL</span>
                              <span className="font-mono text-red-400 font-bold">{fmtPrice(signal.stopLoss)}</span>
                            </div>
                            <div className="flex justify-between">
                              <span className="text-gray-400 text-xs">TP</span>
                              <span className="font-mono text-green-400 font-bold">{fmtPrice(signal.takeProfit)}</span>
                            </div>
                            <div className="flex justify-between">
                              <span className="text-gray-400 text-xs">R:R</span>
                              <span className="font-mono text-white font-bold">{(signal.riskReward ?? 0).toFixed(2)}:1</span>
                            </div>
                          </div>
                        </div>
                      )}
                    </div>

                    {/* Footer */}
                    <div className="px-4 py-2 border-t border-gray-800 bg-gray-900/30">
                      <p className="text-[10px] text-gray-600">
                        {signal.updatedAt ? new Date(signal.updatedAt).toLocaleTimeString("en-GB") : "—"}
                      </p>
                    </div>
                  </div>
                );
              })}
            </div>
          </div>
        </div>
      </div>
    </div>
  );
}
