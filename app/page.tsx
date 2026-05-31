"use client";

import { useEffect, useState } from "react";
import type { Signal } from "@/lib/strategy";

type EngineState = "EARLY" | "SETUP" | "SNIPER" | "NONE";

export default function Home() {
  const [signals, setSignals] = useState<(Signal & { engineState?: EngineState })[]>([]);
  const [loading, setLoading] = useState(true);
  const [lastUpdate, setLastUpdate] = useState("");

  async function fetchSignals() {
    try {
      setLoading(true);

      const res = await fetch("/api/signals");
      const data = await res.json();

      setSignals(data.signals || []);
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
      alert(data.message || "Test alert sent!");
    } catch (err) {
      alert("Failed to send test alert");
    }
  }

  useEffect(() => {
    fetchSignals();
  }, []);

  useEffect(() => {
    const interval = setInterval(fetchSignals, 30000);
    return () => clearInterval(interval);
  }, []);

  const early = signals.filter((s) => s.engineState === "EARLY");
  const setup = signals.filter((s) => s.engineState === "SETUP");
  const sniper = signals.filter((s) => s.engineState === "SNIPER");
  const none = signals.filter(
    (s) => !s.engineState || s.engineState === "NONE"
  );

  return (
    <main className="min-h-screen bg-black text-white px-6 md:px-10 py-10">
      {/* Header */}
      <div className="mb-10">
        <h1 className="text-4xl md:text-5xl font-bold tracking-tight">
          CX Switch
        </h1>
        <p className="text-gray-400 mt-2">
          Market Structure • Compression • Breakout Engine
        </p>

        <div className="flex gap-4 mt-6 items-center">
          <button
            onClick={fetchSignals}
            className="px-5 py-2 bg-white text-black rounded-lg font-semibold hover:bg-gray-200 transition"
          >
            Refresh
          </button>

          <button
            onClick={testTelegram}
            className="px-5 py-2 bg-gray-800 border border-gray-700 rounded-lg hover:bg-gray-700 transition"
          >
            Test Telegram
          </button>

          <span className="text-sm text-gray-500 ml-auto">
            Last update: {lastUpdate || "—"}
          </span>
        </div>
      </div>

      {/* 3 Column Engine View */}
      <div className="grid grid-cols-1 md:grid-cols-3 gap-6">
        <Column title="🟣 EARLY" subtitle="Compression forming" color="purple">
          {early.map((s) => (
            <SignalCard key={s.symbol} signal={s} state="EARLY" />
          ))}
        </Column>

        <Column title="🟡 SETUP" subtitle="Structure valid" color="yellow">
          {setup.map((s) => (
            <SignalCard key={s.symbol} signal={s} state="SETUP" />
          ))}
        </Column>

        <Column title="🟢 SNIPER" subtitle="Breakout active" color="green">
          {sniper.map((s) => (
            <SignalCard key={s.symbol} signal={s} state="SNIPER" />
          ))}
        </Column>
      </div>

      {/* NONE section */}
      {none.length > 0 && (
        <div className="mt-10 opacity-40">
          <h2 className="text-sm text-gray-500 mb-3">NO STRUCTURE</h2>
          <div className="grid grid-cols-1 md:grid-cols-3 gap-4">
            {none.map((s) => (
              <SignalCard key={s.symbol} signal={s} state="NONE" />
            ))}
          </div>
        </div>
      )}
    </main>
  );
}

/* =========================
   COLUMN WRAPPER
========================= */

function Column({
  title,
  subtitle,
  children,
}: {
  title: string;
  subtitle: string;
  color: string;
  children: React.ReactNode;
}) {
  return (
    <div className="border border-gray-800 rounded-xl p-4 bg-gray-950/40">
      <div className="mb-4">
        <h2 className="text-lg font-bold">{title}</h2>
        <p className="text-xs text-gray-500">{subtitle}</p>
      </div>
      <div className="space-y-4">{children}</div>
    </div>
  );
}

/* =========================
   SIGNAL CARD
========================= */

function SignalCard({
  signal,
  state,
}: {
  signal: Signal;
  state: string;
}) {
  const border =
    state === "SNIPER"
      ? "border-green-500/40"
      : state === "SETUP"
      ? "border-yellow-500/40"
      : state === "EARLY"
      ? "border-purple-500/40"
      : "border-gray-800";

  const glow =
    state === "SNIPER"
      ? "shadow-green-500/10"
      : state === "SETUP"
      ? "shadow-yellow-500/10"
      : "shadow-purple-500/10";

  return (
    <div
      className={`border ${border} ${glow} rounded-lg p-4 bg-black/40 backdrop-blur-sm`}
    >
      <div className="flex justify-between items-center mb-2">
        <h3 className="text-xl font-bold">{signal.symbol}</h3>
        <span className="text-xs text-gray-400">{state}</span>
      </div>

      <p className="text-gray-300 text-sm mb-3">
        ${signal.price?.toLocaleString?.() || "—"}
      </p>

      <div className="grid grid-cols-2 gap-2 text-xs text-gray-400">
        <div>Bias: {signal.bias}</div>
        <div>Conf: {signal.confidence}%</div>
        <div>ADX: {signal.adx?.toFixed?.(1) || "0"}</div>
        <div>K: {signal.stochK?.toFixed?.(1) || "0"}</div>
      </div>
    </div>
  );
}
