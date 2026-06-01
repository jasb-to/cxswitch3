"use client";

import { useEffect, useState } from "react";
import type { Signal } from "@/lib/strategy";

export default function Home() {
  const [signals, setSignals] = useState<Signal[]>([]);
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
      const res = await fetch("/api/telegram/test", {
        method: "POST",
      });

      const data = await res.json();

      alert(data.message || "Telegram test sent");
    } catch (err) {
      console.error(err);
      alert("Failed to send Telegram test");
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
      <div className="mx-auto max-w-7xl px-8 md:px-12 lg:px-16 py-10">

        {/* Header */}
        <div className="mb-10">
          <h1 className="text-5xl font-bold">CX Switch</h1>

          <p className="text-gray-400 mt-2">
            Market Structure • Compression • Breakout Engine
          </p>
        </div>

        {/* Controls */}
        <div className="flex flex-wrap items-center gap-3 mb-8">
          <button
            onClick={fetchSignals}
            disabled={loading}
            className="px-5 py-2 rounded-lg bg-white text-black font-semibold"
          >
            {loading ? "Refreshing..." : "Refresh"}
          </button>

          <button
            onClick={testTelegram}
            className="px-5 py-2 rounded-lg border border-gray-700 bg-gray-900"
          >
            Test Telegram
          </button>

          <span className="ml-auto text-sm text-gray-500">
            Last update: {lastUpdate || "—"}
          </span>
        </div>

        {/* Legend */}
        <div className="grid grid-cols-1 md:grid-cols-3 gap-4 mb-10">
          <div className="rounded-xl border border-purple-500/20 bg-purple-500/5 p-5">
            <div className="text-purple-400 font-bold mb-1">
              🟣 EARLY
            </div>
            <div className="text-sm text-gray-400">
              Compression forming
            </div>
          </div>

          <div className="rounded-xl border border-yellow-500/20 bg-yellow-500/5 p-5">
            <div className="text-yellow-400 font-bold mb-1">
              🟡 SETUP
            </div>
            <div className="text-sm text-gray-400">
              Structure valid
            </div>
          </div>

          <div className="rounded-xl border border-green-500/20 bg-green-500/5 p-5">
            <div className="text-green-400 font-bold mb-1">
              🟢 SNIPER
            </div>
            <div className="text-sm text-gray-400">
              Breakout active
            </div>
          </div>
        </div>

        {/* Live Signals */}
        <div className="grid grid-cols-1 md:grid-cols-2 xl:grid-cols-3 gap-6">

          {signals.map((signal) => {
            // ✅ FIXED: use correct backend fields only
            const state = signal.isSniper
              ? "SNIPER"
              : signal.isEarly
              ? "EARLY"
              : "WAIT";

            const stateColor = signal.isSniper
              ? "text-green-400 bg-green-500/10 border-green-500/20"
              : signal.isEarly
              ? "text-purple-400 bg-purple-500/10 border-purple-500/20"
              : "text-gray-400 bg-gray-800 border-gray-700";

            return (
              <div
                key={signal.symbol}
                className="rounded-2xl border border-gray-800 bg-white/[0.03] p-6"
              >
                <div className="flex items-center justify-between mb-5">
                  <div>
                    <h2 className="text-3xl font-bold">
                      {signal.symbol}
                    </h2>

                    <p className="text-gray-400 mt-1">
                      ${signal.price.toLocaleString()}
                    </p>
                  </div>

                  <div
                    className={`px-3 py-1 rounded-lg border text-sm font-semibold ${stateColor}`}
                  >
                    {state}
                  </div>
                </div>

                <div className="grid grid-cols-2 gap-4 mb-5">
                  <Metric label="Bias" value={signal.bias} />
                  <Metric label="Confidence" value={`${signal.confidence}%`} />
                </div>

                <div className="border-t border-gray-800 pt-4 space-y-3">
                  <Row label="ADX" value={signal.adx.toFixed(1)} />
                  <Row label="Stoch K" value={signal.stochK.toFixed(1)} />
                  <Row label="Stoch D" value={signal.stochD.toFixed(1)} />
                </div>

                <div className="border-t border-gray-800 mt-4 pt-4 space-y-3">
                  <Row
                    label="SL"
                    value={
                      signal.stopLoss
                        ? `$${signal.stopLoss.toFixed(2)}`
                        : "—"
                    }
                  />

                  <Row
                    label="TP"
                    value={
                      signal.takeProfit
                        ? `$${signal.takeProfit.toFixed(2)}`
                        : "—"
                    }
                  />

                  <Row
                    label="R/R"
                    value={
                      signal.riskRewardRatio
                        ? signal.riskRewardRatio.toFixed(1)
                        : "—"
                    }
                  />
                </div>

                <div className="border-t border-gray-800 mt-4 pt-4">
                  <p className="text-xs text-gray-500">
                    {signal.reason}
                  </p>
                </div>
              </div>
            );
          })}

        </div>
      </div>
    </main>
  );
}

function Metric({
  label,
  value,
}: {
  label: string;
  value: string;
}) {
  return (
    <div>
      <p className="text-xs text-gray-500 mb-1">{label}</p>
      <p className="font-semibold">{value}</p>
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
    <div className="flex items-center justify-between text-sm">
      <span className="text-gray-500">{label}</span>
      <span className="font-mono">{value}</span>
    </div>
  );
}
