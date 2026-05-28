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

  const getStateBorder = (state?: string, direction?: string) => {
    if (state === "SNIPER" && direction === "LONG") return "border-l-4 border-l-green-500";
    if (state === "SNIPER" && direction === "SHORT") return "border-l-4 border-l-red-500";
    if (state === "BUILDING") return "border-l-4 border-l-amber-500";
    return "border-l-4 border-l-gray-700";
  };

  const getStateBadge = (state?: string, direction?: string) => {
    if (state === "SNIPER" && direction === "LONG") return "bg-green-500 text-black";
    if (state === "SNIPER" && direction === "SHORT") return "bg-red-500 text-white";
    if (state === "BUILDING") return "bg-amber-500 text-black";
    return "bg-gray-700 text-white";
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

  return (
    <div className="min-h-screen w-full bg-black text-gray-100">
      <div className="w-full px-6 py-8">
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
                className="px-5 py-2.5 bg-gray-800 hover:bg-gray-700 text-sm font-semibold rounded text-white disabled:opacity-50 transition"
              >
                {loading ? "Refreshing..." : "Refresh"}
              </button>
              <button
                onClick={testAlert}
                disabled={testLoading}
                className="px-5 py-2.5 bg-gray-800 hover:bg-gray-700 text-sm font-semibold rounded text-white disabled:opacity-50 transition"
              >
                {testLoading ? "Testing..." : "Test Alert"}
              </button>
            </div>
          </div>

          {testResult && (
            <div className="mb-6 p-4 bg-gray-900/50 border border-gray-700 rounded text-sm">
              {testResult}
            </div>
          )}

          {error && (
            <div className="mb-6 p-4 bg-red-950/40 border border-red-800/50 rounded text-red-300 text-sm">
              Error: {error}
            </div>
          )}

          <div>
            <h2 className="text-lg font-bold text-white mb-6">Market Overview</h2>

            {signals.length === 0 && !loading && (
              <div className="text-gray-500 text-sm">No signals available.</div>
            )}

            <div className="grid grid-cols-1 md:grid-cols-3 gap-6">
              {signals.map((signal) => {
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
                    className={`rounded-lg bg-[#111] ${getStateBorder(signal.state, signal.direction)}`}
                  >
                    {/* Card Header */}
                    <div className="px-5 py-4 flex items-center justify-between">
                      <div className="flex items-center gap-3">
                        <h3 className="text-2xl font-bold text-white">{signal.symbol}</h3>
                        {signal.dataQuality && signal.dataQuality !== "OHLC" && (
                          <span className="text-xs text-amber-500">[{signal.dataQuality}]</span>
                        )}
                      </div>
                      <span className={`px-3 py-1 rounded text-xs font-bold ${getStateBadge(signal.state, signal.direction)}`}>
                        {signal.state === "SNIPER" ? signal.direction : signal.state}
                      </span>
                    </div>

                    {/* Price */}
                    <div className="px-5 pb-4">
                      <p className="text-sm text-gray-400">Price: {fmtPrice(signal.price)}</p>
                      <p className={`text-sm font-medium ${(signal.change24h ?? 0) > 0 ? "text-green-400" : "text-red-400"}`}>
                        {fmtPct(signal.change24h)}% 24h
                      </p>
                    </div>

                    {/* Two Column Layout */}
                    <div className="px-5 pb-4 grid grid-cols-2 gap-x-6 gap-y-3">
                      <div>
                        <p className="text-xs text-gray-500 uppercase tracking-wider">4H Bias</p>
                        <p className={`text-sm font-semibold ${getBiasColor(signal.bias)}`}>{signal.bias || "—"}</p>
                      </div>
                      <div>
                        <p className="text-xs text-gray-500 uppercase tracking-wider">1H Bias</p>
                        <p className={`text-sm font-semibold ${getBiasColor(signal.bias)}`}>{signal.bias || "—"}</p>
                      </div>
                      <div>
                        <p className="text-xs text-gray-500 uppercase tracking-wider">Trigger</p>
                        <p className="text-sm font-semibold text-white">{signal.trigger || "—"}</p>
                      </div>
                      <div>
                        <p className="text-xs text-gray-500 uppercase tracking-wider">Momentum</p>
                        <p className={`text-sm font-semibold ${getMomentumColor(signal.momentum)}`}>{signal.momentum || "—"}</p>
                      </div>
                    </div>

                    {/* Divider */}
                    <div className="mx-5 border-t border-gray-800" />

                    {/* StochRSI Section */}
                    <div className="px-5 py-4">
                      <div className="flex justify-between items-center mb-3">
                        <p className="text-xs text-gray-500 uppercase tracking-wider">StochRSI</p>
                        <div className="flex items-center gap-2">
                          {signal.stochRSIDirection && (
                            <span className={`text-xs ${getStochDirectionColor(signal.stochRSIDirection)}`}>
                              {signal.stochRSIDirection === "rising" ? "↗" : signal.stochRSIDirection === "falling" ? "↘" : "→"}
                            </span>
                          )}
                          <span className={`text-lg font-bold ${getStochColor(stoch)}`}>{stoch.toFixed(0)}</span>
                        </div>
                      </div>

                      {hasPeak && (
                        <div className="mb-2 p-2 bg-red-950/30 border border-red-800/30 rounded">
                          <p className="text-xs text-red-400 font-semibold">
                            ↘ Peak {signal.stochRSIPeak?.peakValue} (‑{signal.stochRSIPeak?.dropFromPeak})
                          </p>
                        </div>
                      )}

                      {hasTrough && (
                        <div className="mb-2 p-2 bg-green-950/30 border border-green-800/30 rounded">
                          <p className="text-xs text-green-400 font-semibold">
                            ↗ Trough {signal.stochRSITrough?.troughValue} (+{signal.stochRSITrough?.riseFromTrough})
                          </p>
                        </div>
                      )}

                      <div className="w-full bg-gray-800 rounded-full h-2 overflow-hidden relative">
                        <div className="absolute left-0 h-2 bg-green-900/20" style={{ width: "20%" }} />
                        <div className="absolute right-0 h-2 bg-red-900/20" style={{ width: "20%" }} />
                        <div
                          className="absolute top-0 w-1.5 h-2 bg-white rounded-full"
                          style={{ left: `${Math.min(100, stoch)}%` }}
                        />
                      </div>
                      <div className="flex justify-between text-[10px] mt-1 text-gray-500">
                        <span>Oversold</span>
                        <span className={getStochColor(stoch)}>{signal.stochRSIState}</span>
                        <span>Overbought</span>
                      </div>
                    </div>

                    {/* Divider */}
                    <div className="mx-5 border-t border-gray-800" />

                    {/* 24h Range */}
                    <div className="px-5 py-4">
                      <div className="flex justify-between items-center mb-2">
                        <p className="text-xs text-gray-500 uppercase tracking-wider">24h Range</p>
                        <p className="text-xs text-gray-400">{fmtWhole(signal.low24h)} — {fmtWhole(signal.high24h)}</p>
                      </div>
                      <div className="w-full bg-gray-800 rounded-full h-2 overflow-hidden relative">
                        <div
                          className="absolute top-0 h-2 bg-gray-600 rounded-full"
                          style={{ width: `${Math.min(100, rangePos * 100)}%` }}
                        />
                        <div
                          className="absolute top-0 w-0.5 h-2 bg-white"
                          style={{ left: `${Math.min(100, rangePos * 100)}%` }}
                        />
                      </div>
                      <p className="text-xs text-gray-500 mt-1">{Math.round(rangePos * 100)}% from low</p>
                    </div>

                    {/* Divider */}
                    <div className="mx-5 border-t border-gray-800" />

                    {/* Readiness / Confidence */}
                    <div className="px-5 py-4">
                      <div className="flex justify-between items-center mb-2">
                        <p className="text-xs text-gray-500 uppercase tracking-wider">Confidence</p>
                        <p className={`text-sm font-bold ${confidence >= 80 ? "text-green-400" : confidence >= 60 ? "text-amber-400" : "text-gray-400"}`}>
                          {confidence}%
                        </p>
                      </div>
                      <div className="w-full bg-gray-800 rounded-full h-2 overflow-hidden">
                        <div
                          className={`h-2 rounded-full transition-all duration-500 ${getConfidenceColor(confidence)}`}
                          style={{ width: `${Math.min(100, confidence)}%` }}
                        />
                      </div>
                    </div>

                    {/* Trade Setup - Only when SNIPER */}
                    {signal.state === "SNIPER" && signal.entry != null && (
                      <>
                        <div className="mx-5 border-t border-gray-800" />
                        <div className="px-5 py-4">
                          <p className="text-xs text-gray-500 uppercase tracking-wider mb-3">Trade Setup</p>
                          <div className="space-y-2 text-sm">
                            <div className="flex justify-between">
                              <span className="text-gray-400">Direction</span>
                              <span className={`font-semibold ${signal.direction === "LONG" ? "text-green-400" : "text-red-400"}`}>
                                {signal.direction}
                              </span>
                            </div>
                            <div className="flex justify-between">
                              <span className="text-gray-400">Entry</span>
                              <span className="font-mono text-white font-semibold">{fmtPrice(signal.entry)}</span>
                            </div>
                            <div className="flex justify-between">
                              <span className="text-gray-400">SL</span>
                              <span className="font-mono text-red-400 font-semibold">{fmtPrice(signal.stopLoss)}</span>
                            </div>
                            <div className="flex justify-between">
                              <span className="text-gray-400">TP</span>
                              <span className="font-mono text-green-400 font-semibold">{fmtPrice(signal.takeProfit)}</span>
                            </div>
                            <div className="flex justify-between">
                              <span className="text-gray-400">R:R</span>
                              <span className="font-mono text-white font-semibold">{(signal.riskReward ?? 0).toFixed(2)}</span>
                            </div>
                          </div>
                          {isCounter && (
                            <p className="text-xs text-amber-400 mt-3">⚡ Counter Trend — Tighter stop</p>
                          )}
                        </div>
                      </>
                    )}

                    {/* Footer */}
                    <div className="px-5 py-3 border-t border-gray-800">
                      <p className="text-xs text-gray-600 text-right">
                        {signal.updatedAt ? new Date(signal.updatedAt).toLocaleString("en-GB") : "—"}
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
