"use client";

import { useState, useEffect } from "react";
import type { Signal } from "@/lib/strategy-core";

interface ApiResponse {
  symbols: Signal[];
  activeTrades: Signal[];
  activeSymbols: Signal[];
  lastUpdated: string;
}

// Default signals to show when no data is loaded
const DEFAULT_SIGNALS: Signal[] = [
  {
    symbol: "BTC",
    price: 0,
    state: "DO_NOT_TRADE",
    bias_4h: "NEUTRAL",
    bias_15m: "NEUTRAL",
    macro: "NEUTRAL",
    activation: "DO_NOT_TRADE",
    signal_quality: 0,
    updated_at: new Date().toISOString(),
  },
  {
    symbol: "ETH",
    price: 0,
    state: "DO_NOT_TRADE",
    bias_4h: "NEUTRAL",
    bias_15m: "NEUTRAL",
    macro: "NEUTRAL",
    activation: "DO_NOT_TRADE",
    signal_quality: 0,
    updated_at: new Date().toISOString(),
  },
  {
    symbol: "SOL",
    price: 0,
    state: "DO_NOT_TRADE",
    bias_4h: "NEUTRAL",
    bias_15m: "NEUTRAL",
    macro: "NEUTRAL",
    activation: "DO_NOT_TRADE",
    signal_quality: 0,
    updated_at: new Date().toISOString(),
  },
];

export default function Dashboard() {
  const [data, setData] = useState<ApiResponse | null>(null);
  const [loading, setLoading] = useState(false);

  const fetchSignals = async () => {
    setLoading(true);
    try {
      const res = await fetch("/api/signals", { cache: "no-store" });
      if (res.ok) {
        const json = await res.json();
        setData(json);
      }
    } catch (err) {
      console.error("[FETCH] Error:", err);
    } finally {
      setLoading(false);
    }
  };

  const triggerCron = async () => {
    try {
      await fetch("/api/cron", { method: "POST" });
      await fetchSignals();
    } catch (err) {
      console.error("[CRON] Error:", err);
    }
  };

  const testTelegram = async () => {
    try {
      await fetch("/api/test-telegram", { method: "POST" });
    } catch (err) {
      console.error("[TELEGRAM] Error:", err);
    }
  };

  useEffect(() => {
    fetchSignals();
    const id = setInterval(fetchSignals, 15000);
    return () => clearInterval(id);
  }, []);

  // Always use loaded data or defaults - NEVER show loading screen
  const symbols = data?.symbols || DEFAULT_SIGNALS;
  const activeTrades = data?.activeTrades || [];
  const activeSymbols = data?.activeSymbols || [];

  return (
    <div style={{ padding: "20px", fontFamily: "system-ui, sans-serif" }}>
      {/* TOP BAR */}
      <div
        style={{
          display: "flex",
          justifyContent: "space-between",
          alignItems: "center",
          marginBottom: "30px",
          borderBottom: "1px solid #ddd",
          paddingBottom: "15px",
        }}
      >
        <div>
          <h1 style={{ margin: "0 0 5px 0" }}>Trading Signals</h1>
          <p style={{ margin: 0, color: "#666", fontSize: "12px" }}>
            Last updated: {data?.lastUpdated ? new Date(data.lastUpdated).toLocaleTimeString() : "waiting..."}
          </p>
        </div>
        <div style={{ display: "flex", gap: "10px" }}>
          <button
            onClick={triggerCron}
            disabled={loading}
            style={{
              padding: "8px 16px",
              cursor: loading ? "not-allowed" : "pointer",
              opacity: loading ? 0.5 : 1,
            }}
          >
            Refresh
          </button>
          <button onClick={testTelegram} style={{ padding: "8px 16px", cursor: "pointer" }}>
            Test Alert
          </button>
        </div>
      </div>

      {/* SYMBOL CARDS - ALWAYS 3 */}
      <div style={{ marginBottom: "30px" }}>
        <h2>Market Overview</h2>
        <div
          style={{
            display: "grid",
            gridTemplateColumns: "repeat(auto-fit, minmax(300px, 1fr))",
            gap: "15px",
          }}
        >
          {symbols.map((signal) => (
            <div
              key={signal.symbol}
              style={{
                border: "1px solid #ddd",
                borderRadius: "8px",
                padding: "15px",
                backgroundColor:
                  signal.state === "SNIPER" ? "#f0fff4" : signal.state === "BUILDING" ? "#fffbeb" : "#fef2f2",
              }}
            >
              <div style={{ display: "flex", justifyContent: "space-between", marginBottom: "10px" }}>
                <h3 style={{ margin: 0 }}>{signal.symbol}</h3>
                <span
                  style={{
                    fontWeight: "bold",
                    color:
                      signal.state === "SNIPER" ? "green" : signal.state === "BUILDING" ? "orange" : "red",
                  }}
                >
                  {signal.state}
                </span>
              </div>
              <div style={{ fontSize: "14px", color: "#666", marginBottom: "10px" }}>
                <div>Price: ${signal.price.toFixed(2)}</div>
                <div>4H Bias: {signal.bias_4h}</div>
                <div>15M Bias: {signal.bias_15m}</div>
                <div>Macro: {signal.macro}</div>
                <div>Activation: {signal.activation}</div>
                <div>Signal Quality: {signal.signal_quality}%</div>
                <div style={{ fontSize: "12px", color: "#999", marginTop: "8px" }}>
                  Updated: {new Date(signal.updated_at).toLocaleTimeString()}
                </div>
              </div>
            </div>
          ))}
        </div>
      </div>

      {/* ACTIVE TRADES SECTION */}
      {activeTrades.length > 0 && (
        <div style={{ marginBottom: "30px" }}>
          <h2>Active Trades ({activeTrades.length})</h2>
          <div style={{ border: "1px solid #ddd", borderRadius: "8px", padding: "15px" }}>
            {activeTrades.map((signal) => (
              <div key={signal.symbol} style={{ marginBottom: "10px", paddingBottom: "10px", borderBottom: "1px solid #eee" }}>
                <strong>{signal.symbol}</strong> - {signal.state}
                <div style={{ fontSize: "12px", color: "#666", marginTop: "5px" }}>
                  Price: ${signal.price.toFixed(2)} | Quality: {signal.signal_quality}%
                </div>
              </div>
            ))}
          </div>
        </div>
      )}

      {/* ACTIVE SYMBOLS SECTION */}
      {activeSymbols.length > 0 && (
        <div>
          <h2>Active Symbols ({activeSymbols.length})</h2>
          <div style={{ display: "flex", gap: "10px", flexWrap: "wrap" }}>
            {activeSymbols.map((signal) => (
              <span
                key={signal.symbol}
                style={{
                  backgroundColor:
                    signal.state === "SNIPER" ? "#d1fae5" : signal.state === "BUILDING" ? "#fed7aa" : "#fecaca",
                  padding: "8px 12px",
                  borderRadius: "4px",
                  fontSize: "12px",
                  fontWeight: "bold",
                }}
              >
                {signal.symbol}: {signal.state}
              </span>
            ))}
          </div>
        </div>
      )}
    </div>
  );
}

