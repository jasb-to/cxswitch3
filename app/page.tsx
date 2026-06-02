"use client";

import { useEffect, useState } from "react";

export default function Home() {
  const [signals, setSignals] = useState<any[]>([]);

  async function fetchSignals() {
    const res = await fetch("/api/signals", {
      cache: "no-store",
    });

    const data = await res.json();
    const raw = data.signals || [];

    // keep latest per symbol (extra safety layer)
    const latestMap = new Map();

    for (const s of raw) {
      latestMap.set(s.symbol, s);
    }

    const cleaned = Array.from(latestMap.values());

    setSignals(cleaned);
  }

  useEffect(() => {
    fetchSignals();

    // ✅ FIX: reduce flicker + server spam
    const t = setInterval(fetchSignals, 60000);

    return () => clearInterval(t);
  }, []);

  function isTradable(s: any) {
    return (
      s &&
      s.state !== "WAIT" &&
      s.confidence >= 60 &&
      s.expectedMove >= 0.02 &&
      s.stopLoss !== null &&
      s.takeProfit !== null
    );
  }

  return (
    <main style={{ padding: 24, background: "#000", color: "#fff" }}>
      <h1 style={{ fontSize: 28, marginBottom: 20 }}>
        CX Switch
      </h1>

      <div style={{ display: "grid", gap: 16 }}>
        {signals
          .filter(isTradable)
          .map((s) => {
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
                <div>Confidence: {s.confidence.toFixed(1)}%</div>

                <div>ADX: {Number(s.adx).toFixed(1)}</div>
                <div>Stoch: {Number(s.stoch).toFixed(1)}</div>

                <div>RSI: {Number(s.rsi).toFixed(1)}</div>

                <div style={{ marginTop: 8, opacity: 0.7 }}>
                  {s.reason}
                </div>

                <div style={{ marginTop: 10 }}>
                  <div>
                    SL:{" "}
                    {s.stopLoss
                      ? `$${Number(s.stopLoss).toFixed(2)}`
                      : "-"}
                  </div>
                  <div>
                    TP:{" "}
                    {s.takeProfit
                      ? `$${Number(s.takeProfit).toFixed(2)}`
                      : "-"}
                  </div>
                  <div>
                    RR:{" "}
                    {s.rr ? Number(s.rr).toFixed(2) : "-"}
                  </div>
                  <div>
                    Expected Move:{" "}
                    {(s.expectedMove * 100).toFixed(2)}%
                  </div>
                </div>

                <div style={{ marginTop: 8, opacity: 0.5 }}>
                  {s.updatedAt}
                </div>
              </div>
            );
          })}
      </div>
    </main>
  );
}
