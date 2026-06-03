"use client";

import { useEffect, useState } from "react";

export default function Home() {
  const [signals, setSignals] = useState<any[]>([]);

  async function load() {
    const res = await fetch("/api/signals", { cache: "no-store" });
    const data = await res.json();
    setSignals(data.signals || []);
  }

  useEffect(() => {
    load();
    const t = setInterval(load, 30000);
    return () => clearInterval(t);
  }, []);

  return (
    <main style={{ padding: 20, background: "#000", color: "#fff" }}>
      <h1>CX Switch</h1>

      <div style={{ display: "grid", gap: 12 }}>
        {signals.map((s) => (
          <div key={s.symbol} style={{ border: "1px solid #333", padding: 12 }}>
            <h2>
              {s.symbol} — ${s.price}
            </h2>

            <div>{s.state}</div>
            <div>Bias: {s.bias}</div>
            <div>Confidence: {s.confidence}%</div>

            <div>RSI: {s.rsi}</div>
            <div>Stoch: {s.stochK} / {s.stochD}</div>
            <div>ADX: {s.adx}</div>

            <div>{s.reason}</div>

            {s.state !== "WAIT" && (
              <div style={{ marginTop: 8 }}>
                <div>SL: {s.stopLoss}</div>
                <div>TP: {s.takeProfit}</div>
                <div>RR: {s.rr}</div>
              </div>
            )}

            <div style={{ opacity: 0.5, marginTop: 6 }}>
              {s.updatedAt}
            </div>
          </div>
        ))}
      </div>
    </main>
  );
}
