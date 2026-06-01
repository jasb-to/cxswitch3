"use client";

import { useEffect, useState } from "react";
import type { Signal } from "@/lib/strategy";

export default function Home() {
  const [signals, setSignals] = useState<Signal[]>([]);
  const [loading, setLoading] = useState(false);
  const [lastUpdate, setLastUpdate] = useState("");

  async function fetchSignals() {
    try {
      setLoading(true);

      const res = await fetch("/api/signals");
      const data = await res.json();

      setSignals(data.signals || []);
      setLastUpdate(new Date().toLocaleTimeString());
    } catch (err) {
      console.error(err);
    } finally {
      setLoading(false);
    }
  }

  async function testTelegram() {
    try {
      await fetch("/api/telegram/test", { method: "POST" });
      alert("Test sent");
    } catch {
      alert("Failed");
    }
  }

  useEffect(() => {
    fetchSignals();
    const i = setInterval(fetchSignals, 60000);
    return () => clearInterval(i);
  }, []);

  return (
    <main className="min-h-screen bg-[#0b0f14] text-white">
      {/* FIXED CONTAINER (no left padding drift) */}
      <div className="mx-auto w-full max-w-[1400px] px-6 lg:px-8 py-8">

        {/* HEADER */}
        <div className="mb-8">
          <h1 className="text-3xl font-semibold tracking-wide">
            CX Switch
          </h1>

          <p className="text-sm text-gray-400 mt-1">
            Market Structure • Liquidity • Breakout Engine
          </p>
        </div>

        {/* CONTROLS */}
        <div className="flex items-center gap-3 mb-8">
          <button
            onClick={fetchSignals}
            className="px-4 py-2 rounded-md bg-white text-black text-sm font-medium hover:opacity-90"
          >
            {loading ? "Refreshing..." : "Refresh"}
          </button>

          <button
            onClick={testTelegram}
            className="px-4 py-2 rounded-md bg-[#1a1f2a] border border-gray-700 text-sm"
          >
            Test Telegram
          </button>

          <div className="ml-auto text-xs text-gray-500">
            Last update: {lastUpdate || "—"}
          </div>
        </div>

        {/* SIGNAL GRID */}
        <div className="grid grid-cols-1 md:grid-cols-2 xl:grid-cols-3 gap-5">

          {signals.map((s) => {
            const state = s.isSniper
              ? "SNIPER"
              : s.isEarly
              ? "EARLY"
              : "WAIT";

            const stateColor =
              state === "SNIPER"
                ? "text-green-400 border-green-500/30 bg-green-500/10"
                : state === "EARLY"
                ? "text-purple-400 border-purple-500/30 bg-purple-500/10"
                : "text-gray-400 border-gray-700 bg-gray-800/30";

            return (
              <div
                key={s.symbol}
                className="rounded-xl border border-gray-800 bg-[#0f141b] p-5"
              >
                {/* TOP ROW */}
                <div className="flex justify-between items-start mb-4">
                  <div>
                    <div className="text-xl font-semibold">
                      {s.symbol}
                    </div>
                    <div className="text-sm text-gray-400">
                      ${s.price.toLocaleString()}
                    </div>
                  </div>

                  <div
                    className={`px-2 py-1 text-xs rounded-md border ${stateColor}`}
                  >
                    {state}
                  </div>
                </div>

                {/* CORE METRICS */}
                <div className="grid grid-cols-2 gap-3 text-sm mb-4">
                  <Metric label="Bias" value={s.bias} />
                  <Metric label="Confidence" value={`${s.confidence}%`} />
                </div>

                {/* INDICATORS */}
                <div className="border-t border-gray-800 pt-3 space-y-2 text-sm">
                  <Row label="ADX" value={s.adx.toFixed(1)} />
                  <Row label="Stoch K" value={s.stochK.toFixed(1)} />
                  <Row label="Stoch D" value={s.stochD.toFixed(1)} />
                </div>

                {/* RISK */}
                <div className="border-t border-gray-800 pt-3 mt-3 space-y-2 text-sm">
                  <Row
                    label="SL"
                    value={s.stopLoss ? `$${s.stopLoss.toFixed(2)}` : "—"}
                  />
                  <Row
                    label="TP"
                    value={s.takeProfit ? `$${s.takeProfit.toFixed(2)}` : "—"}
                  />
                  <Row
                    label="R/R"
                    value={s.riskRewardRatio?.toFixed(2) || "—"}
                  />
                </div>

                {/* REASON */}
                <div className="mt-4 text-xs text-gray-500 border-t border-gray-800 pt-3">
                  {s.reason}
                </div>
              </div>
            );
          })}

        </div>
      </div>
    </main>
  );
}

/* ========================= */

function Metric({
  label,
  value,
}: {
  label: string;
  value: string;
}) {
  return (
    <div>
      <div className="text-xs text-gray-500">{label}</div>
      <div className="font-medium">{value}</div>
    </div>
  );
}

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
