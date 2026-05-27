"use client";

import { useState, useEffect } from "react";

interface Signal {
  symbol: string;
  price: number;
  state: "FLAT" | "BUILDING" | "SNIPER";
  confidence: number;
  layer1: {
    trend: string;
    sma20: number;
    smaDistance: number;
  };
  layer2: {
    state: string;
    sma12: number;
    smaDistance: number;
  };
  layer3: {
    trigger: string;
  };
  entry?: number;
  stopLoss?: number;
  takeProfit?: number;
  riskReward?: number;
  holdDuration?: string;
  timeStop?: number;
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

  return (
    <div className="min-h-screen w-full bg-black text-gray-100">
      <div className="w-full mx-auto px-16 py-12">
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
            {signals.map((signal) => (
              <div
                key={signal.symbol}
                className={`rounded-lg border border-gray-800 bg-gray-950 overflow-hidden transition-all hover:border-gray-700 ${
                  signal.state === "SNIPER" ? "border-red-500" : signal.state === "BUILDING" ? "border-cyan-500" : "border-gray-800"
                }`}
              >
                {/* Card Header */}
                <div className="px-6 py-4 border-b border-gray-800 flex items-center justify-between bg-gray-900/30">
                  <span className="text-2xl font-bold text-white">{signal.symbol}</span>
                  <span
                    className={`px-3 py-1.5 rounded text-xs font-bold text-white ${
                      signal.state === "SNIPER"
                        ? "bg-red-600"
                        : signal.state === "BUILDING"
                        ? "bg-cyan-600"
                        : "bg-gray-700"
                    }`}
                  >
                    {signal.state}
                  </span>
                </div>

                {/* Card Body */}
                <div className="px-6 py-5 space-y-4">
                  {/* Price */}
                  <div>
                    <p className="text-xs text-gray-500 uppercase tracking-widest font-semibold">Price</p>
                    <p className="text-lg font-mono text-white mt-1">${signal.price.toLocaleString(undefined, { minimumFractionDigits: 2, maximumFractionDigits: 2 })}</p>
                  </div>

                  {/* Layer 1 */}
                  <div className="border-t border-gray-800 pt-3">
                    <p className="text-xs text-gray-600 uppercase tracking-widest font-semibold mb-2">4H Trend</p>
                    <div className="flex justify-between text-sm">
                      <span className="text-gray-400">Bias:</span>
                      <span
                        className={`font-bold ${
                          signal.layer1.trend === "Bullish"
                            ? "text-green-400"
                            : signal.layer1.trend === "Bearish"
                            ? "text-red-400"
                            : "text-gray-400"
                        }`}
                      >
                        {signal.layer1.trend}
                      </span>
                    </div>
                    <div className="flex justify-between text-sm mt-1">
                      <span className="text-gray-400">SMA Distance:</span>
                      <span className="text-white font-mono">{signal.layer1.smaDistance.toFixed(2)}%</span>
                    </div>
                  </div>

                  {/* Layer 2 */}
                  <div className="border-t border-gray-800 pt-3">
                    <p className="text-xs text-gray-600 uppercase tracking-widest font-semibold mb-2">1H Signal</p>
                    <div className="flex justify-between text-sm">
                      <span className="text-gray-400">State:</span>
                      <span
                        className={`font-bold ${
                          signal.layer2.state === "SNIPER"
                            ? "text-red-400"
                            : signal.layer2.state === "BUILDING"
                            ? "text-cyan-400"
                            : "text-gray-400"
                        }`}
                      >
                        {signal.layer2.state}
                      </span>
                    </div>
                    <div className="flex justify-between text-sm mt-1">
                      <span className="text-gray-400">SMA Distance:</span>
                      <span className="text-white font-mono">{signal.layer2.smaDistance.toFixed(2)}%</span>
                    </div>
                  </div>

                  {/* Layer 3 */}
                  <div className="border-t border-gray-800 pt-3">
                    <p className="text-xs text-gray-600 uppercase tracking-widest font-semibold mb-2">15M Trigger</p>
                    <div className="flex justify-between text-sm">
                      <span className="text-gray-400">Status:</span>
                      <span className="text-white font-bold">{signal.layer3.trigger}</span>
                    </div>
                  </div>

                  {/* Confidence */}
                  <div className="border-t border-gray-800 pt-3">
                    <div className="flex items-center justify-between mb-2">
                      <p className="text-xs text-gray-600 uppercase tracking-widest font-semibold">Confidence</p>
                      <p className="text-xs font-bold text-white">{signal.confidence}%</p>
                    </div>
                    <div className="w-full bg-gray-800 rounded-full h-2 overflow-hidden">
                      <div
                        className={`h-2 rounded-full transition-all ${
                          signal.confidence >= 85
                            ? "bg-red-500"
                            : signal.confidence >= 60
                            ? "bg-cyan-500"
                            : "bg-gray-600"
                        }`}
                        style={{ width: `${Math.min(100, signal.confidence)}%` }}
                      />
                    </div>
                  </div>

                  {/* Trade Setup - Only for SNIPER */}
                  {signal.state === "SNIPER" && (
                    <div className="border-t border-gray-800 pt-4 mt-4">
                      <p className="text-xs text-gray-600 uppercase tracking-widest font-semibold mb-3">Trade Setup</p>
                      <div className="space-y-2 text-sm">
                        <div className="flex justify-between">
                          <span className="text-gray-500">Entry:</span>
                          <span className="font-mono text-white font-semibold">${signal.entry?.toLocaleString(undefined, { minimumFractionDigits: 2, maximumFractionDigits: 2 })}</span>
                        </div>
                        <div className="flex justify-between">
                          <span className="text-gray-500">SL:</span>
                          <span className="font-mono text-white">${signal.stopLoss?.toLocaleString(undefined, { minimumFractionDigits: 2, maximumFractionDigits: 2 })}</span>
                        </div>
                        <div className="flex justify-between">
                          <span className="text-gray-500">TP:</span>
                          <span className="font-mono text-white">${signal.takeProfit?.toLocaleString(undefined, { minimumFractionDigits: 2, maximumFractionDigits: 2 })}</span>
                        </div>
                        <div className="flex justify-between">
                          <span className="text-gray-500">R:R:</span>
                          <span className="font-mono text-white font-semibold">{signal.riskReward?.toFixed(1)}</span>
                        </div>
                        <div className="flex justify-between">
                          <span className="text-gray-500">Hold:</span>
                          <span className="text-white font-bold">{signal.holdDuration}</span>
                        </div>
                        <div className="flex justify-between">
                          <span className="text-gray-500">Time Stop:</span>
                          <span className="text-white">4h</span>
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
  );
}
