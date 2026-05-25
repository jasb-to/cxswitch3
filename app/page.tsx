"use client";

import { useState, useEffect } from "react";
import type { Signal } from "@/lib/signal-store";

export default function Dashboard() {
  const [signals, setSignals] = useState<Signal[]>([]);
  const [loading, setLoading] = useState(false);
  const [lastUpdated, setLastUpdated] = useState<string | null>(null);

  const fetchSignals = async () => {
    try {
      const res = await fetch("/api/signals", { cache: "no-store" });
      if (!res.ok) throw new Error(`HTTP ${res.status}`);

      const data: Signal[] = await res.json();
      setSignals(Array.isArray(data) ? data : []);
      setLastUpdated(new Date().toISOString());
    } catch (err) {
      console.error("[DASHBOARD]", err);
    }
  };

  const triggerCron = async () => {
    setLoading(true);
    try {
      await fetch("/api/cron", { method: "POST" });
      await new Promise(r => setTimeout(r, 500));
      await fetchSignals();
    } catch (err) {
      console.error("[CRON]", err);
    } finally {
      setLoading(false);
    }
  };

  const testTelegram = async () => {
    try {
      const res = await fetch("/api/test-telegram", { method: "POST" });
      const json = await res.json();
      alert(json.ok ? "Telegram connected!" : `Error: ${json.error}`);
    } catch (err) {
      alert(`Error: ${err}`);
    }
  };

  useEffect(() => {
    fetchSignals();
  }, []);

  return (
    <div style={{ backgroundColor: "#000", color: "#fff", minHeight: "100vh", padding: "20px" }}>
      <div style={{ maxWidth: "1200px", margin: "0 auto" }}>
        {/* Header */}
        <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", marginBottom: "30px" }}>
          <div>
            <h1 style={{ margin: 0, fontSize: "32px" }}>Trading Signals</h1>
            <p style={{ margin: "5px 0 0 0", color: "#999", fontSize: "13px" }} suppressHydrationWarning>
              {lastUpdated ? `Last updated: ${new Date(lastUpdated).toLocaleString()}` : "Never"}
            </p>
          </div>
          <div style={{ display: "flex", gap: "10px" }}>
            <button onClick={triggerCron} disabled={loading} style={{
              padding: "8px 16px",
              backgroundColor: loading ? "#444" : "#0066cc",
              color: "#fff",
              border: "none",
              borderRadius: "4px",
              cursor: loading ? "not-allowed" : "pointer"
            }}>
              {loading ? "Refreshing..." : "Refresh"}
            </button>
            <button onClick={testTelegram} style={{
              padding: "8px 16px",
              backgroundColor: "#666",
              color: "#fff",
              border: "none",
              borderRadius: "4px",
              cursor: "pointer"
            }}>
              Test Alert
            </button>
          </div>
        </div>

        {/* Signals Grid */}
        {signals.length === 0 ? (
          <p style={{ color: "#999", textAlign: "center", padding: "40px" }}>No signals</p>
        ) : (
          <div style={{
            display: "grid",
            gridTemplateColumns: "repeat(auto-fit, minmax(300px, 1fr))",
            gap: "20px"
          }}>
            {signals.map((signal) => (
              <div
                key={signal.symbol}
                style={{
                  backgroundColor: "#111",
                  border: "1px solid #2a2a2a",
                  borderLeft: signal.state === "SNIPER" 
                    ? (signal.direction === "LONG" ? "4px solid #00c853" : "4px solid #ff1744")
                    : signal.state === "BUILDING"
                    ? "4px solid #ff9100"
                    : "4px solid #666",
                  borderRadius: "8px",
                  padding: "16px",
                  display: "flex",
                  flexDirection: "column"
                }}
              >
                {/* Header */}
                <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", marginBottom: "12px" }}>
                  <h2 style={{ margin: 0, fontSize: "20px" }}>{signal.symbol}</h2>
                  <span style={{
                    backgroundColor: signal.state === "SNIPER" ? "#00c853" : signal.state === "BUILDING" ? "#ff9100" : "#666",
                    color: "#000",
                    padding: "4px 8px",
                    borderRadius: "4px",
                    fontSize: "12px",
                    fontWeight: "bold"
                  }}>
                    {signal.state}
                  </span>
                </div>

                {/* Price */}
                <p style={{ margin: "0 0 12px 0", fontSize: "24px", fontWeight: "bold" }}>
                  ${signal.price.toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 })}
                </p>

                {/* SNIPER Details */}
                {signal.state === "SNIPER" && signal.direction && (
                  <div style={{ backgroundColor: "#1a1a1a", padding: "12px", borderRadius: "4px", marginBottom: "12px" }}>
                    <p style={{ margin: "0 0 8px 0", fontSize: "14px", fontWeight: "bold" }}>Trade Setup</p>
                    <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr", gap: "8px", fontSize: "12px" }}>
                      <div><span style={{ color: "#999" }}>Direction:</span> {signal.direction}</div>
                      <div><span style={{ color: "#999" }}>Entry:</span> ${signal.entry?.toFixed(2)}</div>
                      <div><span style={{ color: "#999" }}>SL:</span> ${signal.stopLoss?.toFixed(2)}</div>
                      <div><span style={{ color: "#999" }}>TP:</span> ${signal.takeProfit?.toFixed(2)}</div>
                      <div><span style={{ color: "#999" }}>RR:</span> {signal.riskReward?.toFixed(2)}</div>
                      <div><span style={{ color: "#999" }}>Confidence:</span> {signal.confidence}%</div>
                    </div>
                    {signal.reason && (
                      <p style={{ margin: "8px 0 0 0", fontSize: "12px", color: "#aaa" }}>Reason: {signal.reason}</p>
                    )}
                  </div>
                )}

                {/* Footer */}
                <p style={{
                  margin: "auto 0 0 0",
                  paddingTop: "12px",
                  borderTop: "1px solid #2a2a2a",
                  fontSize: "11px",
                  color: "#666",
                  textAlign: "right"
                }} suppressHydrationWarning>
                  {new Date(signal.updated_at).toLocaleString()}
                </p>
              </div>
            ))}
          </div>
        )}
      </div>
    </div>
  );
}
