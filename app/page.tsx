"use client";

import { useState, useEffect } from "react";
import type { Signal } from "@/lib/strategy-core";

interface ApiResponse {
  symbols: Signal[];
  activeTrades: Signal[];
  activeSymbols: Signal[];
  lastUpdated: string;
}

const DARK_BG = "#0b0f14";
const CARD_BG = "#111827";
const BORDER_COLOR = "#1f2937";
const TEXT_PRIMARY = "#e5e7eb";
const TEXT_MUTED = "#9ca3af";

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

  const symbols = data?.symbols || [];

  return (
    <div style={{ backgroundColor: DARK_BG, color: TEXT_PRIMARY, minHeight: "100vh", padding: "20px", fontFamily: "system-ui, sans-serif" }}>
      {/* TOP BAR */}
      <div style={{ marginBottom: "30px", borderBottom: `1px solid ${BORDER_COLOR}`, paddingBottom: "15px" }}>
        <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center" }}>
          <div>
            <h1 style={{ margin: "0 0 5px 0", fontSize: "28px", fontWeight: "bold" }}>Trading Signals</h1>
            <p style={{ margin: 0, color: TEXT_MUTED, fontSize: "12px" }}>
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
                backgroundColor: CARD_BG,
                color: TEXT_PRIMARY,
                border: `1px solid ${BORDER_COLOR}`,
                borderRadius: "6px",
              }}
            >
              Refresh
            </button>
            <button
              onClick={testTelegram}
              style={{
                padding: "8px 16px",
                cursor: "pointer",
                backgroundColor: CARD_BG,
                color: TEXT_PRIMARY,
                border: `1px solid ${BORDER_COLOR}`,
                borderRadius: "6px",
              }}
            >
              Test Alert
            </button>
          </div>
        </div>
      </div>

      {/* SYMBOL CARDS - ALWAYS 3 */}
      <div style={{ marginBottom: "40px" }}>
        <h2 style={{ marginBottom: "20px", fontSize: "18px", fontWeight: "600" }}>Market Overview</h2>
        <div style={{ display: "grid", gridTemplateColumns: "repeat(auto-fit, minmax(320px, 1fr))", gap: "20px" }}>
          {symbols.map((signal) => {
            const isSniper = signal.state === "SNIPER";
            const isBuilding = signal.state === "BUILDING";
            const stateColor = isSniper ? "#22c55e" : isBuilding ? "#eab308" : "#6b7280";
            const borderColor = isSniper ? "#15803d" : isBuilding ? "#854d0e" : "#374151";

            return (
              <div
                key={signal.symbol}
                style={{
                  backgroundColor: CARD_BG,
                  border: `1px solid ${borderColor}`,
                  borderRadius: "8px",
                  padding: "20px",
                }}
              >
                {/* HEADER */}
                <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", marginBottom: "16px" }}>
                  <div>
                    <div style={{ fontSize: "24px", fontWeight: "bold" }}>{signal.symbol}/USD</div>
                  </div>
                  <div
                    style={{
                      backgroundColor: stateColor,
                      color: signal.state === "BUILDING" ? "#000" : "#fff",
                      padding: "6px 12px",
                      borderRadius: "4px",
                      fontSize: "12px",
                      fontWeight: "bold",
                    }}
                  >
                    {signal.state}
                  </div>
                </div>

                {/* PRICE */}
                <div style={{ marginBottom: "16px", fontSize: "32px", fontWeight: "bold", color: stateColor }}>
                  ${signal.price.toLocaleString()}
                </div>

                {/* MARKET BIAS SECTION */}
                <div style={{ marginBottom: "16px", backgroundColor: DARK_BG, padding: "12px", borderRadius: "4px", borderLeft: `2px solid ${stateColor}` }}>
                  <div style={{ fontSize: "12px", color: TEXT_MUTED, fontWeight: "600", marginBottom: "8px" }}>Market Bias</div>
                  <div style={{ fontSize: "14px", marginBottom: "4px" }}>4H: <span style={{ fontWeight: "bold" }}>{signal.bias_4h}</span></div>
                  <div style={{ fontSize: "14px", marginBottom: "4px" }}>15M: <span style={{ fontWeight: "bold" }}>{signal.bias_15m}</span></div>
                  <div style={{ fontSize: "14px" }}>Macro: <span style={{ fontWeight: "bold" }}>{signal.macro}</span></div>
                </div>

                {/* STATE OF PLAY SECTION */}
                <div style={{ marginBottom: "16px", backgroundColor: DARK_BG, padding: "12px", borderRadius: "4px" }}>
                  <div style={{ fontSize: "12px", color: TEXT_MUTED, fontWeight: "600", marginBottom: "8px" }}>State of Play</div>
                  <div style={{ fontSize: "14px", marginBottom: "4px" }}>Direction: <span style={{ fontWeight: "bold", color: stateColor }}>{isSniper ? "LONG bias" : isBuilding ? "WAIT" : "NEUTRAL"}</span></div>
                  <div style={{ fontSize: "14px", marginBottom: "4px" }}>Activation: <span style={{ fontWeight: "bold" }}>{signal.activation}</span></div>
                  <div style={{ fontSize: "14px" }}>Signal Quality: <span style={{ fontWeight: "bold", color: stateColor }}>{signal.signalQuality}%</span></div>
                </div>

                {/* FOOTER */}
                <div style={{ fontSize: "12px", color: TEXT_MUTED, textAlign: "right" }}>
                  Updated: {new Date(signal.updatedAt).toLocaleTimeString()}
                </div>
              </div>
            );
          })}
        </div>
      </div>

      {/* ACTIVE TRADES SECTION */}
      {data?.activeTrades.length ? (
        <div style={{ marginBottom: "30px" }}>
          <h2 style={{ marginBottom: "16px", fontSize: "18px", fontWeight: "600" }}>Active Trades ({data.activeTrades.length})</h2>
          <div style={{ backgroundColor: CARD_BG, border: `1px solid ${BORDER_COLOR}`, borderRadius: "8px", padding: "16px" }}>
            {data.activeTrades.map((signal) => (
              <div key={signal.symbol} style={{ paddingBottom: "12px", marginBottom: "12px", borderBottom: `1px solid ${BORDER_COLOR}` }}>
                <div style={{ fontSize: "14px", fontWeight: "bold", marginBottom: "4px" }}>{signal.symbol}</div>
                <div style={{ fontSize: "12px", color: TEXT_MUTED }}>Price: ${signal.price.toLocaleString()} | Quality: {signal.signalQuality}%</div>
              </div>
            ))}
          </div>
        </div>
      ) : null}
    </div>
  );
}
