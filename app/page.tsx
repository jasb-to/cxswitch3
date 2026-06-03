"use client";

import { useEffect, useState } from "react";

type SignalState = "EARLY" | "SNIPER" | "WAIT";

interface Signal {
  symbol: string;
  price: number;

  state: SignalState;

  bias: "LONG" | "SHORT" | "NEUTRAL";
  confidence: number;

  adx: number;
  stochK: number;
  stochD: number;
  rsi: number;

  reason: string;

  stopLoss: number | null;
  takeProfit: number | null;
  rr: number | null;

  expectedMove: number;

  updatedAt: string;
}

export default function Page() {
  const [signals, setSignals] = useState<Signal[]>([]);
  const [loading, setLoading] = useState(true);

  async function fetchSignals() {
    try {
      const res = await fetch("/api/cron", {
        cache: "no-store",
      });

      const data = await res.json();

      setSignals(Array.isArray(data.signals) ? data.signals : []);
    } catch (err) {
      console.error("UI fetch error:", err);
      setSignals([]);
    } finally {
      setLoading(false);
    }
  }

  useEffect(() => {
    fetchSignals();

    const interval = setInterval(() => {
      fetchSignals();
    }, 15000); // faster refresh for trading UI

    return () => clearInterval(interval);
  }, []);

  function color(state: SignalState) {
    if (state === "SNIPER") return "#00ff88";
    if (state === "EARLY") return "#ffaa00";
    return "#777";
  }

  return (
    <main
      style={{
        padding: 24,
        background: "#0a0a0a",
        color: "#fff",
        fontFamily: "monospace",
      }}
    >
      <h1 style={{ marginBottom: 20 }}>CX Switch</h1>

      {loading && <div>Loading signals...</div>}

      <div style={{ display: "grid", gap: 16 }}>
        {signals.map((s) => (
          <div
            key={s.symbol}
            style={{
              border: "1px solid #222",
              padding: 16,
              borderRadius: 8,
            }}
          >
            {/* HEADER */}
            <div style={{ fontSize: 18, marginBottom: 6 }}>
              {s.symbol} — ${s.price}
            </div>

            <div style={{ color: color(s.state), fontWeight: "bold" }}>
              {s.state}
            </div>

            {/* CORE METRICS */}
            <div>Bias: {s.bias}</div>
            <div>Confidence: {s.confidence}%</div>

            <div>RSI: {s.rsi}</div>
            <div>
              Stoch: {s.stochK ?? "—"} / {s.stochD ?? "—"}
            </div>
            <div>ADX: {s.adx}</div>

            <div style={{ marginTop: 6, opacity: 0.8 }}>
              {s.reason}
            </div>

            {/* TRADE LEVELS */}
            {s.state !== "WAIT" && (
              <div style={{ marginTop: 10, paddingTop: 10, borderTop: "1px solid #222" }}>
                <div>SL: {s.stopLoss ?? "—"}</div>
                <div>TP: {s.takeProfit ?? "—"}</div>
                <div>RR: {s.rr ?? "—"}</div>
                <div>Expected Move: {s.expectedMove}%</div>
              </div>
            )}

            {/* TIMESTAMP */}
            <div style={{ marginTop: 10, fontSize: 11, opacity: 0.5 }}>
              {s.updatedAt}
            </div>
          </div>
        ))}
      </div>
    </main>
  );
}
