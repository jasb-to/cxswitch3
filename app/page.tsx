"use client";

import { useState, useEffect } from "react";

interface LayerStatus {
  status: string;
  detail: string;
  met: boolean;
}

interface Signal {
  symbol: string;
  price: number;
  state: "FLAT" | "LONG" | "SHORT";
  entry?: number;
  stopLoss?: number;
  takeProfit?: number;
  riskReward?: number;
  confidence: number;
  layer1: LayerStatus;
  layer2: LayerStatus;
  layer3: LayerStatus;
  bias4h: string;
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
      setLastUpdate(new Date().toLocaleTimeString());
      setError("");
    } catch (err: any) {
      setError(err.message || "Failed to fetch");
    } finally {
      setLoading(false);
    }
  }

  useEffect(() => {
    fetchSignals();
    const interval = setInterval(fetchSignals, 15000);
    return () => clearInterval(interval);
  }, []);

  const getCardBorder = (state: string) => {
    if (state === "LONG") return "border-l-4 border-l-green-500";
    if (state === "SHORT") return "border-l-4 border-l-red-500";
    return "border-l-4 border-l-gray-600";
  };

  const getStateBg = (state: string) => {
    if (state === "LONG") return "bg-green-950/30";
    if (state === "SHORT") return "bg-red-950/30";
    return "bg-gray-900";
  };

  const getStateText = (state: string) => {
    if (state === "LONG") return "text-green-400 font-bold";
    if (state === "SHORT") return "text-red-400 font-bold";
    return "text-gray-400";
  };

  const getBiasText = (bias: string) => {
    if (bias.includes("Bullish")) return "text-green-400";
    if (bias.includes("Bearish")) return "text-red-400";
    return "text-gray-400";
  };

  return (
    <div className="min-h-screen bg-[#0a0a0a] text-gray-100 p-4">
      {/* Header */}
      <div className="max-w-7xl mx-auto mb-6">
        <div className="flex items-center justify-between">
          <div>
            <h1 className="text-2xl font-bold text-white">3-Layer Trendline Trading</h1>
            <p className="text-sm text-gray-500 mt-1">4H Breaks → 15M Retests → 5M Entry</p>
          </div>
          <div className="flex items-center gap-4">
            <span className="text-xs text-gray-500">
              {lastUpdate ? `Updated: ${lastUpdate}` : ""}
            </span>
            <button
              onClick={fetchSignals}
              disabled={loading}
              className="px-4 py-2 bg-gray-800 hover:bg-gray-700 text-sm rounded text-white disabled:opacity-50"
            >
              {loading ? "Loading..." : "Refresh"}
            </button>
          </div>
        </div>
      </div>

      {/* Error */}
      {error && (
        <div className="max-w-7xl mx-auto mb-4 p-3 bg-red-950/50 border border-red-800 rounded text-red-300 text-sm">
          Error: {error}
        </div>
      )}

      {/* 3 Column Grid */}
      <div className="max-w-7xl mx-auto grid grid-cols-1 md:grid-cols-3 gap-4">
        {signals.length === 0 && !loading ? (
          <div className="col-span-3 text-center py-20 text-gray-500">
            No signals available
          </div>
        ) : (
          signals.map((signal) => (
            <div
              key={signal.symbol}
              className={`rounded-lg overflow-hidden ${getCardBorder(signal.state)} ${getStateBg(signal.state)} border border-gray-800`}
            >
              {/* Card Header */}
              <div className="p-4 border-b border-gray-800">
                <div className="flex items-center justify-between">
                  <div className="flex items-center gap-3">
                    <span className="text-2xl font-bold text-white">{signal.symbol}</span>
                    <span className={`text-lg ${getStateText(signal.state)}`}>
                      {signal.state}
                    </span>
                  </div>
                  <div className="text-right">
                    <div className="text-xl font-mono text-white">
                      ${signal.price?.toLocaleString(undefined, { minimumFractionDigits: 2, maximumFractionDigits: 2 }) || "--"}
                    </div>
                    <div className="text-xs text-gray-500">Current Price</div>
                  </div>
                </div>
              </div>

              {/* Market Bias */}
              <div className="p-4 border-b border-gray-800">
                <div className="flex items-center justify-between mb-2">
                  <span className="text-xs uppercase tracking-wider text-gray-500">4H Bias</span>
                  <span className={`text-sm font-semibold ${getBiasText(signal.bias4h)}`}>
                    {signal.bias4h || "Neutral"}
                  </span>
                </div>
                <div className="w-full bg-gray-800 rounded-full h-2">
                  <div
                    className={`h-2 rounded-full transition-all ${
                      signal.confidence >= 60
                        ? signal.state === "LONG"
                          ? "bg-green-500"
                          : "bg-red-500"
                        : "bg-gray-600"
                    }`}
                    style={{ width: `${signal.confidence}%` }}
                  />
                </div>
                <div className="flex justify-between mt-1">
                  <span className="text-xs text-gray-500">Confidence</span>
                  <span className="text-xs text-gray-400">{signal.confidence}%</span>
                </div>
              </div>

              {/* Layer Breakdown */}
              <div className="p-4 space-y-3">
                {[
                  { label: "Layer 1", layer: signal.layer1, desc: "4H Trendline Break" },
                  { label: "Layer 2", layer: signal.layer2, desc: "15M Retest" },
                  { label: "Layer 3", layer: signal.layer3, desc: "5M Entry Trigger" },
                ].map(({ label, layer, desc }) => (
                  <div key={label} className="flex items-start gap-3">
                    <div
                      className={`w-2 h-2 rounded-full mt-1.5 shrink-0 ${
                        layer?.met ? "bg-green-500" : "bg-gray-600"
                      }`}
                    />
                    <div className="flex-1">
                      <div className="flex items-center justify-between">
                        <span className="text-sm text-gray-300">{label}</span>
                        <span
                          className={`text-xs ${
                            layer?.met ? "text-green-400" : "text-gray-500"
                          }`}
                        >
                          {layer?.status || "Waiting"}
                        </span>
                      </div>
                      <p className="text-xs text-gray-500">{desc}</p>
                      {layer?.detail && (
                        <p className="text-xs text-gray-400 mt-0.5">{layer.detail}</p>
                      )}
                    </div>
                  </div>
                ))}
              </div>

              {/* Trade Levels - Only show when active */}
              {(signal.state === "LONG" || signal.state === "SHORT") && (
                <div className="p-4 border-t border-gray-800 bg-black/20">
                  <div className="grid grid-cols-2 gap-3 text-sm">
                    <div>
                      <span className="text-xs text-gray-500 block">Entry</span>
                      <span className="text-white font-mono">
                        ${signal.entry?.toLocaleString(undefined, { minimumFractionDigits: 2 }) || "--"}
                      </span>
                    </div>
                    <div>
                      <span className="text-xs text-gray-500 block">Stop Loss</span>
                      <span className="text-red-400 font-mono">
                        ${signal.stopLoss?.toLocaleString(undefined, { minimumFractionDigits: 2 }) || "--"}
                      </span>
                    </div>
                    <div>
                      <span className="text-xs text-gray-500 block">Take Profit</span>
                      <span className="text-green-400 font-mono">
                        ${signal.takeProfit?.toLocaleString(undefined, { minimumFractionDigits: 2 }) || "--"}
                      </span>
                    </div>
                    <div>
                      <span className="text-xs text-gray-500 block">R:R</span>
                      <span className="text-yellow-400 font-mono">
                        {signal.riskReward?.toFixed(2) || "--"}
                      </span>
                    </div>
                  </div>
                </div>
              )}

              {/* Footer */}
              <div className="p-3 border-t border-gray-800 bg-black/30">
                <div className="flex items-center justify-between text-xs text-gray-600">
                  <span>{signal.updatedAt ? new Date(signal.updatedAt).toLocaleTimeString() : "--"}</span>
                  <span>
                    {signal.state === "FLAT"
                      ? "Scanning..."
                      : signal.confidence >= 60
                      ? "Ready to Execute"
                      : "Building Confidence"}
                  </span>
                </div>
              </div>
            </div>
          ))
        )}
      </div>

      {/* Legend */}
      <div className="max-w-7xl mx-auto mt-6 p-4 bg-gray-900/50 rounded-lg border border-gray-800">
        <div className="flex flex-wrap gap-6 text-xs text-gray-500">
          <div className="flex items-center gap-2">
            <div className="w-3 h-3 bg-green-500 rounded" />
            <span>LONG Signal Active</span>
          </div>
          <div className="flex items-center gap-2">
            <div className="w-3 h-3 bg-red-500 rounded" />
            <span>SHORT Signal Active</span>
          </div>
          <div className="flex items-center gap-2">
            <div className="w-3 h-3 bg-gray-600 rounded" />
            <span>FLAT / Scanning</span>
          </div>
          <div className="flex items-center gap-2">
            <div className="w-3 h-3 bg-green-500 rounded-full" />
            <span>Layer Condition Met</span>
          </div>
          <div className="flex items-center gap-2">
            <div className="w-3 h-3 bg-gray-600 rounded-full" />
            <span>Layer Condition Waiting</span>
          </div>
        </div>
      </div>
    </div>
  );
}
