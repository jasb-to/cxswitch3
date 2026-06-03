"use client";

import { useEffect, useState } from "react";

export default function Home() {
  const [signals, setSignals] = useState<any[]>([]);

  async function load() {
    try {
      const res = await fetch("/api/signals", { cache: "no-store" });
      const data = await res.json();
      setSignals(data.signals || []);
    } catch (e) {
      console.error("UI fetch error:", e);
    }
  }

  useEffect(() => {
    load();
    const t = setInterval(load, 15000); // faster refresh for trading
    return () => clearInterval(t);
  }, []);

  return (
    <main style={{ padding: 20, background: "#000", color: "#fff", fontFamily: "Arial" }}>
      <h1 style={{ marginBottom: 20 }}>CX Switch</h1>

      <div style={{ display: "grid", gap: 16 }}>
        {signals.map((s) => (
          <div
            key={s.symbol}
            style={{
              border: "1px solid #333",
              padding: 14,
              borderRadius: 8,
              background: "#111",
            }}
          >
            {/* HEADER */}
            <div style={{ fontSize: 20, fontWeight: "bold" }}>
              {s.symbol} — ${Number(s.price).toFixed(2)}
            </div>

            <div style={{ marginTop: 6 }}>
              <strong>{s.state}</strong>
            </div>

            <div>Bias: {s.bias}</div>
            <div>Confidence: {Number(s.confidence).toFixed(1)}%</div>

            <div>RSI: {Number(s.rsi).toFixed(1)}</div>
            <div>Stoch: {Number(s.stoch).toFixed(1)}</div>
            <div>ADX: {Number(s.adx).toFixed(1)}</div>

            <div style={{ marginTop: 6, opacity: 0.8 }}>{s.reason}</div>

            {/* TRADE BOX */}
            {s.state !== "WAIT" && (
              <div
                style={{
                  marginTop: 12,
                  padding: 10,
                  background: "#0a0a0a",
                  border: "1px solid #222",
                }}
              >
                <div>Expected Move: {s.expectedMove}%</div>

                <div>
                  SL:{" "}
                  {s.stopLoss !== null
                    ? Number(s.stopLoss).toFixed(2)
                    : "-"}
                </div>

                <div>
                  TP:{" "}
                  {s.takeProfit !== null
                    ? Number(s.takeProfit).toFixed(2)
                    : "-"}
                </div>

                <div>
                  RR:{" "}
                  {s.rr !== null
                    ? Number(s.rr).toFixed(2)
                    : "-"}
                </div>
              </div>
            )}

            <div style={{ marginTop: 8, fontSize: 12, opacity: 0.5 }}>
              {s.updatedAt}
            </div>
          </div>
        ))}
      </div>
    </main>
  );
} 
