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
  const [telegramStatus, setTelegramStatus] = useState("");
  const [testLoading, setTestLoading] = useState(false);

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

  async function testTelegram() {
    setTestLoading(true);
    setTelegramStatus("Sending test...");
    try {
      const res = await fetch("/api/telegram?action=test", { cache: "no-store" });
      const data = await res.json();
      setTelegramStatus(data.success ? "✓ Test message sent" : `✗ ${data.error || data.message}`);
    } catch (err: any) {
      setTelegramStatus(`✗ ${err.message}`);
    } finally {
      setTestLoading(false);
      setTimeout(() => setTelegramStatus(""), 5000);
    }
  }

  useEffect(() => {
    fetchSignals();
    const interval = setInterval(fetchSignals, 5000);
    return () => clearInterval(interval);
  }, []);

  const getCardClasses = (state: string) => {
    const base = "rounded-lg border border-gray-800 overflow-hidden";
    if (state === "LONG") return `${base} border-l-4 border-l-green-500 bg-[#0f1f0f]`;
    if (state === "SHORT") return `${base} border-l-4 border-l-red-500 bg-[#1f0f0f]`;
    return `${base} border-l-4 border-l-gray-600 bg-[#1a1a1a]`;
  };

  const getStateBadge = (state: string) => {
    if (state === "LONG") return "bg-green-600 text-white px-3 py-1 rounded text-sm font-bold";
    if (state === "SHORT") return "bg-red-600 text-white px-3 py-1 rounded text-sm font-bold";
    return "bg-gray-700 text-gray-300 px-3 py-1 rounded text-sm";
  };

  const getBiasColor = (bias: string) => {
    if (bias.includes("Bullish")) return "text-green-400";
    if (bias.includes("Bearish")) return "text-red-400";
    return "text-gray-400";
  };

  const formatPrice = (price?: number) => {
    if (!price) return "--";
    return price >= 1000 
      ? `$${price.toLocaleString(undefined, { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`
      : `$${price.toFixed(2)}`;
  };

  return (
    <div className="min-h-screen bg-[#0a0a0a] text-gray-100">
      {/* Header Bar */}
      <div className="border-b border-gray-800 bg-[#111]">
        <div className="max-w-7xl mx-auto px-4 py-4 flex items-center justify-between">
          <div>
            <h1 className="text-xl font-bold text-white tracking-tight">CXSWITCH</h1>
            <p className="text-xs text-gray-500 mt-0.5">3-Layer Trendline Trading · 4H → 15M → 5M</p>
          </div>
          <div className="flex items-center gap-3">
            <span className="text-xs text-gray-600">
              {lastUpdate || "--:--:--"}
            </span>
            <button
              onClick={fetchSignals}
              disabled={loading}
              className="px-3 py-1.5 bg-gray-800 hover:bg-gray-700 text-xs rounded text-white disabled:opacity-50 transition-colors"
            >
              {loading ? "..." : "Refresh"}
            </button>
            <button
              onClick={testTelegram}
              disabled={testLoading}
              className="px-3 py-1.5 bg-blue-900 hover:bg-blue-800 text-xs rounded text-blue-200 disabled:opacity-50 transition-colors"
            >
              {testLoading ? "..." : "Test Telegram"}
            </button>
          </div>
        </div>
        {telegramStatus && (
          <div className="max-w-7xl mx-auto px-4 pb-2">
            <span className="text-xs text-blue-400">{telegramStatus}</span>
          </div>
        )}
      </div>

      {/* Error Banner */}
      {error && (
        <div className="max-w-7xl mx-auto px-4 mt-4">
          <div className="p-3 bg-red-950/50 border border-red-800 rounded text-red-300 text-sm">
            Error: {error}
          </div>
        </div>
      )}

      {/* Main Grid - 3 Columns */}
      <div className="max-w-7xl mx-auto px-4 py-6">
        {signals.length === 0 && !loading ? (
          <div className="text-center py-20 text-gray-600">
            <div className="text-4xl mb-4">📡</div>
            <p>No signals available</p>
          </div>
        ) : (
          <div className="grid grid-cols-3 gap-4">
            {signals.map((signal) => (
              <div key={signal.symbol} className={getCardClasses(signal.state)}>

                {/* Card Header: Symbol + Price + State */}
                <div className="p-4 border-b border-gray-800/50">
                  <div className="flex items-center justify-between mb-3">
                    <span className="text-3xl font-black text-white tracking-tighter">
                      {signal.symbol}
                    </span>
                    <span className={getStateBadge(signal.state)}>
                      {signal.state}
                    </span>
                  </div>
                  <div className="flex items-baseline justify-between">
                    <span className="text-2xl font-mono text-white">
                      {formatPrice(signal.price)}
                    </span>
                    <span className="text-xs text-gray-500">Live Price</span>
                  </div>
                </div>

                {/* 4H Bias Section */}
                <div className="px-4 py-3 border-b border-gray-800/50">
                  <div className="flex items-center justify-between mb-2">
                    <span className="text-xs uppercase tracking-wider text-gray-500 font-semibold">
                      4H Bias
                    </span>
                    <span className={`text-sm font-bold ${getBiasColor(signal.bias4h)}`}>
                      {signal.bias4h}
                    </span>
                  </div>
                  <div className="w-full bg-gray-800 rounded-full h-1.5 mb-1">
                    <div
                      className={`h-1.5 rounded-full transition-all duration-500 ${
                        signal.confidence >= 60
                          ? signal.state === "LONG"
                            ? "bg-green-500"
                            : signal.state === "SHORT"
                            ? "bg-red-500"
                            : "bg-yellow-500"
                          : "bg-gray-600"
                      }`}
                      style={{ width: `${Math.min(100, signal.confidence)}%` }}
                    />
                  </div>
                  <div className="flex justify-between">
                    <span className="text-[10px] text-gray-600">Confidence</span>
                    <span className="text-[10px] text-gray-400">{signal.confidence}%</span>
                  </div>
                </div>

                {/* Layer Stack */}
                <div className="px-4 py-3 space-y-2">
                  {[
                    { num: "1", name: "4H Break", layer: signal.layer1 },
                    { num: "2", name: "15M Retest", layer: signal.layer2 },
                    { num: "3", name: "5M Entry", layer: signal.layer3 },
                  ].map(({ num, name, layer }) => (
                    <div key={num} className="flex items-center gap-3">
                      <div
                        className={`w-6 h-6 rounded-full flex items-center justify-center text-xs font-bold shrink-0 ${
                          layer?.met
                            ? "bg-green-600 text-white"
                            : "bg-gray-800 text-gray-500"
                        }`}
                      >
                        {num}
                      </div>
                      <div className="flex-1 min-w-0">
                        <div className="flex items-center justify-between">
                          <span className="text-sm text-gray-300">{name}</span>
                          <span
                            className={`text-xs ${
                              layer?.met ? "text-green-400" : "text-gray-500"
                            }`}
                          >
                            {layer?.status || "Waiting"}
                          </span>
                        </div>
                        {layer?.detail && (
                          <p className="text-xs text-gray-600 truncate">{layer.detail}</p>
                        )}
                      </div>
                    </div>
                  ))}
                </div>

                {/* Trade Levels - Only when active */}
                {(signal.state === "LONG" || signal.state === "SHORT") && (
                  <div className="px-4 py-3 border-t border-gray-800/50 bg-black/20">
                    <div className="grid grid-cols-2 gap-x-4 gap-y-2 text-sm">
                      <div>
                        <span className="text-[10px] text-gray-500 uppercase block">Entry</span>
                        <span className="text-white font-mono">{formatPrice(signal.entry)}</span>
                      </div>
                      <div>
                        <span className="text-[10px] text-gray-500 uppercase block">Stop Loss</span>
                        <span className="text-red-400 font-mono">{formatPrice(signal.stopLoss)}</span>
                      </div>
                      <div>
                        <span className="text-[10px] text-gray-500 uppercase block">Take Profit</span>
                        <span className="text-green-400 font-mono">{formatPrice(signal.takeProfit)}</span>
                      </div>
                      <div>
                        <span className="text-[10px] text-gray-500 uppercase block">R:R</span>
                        <span className="text-yellow-400 font-mono">{signal.riskReward?.toFixed(2) || "--"}</span>
                      </div>
                    </div>
                  </div>
                )}

                {/* Footer */}
                <div className="px-4 py-2 border-t border-gray-800/50 bg-black/30">
                  <div className="flex items-center justify-between text-[10px]">
                    <span className="text-gray-600">
                      {signal.updatedAt ? new Date(signal.updatedAt).toLocaleTimeString() : "--"}
                    </span>
                    <span
                      className={
                        signal.state === "FLAT"
                          ? "text-gray-600"
                          : signal.confidence >= 60
                          ? signal.state === "LONG"
                            ? "text-green-400"
                            : "text-red-400"
                          : "text-yellow-500"
                      }
                    >
                      {signal.state === "FLAT"
                        ? "Scanning Market"
                        : signal.confidence >= 60
                        ? "🔥 Ready to Execute"
                        : "Building Setup"}
                    </span>
                  </div>
                </div>
              </div>
            ))}
          </div>
        )}
      </div>

      {/* Status Bar */}
      <div className="border-t border-gray-800 bg-[#111] mt-auto">
        <div className="max-w-7xl mx-auto px-4 py-2 flex items-center justify-between text-[10px] text-gray-600">
          <div className="flex gap-4">
            <span>● Green = LONG Active</span>
            <span>● Red = SHORT Active</span>
            <span>● Grey = FLAT / Scanning</span>
          </div>
          <span>Polls every 5s · Cron every 5m</span>
        </div>
      </div>
    </div>
  );
}
