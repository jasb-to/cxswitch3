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

  useEffect(() => {
    fetchSignals();
  }, []);

  useEffect(() => {
    const interval = setInterval(fetchSignals, 60000);
    return () => clearInterval(interval);
  }, []);

  return (
    <main className="min-h-screen bg-black text-white">
      {/* CRITICAL FIX: proper centered container */}
      <div className="w-full flex justify-center">
        <div className="w-full max-w-7xl px-6 sm:px-8 lg:px-12 py-10">
          
          {/* Header */}
          <div className="mb-10">
            <h1 className="text-4xl sm:text-5xl font-bold">
              CX Switch
            </h1>
            <p className="text-gray-400 mt-2">
              Market Structure • Compression • Breakout Engine
            </p>
          </div>

          {/* Controls */}
          <div className="flex items-center gap-3 mb-8">
            <button
              onClick={fetchSignals}
              className="px-5 py-2 bg-white text-black rounded-lg font-semibold"
            >
              Refresh
            </button>

            <button className="px-5 py-2 bg-gray-800 border border-gray-700 rounded-lg">
              Test Telegram
            </button>

            <span className="ml-auto text-sm text-gray-500">
              Last update: {lastUpdate || "—"}
            </span>
          </div>

          {/* Signal Legend (your current output) */}
          <div className="grid grid-cols-1 md:grid-cols-3 gap-6">
            
            <div className="p-6 border border-gray-800 rounded-xl bg-white/5">
              <div className="text-purple-400 font-bold mb-2">
                🟣 EARLY
              </div>
              <div className="text-gray-300">
                Compression forming
              </div>
            </div>

            <div className="p-6 border border-gray-800 rounded-xl bg-white/5">
              <div className="text-yellow-400 font-bold mb-2">
                🟡 SETUP
              </div>
              <div className="text-gray-300">
                Structure valid
              </div>
            </div>

            <div className="p-6 border border-gray-800 rounded-xl bg-white/5">
              <div className="text-green-400 font-bold mb-2">
                🟢 SNIPER
              </div>
              <div className="text-gray-300">
                Breakout active
              </div>
            </div>

          </div>

        </div>
      </div>
    </main>
  );
}
