"use client";

import { useEffect, useState } from "react";

export default function Home() {
  const [signals, setSignals] = useState<any[]>([]);
  const [loading, setLoading] = useState(true);

  async function fetchSignals() {
    try {
      setLoading(true);

      const res = await fetch("/api/signals");
      const data = await res.json();

      console.log("📡 RAW API RESPONSE:", data);

      setSignals(data.signals || []);
    } catch (err) {
      console.error("FETCH ERROR:", err);
    } finally {
      setLoading(false);
    }
  }

  useEffect(() => {
    fetchSignals();
  }, []);

  return (
    <main style={{ padding: 20, background: "#000", color: "#fff" }}>
      <h1>CX Switch DEBUG</h1>

      <button onClick={fetchSignals}>
        Refresh
      </button>

      <pre style={{ marginTop: 20, color: "lime" }}>
        {JSON.stringify(signals, null, 2)}
      </pre>

      <hr />

      <h2>Rendered Cards</h2>

      {signals?.map((s, i) => (
        <div
          key={i}
          style={{
            border: "1px solid #333",
            marginTop: 10,
            padding: 10,
          }}
        >
          <div>{s.symbol}</div>
          <div>Price: {s.price}</div>
          <div>State: {s.state}</div>
          <div>Bias: {s.bias}</div>
          <div>Confidence: {s.confidence}</div>
        </div>
      ))}
    </main>
  );
}
