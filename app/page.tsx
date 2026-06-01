"use client";

import { useEffect, useState } from "react";

export default function Home() {
  const [signals, setSignals] = useState<any[]>([]);

  async function fetchSignals() {
    const res = await fetch("/api/signals");
    const data = await res.json();

    const raw = data.signals || [];

    // 🔥 KEEP ONLY LATEST PER SYMBOL
    const latestMap = new Map();

    for (const s of raw) {
      latestMap.set(s.symbol, s);
    }

    setSignals(Array.from(latestMap.values()));
  }

  useEffect(() => {
    fetchSignals();
    const t = setInterval(fetchSignals, 5000);
    return () => clearInterval(t);
  }, []);

  return (
    <main style={{ padding: 24, background: "#000", color: "#fff" }}>
      <h1 style={{ fontSize: 28, marginBottom: 20 }}>
        CX Switch
      </h1>

      <div style={{ display: "grid", gap: 16 }}>
        {signals.map((s) => {
          const stateColor =
            s.state === "SNIPER"
              ? "lime"
              : s.state === "EARLY"
              ? "violet"
              : "gray";

          return (
            <div
              key={s.symbol}
              style={{
                border: "1px solid #222",
                padding: 16,
                borderRadius: 12,
              }}
            >
              <div style={{ fontSize: 22 }}>
                {s.symbol} — ${s.price}
              </div>

              <div style={{ color: stateColor }}>
                {s.state}
              </div>

              <div>Bias: {s.bias}</div>
              <div>Confidence: {s.confidence}%</div>

              <div>ADX: {Number(s.adx).toFixed(1)}</div>
              <div>Stoch: {Number(s.stochK).toFixed(1)}</div>

              <div style={{ marginTop: 8, opacity: 0.7 }}>
                {s.reason}
              </div>

              {s.state === "SNIPER" && (
                <div style={{ marginTop: 10 }}>
                  <div>SL: {s.stopLoss}</div>
                  <div>TP: {s.takeProfit}</div>
                </div>
              )}
            </div>
          );
        })}
      </div>
    </main>
  );
}
