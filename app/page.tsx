"use client";

import { useEffect, useState } from "react";

export default function Home() {
  const [signals, setSignals] = useState<any[]>([]);

  async function fetchSignals() {
    const res = await fetch("/api/signals");
    const data = await res.json();

    setSignals(data.signals || []);
  }

  useEffect(() => {
    fetchSignals();
    const t = setInterval(fetchSignals, 60000); // 60s (correct)
    return () => clearInterval(t);
  }, []);

  return (
    <main style={{ padding: 24, background: "#000", color: "#fff" }}>
      <h1>CX Switch</h1>

      <div style={{ display: "grid", gap: 16 }}>
        {signals.map((s) => (
          <div key={s.symbol} style={{ border: "1px solid #333", padding: 12 }}>
            <div style={{ fontSize: 20 }}>
              {s.symbol} — ${s.price}
            </div>

            <div>{s.state}</div>
            <div>Bias: {s.bias}</div>
            <div>Confidence: {s.confidence}%</div>

            <div>ADX: {s.adx}</div>
            <div>Stoch: {s.stoch}</div>

            <div>{s.reason}</div>

            {s.state !== "WAIT" && (
              <div style={{ marginTop: 10 }}>
                <div>SL: {s.stopLoss}</div>
                <div>TP: {s.takeProfit}</div>
                <div>RR: {s.rr}</div>
              </div>
            )}

            <div style={{ opacity: 0.6, marginTop: 6 }}>
              {s.updatedAt}
            </div>
          </div>
        ))}
      </div>
    </main>
  );
}
