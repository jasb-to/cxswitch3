"use client";

import { useState, useEffect } from "react";
import useSWR from "swr";
import type { SignalViewModel } from "@/lib/signal-view-model";

const fetcher = (url: string) => fetch(url, { cache: "no-store" }).then(res => {
  if (!res.ok) throw new Error(`API returned ${res.status}`);
  return res.json();
});

export default function Dashboard() {
  const [mounted, setMounted] = useState(false);
  const [isRefreshing, setIsRefreshing] = useState(false);
  const [isTesting, setIsTesting] = useState(false);

  const { data: signals = [], error, isLoading, mutate } = useSWR<SignalViewModel[]>(
    "/api/signals",
    fetcher,
    {
      revalidateOnFocus: true,
      revalidateOnReconnect: true,
      focusThrottleInterval: 0,
      dedupingInterval: 0,
      refreshInterval: 30000,
      errorRetryInterval: 10000,
      errorRetryCount: 3,
      compare: (a, b) => JSON.stringify(a) === JSON.stringify(b),
    }
  );

  useEffect(() => {
    setMounted(true);
  }, []);

  const handleRefreshSignals = async () => {
    setIsRefreshing(true);
    try {
      await mutate();
    } catch (err) {
      console.error("[v0] Refresh error:", err);
    } finally {
      setIsRefreshing(false);
    }
  };

  const handleTestTelegram = async () => {
    setIsTesting(true);
    try {
      const res = await fetch("/api/test-telegram", { method: "POST" });
      const result = await res.json();
      alert(result.ok ? "✓ Test alert sent!" : `✗ Error: ${result.error || "Unknown error"}`);
    } catch (err) {
      alert(`✗ Error: ${String(err)}`);
    } finally {
      setIsTesting(false);
    }
  };

  if (!mounted) return <div style={{ padding: "20px", color: "#9ca3af" }}>Loading...</div>;
  if (error) return <div style={{ padding: "20px", color: "#ff1744" }}>Error: {String(error)}</div>;
  if (isLoading && signals.length === 0) return <div style={{ padding: "20px", color: "#9ca3af" }}>Loading signals...</div>;

  return (
    <div style={{ backgroundColor: "#000", color: "#e5e7eb", minHeight: "100vh", padding: "24px", fontFamily: "system-ui, sans-serif" }}>
      {/* HEADER */}
      <div style={{ marginBottom: "32px", borderBottom: "1px solid #2a2a2a", paddingBottom: "20px" }}>
        <div style={{ display: "flex", justifyContent: "space-between", alignItems: "flex-start", marginBottom: "16px", gap: "16px" }}>
          <div>
            <p style={{ margin: "0 0 8px 0", fontSize: "32px", fontWeight: "bold", color: "#fff" }}>Trading Signals</p>
            <p style={{ margin: 0, color: "#9ca3af", fontSize: "13px" }} suppressHydrationWarning>
              Live structure analysis • Entry points at compression tops
            </p>
          </div>
          
          <div style={{ display: "flex", gap: "8px", flexShrink: 0 }}>
            <button
              onClick={handleRefreshSignals}
              disabled={isRefreshing}
              style={{
                padding: "8px 16px",
                backgroundColor: "#00d4ff",
                color: "#000",
                border: "none",
                borderRadius: "6px",
                cursor: isRefreshing ? "not-allowed" : "pointer",
                opacity: isRefreshing ? 0.6 : 1,
                fontSize: "13px",
                fontWeight: "600",
                transition: "opacity 0.2s",
              }}
            >
              {isRefreshing ? "Refreshing..." : "Refresh"}
            </button>
            <button
              onClick={handleTestTelegram}
              disabled={isTesting}
              style={{
                padding: "8px 16px",
                backgroundColor: "transparent",
                color: "#9ca3af",
                border: "1px solid #2a2a2a",
                borderRadius: "6px",
                cursor: isTesting ? "not-allowed" : "pointer",
                opacity: isTesting ? 0.6 : 1,
                fontSize: "13px",
                fontWeight: "600",
              }}
            >
              {isTesting ? "Testing..." : "Test Telegram"}
            </button>
          </div>
        </div>
      </div>

      {/* SIGNAL CARDS */}
      <div style={{ display: "grid", gridTemplateColumns: "repeat(auto-fit, minmax(340px, 1fr))", gap: "16px" }}>
        {signals.map((signal) => {
          const isSNIPER = signal.state === "SNIPER";
          const isBuilding = signal.state === "BUILDING";
          
          // Color scheme based on state and direction
          const stateColor = isSNIPER 
            ? (signal.direction === "LONG" ? "#00c853" : "#ff1744")
            : isBuilding ? "#ff9100" : "#555";

          const priceDiff = signal.entry ? signal.price - signal.entry : 0;
          const pricePercentDiff = signal.entry ? ((priceDiff / signal.entry) * 100).toFixed(1) : "0.0";

          return (
            <div
              key={signal.symbol}
              style={{
                backgroundColor: "#111",
                border: "1px solid #2a2a2a",
                borderLeft: `4px solid ${stateColor}`,
                borderRadius: "8px",
                padding: "16px",
              }}
            >
              {/* SYMBOL + STATE */}
              <div style={{ display: "flex", justifyContent: "space-between", alignItems: "start", marginBottom: "16px" }}>
                <div>
                  <h3 style={{ margin: "0 0 4px 0", fontSize: "24px", fontWeight: "bold", color: "#fff" }}>
                    {signal.symbol}
                  </h3>
                  <div
                    style={{
                      display: "inline-block",
                      padding: "4px 8px",
                      backgroundColor: stateColor,
                      color: "#000",
                      borderRadius: "4px",
                      fontSize: "11px",
                      fontWeight: "bold",
                    }}
                  >
                    {signal.state}
                  </div>
                </div>
                <div style={{ textAlign: "right" }}>
                  <p style={{ margin: "0 0 6px 0", fontSize: "14px", fontWeight: "bold", color: "#fff" }}>
                    ${signal.price.toFixed(2)}
                  </p>
                  {signal.hold_remaining_ms && signal.hold_remaining_ms > 0 && (
                    <p style={{ margin: 0, fontSize: "10px", color: "#ff9100" }}>
                      🔒 {Math.ceil(signal.hold_remaining_ms / 1000)}s
                    </p>
                  )}
                </div>
              </div>

              {/* STRUCTURE LAYERS */}
              <div style={{ marginBottom: "16px", paddingBottom: "16px", borderBottom: "1px solid #2a2a2a" }}>
                {/* 4H BIAS */}
                <div style={{ marginBottom: "12px" }}>
                  <div style={{ fontSize: "10px", fontWeight: "600", color: "#9ca3af", marginBottom: "3px" }}>
                    4H CONTEXT
                  </div>
                  <div style={{ fontSize: "13px", color: "#fff", fontWeight: "500" }}>
                    {signal.bias_4h === "Bullish" ? "📈 Bullish (HH/HL)" : 
                     signal.bias_4h === "Bearish" ? "📉 Bearish (LH/LL)" : 
                     "➡️ Neutral"}
                  </div>
                </div>

                {/* 15M SETUP */}
                <div style={{ marginBottom: "12px" }}>
                  <div style={{ fontSize: "10px", fontWeight: "600", color: "#9ca3af", marginBottom: "3px" }}>
                    15M SETUP
                  </div>
                  <div style={{ fontSize: "13px", color: "#fff", fontWeight: "500" }}>
                    {signal.structure_15m === "Setup" ? "🔴 Compression (entry zone)" :
                     signal.structure_15m === "Breakout" ? "🟢 Breakout forming" :
                     "🔵 Ranging"}
                  </div>
                </div>

                {/* 5M TRIGGER */}
                <div>
                  <div style={{ fontSize: "10px", fontWeight: "600", color: "#9ca3af", marginBottom: "3px" }}>
                    5M TRIGGER
                  </div>
                  <div style={{ fontSize: "13px", color: "#fff", fontWeight: "500" }}>
                    {signal.trigger_5m === "Breaking Up" ? "⬆️ Breaking up" :
                     signal.trigger_5m === "Breaking Down" ? "⬇️ Breaking down" :
                     signal.trigger_5m === "Retest Bullish" ? "🔄 Retesting support" :
                     signal.trigger_5m === "Retest Bearish" ? "🔄 Retesting resistance" :
                     "⏸️ Flat"}
                  </div>
                </div>
              </div>

              {/* ENTRY POINT - YELLOW CIRCLE */}
              {signal.entry && (
                <div style={{ marginBottom: "16px", paddingBottom: "16px", borderBottom: "1px solid #2a2a2a" }}>
                  <div style={{ fontSize: "10px", fontWeight: "600", color: "#9ca3af", marginBottom: "6px" }}>
                    ENTRY POINT (Yellow Circle)
                  </div>
                  <div style={{ fontSize: "14px", fontWeight: "bold", color: "#ffeb3b", marginBottom: "4px" }}>
                    ${signal.entry.toFixed(2)}
                  </div>
                  <div style={{ fontSize: "11px", color: "#fff" }}>
                    {signal.entry_description || "At compression top"}
                  </div>
                  <div style={{ fontSize: "11px", color: signal.priceDiff > 0 ? "#00c853" : "#ff1744", marginTop: "4px" }}>
                    Current: {priceDiff > 0 ? "+" : ""}{priceDiff.toFixed(2)} ({pricePercentDiff}%)
                  </div>
                </div>
              )}

              {/* TRADE SETUP - IF SNIPER OR BUILDING */}
              {signal.direction && (
                <div style={{ marginBottom: "12px", paddingBottom: "12px", borderBottom: "1px solid #2a2a2a" }}>
                  <div style={{ fontSize: "10px", fontWeight: "600", color: "#9ca3af", marginBottom: "8px" }}>
                    TRADE SETUP
                  </div>
                  <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr", gap: "8px", fontSize: "11px" }}>
                    <div>
                      <span style={{ color: "#9ca3af" }}>Direction:</span>
                      <div style={{ color: stateColor, fontWeight: "bold" }}>
                        {signal.direction === "LONG" ? "🟢 LONG" : "🔴 SHORT"}
                      </div>
                    </div>
                    <div>
                      <span style={{ color: "#9ca3af" }}>Confidence:</span>
                      <div style={{ color: "#fff", fontWeight: "bold" }}>
                        {signal.confidence}%
                      </div>
                    </div>
                    <div>
                      <span style={{ color: "#9ca3af" }}>SL:</span>
                      <div style={{ color: "#fff", fontWeight: "bold" }}>
                        ${signal.stopLoss?.toFixed(2)}
                      </div>
                    </div>
                    <div>
                      <span style={{ color: "#9ca3af" }}>TP:</span>
                      <div style={{ color: "#fff", fontWeight: "bold" }}>
                        ${signal.takeProfit?.toFixed(2)}
                      </div>
                    </div>
                    <div>
                      <span style={{ color: "#9ca3af" }}>RR:</span>
                      <div style={{ color: "#fff", fontWeight: "bold" }}>
                        1:{signal.riskReward?.toFixed(2)}
                      </div>
                    </div>
                  </div>
                </div>
              )}

              {/* REASON / INSIGHT */}
              <div style={{ fontSize: "11px", color: "#9ca3af", lineHeight: "1.5", fontStyle: "italic" }}>
                {signal.reason || "Monitoring market structure"}
              </div>
            </div>
          );
        })}
      </div>

      {signals.length === 0 && (
        <div style={{ textAlign: "center", padding: "40px", color: "#555" }}>
          No signals available
        </div>
      )}
    </div>
  );
}
