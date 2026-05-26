"use client";

import { useState, useEffect } from "react";
import useSWR from "swr";
import type { Signal } from "@/lib/strategy-core";

const fetcher = (url: string) => fetch(url, { cache: "no-store" }).then(res => {
  if (!res.ok) throw new Error(`API returned ${res.status}`);
  return res.json();
});

export default function Dashboard() {
  const [mounted, setMounted] = useState(false);
  const [isRefreshing, setIsRefreshing] = useState(false);
  const [isTesting, setIsTesting] = useState(false);

  const { data: signals = [], error, isLoading, mutate } = useSWR<Signal[]>(
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
      const data = await res.json();
      if (data.ok) {
        alert("Telegram message sent!");
      } else {
        alert(`Error: ${data.error}`);
      }
    } catch (err) {
      alert(`Test failed: ${err}`);
    } finally {
      setIsTesting(false);
    }
  };

  if (!mounted) return null;

  return (
    <div style={{ backgroundColor: "#0a0a0a", color: "#fff", minHeight: "100vh", padding: "24px" }}>
      {/* HEADER */}
      <div style={{ marginBottom: "32px" }}>
        <h1 style={{ margin: "0 0 8px 0", fontSize: "32px", fontWeight: "bold" }}>
          Trading Signals
        </h1>
        <p style={{ margin: 0, fontSize: "13px", color: "#9ca3af" }}>
          Early Entry Mode v2: Prioritizing structural shifts and early breaks
        </p>
      </div>

      {/* STATUS BAR */}
      <div style={{ display: "flex", gap: "12px", marginBottom: "24px", flexWrap: "wrap" }}>
        <div style={{ display: "flex", gap: "8px" }}>
          <button
            onClick={handleRefreshSignals}
            disabled={isRefreshing || isLoading}
            style={{
              padding: "8px 16px",
              backgroundColor: "#1a7fff",
              color: "#fff",
              border: "none",
              borderRadius: "6px",
              cursor: isRefreshing ? "not-allowed" : "pointer",
              fontSize: "13px",
              fontWeight: "600",
              opacity: isRefreshing ? 0.6 : 1,
            }}
          >
            {isRefreshing ? "Refreshing..." : "Refresh Signals"}
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

        {error && (
          <div style={{ color: "#ff1744", fontSize: "13px", fontWeight: "600" }}>
            ⚠️ Error loading signals
          </div>
        )}

        {isLoading && (
          <div style={{ color: "#9ca3af", fontSize: "13px", fontWeight: "600" }}>
            ⏳ Loading...
          </div>
        )}

        {signals.length > 0 && !isLoading && (
          <div style={{ color: "#4caf50", fontSize: "13px", fontWeight: "600" }}>
            ✓ {signals.length} signals live
          </div>
        )}
      </div>

      {/* SIGNAL CARDS GRID */}
      <div style={{ display: "grid", gridTemplateColumns: "repeat(auto-fit, minmax(380px, 1fr))", gap: "16px" }}>
        {signals.map((signal) => {
          const isSNIPER = signal.state === "SNIPER";
          const isBuilding = signal.state === "BUILDING";
          const isWatching = signal.state === "WATCHING_SHIFT";

          // Color scheme: Green=LONG, Red=SHORT, Orange=BUILDING, Gray=WATCHING
          let stateColor = "#4a4a4a"; // WATCHING_SHIFT default
          let stateBgColor = "#1a1a1a";
          
          if (isSNIPER && signal.direction === "LONG") {
            stateColor = "#4caf50";
            stateBgColor = "#1b5e20";
          } else if (isSNIPER && signal.direction === "SHORT") {
            stateColor = "#f44336";
            stateBgColor = "#b71c1c";
          } else if (isBuilding) {
            stateColor = "#ff9100";
            stateBgColor = "#e65100";
          }

          const priceDiff = signal.entry ? signal.price - signal.entry : 0;
          const pricePercentDiff = signal.entry ? (((signal.price - signal.entry) / signal.entry) * 100).toFixed(2) : "0.00";

          return (
            <div
              key={signal.symbol}
              style={{
                backgroundColor: "#111",
                border: "1px solid #2a2a2a",
                borderLeft: `5px solid ${stateColor}`,
                borderRadius: "10px",
                padding: "18px",
              }}
            >
              {/* HEADER: Symbol + State + Price */}
              <div style={{ display: "flex", justifyContent: "space-between", alignItems: "start", marginBottom: "16px" }}>
                <div>
                  <h2 style={{ margin: "0 0 8px 0", fontSize: "28px", fontWeight: "bold", color: "#fff" }}>
                    {signal.symbol}
                  </h2>
                  <div style={{ display: "flex", gap: "8px", alignItems: "center" }}>
                    <div
                      style={{
                        padding: "6px 10px",
                        backgroundColor: stateBgColor,
                        color: stateColor,
                        borderRadius: "4px",
                        fontSize: "11px",
                        fontWeight: "bold",
                        border: `1px solid ${stateColor}`,
                      }}
                    >
                      {signal.state === "SNIPER"
                        ? signal.direction === "LONG"
                          ? "SNIPER LONG"
                          : "SNIPER SHORT"
                        : signal.state === "BUILDING"
                          ? "BUILDING"
                          : "WATCHING"}
                    </div>
                    {signal.is_active && (
                      <div style={{ fontSize: "11px", color: "#ff9100", fontWeight: "bold" }}>
                        🔴 ACTIVE
                      </div>
                    )}
                  </div>
                </div>
                <div style={{ textAlign: "right" }}>
                  <p style={{ margin: "0 0 6px 0", fontSize: "18px", fontWeight: "bold", color: "#fff" }}>
                    ${signal.price.toFixed(2)}
                  </p>
                  {signal.hold_remaining_ms && signal.hold_remaining_ms > 0 && (
                    <p style={{ margin: 0, fontSize: "11px", color: "#ff9100" }}>
                      🔒 Hold: {Math.ceil(signal.hold_remaining_ms / 1000)}s
                    </p>
                  )}
                </div>
              </div>

              {/* MARKET CONTEXT - 3 LAYERS */}
              <div style={{ marginBottom: "16px", paddingBottom: "16px", borderBottom: "1px solid #2a2a2a" }}>
                {/* 4H BIAS */}
                <div style={{ marginBottom: "11px" }}>
                  <div style={{ fontSize: "10px", fontWeight: "700", color: "#7a8a9a", marginBottom: "4px", textTransform: "uppercase" }}>
                    4H BIAS
                  </div>
                  <div style={{ fontSize: "14px", color: "#e0e0e0", fontWeight: "500" }}>
                    {signal.bias_4h === "Bullish"
                      ? "📈 Bullish (HH/HL)"
                      : signal.bias_4h === "Bearish"
                        ? "📉 Bearish (LH/LL)"
                        : "➡️ Neutral"}
                  </div>
                </div>

                {/* 15M STRUCTURE */}
                <div style={{ marginBottom: "11px" }}>
                  <div style={{ fontSize: "10px", fontWeight: "700", color: "#7a8a9a", marginBottom: "4px", textTransform: "uppercase" }}>
                    15M STRUCTURE
                  </div>
                  <div style={{ fontSize: "14px", color: "#e0e0e0", fontWeight: "500" }}>
                    {signal.structure_15m === "Shift Forming"
                      ? "🌀 Shift Forming (" + signal.shift_type + ")"
                      : signal.structure_15m === "Compressing"
                        ? "🟡 Compressing (entry zone)"
                        : signal.structure_15m === "Expanding"
                          ? "📊 Expanding (breakout)"
                          : "〰️ Ranging"}
                  </div>
                </div>

                {/* 5M TRIGGER */}
                <div>
                  <div style={{ fontSize: "10px", fontWeight: "700", color: "#7a8a9a", marginBottom: "4px", textTransform: "uppercase" }}>
                    5M TRIGGER
                  </div>
                  <div style={{ fontSize: "14px", color: "#e0e0e0", fontWeight: "500" }}>
                    {signal.trigger_5m === "Early Break Up"
                      ? "⬆️ Early Break Up"
                      : signal.trigger_5m === "Early Break Down"
                        ? "⬇️ Early Break Down"
                        : signal.trigger_5m === "Retest"
                          ? "🔄 Retest"
                          : signal.trigger_5m === "Compression"
                            ? "🔵 Compression"
                            : "⚪ Neutral"}
                  </div>
                </div>
              </div>

              {/* ENTRY ZONE (if BUILDING or SNIPER) */}
              {(isBuilding || isSNIPER) && signal.entry !== undefined && (
                <div style={{ marginBottom: "16px", paddingBottom: "16px", borderBottom: "1px solid #2a2a2a" }}>
                  <div style={{ display: "flex", justifyContent: "space-between", alignItems: "start", marginBottom: "6px" }}>
                    <div>
                      <div style={{ fontSize: "10px", fontWeight: "700", color: "#7a8a9a", marginBottom: "4px", textTransform: "uppercase" }}>
                        🟡 ENTRY POINT
                      </div>
                      <div style={{ fontSize: "16px", fontWeight: "bold", color: "#ffeb3b" }}>
                        ${signal.entry.toFixed(2)}
                      </div>
                    </div>
                    <div style={{ textAlign: "right" }}>
                      <div style={{ fontSize: "12px", color: "#9ca3af" }}>
                        {priceDiff >= 0 ? "+" : ""}{priceDiff.toFixed(2)} ({pricePercentDiff}%)
                      </div>
                      <div style={{ fontSize: "10px", color: "#7a8a9a", marginTop: "3px" }}>
                        {signal.entry_description}
                      </div>
                    </div>
                  </div>
                </div>
              )}

              {/* TRADE SETUP (if direction exists) */}
              {signal.direction && (
                <div style={{ marginBottom: "12px" }}>
                  <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr", gap: "12px", marginBottom: "12px" }}>
                    <div>
                      <div style={{ fontSize: "10px", fontWeight: "700", color: "#7a8a9a", marginBottom: "4px" }}>
                        STOP LOSS
                      </div>
                      <div style={{ fontSize: "13px", color: "#ff6b6b", fontWeight: "600" }}>
                        ${signal.stopLoss?.toFixed(2)}
                      </div>
                    </div>
                    <div>
                      <div style={{ fontSize: "10px", fontWeight: "700", color: "#7a8a9a", marginBottom: "4px" }}>
                        TAKE PROFIT
                      </div>
                      <div style={{ fontSize: "13px", color: "#4caf50", fontWeight: "600" }}>
                        ${signal.takeProfit?.toFixed(2)}
                      </div>
                    </div>
                  </div>

                  <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr", gap: "12px" }}>
                    <div>
                      <div style={{ fontSize: "10px", fontWeight: "700", color: "#7a8a9a", marginBottom: "4px" }}>
                        RISK/REWARD
                      </div>
                      <div style={{ fontSize: "14px", color: "#ffc107", fontWeight: "bold" }}>
                        {signal.riskReward?.toFixed(2)}:1
                      </div>
                    </div>
                    <div>
                      <div style={{ fontSize: "10px", fontWeight: "700", color: "#7a8a9a", marginBottom: "4px" }}>
                        CONFIDENCE
                      </div>
                      <div style={{ fontSize: "14px", color: stateColor, fontWeight: "bold" }}>
                        {signal.confidence}%
                      </div>
                    </div>
                  </div>
                </div>
              )}

              {/* REASON / NOTES */}
              {signal.reason && (
                <div style={{ padding: "10px", backgroundColor: "#1a1a1a", borderRadius: "6px", fontSize: "12px", color: "#b0b0b0", fontStyle: "italic" }}>
                  "{signal.reason}"
                </div>
              )}
            </div>
          );
        })}
      </div>

      {/* EMPTY STATE (NO SIGNALS) */}
      {signals.length === 0 && !isLoading && (
        <div style={{ textAlign: "center", padding: "48px 24px", color: "#7a8a9a" }}>
          <p style={{ fontSize: "16px", marginBottom: "8px" }}>No signals yet</p>
          <p style={{ fontSize: "13px", color: "#555" }}>Waiting for early market shifts to be detected...</p>
        </div>
      )}
    </div>
  );
}
