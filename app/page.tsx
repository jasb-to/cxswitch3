"use client";

import { useEffect, useState } from "react";

export default function Home() {
  const [signals, setSignals] = useState([]);

  useEffect(() => {
    fetch("/api/signals")
      .then((r) => r.json())
      .then((data) => setSignals(data.signals || []));
  }, []);

  return (
    <main>
      {signals
        .filter(
          (signal) =>
            signal &&
            typeof signal.price === "number" &&
            typeof signal.adx === "number"
        )
        .map((signal) => {
          const state = signal.isSniper
            ? "SNIPER"
            : signal.isEarly
            ? "EARLY"
            : "WAIT";

          return (
            <div key={signal.symbol}>
              <h2>{signal.symbol}</h2>
              <p>{signal.price}</p>
            </div>
          );
        })}
    </main>
  );
}
