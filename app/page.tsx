"use client";

import { useState, useEffect } from "react";

interface Signal {
  symbol: string;
  state: "SNIPER" | "BUILDING" | "DO_NOT_TRADE";
  timestamp: number;
}

interface ApiResponse {
  ready: boolean;
  signals: Signal[];
}

export default function Dashboard() {
  const [data, setData] = useState<ApiResponse | null>(null);
  const [mounted, setMounted] = useState(false);
  const [error, setError] = useState<string | null>(null);

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
        if (!res.ok) throw new Error(`${res.status}`);
        const json: ApiResponse = await res.json();
        // Guard: validate structure
        if (json && typeof json === "object" && Array.isArray(json.signals)) {
          setData(json);
          setError(null);
        }
      } catch (err) {
        console.error("[POLL] Error:", err);
        setError(String(err));
      }
    };

    poll();
    const id = setInterval(poll, 15000);
    return () => clearInterval(id);
  }, [mounted]);

  if (!mounted) return <div>Loading...</div>;
  if (error) return <div>Error: {error}</div>;
  if (!data) return <div>No data</div>;

  return (
    <div style={{ padding: "20px", fontFamily: "monospace" }}>
      <h1>Trading Signals</h1>
      <p>Ready: {data.ready ? "✓" : "✗"}</p>

      <div style={{ marginTop: "20px" }}>
        {data.signals.length === 0 ? (
          <p>No signals</p>
        ) : (
          <table style={{ borderCollapse: "collapse", width: "100%" }}>
            <thead>
              <tr style={{ borderBottom: "2px solid #333" }}>
                <th style={{ padding: "10px", textAlign: "left" }}>Symbol</th>
                <th style={{ padding: "10px", textAlign: "left" }}>State</th>
                <th style={{ padding: "10px", textAlign: "left" }}>Time</th>
              </tr>
            </thead>
            <tbody>
              {data.signals.map((signal) => (
                <tr key={signal.symbol} style={{ borderBottom: "1px solid #ccc" }}>
                  <td style={{ padding: "10px" }}>{signal.symbol}</td>
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
                    {new Date(signal.timestamp).toLocaleTimeString()}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        )}
      </div>
    </div>
  );
}
