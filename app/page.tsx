"use client";

import { useEffect, useState } from "react";

export default function Home() {
  const [signals, setSignals] = useState<any[]>([]);

  async function fetchSignals() {
    try {
      const res = await fetch("/api/signals");

      if (!res.ok) return;

      const data = await res.json();

      const raw = data.signals || [];

      const latestMap = new Map();

      for (const s of raw) {
        latestMap.set(s.symbol, s);
      }

      setSignals(Array.from(latestMap.values()));
    } catch (err) {
      console.error("[UI]", err);
    }
  }

  useEffect(() => {
    fetchSignals();

    // refresh once per minute
    const t = setInterval(fetchSignals, 60000);

    return () => clearInterval(t);
  }, []);

  return (
    <main
      style={{
        padding: 24,
        background: "#000",
        color: "#fff",
        minHeight: "100vh",
      }}
    >
      <h1
        style={{
          fontSize: 32,
          marginBottom: 24,
          fontWeight: 700,
        }}
      >
        CX Switch
      </h1>

      <div
        style={{
          display: "grid",
          gap: 16,
        }}
      >
        {signals.map((s) => {
          const stateColor =
            s.state === "SNIPER"
              ? "#00ff66"
              : s.state === "EARLY"
              ? "#b14dff"
              : "#888";

          return (
            <div
              key={s.symbol}
              style={{
                border: "1px solid #222",
                borderRadius: 12,
                padding: 16,
                background: "#080808",
              }}
            >
              <div
                style={{
                  fontSize: 22,
                  fontWeight: 700,
                  marginBottom: 8,
                }}
              >
                {s.symbol} — $
                {Number(s.price).toLocaleString(undefined, {
                  maximumFractionDigits: 2,
                })}
              </div>

              <div
                style={{
                  color: stateColor,
                  fontWeight: 700,
                  marginBottom: 10,
                }}
              >
                {s.state}
              </div>

              <div>Bias: {s.bias}</div>

              <div>
                Confidence: {Math.round(Number(s.confidence || 0))}%
              </div>

              <div>
                ADX: {Number(s.adx || 0).toFixed(1)}
              </div>

              <div>
                Stoch: {Number(s.stochK || 0).toFixed(1)}
              </div>

              <div
                style={{
                  marginTop: 10,
                  opacity: 0.8,
                }}
              >
                {s.reason}
              </div>

              {s.state === "SNIPER" && (
                <div style={{ marginTop: 12 }}>
                  <div>
                    SL: $
                    {Number(s.stopLoss || 0).toLocaleString(undefined, {
                      maximumFractionDigits: 2,
                    })}
                  </div>

                  <div>
                    TP: $
                    {Number(s.takeProfit || 0).toLocaleString(undefined, {
                      maximumFractionDigits: 2,
                    })}
                  </div>

                  <div>
                    RR: {s.riskRewardRatio ?? "-"}
                  </div>
                </div>
              )}

              <div
                style={{
                  marginTop: 12,
                  opacity: 0.5,
                  fontSize: 12,
                }}
              >
                {s.updatedAt}
              </div>
            </div>
          );
        })}
      </div>
    </main>
  );
}
