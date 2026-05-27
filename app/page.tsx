"use client";

import { useState, useEffect } from "react";

interface Signal {
  symbol: string;
  price: number;
  change24h: number;
  bias: "Bullish" | "Bearish" | "Neutral";
  state: "FLAT" | "BUILDING" | "SNIPER";
  direction?: "LONG" | "SHORT";
  confidence: number;
  trigger: string;
  entry?: number;
  stopLoss?: number;
  takeProfit?: number;
  riskReward?: number;
  updatedAt: string;
}

export default function Home() {
  const [signals, setSignals] = useState<Signal[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState("");
  const [lastUpdate, setLastUpdate] = useState("");

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

  useEffect(() => {
    fetchSignals();
    const interval = setInterval(fetchSignals, 60000);
    return () => clearInterval(interval);
  }, []);

  return (
    <div className="min-h-screen w-full bg-black text-gray-100">
      <div className="w-screen px-20 py-16">
        <div className="max-w-7xl mx-auto">
          <div className="flex items-start justify-between mb-12">
            <div>
              <h1 className="text-4xl font-bold text-white">Trading Signals</h1>
              <p className="text-sm text-gray-400 mt-2">Last updated: {lastUpdate}</p>
            </div>
            <button
              onClick={fetchSignals}
              disabled={loading}
              className="px-6 py-2.5 bg-gray-900 hover:bg-gray-800 text-sm font-medium rounded text-white disabled:opacity-50 transition-colors"
            >
              {loading ? "Refresh..." : "Refresh"}
            </button>
          </div>

          {error && (
            <div className="mb-8 p-4 bg-red-950/50 border border-red-800 rounded text-red-300 text-sm">
              Error: {error}
            </div>
          )}

          <div>
            <h2 className="text-xl font-semibold text-white mb-6">Market Overview</h2>
            <div className="grid grid-cols-3 gap-6">
              {signals.map((signal) => (
                <div
                  key={signal.symbol}
                  className={`rounded-lg border bg-gray-950 overflow-hidden transition-all hover:border-gray-700 ${
                    signal.state === "SNIPER" 
                      ? "border-red-500" 
                      : signal.state === "BUILDING" 
                      ? "border-cyan-500" 
                      : "border-gray-800"
                  }`}
                >
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

                  <div className="px-6 py-5 space-y-4">
                    <div>
                      <p className="text-xs text-gray-500 uppercase tracking-widest font-semibold">Price</p>
                      <p className="text-lg font-mono text-white mt-1">
                        ${signal.price.toLocaleString(undefined, { minimumFractionDigits: 2, maximumFractionDigits: 2 })}
                      </p>
                      <p className={`text-sm mt-1 ${signal.change24h > 0 ? "text-green-400" : signal.change24h < 0 ? "text-red-400" : "text-gray-400"}`}>
                        {signal.change24h > 0 ? "+" : ""}{signal.change24h.toFixed(2)}% (24h)
                      </p>
                    </div>

                    <div className="border-t border-gray-800 pt-3">
                      <p className="text-xs text-gray-600 uppercase tracking-widest font-semibold mb-2">4H Bias</p>
                      <div className="flex justify-between text-sm">
                        <span className="text-gray-400">Direction:</span>
                        <span className={`font-bold ${signal.bias === "Bullish" ? "text-green-400" : signal.bias === "Bearish" ? "text-red-400" : "text-gray-400"}`}>
                          {signal.bias}
                        </span>
                      </div>
                    </div>

                    <div className="border-t border-gray-800 pt-3">
                      <p className="text-xs text-gray-600 uppercase tracking-widest font-semibold mb-2">Trigger</p>
                      <div className="flex justify-between text-sm">
                        <span className="text-gray-400">Status:</span>
                        <span className="text-white font-bold">{signal.trigger}</span>
                      </div>
                    </div>

                    <div className="border-t border-gray-800 pt-3">
                      <p className="text-xs text-gray-600 uppercase tracking-widest font-semibold mb-2">Direction</p>
                      <div className="flex justify-between text-sm">
                        <span className="text-gray-400">Bias:</span>
                        <span className={`font-bold ${signal.direction === "LONG" ? "text-green-400" : signal.direction === "SHORT" ? "text-red-400" : "text-gray-400"}`}>
                          {signal.direction || "—"}
                        </span>
                      </div>
                    </div>

                    <div className="border-t border-gray-800 pt-3">
                      <div className="flex items-center justify-between mb-2">
                        <p className="text-xs text-gray-600 uppercase tracking-widest font-semibold">Confidence</p>
                        <p className="text-xs font-bold text-white">{signal.confidence}%</p>
                      </div>
                      <div className="w-full bg-gray-800 rounded-full h-2 overflow-hidden">
                        <div
                          className={`h-2 rounded-full transition-all ${
                            signal.confidence >= 85 ? "bg-red-500" : signal.confidence >= 60 ? "bg-cyan-500" : "bg-gray-600"
                          }`}
                          style={{ width: `${Math.min(100, signal.confidence)}%` }}
                        />
                      </div>
                    </div>

                    {signal.state === "SNIPER" && signal.entry && (
                      <div className="border-t border-gray-800 pt-4 mt-4">
                        <p className="text-xs text-gray-600 uppercase tracking-widest font-semibold mb-3">Trade Setup</p>
                        <div className="space-y-2 text-sm">
                          <div className="flex justify-between">
                            <span className="text-gray-500">Entry:</span>
                            <span className="font-mono text-white font-semibold">${signal.entry.toLocaleString(undefined, { minimumFractionDigits: 2, maximumFractionDigits: 2 })}</span>
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
                            <span className="font-mono text-white font-semibold">{signal.riskReward?.toFixed(2)}</span>
                          </div>
                        </div>
                      </div>
                    )}
                  </div>

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
