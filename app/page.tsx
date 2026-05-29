"use client";

import { useEffect, useState } from "react";

interface Signal {
  symbol: string;
  price: number;
  bias4H: string;
  bias1H: string;
  setup: "LONG" | "SHORT" | null;
  strength: string;
  emaCross: string;
  stochRSI: number;
  stochDirection: string;
  momentum: string;
  trigger: string;
  entry?: number;
  stopLoss?: number;
  takeProfit?: number;
  updatedAt: string;
}

// Defensive fallbacks
function safe(value: any, fallback: any) {
  return value !== undefined && value !== null ? value : fallback;
}

function getStochLabel(stochRSI: number) {
  if (stochRSI < 20) return "Oversold";
  if (stochRSI > 65) return "Overbought";
  return "Neutral";
}

function getStrengthGrade(strength: string) {
  const s = safe(strength, "D");
  const map: Record<string, string> = { "A+": "A+", A: "A", B: "B", C: "C", D: "D" };
  return map[s] || "D";
}

function formatPrice(n?: number) {
  if (!n) return "—";
  return n.toLocaleString(undefined, { style: "currency", currency: "USD" });
}

function SignalCard({ signal }: { signal: Signal }) {
  const bias4H = safe(signal.bias4H, "Neutral");
  const bias1H = safe(signal.bias1H, "Neutral");
  const emaCross = safe(signal.emaCross, "None");
  const stochRSI = safe(signal.stochRSI, 50);
  const stochDirection = safe(signal.stochDirection, "neutral");
  const momentum = safe(signal.momentum, "Flat");
  const strength = getStrengthGrade(signal.strength);

  const isActive = signal.setup === "LONG" || signal.setup === "SHORT";
  const isMuted = !isActive;

  const biasColor = (bias: string) => {
    if (bias === "Bullish") return "text-green-400";
    if (bias === "Bearish") return "text-red-400";
    return "text-gray-400";
  };

  const emaCrossColor = (cross: string) => {
    if (cross === "Bullish Cross") return "text-green-400";
    if (cross === "Bearish Cross") return "text-red-400";
    return "text-gray-400";
  };

  const stochColor = (stoch: number) => {
    if (stoch < 20) return "text-blue-400";
    if (stoch > 65) return "text-orange-400";
    return "text-gray-400";
  };

  const borderStyle = 
    signal.setup === "LONG" ? "border border-green-500/50 shadow-lg shadow-green-500/20" :
    signal.setup === "SHORT" ? "border border-red-500/50 shadow-lg shadow-red-500/20" :
    "border border-zinc-800";

  return (
    <div
      className={`rounded-xl p-6 transition-all duration-300 ${
        isActive ? "bg-zinc-900/80" : "bg-zinc-950/40"
      } ${borderStyle} ${isMuted ? "opacity-60" : ""}`}
    >
      {/* TOP SECTION */}
      <div className="flex items-start justify-between mb-5">
        <div>
          <h2 className="text-4xl font-bold text-white tracking-tight">{signal.symbol}</h2>
          <p className="text-2xl font-mono text-white/80 mt-1">{formatPrice(signal.price)}</p>
        </div>
        <div className="text-right">
          <div className={`inline-block px-3 py-1 rounded-full text-xs font-bold ${
            signal.change24h > 0 ? "bg-green-500/20 text-green-400" :
            signal.change24h < 0 ? "bg-red-500/20 text-red-400" :
            "bg-gray-500/20 text-gray-400"
          }`}>
            {signal.change24h > 0 ? "+" : ""}{signal.change24h.toFixed(2)}%
          </div>
          <div className={`mt-3 px-3 py-2 rounded-lg text-sm font-bold ${
            signal.setup === "LONG" ? "bg-green-500 text-black" :
            signal.setup === "SHORT" ? "bg-red-500 text-white" :
            "bg-gray-700 text-gray-300"
          }`}>
            {signal.setup || "WAIT"}
          </div>
        </div>
      </div>

      {/* MIDDLE SECTION - STRUCTURED INTELLIGENCE */}
      <div className="space-y-3 mb-5 border-t border-zinc-800 pt-5">
        <div className="flex justify-between items-center text-sm">
          <span className="text-gray-600">4H Trend</span>
          <span className={`font-bold ${biasColor(bias4H)}`}>{bias4H}</span>
        </div>
        <div className="flex justify-between items-center text-sm">
          <span className="text-gray-600">1H Confirmation</span>
          <span className={`font-bold ${biasColor(bias1H)}`}>{bias1H}</span>
        </div>
        <div className="flex justify-between items-center text-sm">
          <span className="text-gray-600">EMA Cross (15m)</span>
          <span className={`font-bold ${emaCrossColor(emaCross)}`}>{emaCross}</span>
        </div>
        <div className="flex justify-between items-center text-sm">
          <span className="text-gray-600">StochRSI</span>
          <span className={`font-mono font-bold ${stochColor(stochRSI)}`}>
            {stochRSI} <span className="text-xs text-gray-500">({getStochLabel(stochRSI)})</span>
          </span>
        </div>
      </div>

      {/* MOMENTUM STRIP */}
      <div className="flex gap-4 mb-5 border-t border-zinc-800 pt-5">
        <div className="flex-1">
          <p className="text-xs text-gray-600 mb-1">Momentum</p>
          <p className="text-sm font-bold text-white">{momentum}</p>
        </div>
        <div className="flex-1">
          <p className="text-xs text-gray-600 mb-1">Strength</p>
          <p className={`text-sm font-bold ${
            strength === "A+" ? "text-green-400" :
            strength === "A" ? "text-emerald-400" :
            strength === "B" ? "text-yellow-400" :
            "text-gray-400"
          }`}>{strength}</p>
        </div>
      </div>

      {/* BOTTOM CTA AREA */}
      {signal.setup ? (
        <div className="border-t border-zinc-800 pt-5 space-y-2">
          <div className="text-xs font-bold text-gray-500 uppercase tracking-widest">Entry Active</div>
          <div className="space-y-1.5 text-sm">
            <div className="flex justify-between">
              <span className="text-gray-600">Entry</span>
              <span className="font-mono text-white">{formatPrice(signal.entry)}</span>
            </div>
            <div className="flex justify-between">
              <span className="text-gray-600">SL</span>
              <span className="font-mono text-red-400">{formatPrice(signal.stopLoss)}</span>
            </div>
            <div className="flex justify-between">
              <span className="text-gray-600">TP</span>
              <span className="font-mono text-green-400">{formatPrice(signal.takeProfit)}</span>
            </div>
          </div>
        </div>
      ) : (
        <div className="border-t border-zinc-800 pt-5">
          <p className="text-xs text-gray-600">Waiting for setup...</p>
        </div>
      )}
    </div>
  );
}

export default function Home() {
  const [signals, setSignals] = useState<Signal[]>([]);

  async function load() {
    const res = await fetch("/api/signals", { cache: "no-store" });
    const data = await res.json();
    setSignals(data.signals || []);
  }

  useEffect(() => {
    load();
    const t = setInterval(load, 60000);
    return () => clearInterval(t);
  }, []);

  return (
    <main className="min-h-screen bg-black text-white">
      <div className="px-8 py-12">
        <div className="max-w-7xl mx-auto">
          <div className="mb-12">
            <h1 className="text-5xl font-bold tracking-tight">Switch Signals</h1>
            <p className="text-gray-400 mt-2">Real-time multi-timeframe trading signals</p>
          </div>

          <div className="grid md:grid-cols-3 gap-8">
            {signals.map((s) => (
              <SignalCard key={s.symbol} signal={s} />
            ))}
          </div>
        </div>
      </div>
    </main>
  );
}
