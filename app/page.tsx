"use client";

import { useEffect, useState } from "react";
import type { Signal } from "@/lib/persistence";

export default function Home() {
  const [signals, setSignals] = useState<Signal[]>([]);
  const [loading, setLoading] = useState(false);
  const [lastUpdate, setLastUpdate] = useState<string>("");

  async function fetchSignals() {
    try {
      setLoading(true);

      const res = await fetch("/api/signals", {
        cache: "no-store",
      });

      const data = await res.json();

      const safeSignals = Array.isArray(data?.signals)
        ? data.signals.filter((s: any) => s?.symbol && typeof s?.price === "number")
        : [];

      setSignals(safeSignals);
      setLastUpdate(new Date().toLocaleTimeString());
    } catch (err) {
      console.error("Failed to fetch signals:", err);
      setSignals([]);
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
      alert(data?.message || "Telegram test sent");
    } catch (err) {
      console.error(err);
      alert("Failed to send Telegram test");
    }
  }

  useEffect(() => {
    fetchSignals();
  }, []);

  useEffect(() => {
    const interval = setInterval(fetchSignals, 30000);
    return () => clearInterval(interval);
  }, []);

  return (
    <main className="min-h-screen bg-black text-white px-6 md:px-12 lg:px-16">
      <div className="max-w-7xl mx-auto py-10">

        {/* HEADER */}
        <div className="mb-8">
          <h1 className="text-4xl font-bold">CX Switch</h1>
          <p className="text-gray-400 mt-1">
            Market Structure • Compression • Breakout Engine
          </p>
        </div>

        {/* CONTROLS */}
        <div className="flex items-center gap-3 mb-8">
          <button
            onClick={fetchSignals}
            className="px-4 py-2 rounded bg-white text-black font-semibold"
          >
            {loading ? "Loading..." : "Refresh"}
          </button>

          <button
            onClick={testTelegram}
            className="px-4 py-2 rounded border border-gray-700"
          >
            Test Telegram
          </button>

          <div className="ml-auto text-sm text-gray-500">
            Last update: {lastUpdate || "—"}
          </div>
        </div>

        {/* LEGEND */}
        <div className="grid grid-cols-1 md:grid-cols-3 gap-4 mb-10">
          <Legend title="🟣 EARLY" desc="Compression forming" color="purple" />
          <Legend title="🟡 SETUP" desc="Structure valid" color="yellow" />
          <Legend title="🟢 SNIPER" desc="Breakout active" color="green" />
        </div>

        {/* SIGNALS */}
        <div className="grid grid-cols-1 md:grid-cols-2 xl:grid-cols-3 gap-6">
          {signals.map((signal) => {
            const state = signal.isSniper
              ? "SNIPER"
              : signal.isEarly
              ? "EARLY"
              : "WAIT";

            const color =
              state === "SNIPER"
                ? "border-green-500/30 text-green-400"
                : state === "EARLY"
                ? "border-purple-500/30 text-purple-400"
                : "border-gray-800 text-gray-400";

            return (
              <div
                key={signal.symbol}
                className="rounded-xl border bg-white/5 p-5"
              >
                {/* TOP */}
                <div className="flex justify-between mb-4">
                  <div>
                    <div className="text-2xl font-bold">
                      {signal.symbol}
                    </div>

                    <div className="text-gray-400">
                      ${Number(signal.price || 0).toLocaleString()}
                    </div>
                  </div>

                  <div className={`px-3 py-1 border rounded ${color}`}>
                    {state}
                  </div>
                </div>

                {/* META */}
                <div className="grid grid-cols-2 gap-3 text-sm mb-4">
                  <Meta label="Bias" value={signal.bias} />
                  <Meta label="Confidence" value={`${signal.confidence}%`} />
                </div>

                {/* INDICATORS */}
                <div className="border-t border-gray-800 pt-3 space-y-2 text-sm">
                  <Row label="ADX" value={signal.adx?.toFixed?.(1) ?? "0"} />
                  <Row label="Stoch K" value={signal.stochK?.toFixed?.(1) ?? "0"} />
                  <Row label="Stoch D" value={signal.stochD?.toFixed?.(1) ?? "0"} />
                </div>

                {/* RISK */}
                <div className="border-t border-gray-800 mt-3 pt-3 space-y-2 text-sm">
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
                        ? signal.riskRewardRatio.toFixed(2)
                        : "—"
                    }
                  />
                </div>

                {/* REASON */}
                <div className="mt-3 text-xs text-gray-500">
                  {signal.reason || "—"}
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

function Meta({
  label,
  value,
}: {
  label: string;
  value: string;
}) {
  return (
    <div>
      <div className="text-gray-500 text-xs">{label}</div>
      <div className="font-semibold">{value}</div>
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

function Legend({
  title,
  desc,
}: {
  title: string;
  desc: string;
  color: string;
}) {
  return (
    <div className="p-4 rounded-xl border border-gray-800 bg-white/5">
      <div className="font-bold">{title}</div>
      <div className="text-gray-400 text-sm">{desc}</div>
    </div>
  );
}
