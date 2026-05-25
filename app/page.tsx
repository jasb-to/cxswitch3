"use client";

import { useState, useEffect } from "react";
import type { Signal } from "@/lib/signal-store";

interface ApiResponse {
  symbols: Signal[];
  activeTrades: Signal[];
  activeSymbols: Signal[];
  lastUpdated: string;
}

export default function Dashboard() {
  const [signals, setSignals] = useState<Signal[]>([]);
  const [loading, setLoading] = useState(false);
  const [refreshing, setRefreshing] = useState(false);
  const [testingAlert, setTestingAlert] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [toast, setToast] = useState<{ type: "success" | "error"; message: string } | null>(null);

  // Fetch signals from API
  const fetchSignals = async () => {
    try {
      setError(null);
      console.log("[FRONTEND] Fetching signals...");
      
      const res = await fetch("/api/signals", { cache: "no-store" });
      const json = (await res.json()) as ApiResponse;
      
      console.log("[FRONTEND API RESPONSE]", json);
      
      // Guaranteed: symbols array always exists and has 3 items
      const symbols = json?.symbols ?? [];
      console.log("[FRONTEND SYMBOLS]", symbols);
      
      if (Array.isArray(symbols)) {
        setSignals(symbols);
      }
    } catch (err) {
      const message = err instanceof Error ? err.message : "Failed to fetch signals";
      console.error("[FRONTEND ERROR]", message);
      setError(message);
    }
  };

  // Load signals on mount and every 5 seconds
  useEffect(() => {
    fetchSignals();
    const interval = setInterval(fetchSignals, 5000);
    return () => clearInterval(interval);
  }, []);

  // Refresh button: call cron, wait, then reload signals
  const handleRefresh = async () => {
    try {
      setRefreshing(true);
      console.log("[FRONTEND] Calling /api/cron...");
      await fetch("/api/cron", { method: "POST" });
      
      // Wait 500ms for cron to complete
      await new Promise(resolve => setTimeout(resolve, 500));
      
      await fetchSignals();
      setToast({ type: "success", message: "Signals refreshed" });
    } catch (err) {
      setToast({ type: "error", message: "Refresh failed" });
    } finally {
      setRefreshing(false);
    }
  };

  // Test Telegram button
  const handleTestTelegram = async () => {
    try {
      setTestingAlert(true);
      console.log("[FRONTEND] Calling /api/test-telegram...");
      const res = await fetch("/api/test-telegram", { method: "POST" });
      
      if (res.ok) {
        setToast({ type: "success", message: "Telegram alert sent" });
      } else {
        setToast({ type: "error", message: "Telegram alert failed" });
      }
    } catch (err) {
      setToast({ type: "error", message: "Telegram error" });
    } finally {
      setTestingAlert(false);
    }
  };

  // Determine readiness label
  const getReadiness = (signal: Signal): string => {
    if (signal.state === "SNIPER") return "READY";
    if (signal.state === "BUILDING") return "WATCH";
    return "NO TRADE";
  };

  // Get state color (left border)
  const getStateColor = (signal: Signal): string => {
    if (signal.state === "SNIPER") {
      return signal.direction === "LONG" ? "#00c853" : "#ff1744";
    }
    if (signal.state === "BUILDING") return "#ff9100";
    return "#666";
  };

  return (
    <div className="min-h-screen bg-black text-white p-6">
      {/* Header */}
      <div className="flex justify-between items-center mb-8">
        <h1 className="text-3xl font-bold">Trading Signals</h1>
        <div className="flex gap-3">
          <button
            onClick={handleRefresh}
            disabled={refreshing}
            className="px-4 py-2 bg-blue-600 hover:bg-blue-700 disabled:opacity-50 rounded"
          >
            {refreshing ? "Refreshing..." : "Refresh"}
          </button>
          <button
            onClick={handleTestTelegram}
            disabled={testingAlert}
            className="px-4 py-2 bg-purple-600 hover:bg-purple-700 disabled:opacity-50 rounded"
          >
            {testingAlert ? "Testing..." : "Test Telegram"}
          </button>
        </div>
      </div>

      {/* Toast */}
      {toast && (
        <div className={`mb-4 p-3 rounded ${toast.type === "success" ? "bg-green-900" : "bg-red-900"}`}>
          {toast.message}
        </div>
      )}

      {/* Error message */}
      {error && <div className="mb-4 p-3 bg-red-900 rounded">{error}</div>}

      {/* Symbol cards grid */}
      <div className="grid grid-cols-1 md:grid-cols-3 gap-6">
        {signals.map((signal) => (
          <div
            key={signal.symbol}
            className="border rounded-lg p-6"
            style={{
              backgroundColor: "#111111",
              borderColor: "#2a2a2a",
              borderLeftColor: getStateColor(signal),
              borderLeftWidth: "4px",
            }}
          >
            {/* Symbol header */}
            <div className="flex justify-between items-center mb-4">
              <h2 className="text-2xl font-bold">{signal.symbol}/USD</h2>
              <div className={`px-3 py-1 rounded text-sm font-semibold ${
                signal.state === "SNIPER" 
                  ? signal.direction === "LONG" 
                    ? "bg-green-900 text-green-200"
                    : "bg-red-900 text-red-200"
                  : signal.state === "BUILDING"
                  ? "bg-orange-900 text-orange-200"
                  : "bg-gray-700 text-gray-200"
              }`}>
                {signal.state}
              </div>
            </div>

            {/* Price */}
            <div className="mb-4 pb-4 border-b border-gray-700">
              <div className="text-gray-400 text-sm">Price</div>
              <div className="text-2xl font-mono font-bold">
                ${signal.price > 0 ? signal.price.toLocaleString("en-US", { maximumFractionDigits: 2 }) : "0.00"}
              </div>
            </div>

            {/* State and readiness */}
            <div className="mb-4 pb-4 border-b border-gray-700">
              <div className="text-gray-400 text-sm">Readiness</div>
              <div className="text-lg font-semibold">{getReadiness(signal)}</div>
            </div>

            {/* Market biases */}
            <div className="mb-4 pb-4 border-b border-gray-700 grid grid-cols-2 gap-2">
              <div>
                <div className="text-gray-400 text-xs">4H Bias</div>
                <div className="font-mono text-sm">Neutral</div>
              </div>
              <div>
                <div className="text-gray-400 text-xs">15M Bias</div>
                <div className="font-mono text-sm">Neutral</div>
              </div>
              <div className="col-span-2">
                <div className="text-gray-400 text-xs">Macro Trend</div>
                <div className="font-mono text-sm">Neutral</div>
              </div>
            </div>

            {/* SNIPER trade details */}
            {signal.state === "SNIPER" && signal.direction && (
              <div className="pt-4 border-t border-gray-700">
                <div className="text-sm font-semibold mb-3 text-green-300">Trade Setup</div>
                <div className="space-y-2 text-sm">
                  <div className="flex justify-between">
                    <span className="text-gray-400">Direction:</span>
                    <span className="font-mono font-bold">{signal.direction}</span>
                  </div>
                  <div className="flex justify-between">
                    <span className="text-gray-400">Entry:</span>
                    <span className="font-mono">${signal.entry?.toFixed(2)}</span>
                  </div>
                  <div className="flex justify-between">
                    <span className="text-gray-400">Stop Loss:</span>
                    <span className="font-mono text-red-400">${signal.stopLoss?.toFixed(2)}</span>
                  </div>
                  <div className="flex justify-between">
                    <span className="text-gray-400">Take Profit:</span>
                    <span className="font-mono text-green-400">${signal.takeProfit?.toFixed(2)}</span>
                  </div>
                  <div className="flex justify-between pt-2 border-t border-gray-700">
                    <span className="text-gray-400">Risk/Reward:</span>
                    <span className="font-mono font-bold">{signal.riskReward?.toFixed(2)}x</span>
                  </div>
                  <div className="flex justify-between">
                    <span className="text-gray-400">Confidence:</span>
                    <span className="font-mono">{signal.confidence}%</span>
                  </div>
                  <div className="flex justify-between">
                    <span className="text-gray-400">Reason:</span>
                    <span className="font-mono text-xs">{signal.reason}</span>
                  </div>
                </div>
              </div>
            )}

            {/* Updated timestamp */}
            <div className="mt-4 pt-4 border-t border-gray-700 text-xs text-gray-500">
              {new Date(signal.updated_at).toLocaleTimeString()}
            </div>
          </div>
        ))}
      </div>
    </div>
  );
}
