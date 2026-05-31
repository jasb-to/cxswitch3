"use client";

import { useEffect, useState } from "react";
import type { Signal } from "@/lib/strategy";

export default function Home() {
  const [signals, setSignals] = useState<Signal[]>([]);
  const [loading, setLoading] = useState(true);
  const [lastUpdate, setLastUpdate] = useState<string>("");

  async function fetchSignals() {
    try {
      setLoading(true);

      const res = await fetch("/api/signals");
      const data = await res.json();

      setSignals(data.signals || []);

      console.log(`[UI] Received ${data.signals?.length || 0} signals`);

      (data.signals || []).forEach((signal: Signal) => {
        console.log(
          `[UI] ${signal.symbol}: setup=${signal.isSetupValid}, sniper=${signal.isSniper}`
        );
      });

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
    } catch (err) {
      alert("Telegram test failed");
      console.error(err);
    }
  }

  useEffect(() => {
    fetchSignals();
  }, []);

  useEffect(() => {
    const interval = setInterval(fetchSignals, 60000);
    return () => clearInterval(interval);
  }, []);

  return (
    <main className="min-h-screen bg-black text-white">
      {/* FULL PAGE WRAPPER (fixes left edge issue) */}
      <div className="w-full px-6 sm:px-10 lg:px-16 py-10 max-w-screen-2xl mx-auto">
        
        {/* HEADER */}
        <div className="mb-10">
          <h1 className="text-4xl sm:text-5xl font-bold tracking-tight">
            CX Switch
          </h1>
          <p className="text-gray-400 mt-2">
            Market Structure • Momentum • Execution Flow
          </p>
        </div>

        {/* CONTROLS */}
        <div className="flex flex-col sm:flex-row gap-3 items-start sm:items-center mb-8">
          <button
            onClick={fetchSignals}
            disabled={loading}
            className="px-5 py-2 bg-white text-black rounded-lg font-semibold hover:bg-gray-200 transition disabled:opacity-50"
          >
            {loading ? "Scanning..." : "Refresh"}
          </button>

          <button
            onClick={testTelegram}
            className="px-5 py-2 bg-gray-800 border border-gray-700 rounded-lg hover:bg-gray-700 transition"
          >
            Test Telegram
          </button>

          <span className="text-sm text-gray-500 sm:ml-auto">
            Last update: {lastUpdate || "—"}
          </span>
        </div>

        {/* GRID (FIXED 3 COLUMNS) */}
        <div className="w-full grid grid-cols-1 md:grid-cols-3 gap-6 items-stretch">
          {signals.map((signal) => (
            <SignalCard key={signal.symbol} signal={signal} />
          ))}
        </div>
      </div>
    </main>
  );
}

/* =========================
   SIGNAL CARD
========================= */

function SignalCard({ signal }: { signal: Signal }) {
  const isSniper = signal.isSniper;
  const isSetupValid = signal.isSetupValid;

  const borderColor = isSniper
    ? "border-green-500/40"
    : isSetupValid
    ? "border-yellow-500/40"
    : "border-gray-800";

  const bg = isSniper
    ? "bg-green-500/5"
    : isSetupValid
    ? "bg-yellow-500/5"
    : "bg-gray-900/40";

  const badge = isSniper
    ? "text-green-400 border-green-500/30 bg-green-500/10"
    : isSetupValid
    ? "text-yellow-400 border-yellow-500/30 bg-yellow-500/10"
    : "text-gray-400 border-gray-700 bg-gray-800/40";

  const label = isSniper ? "SNIPER" : isSetupValid ? "SETUP" : "WAIT";

  const safe = (v: number | null | undefined) =>
    typeof v === "number" && !isNaN(v) ? v : 0;

  return (
    <div
      className={`w-full h-full border ${borderColor} ${bg} rounded-xl p-6 backdrop-blur-sm flex flex-col`}
    >
      {/* HEADER */}
      <div className="flex justify-between items-start mb-6">
        <div>
          <h2 className="text-2xl font-bold">{signal.symbol}</h2>
          <p className="text-gray-400 text-sm">
            ${signal.price?.toFixed(2)}
          </p>
        </div>

        <div className={`px-3 py-1 rounded-lg border text-xs ${badge}`}>
          {label}
        </div>
      </div>

      {/* METRICS */}
      <div className="grid grid-cols-2 gap-3 mb-5">
        <Metric label="Bias" value={signal.bias} />
        <Metric label="Confidence" value={`${signal.confidence}%`} />
      </div>

      {/* INDICATORS */}
      <div className="space-y-2 text-sm mb-5">
        <Row label="ADX" value={safe(signal.adx).toFixed(1)} />
        <Row label="Stoch K" value={safe(signal.stochK).toFixed(1)} />
        <Row label="Stoch D" value={safe(signal.stochD).toFixed(1)} />
      </div>

      {/* RISK */}
      <div className="mt-auto pt-4 border-t border-gray-800 space-y-2 text-sm">
        <Row
          label="SL"
          value={signal.stopLoss ? signal.stopLoss.toFixed(2) : "—"}
        />
        <Row
          label="TP"
          value={signal.takeProfit ? signal.takeProfit.toFixed(2) : "—"}
        />
        <Row
          label="R/R"
          value={
            signal.riskRewardRatio ? `${signal.riskRewardRatio}:1` : "—"
          }
        />
      </div>
    </div>
  );
}

/* =========================
   SMALL UI COMPONENTS
========================= */

function Metric({ label, value }: { label: string; value: string }) {
  return (
    <div className="bg-black/30 border border-gray-800 rounded-lg p-3">
      <p className="text-xs text-gray-500">{label}</p>
      <p className="font-mono text-white">{value}</p>
    </div>
  );
}

function Row({ label, value }: { label: string; value: string }) {
  return (
    <div className="flex justify-between">
      <span className="text-gray-500">{label}</span>
      <span className="font-mono text-white">{value}</span>
    </div>
  );
}
