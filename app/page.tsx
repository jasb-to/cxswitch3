"use client";

import { useEffect, useState } from "react";
import type { Signal } from "@/lib/strategy";

type UIState = "SNIPER" | "SETUP" | "EARLY" | "NONE";

export default function Home() {
  const [signals, setSignals] = useState<Signal[]>([]);
  const [loading, setLoading] = useState(true);
  const [lastUpdate, setLastUpdate] = useState("");

  async function fetchSignals() {
    try {
      setLoading(true);

      const res = await fetch("/api/signals");
      const data = await res.json();

      const safeSignals = data.signals || [];
      setSignals(safeSignals);

      console.log(`[UI] Signals received: ${safeSignals.length}`);

      setLastUpdate(new Date().toLocaleTimeString());
    } catch (err) {
      console.error("Failed to fetch signals:", err);
    } finally {
      setLoading(false);
    }
  }

  async function testTelegram() {
    try {
      const res = await fetch("/api/telegram/test", { method: "POST" });
      const data = await res.json();
      alert(data.message || "Test sent");
    } catch {
      alert("Telegram test failed");
    }
  }

  useEffect(() => {
    fetchSignals();
  }, []);

  useEffect(() => {
    const i = setInterval(fetchSignals, 60000);
    return () => clearInterval(i);
  }, []);

  return (
    <main className="min-h-screen bg-black text-white">
      <div className="max-w-6xl mx-auto px-6 py-10">
        {/* HEADER */}
        <div className="mb-10">
          <h1 className="text-4xl font-bold">CX Switch</h1>
          <p className="text-gray-400 mt-1">
            Early Entry Radar • Structure → Momentum → Trigger
          </p>
        </div>

        {/* CONTROLS */}
        <div className="flex gap-3 mb-8 items-center">
          <button
            onClick={fetchSignals}
            disabled={loading}
            className="px-5 py-2 bg-white text-black font-semibold rounded-lg"
          >
            {loading ? "Scanning..." : "Scan"}
          </button>

          <button
            onClick={testTelegram}
            className="px-5 py-2 bg-gray-800 rounded-lg border border-gray-700"
          >
            Test
          </button>

          <span className="text-xs text-gray-500 ml-auto">
            {lastUpdate || "—"}
          </span>
        </div>

        {/* GRID */}
        <div className="grid md:grid-cols-2 lg:grid-cols-3 gap-5">
          {signals.map((s) => (
            <SignalCard key={s.symbol} signal={s} />
          ))}
        </div>
      </div>
    </main>
  );
}

/* =========================
   CARD
========================= */

function SignalCard({ signal }: { signal: Signal }) {
  const state: UIState = signal.isSniper
    ? "SNIPER"
    : signal.isSetupValid
    ? "SETUP"
    : signal.adx > 12
    ? "EARLY"
    : "NONE";

  const colors =
    state === "SNIPER"
      ? "border-green-500/40 bg-green-500/5"
      : state === "SETUP"
      ? "border-yellow-500/40 bg-yellow-500/5"
      : state === "EARLY"
      ? "border-blue-500/40 bg-blue-500/5"
      : "border-gray-800 bg-gray-900/30";

  const badge =
    state === "SNIPER"
      ? "🟢 SNIPER"
      : state === "SETUP"
      ? "🟡 SETUP"
      : state === "EARLY"
      ? "🔵 EARLY"
      : "⚪ WAIT";

  const safe = (n: any) => (typeof n === "number" && isFinite(n) ? n : 0);

  return (
    <div className={`border rounded-xl p-5 ${colors}`}>
      {/* HEADER */}
      <div className="flex justify-between mb-4">
        <div>
          <h2 className="text-2xl font-bold">{signal.symbol}</h2>
          <p className="text-gray-400 text-sm">
            ${safe(signal.price).toFixed(2)}
          </p>
        </div>

        <div className="text-xs px-3 py-1 border border-gray-700 rounded-lg">
          {badge}
        </div>
      </div>

      {/* CORE METRICS */}
      <div className="space-y-2 text-sm mb-4">
        <Row label="Bias" value={signal.bias} />
        <Row label="Confidence" value={`${safe(signal.confidence)}%`} />
        <Row label="ADX" value={safe(signal.adx).toFixed(1)} />
        <Row label="Stoch" value={safe(signal.stochK).toFixed(1)} />
      </div>

      {/* RISK */}
      <div className="border-t border-gray-800 pt-3 text-xs space-y-1">
        <Row
          label="SL"
          value={
            signal.stopLoss != null ? signal.stopLoss.toFixed(2) : "—"
          }
        />
        <Row
          label="TP"
          value={
            signal.takeProfit != null ? signal.takeProfit.toFixed(2) : "—"
          }
        />
        <Row
          label="R/R"
          value={
            signal.riskRewardRatio != null
              ? signal.riskRewardRatio.toFixed(2)
              : "—"
          }
        />
      </div>

      {/* REASON */}
      <p className="text-xs text-gray-400 mt-3">{signal.reason}</p>
    </div>
  );
}

/* =========================
   ROW
========================= */

function Row({
  label,
  value,
}: {
  label: string;
  value: string;
}) {
  return (
    <div className="flex justify-between">
      <span className="text-gray-500">{label}</span>
      <span className="font-mono">{value}</span>
    </div>
  );
}
