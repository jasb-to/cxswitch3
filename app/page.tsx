"use client";

import { useState, useEffect } from "react";
import type { Signal } from "@/lib/signal-store";

interface ApiResponse {
  symbols: Signal[];
  activeTrades: Signal[];
  activeSymbols: Signal[];
  lastUpdated: string;
}

const FALLBACK_SIGNAL = (symbol: string): Signal => ({
  symbol,
  price: 0,
  state: "DO_NOT_TRADE",
  direction: undefined,
  entry: undefined,
  stopLoss: undefined,
  takeProfit: undefined,
  riskReward: undefined,
  confidence: undefined,
  reason: undefined,
  updated_at: new Date().toISOString(),
});

export default function Dashboard() {
  const [data, setData] = useState<ApiResponse | null>(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const fetchSignals = async () => {
    try {
      setError(null);
      const res = await fetch("/api/signals", { cache: "no-store" });
      
      if (!res.ok) {
        throw new Error(`API returned ${res.status}`);
      }

      const json = await res.json();
      console.log("[FRONTEND SIGNALS]", json);

      // Parse symbols with fallback logic
      let symbols = 
        json?.symbols ??
        json?.data?.symbols ??
        (Array.isArray(json) ? json : []);

      if (!Array.isArray(symbols)) {
        symbols = [];
      }

      console.log("[FRONTEND PARSED]", symbols);

      setData({
        symbols,
        activeTrades: json?.activeTrades ?? symbols.filter(s => s?.state === "SNIPER"),
        activeSymbols: json?.activeSymbols ?? symbols.filter(s => s?.state !== "DO_NOT_TRADE"),
        lastUpdated: json?.lastUpdated ?? new Date().toISOString(),
      });
    } catch (err) {
      console.error("[FETCH] Error:", err);
      setError(String(err));
    }
  };

  const triggerCron = async () => {
    setLoading(true);
    try {
      const res = await fetch("/api/cron", { method: "POST" });
      if (!res.ok) throw new Error("Cron failed");
      
      // Wait a moment for data to update
      await new Promise(r => setTimeout(r, 500));
      
      await fetchSignals();
    } catch (err) {
      setError("Cron error: " + String(err));
      console.error("[CRON] Error:", err);
    } finally {
      setLoading(false);
    }
  };

  const testTelegram = async () => {
    try {
      const res = await fetch("/api/test-telegram", { method: "POST" });
      const result = await res.json();
      alert(result.ok ? "Telegram alert sent!" : "Telegram failed: " + (result.error || "Unknown error"));
    } catch (err) {
      alert("Telegram error: " + String(err));
    }
  };

  useEffect(() => {
    fetchSignals();
    const id = setInterval(fetchSignals, 15000);
    return () => clearInterval(id);
  }, []);

  // Force merge: always show 3 cards
  const SYMBOLS = ["BTC", "ETH", "SOL"];
  const apiSymbols = data?.symbols ?? [];
  
  console.log("[FRONTEND MERGED]", apiSymbols);

  const merged = SYMBOLS.map(sym => {
    const found = apiSymbols.find(s => s?.symbol === sym);
    if (found) return found;
    return FALLBACK_SIGNAL(sym);
  });

  console.log("[FRONTEND MERGED RESULT]", merged);

  return (
    <div style={{ backgroundColor: "#000", color: "#e5e7eb", minHeight: "100vh", padding: "24px", fontFamily: "system-ui, sans-serif" }}>
      {/* HEADER */}
      <div style={{ marginBottom: "32px", borderBottom: "1px solid #2a2a2a", paddingBottom: "20px" }}>
        <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center" }}>
          <div>
            <p style={{ margin: "0 0 8px 0", fontSize: "32px", fontWeight: "bold", color: "#fff" }}>Trading Signals</p>
            <p style={{ margin: 0, color: "#9ca3af", fontSize: "13px" }} suppressHydrationWarning>
              Last updated: {data?.lastUpdated ? new Date(data.lastUpdated).toLocaleString() : "never"}
            </p>
            {error && (
              <p style={{ margin: "8px 0 0 0", color: "#ff6b6b", fontSize: "12px" }}>
                ⚠️ {error}
              </p>
            )}
          </div>
          <div style={{ display: "flex", gap: "12px" }}>
            <button
              onClick={triggerCron}
              disabled={loading}
              style={{
                padding: "8px 16px",
                backgroundColor: "#222",
                color: "#fff",
                border: "1px solid #2a2a2a",
                borderRadius: "6px",
                cursor: loading ? "not-allowed" : "pointer",
                opacity: loading ? 0.5 : 1,
                fontSize: "14px",
                fontWeight: "500",
              }}
            >
              {loading ? "Refreshing..." : "Refresh"}
            </button>
            <button
              onClick={testTelegram}
              style={{
                padding: "8px 16px",
                backgroundColor: "#222",
                color: "#fff",
                border: "1px solid #2a2a2a",
                borderRadius: "6px",
                cursor: "pointer",
                fontSize: "14px",
                fontWeight: "500",
              }}
            >
              Test Alert
            </button>
          </div>
        </div>
      </div>

      {/* SYMBOL CARDS - ALWAYS RENDER 3 */}
      <div style={{ marginBottom: "32px" }}>
        <h2 style={{ marginBottom: "16px", fontSize: "18px", fontWeight: "600", color: "#fff" }}>Market Overview</h2>
        <div style={{ display: "grid", gridTemplateColumns: "repeat(auto-fit, minmax(300px, 1fr))", gap: "16px" }}>
          {merged.map((signal) => {
            if (!signal) return null;

            const isSNIPER = signal.state === "SNIPER";
            const isBuilding = signal.state === "BUILDING";
            const borderColor = isSNIPER 
              ? (signal.direction === "LONG" ? "#00c853" : "#ff1744") 
              : isBuilding ? "#ff9100" : "#555";

            return (
              <div
                key={signal.symbol}
                style={{
                  backgroundColor: "#111",
                  border: "1px solid #2a2a2a",
                  borderLeft: `4px solid ${borderColor}`,
                  borderRadius: "8px",
                  padding: "16px",
                }}
              >
                {/* HEADER */}
                <div style={{ display: "flex", justifyContent: "space-between", alignItems: "start", marginBottom: "16px" }}>
                  <div>
                    <h3 style={{ margin: "0 0 8px 0", fontSize: "20px", fontWeight: "bold", color: "#fff" }}>{signal.symbol}</h3>
                    <p style={{ margin: 0, fontSize: "12px", color: "#9ca3af" }}>
                      Price: ${signal.price.toLocaleString("en-US", { minimumFractionDigits: 2, maximumFractionDigits: 2 })}
                    </p>
                  </div>
                  <div
                    style={{
                      padding: "6px 12px",
                      backgroundColor: borderColor,
                      color: "#000",
                      borderRadius: "4px",
                      fontSize: "12px",
                      fontWeight: "bold",
                    }}
                  >
                    {signal.state}
                  </div>
                </div>

                {/* SNIPER DETAILS */}
                {isSNIPER && signal.direction ? (
                  <div style={{ fontSize: "13px", lineHeight: "1.6", color: "#e5e7eb" }}>
                    <div style={{ marginBottom: "12px", borderTop: "1px solid #2a2a2a", paddingTop: "12px" }}>
                      <div style={{ color: "#9ca3af", fontSize: "11px", fontWeight: "600", marginBottom: "8px" }}>TRADE DETAILS</div>
                      <div style={{ marginBottom: "6px" }}>
                        <span style={{ color: "#9ca3af" }}>Direction:</span>{" "}
                        <span style={{ color: borderColor, fontWeight: "bold" }}>{signal.direction}</span>
                      </div>
                      <div style={{ marginBottom: "6px" }}>
                        <span style={{ color: "#9ca3af" }}>Entry:</span> <span style={{ fontWeight: "bold" }}>${signal.entry?.toFixed(2)}</span>
                      </div>
                      <div style={{ marginBottom: "6px" }}>
                        <span style={{ color: "#9ca3af" }}>SL:</span> <span style={{ fontWeight: "bold" }}>${signal.stopLoss?.toFixed(2)}</span>
                      </div>
                      <div style={{ marginBottom: "6px" }}>
                        <span style={{ color: "#9ca3af" }}>TP:</span> <span style={{ fontWeight: "bold" }}>${signal.takeProfit?.toFixed(2)}</span>
                      </div>
                      <div style={{ marginBottom: "6px" }}>
                        <span style={{ color: "#9ca3af" }}>RR:</span> <span style={{ fontWeight: "bold" }}>{signal.riskReward?.toFixed(2)}</span>
                      </div>
                      <div style={{ marginBottom: "6px" }}>
                        <span style={{ color: "#9ca3af" }}>Confidence:</span>{" "}
                        <span style={{ fontWeight: "bold", color: borderColor }}>{signal.confidence}%</span>
                      </div>
                      <div>
                        <span style={{ color: "#9ca3af" }}>Reason:</span> <span style={{ fontWeight: "500" }}>{signal.reason}</span>
                      </div>
                    </div>
                  </div>
                ) : (
                  <div style={{ fontSize: "13px", color: "#9ca3af", paddingTop: "8px" }}>
                    No active trade details
                  </div>
                )}

                {/* FOOTER */}
                <div style={{ marginTop: "12px", paddingTop: "12px", borderTop: "1px solid #2a2a2a", fontSize: "11px", color: "#6b7280", textAlign: "right" }} suppressHydrationWarning>
                  Updated: {new Date(signal.updated_at).toLocaleString()}
                </div>
              </div>
            );
          })}
        </div>
      </div>

      {/* ACTIVE TRADES SECTION */}
      {data?.activeTrades && data.activeTrades.length > 0 && (
        <div>
          <h2 style={{ marginBottom: "16px", fontSize: "18px", fontWeight: "600", color: "#fff" }}>Active Trades ({data.activeTrades.length})</h2>
          <div style={{ backgroundColor: "#111", border: "1px solid #2a2a2a", borderRadius: "8px", padding: "16px" }}>
            {data.activeTrades.map((signal) => (
              <div key={signal.symbol} style={{ marginBottom: "12px", paddingBottom: "12px", borderBottom: "1px solid #2a2a2a" }}>
                <div style={{ fontWeight: "bold", marginBottom: "4px", color: "#fff" }}>{signal.symbol}</div>
                <div style={{ fontSize: "12px", color: "#9ca3af" }}>
                  {signal.direction} @ ${signal.entry?.toFixed(2)} | RR: {signal.riskReward?.toFixed(2)}
                </div>
              </div>
            ))}
          </div>
        </div>
      )}
    </div>
  );
}
