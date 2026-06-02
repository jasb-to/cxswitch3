"use client";

import { useEffect, useState } from "react";

export default function Home() {
  const [signals, setSignals] = useState<any[]>([]);

  async function fetchSignals() {
    const res = await fetch("/api/signals");
    const data = await res.json();

    const raw = Array.isArray(data?.signals) ? data.signals : [];

    const latestMap = new Map();

    for (const s of raw) {
      if (s?.symbol) latestMap.set(s.symbol, s);
    }

    setSignals(Array.from(latestMap.values()));
  }

  useEffect(() => {
    fetchSignals();
    const t = setInterval(fetchSignals, 60000);
    return () => clearInterval(t);
  }, []);

  return (
    <main style={{ padding: 24, background: "#000", color: "#fff" }}>
      <h1 style={{ fontSize: 28, marginBottom: 20 }}>CX Switch</h1>

      <div style={{ display: "grid", gap: 16 }}>
        {signals.map((s) => (
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

            <div>{s.state}</div>

            <div>Bias: {s.bias}</div>
            <div>Confidence: {s.confidence}%</div>

            <div>ADX: {Number(s.adx || 0).toFixed(1)}</div>
            <div>Stoch: {Number(s.stoch || 0).toFixed(1)}</div>

            <div style={{ marginTop: 8 }}>{s.reason}</div>

            {s.state === "SNIPER" && (
              <div style={{ marginTop: 10 }}>
                <div>SL: {s.stopLoss}</div>
                <div>TP: {s.takeProfit}</div>
                <div>RR: {s.rr}</div>
              </div>
            )}
          </div>
        ))}
      </div>
    </main>
  );
}
