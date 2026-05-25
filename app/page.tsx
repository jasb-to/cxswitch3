"use client";

import { useState, useEffect } from "react";

interface Signal {
  symbol: string;
  state: "SNIPER" | "BUILDING" | "DO_NOT_TRADE";
  timestamp: number;
}

interface ApiResponse {
  ready?: boolean;
  signals?: Signal[];
}

// Fallback signals when API is empty/broken
const FALLBACK_SIGNALS: Signal[] = [
  { symbol: "BTC", state: "DO_NOT_TRADE", timestamp: Date.now() },
  { symbol: "ETH", state: "DO_NOT_TRADE", timestamp: Date.now() },
  { symbol: "SOL", state: "DO_NOT_TRADE", timestamp: Date.now() },
];

export default function Dashboard() {
  const [signals, setSignals] = useState<Signal[]>(FALLBACK_SIGNALS);
  const [mounted, setMounted] = useState(false);

  // Hydration guard
  useEffect(() => {
    setMounted(true);
  }, []);

  // Poll signals - 15s interval
  useEffect(() => {
    if (!mounted) return;

    const poll = async () => {
      try {
        const res = await fetch("/api/signals", { cache: "no-store" });
        if (!res.ok) {
          console.error("[POLL] HTTP error:", res.status);
          setSignals(FALLBACK_SIGNALS);
          return;
        }
        
        const data = await res.json();
        console.log("[DEBUG /api/signals raw]", data);

        // Harden response parsing with fallback logic
        const parsed = Array.isArray(data)
          ? data
          : Array.isArray(data?.signals)
          ? data.signals
          : data?.data?.signals
          ? data.data.signals
          : [];

        // Type check each signal
        const validSignals = parsed.filter(
          (s: any) =>
            s &&
            typeof s === "object" &&
            typeof s.symbol === "string" &&
            typeof s.state === "string" &&
            typeof s.timestamp === "number"
        );

        if (validSignals.length > 0) {
          setSignals(validSignals);
        } else {
          console.warn("[POLL] No valid signals parsed, using fallback");
          setSignals(FALLBACK_SIGNALS);
        }
      } catch (err) {
        console.error("[POLL] Error:", err);
        setSignals(FALLBACK_SIGNALS);
      }
    };

    poll();
    const id = setInterval(poll, 15000);
    return () => clearInterval(id);
  }, [mounted]);

  // Frontend must ALWAYS render - no loading gate
  return (
    <div style={{ padding: "20px", fontFamily: "monospace" }}>
      <h1>Trading Signals</h1>

      <div style={{ marginTop: "20px" }}>
        <table style={{ borderCollapse: "collapse", width: "100%" }}>
          <thead>
            <tr style={{ borderBottom: "2px solid #333" }}>
              <th style={{ padding: "10px", textAlign: "left" }}>Symbol</th>
              <th style={{ padding: "10px", textAlign: "left" }}>State</th>
              <th style={{ padding: "10px", textAlign: "left" }}>Updated</th>
            </tr>
          </thead>
          <tbody>
            {signals.map((signal) => (
              <tr key={signal.symbol} style={{ borderBottom: "1px solid #ccc" }}>
                <td style={{ padding: "10px", fontWeight: "bold" }}>
                  {signal.symbol}
                </td>
                <td
                  style={{
                    padding: "10px",
                    fontWeight: signal.state === "SNIPER" ? "bold" : "normal",
                    color:
                      signal.state === "SNIPER"
                        ? "green"
                        : signal.state === "BUILDING"
                        ? "orange"
                        : "red",
                  }}
                >
                  {signal.state}
                </td>
                <td style={{ padding: "10px" }}>
                  {new Date(signal.timestamp).toISOString().split('T')[1].slice(0, 8)}
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </div>
  );
}
