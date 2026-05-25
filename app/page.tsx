"use client";

import { useState, useEffect } from "react";
import type { Signal } from "@/lib/signal-store";

interface ApiResponse {
  symbols: Signal[];
  activeTrades: Signal[];
  activeSymbols: Signal[];
  lastUpdated: string;
}

const DARK_BG = "#0a0e27";
const CARD_BG = "#111c44";
const BORDER = "#1e2d5f";
const TEXT = "#e5e7eb";
const TEXT_MUTED = "#9ca3af";
const GREEN = "#22c55e";
const ORANGE = "#f59e0b";
const GREY = "#6b7280";

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
    <div style={{ backgroundColor: DARK_BG, color: TEXT, minHeight: "100vh", padding: "24px", fontFamily: "system-ui, sans-serif" }}>
      {/* HEADER */}
      <div style={{ marginBottom: "32px", borderBottom: `1px solid ${BORDER}`, paddingBottom: "20px" }}>
        <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center" }}>
          <div>
            <h1 style={{ margin: "0 0 8px 0", fontSize: "32px", fontWeight: "bold" }}>Trading Signals</h1>
            <p style={{ margin: 0, color: TEXT_MUTED, fontSize: "13px" }}>
              Last updated: {data?.lastUpdated ? new Date(data.lastUpdated).toLocaleTimeString() : "waiting..."}
            </p>
          </div>
          <div style={{ display: "flex", gap: "12px" }}>
            <button
              onClick={triggerCron}
              disabled={loading}
              style={{
                padding: "10px 18px",
                cursor: loading ? "not-allowed" : "pointer",
                opacity: loading ? 0.5 : 1,
                backgroundColor: CARD_BG,
                color: TEXT,
                border: `1px solid ${BORDER}`,
                borderRadius: "6px",
                fontSize: "14px",
                fontWeight: "500",
              }}
            >
              Refresh
            </button>
            <button
              onClick={testTelegram}
              style={{
                padding: "10px 18px",
                cursor: "pointer",
                backgroundColor: CARD_BG,
                color: TEXT,
                border: `1px solid ${BORDER}`,
                borderRadius: "6px",
                fontSize: "14px",
                fontWeight: "500",
              }}
            >
              Test Alert
            </button>
          </div>
        </div>
      </div>

      {/* SYMBOL CARDS GRID */}
      <div style={{ marginBottom: "40px" }}>
        <h2 style={{ marginBottom: "20px", fontSize: "18px", fontWeight: "600", margin: "0 0 20px 0" }}>Market Overview</h2>
        <div style={{ display: "grid", gridTemplateColumns: "repeat(auto-fit, minmax(360px, 1fr))", gap: "20px" }}>
          {symbols.map((signal) => {
            const isSNIPER = signal.state === "SNIPER";
            const isBuilding = signal.state === "BUILDING";
            const stateColor = isSNIPER ? GREEN : isBuilding ? ORANGE : GREY;
            const borderColor = isSNIPER ? "#064e3b" : isBuilding ? "#78350f" : "#374151";

            return (
              <div
                key={signal.symbol}
                style={{
                  backgroundColor: CARD_BG,
                  border: `2px solid ${borderColor}`,
                  borderRadius: "8px",
                  padding: "24px",
                }}
              >
                {/* HEADER WITH SYMBOL AND STATE BADGE */}
                <div style={{ display: "flex", justifyContent: "space-between", alignItems: "flex-start", marginBottom: "20px" }}>
                  <div>
                    <div style={{ fontSize: "28px", fontWeight: "bold", color: TEXT }}>{signal.symbol}/USD</div>
                  </div>
                  <div
                    style={{
                      backgroundColor: stateColor,
                      color: isBuilding ? "#000" : "#fff",
                      padding: "6px 14px",
                      borderRadius: "4px",
                      fontSize: "12px",
                      fontWeight: "bold",
                    }}
                  >
                    {signal.state}
                  </div>
                </div>

                {/* PRICE */}
                <div style={{ fontSize: "36px", fontWeight: "bold", color: stateColor, marginBottom: "24px" }}>
                  ${signal.price.toLocaleString(undefined, { minimumFractionDigits: 2, maximumFractionDigits: 2 })}
                </div>

                {/* SNIPER TRADE DETAILS */}
                {isSNIPER && signal.direction ? (
                  <div style={{ backgroundColor: DARK_BG, padding: "16px", borderRadius: "6px", marginBottom: "16px", borderLeft: `3px solid ${stateColor}` }}>
                    <div style={{ marginBottom: "12px" }}>
                      <div style={{ fontSize: "12px", color: TEXT_MUTED, fontWeight: "600", marginBottom: "4px" }}>DIRECTION</div>
                      <div style={{ fontSize: "16px", fontWeight: "bold", color: stateColor }}>{signal.direction}</div>
                    </div>

                    <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr", gap: "12px", marginBottom: "12px" }}>
                      <div>
                        <div style={{ fontSize: "11px", color: TEXT_MUTED, fontWeight: "600", marginBottom: "4px" }}>ENTRY</div>
                        <div style={{ fontSize: "14px", fontWeight: "bold" }}>${signal.entry?.toFixed(2)}</div>
                      </div>
                      <div>
                        <div style={{ fontSize: "11px", color: TEXT_MUTED, fontWeight: "600", marginBottom: "4px" }}>STOP LOSS</div>
                        <div style={{ fontSize: "14px", fontWeight: "bold" }}>${signal.stopLoss?.toFixed(2)}</div>
                      </div>
                    </div>

                    <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr", gap: "12px" }}>
                      <div>
                        <div style={{ fontSize: "11px", color: TEXT_MUTED, fontWeight: "600", marginBottom: "4px" }}>TAKE PROFIT</div>
                        <div style={{ fontSize: "14px", fontWeight: "bold" }}>${signal.takeProfit?.toFixed(2)}</div>
                      </div>
                      <div>
                        <div style={{ fontSize: "11px", color: TEXT_MUTED, fontWeight: "600", marginBottom: "4px" }}>RISK/REWARD</div>
                        <div style={{ fontSize: "14px", fontWeight: "bold", color: GREEN }}>{signal.riskReward?.toFixed(2)}</div>
                      </div>
                    </div>

                    <div style={{ marginTop: "12px", paddingTop: "12px", borderTop: `1px solid ${BORDER}` }}>
                      <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr", gap: "12px" }}>
                        <div>
                          <div style={{ fontSize: "11px", color: TEXT_MUTED, fontWeight: "600", marginBottom: "4px" }}>CONFIDENCE</div>
                          <div style={{ fontSize: "14px", fontWeight: "bold" }}>{signal.confidence}%</div>
                        </div>
                        <div>
                          <div style={{ fontSize: "11px", color: TEXT_MUTED, fontWeight: "600", marginBottom: "4px" }}>REASON</div>
                          <div style={{ fontSize: "12px" }}>{signal.reason}</div>
                        </div>
                      </div>
                    </div>
                  </div>
                ) : null}

                {/* FOOTER */}
                <div style={{ fontSize: "11px", color: TEXT_MUTED, textAlign: "right" }}>
                  Updated: {new Date(signal.updated_at).toLocaleTimeString()}
                </div>
              </div>
            );
          })}
        </div>
      </div>

      {/* ACTIVE TRADES SECTION */}
      {data?.activeTrades.length ? (
        <div style={{ marginBottom: "32px" }}>
          <h2 style={{ marginBottom: "16px", fontSize: "18px", fontWeight: "600", margin: "0 0 16px 0" }}>Active Trades ({data.activeTrades.length})</h2>
          <div style={{ backgroundColor: CARD_BG, border: `1px solid ${BORDER}`, borderRadius: "8px", overflow: "hidden" }}>
            {data.activeTrades.map((signal, idx) => (
              <div
                key={signal.symbol}
                style={{
                  padding: "16px",
                  borderBottom: idx < data.activeTrades.length - 1 ? `1px solid ${BORDER}` : "none",
                }}
              >
                <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", marginBottom: "8px" }}>
                  <div style={{ fontSize: "14px", fontWeight: "bold" }}>{signal.symbol}</div>
                  <div style={{ fontSize: "13px", color: TEXT_MUTED }}>
                    {signal.direction} @ ${signal.entry?.toFixed(2)}
                  </div>
                </div>
                <div style={{ fontSize: "12px", color: TEXT_MUTED }}>
                  SL: ${signal.stopLoss?.toFixed(2)} | TP: ${signal.takeProfit?.toFixed(2)} | RR: {signal.riskReward?.toFixed(2)}
                </div>
              </div>
            ))}
          </div>
        </div>
      ) : null}
    </div>
  );
}
