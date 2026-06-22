"use client";

import React, { useState, useEffect, useMemo } from "react";
import { LineChart, Line, XAxis, YAxis, CartesianGrid, Tooltip, ResponsiveContainer, ReferenceLine } from "recharts";

// ─── Types ─────────────────────────────────────────────────────────────

type Position = "LONG" | "SHORT" | "NONE";

interface Signal {
  id: string;
  ticker: string;
  timeframe: string;
  position: Position;
  entryPrice: number;
  targetPrice: number;
  stopLoss: number;
  timestamp: number;      // when signal was generated
  ttl: number;            // time-to-live in ms (e.g. 4h = 14400000)
  entryBuffer: number;    // price buffer % for valid entry (e.g. 0.01 = 1%)
  status: "ACTIVE" | "EXPIRED" | "STOPPED" | "TARGET_HIT" | "PENDING_ENTRY";
  stochK?: number;
  stochD?: number;
  macdHist?: number;
  ema8?: number;
  ema21?: number;
}

interface PriceData {
  time: string;
  price: number;
  ema8?: number;
  ema21?: number;
}

// ─── Mock Data & Helpers ───────────────────────────────────────────────

const MOCK_SIGNALS: Signal[] = [
  {
    id: "sol-4h-001",
    ticker: "SOL",
    timeframe: "4H",
    position: "SHORT",
    entryPrice: 142.50,
    targetPrice: 128.00,
    stopLoss: 148.00,
    timestamp: Date.now() - 1000 * 60 * 60 * 2, // 2h ago
    ttl: 1000 * 60 * 60 * 4, // 4h TTL
    entryBuffer: 0.015,
    status: "ACTIVE",
    stochK: 3.00,
    stochD: 23.48,
    macdHist: -0.45,
    ema8: 141.20,
    ema21: 145.80,
  },
  {
    id: "btc-4h-001",
    ticker: "BTC",
    timeframe: "4H",
    position: "SHORT",
    entryPrice: 67500,
    targetPrice: 64500,
    stopLoss: 69200,
    timestamp: Date.now() - 1000 * 60 * 60 * 5, // 5h ago
    ttl: 1000 * 60 * 60 * 4, // 4h TTL
    entryBuffer: 0.01,
    status: "ACTIVE",
    stochK: 70.13,
    stochD: 84.85,
    macdHist: -120,
    ema8: 67300,
    ema21: 67800,
  },
];

function generateMockPriceData(basePrice: number, points: number = 50): PriceData[] {
  const data: PriceData[] = [];
  let price = basePrice;
  for (let i = 0; i < points; i++) {
    price = price * (1 + (Math.random() - 0.48) * 0.008);
    data.push({
      time: new Date(Date.now() - (points - i) * 5 * 60 * 1000).toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" }),
      price: Number(price.toFixed(2)),
      ema8: Number((price * 0.995).toFixed(2)),
      ema21: Number((price * 1.005).toFixed(2)),
    });
  }
  return data;
}

// ─── Components ────────────────────────────────────────────────────────

function SignalCard({ signal, currentPrice }: { signal: Signal; currentPrice: number }) {
  const [now, setNow] = useState(Date.now());

  useEffect(() => {
    const timer = setInterval(() => setNow(Date.now()), 1000);
    return () => clearInterval(timer);
  }, []);

  // ─── FIXED: Correct TTL & Entry Buffer Logic ──────────────────────

  const timeSinceSignal = now - signal.timestamp;
  const ttlRemaining = signal.ttl - timeSinceSignal;
  const isTtlExpired = ttlRemaining <= 0;

  // Entry buffer: price must be within buffer% of entryPrice to be "entered"
  const entryBufferMin = signal.entryPrice * (1 - signal.entryBuffer);
  const entryBufferMax = signal.entryPrice * (1 + signal.entryBuffer);
  const isWithinEntryBuffer = currentPrice >= entryBufferMin && currentPrice <= entryBufferMax;

  // Determine TRUE status (not the stored status which may be stale)
  let trueStatus = signal.status;

  if (signal.position === "SHORT") {
    if (currentPrice <= signal.targetPrice) trueStatus = "TARGET_HIT";
    else if (currentPrice >= signal.stopLoss) trueStatus = "STOPPED";
    else if (isTtlExpired && !isWithinEntryBuffer) trueStatus = "EXPIRED";
    else if (!isWithinEntryBuffer && timeSinceSignal > 1000 * 60 * 30) trueStatus = "PENDING_ENTRY";
    else trueStatus = "ACTIVE";
  } else {
    // LONG logic
    if (currentPrice >= signal.targetPrice) trueStatus = "TARGET_HIT";
    else if (currentPrice <= signal.stopLoss) trueStatus = "STOPPED";
    else if (isTtlExpired && !isWithinEntryBuffer) trueStatus = "EXPIRED";
    else if (!isWithinEntryBuffer && timeSinceSignal > 1000 * 60 * 30) trueStatus = "PENDING_ENTRY";
    else trueStatus = "ACTIVE";
  }

  // ─── P&L Calculation ──────────────────────────────────────────────

  const pnl = signal.position === "SHORT"
    ? ((signal.entryPrice - currentPrice) / signal.entryPrice) * 100
    : ((currentPrice - signal.entryPrice) / signal.entryPrice) * 100;

  const pnlColor = pnl >= 0 ? "text-emerald-400" : "text-rose-400";
  const statusColors: Record<string, string> = {
    ACTIVE: "bg-emerald-500/20 text-emerald-400 border-emerald-500/30",
    PENDING_ENTRY: "bg-amber-500/20 text-amber-400 border-amber-500/30",
    EXPIRED: "bg-slate-500/20 text-slate-400 border-slate-500/30",
    STOPPED: "bg-rose-500/20 text-rose-400 border-rose-500/30",
    TARGET_HIT: "bg-cyan-500/20 text-cyan-400 border-cyan-500/30",
  };

  // ─── Exit Rules Display ───────────────────────────────────────────

  const exitRules = useMemo(() => {
    const rules: string[] = [];
    if (signal.position === "SHORT") {
      rules.push(`K > 80 (overbought pullback)`);
      rules.push(`K crosses above D (momentum shift)`);
      rules.push(`8/21 EMA bullish cross`);
    } else {
      rules.push(`K < 20 (oversold pullback)`);
      rules.push(`K crosses below D (momentum shift)`);
      rules.push(`8/21 EMA bearish cross`);
    }
    return rules;
  }, [signal.position]);

  return (
    <div className="bg-slate-900/80 border border-slate-700/50 rounded-xl p-5 space-y-4 backdrop-blur-sm">
      {/* Header */}
      <div className="flex items-center justify-between">
        <div className="flex items-center gap-3">
          <span className="text-2xl font-bold text-white">{signal.ticker}</span>
          <span className="px-2 py-0.5 bg-slate-700/50 rounded text-xs text-slate-300">{signal.timeframe}</span>
          <span className={`px-3 py-1 rounded-full text-xs font-semibold border ${signal.position === "SHORT" ? "bg-rose-500/20 text-rose-400 border-rose-500/30" : "bg-emerald-500/20 text-emerald-400 border-emerald-500/30"}`}>
            {signal.position}
          </span>
        </div>
        <span className={`px-3 py-1 rounded-full text-xs font-semibold border ${statusColors[trueStatus] || statusColors.EXPIRED}`}>
          {trueStatus.replace("_", " ")}
        </span>
      </div>

      {/* Prices */}
      <div className="grid grid-cols-3 gap-4 text-sm">
        <div>
          <div className="text-slate-500 text-xs mb-1">Entry</div>
          <div className="text-white font-mono">${signal.entryPrice.toLocaleString()}</div>
        </div>
        <div>
          <div className="text-slate-500 text-xs mb-1">Current</div>
          <div className="text-white font-mono">${currentPrice.toLocaleString()}</div>
        </div>
        <div>
          <div className="text-slate-500 text-xs mb-1">Target</div>
          <div className="text-emerald-400 font-mono">${signal.targetPrice.toLocaleString()}</div>
        </div>
      </div>

      {/* P&L Bar */}
      <div className="flex items-center justify-between bg-slate-800/50 rounded-lg p-3">
        <span className="text-slate-400 text-sm">Unrealized P&L</span>
        <span className={`text-lg font-bold font-mono ${pnlColor}`}>
          {pnl >= 0 ? "+" : ""}{pnl.toFixed(2)}%
        </span>
      </div>

      {/* Indicators */}
      <div className="grid grid-cols-2 gap-3 text-xs">
        <div className="bg-slate-800/30 rounded-lg p-3 space-y-1">
          <div className="text-slate-500">Stochastic</div>
          <div className="text-white font-mono">K: {signal.stochK?.toFixed(2)} <span className="text-slate-500">D: {signal.stochD?.toFixed(2)}</span></div>
          <div className="text-slate-400">
            {signal.stochK! < signal.stochD! ? "K < D (bearish)" : "K > D (bullish)"}
          </div>
        </div>
        <div className="bg-slate-800/30 rounded-lg p-3 space-y-1">
          <div className="text-slate-500">MACD</div>
          <div className={`font-mono ${(signal.macdHist || 0) < 0 ? "text-rose-400" : "text-emerald-400"}`}>
            {(signal.macdHist || 0) < 0 ? "↓" : "↑"} {signal.macdHist?.toFixed(2)}
          </div>
          <div className="text-slate-400">{(signal.macdHist || 0) < 0 ? "Bearish" : "Bullish"} histogram</div>
        </div>
      </div>

      {/* TTL / Entry Buffer Info */}
      <div className="space-y-2 text-xs">
        <div className="flex justify-between text-slate-400">
          <span>TTL Remaining</span>
          <span className={isTtlExpired ? "text-rose-400" : "text-emerald-400"}>
            {isTtlExpired ? "EXPIRED" : formatDuration(ttlRemaining)}
          </span>
        </div>
        <div className="flex justify-between text-slate-400">
          <span>Entry Buffer</span>
          <span className={isWithinEntryBuffer ? "text-emerald-400" : "text-amber-400"}>
            {isWithinEntryBuffer ? "WITHIN RANGE" : "OUTSIDE RANGE"} (${entryBufferMin.toFixed(2)} - ${entryBufferMax.toFixed(2)})
          </span>
        </div>
      </div>

      {/* Exit Rules */}
      <div className="border-t border-slate-700/50 pt-3">
        <div className="text-slate-500 text-xs mb-2 font-semibold uppercase tracking-wider">Exit Triggers</div>
        <ul className="space-y-1">
          {exitRules.map((rule, i) => (
            <li key={i} className="text-slate-300 text-xs flex items-center gap-2">
              <span className="w-1 h-1 rounded-full bg-slate-500" />
              {rule}
            </li>
          ))}
        </ul>
      </div>

      {/* Action Buttons */}
      <div className="flex gap-2 pt-2">
        <button className="flex-1 bg-rose-500/20 hover:bg-rose-500/30 text-rose-400 border border-rose-500/30 rounded-lg py-2 text-sm font-medium transition-colors">
          Close Position
        </button>
        <button className="flex-1 bg-slate-700/50 hover:bg-slate-700/70 text-slate-300 border border-slate-600/30 rounded-lg py-2 text-sm font-medium transition-colors">
          Edit SL/TP
        </button>
      </div>
    </div>
  );
}

function formatDuration(ms: number): string {
  const hours = Math.floor(ms / 3600000);
  const minutes = Math.floor((ms % 3600000) / 60000);
  const seconds = Math.floor((ms % 60000) / 1000);
  return `${hours}h ${minutes}m ${seconds}s`;
}

// ─── Main Dashboard ────────────────────────────────────────────────────

export default function TradingDashboard() {
  const [signals, setSignals] = useState<Signal[]>(MOCK_SIGNALS);
  const [prices, setPrices] = useState<Record<string, number>>({
    SOL: 138.20,
    BTC: 66800,
  });

  // Simulate live price updates
  useEffect(() => {
    const interval = setInterval(() => {
      setPrices((prev) => ({
        SOL: prev.SOL * (1 + (Math.random() - 0.5) * 0.002),
        BTC: prev.BTC * (1 + (Math.random() - 0.5) * 0.001),
      }));
    }, 3000);
    return () => clearInterval(interval);
  }, []);

  const solData = useMemo(() => generateMockPriceData(prices.SOL), [prices.SOL]);
  const btcData = useMemo(() => generateMockPriceData(prices.BTC), [prices.BTC]);

  return (
    <div className="min-h-screen bg-slate-950 text-white p-6">
      <div className="max-w-7xl mx-auto space-y-8">
        {/* Header */}
        <div className="flex items-center justify-between">
          <div>
            <h1 className="text-3xl font-bold text-white">Strategy Dashboard</h1>
            <p className="text-slate-400 mt-1">Fixed TTL & Entry Buffer Logic — Strategy Logic Preserved</p>
          </div>
          <div className="flex items-center gap-2">
            <span className="w-2 h-2 rounded-full bg-emerald-500 animate-pulse" />
            <span className="text-emerald-400 text-sm font-medium">Live</span>
          </div>
        </div>

        {/* Signal Cards */}
        <div className="grid grid-cols-1 lg:grid-cols-2 gap-6">
          {signals.map((signal) => (
            <SignalCard key={signal.id} signal={signal} currentPrice={prices[signal.ticker]} />
          ))}
        </div>

        {/* Price Charts */}
        <div className="grid grid-cols-1 lg:grid-cols-2 gap-6">
          <PriceChart title="SOL/USD" data={solData} signal={signals[0]} />
          <PriceChart title="BTC/USD" data={btcData} signal={signals[1]} />
        </div>
      </div>
    </div>
  );
}

// ─── Price Chart Component ───────────────────────────────────────────

function PriceChart({ title, data, signal }: { title: string; data: PriceData[]; signal: Signal }) {
  return (
    <div className="bg-slate-900/80 border border-slate-700/50 rounded-xl p-5 backdrop-blur-sm">
      <h3 className="text-lg font-semibold text-white mb-4">{title}</h3>
      <ResponsiveContainer width="100%" height={300}>
        <LineChart data={data}>
          <CartesianGrid strokeDasharray="3 3" stroke="#334155" />
          <XAxis dataKey="time" stroke="#64748b" fontSize={12} />
          <YAxis stroke="#64748b" fontSize={12} domain={["auto", "auto"]} />
          <Tooltip
            contentStyle={{ backgroundColor: "#0f172a", border: "1px solid #334155", borderRadius: "8px" }}
            labelStyle={{ color: "#94a3b8" }}
          />
          <ReferenceLine y={signal.entryPrice} stroke="#fbbf24" strokeDasharray="5 5" label={{ value: "Entry", fill: "#fbbf24", fontSize: 12 }} />
          <ReferenceLine y={signal.targetPrice} stroke="#34d399" strokeDasharray="5 5" label={{ value: "Target", fill: "#34d399", fontSize: 12 }} />
          <ReferenceLine y={signal.stopLoss} stroke="#f87171" strokeDasharray="5 5" label={{ value: "Stop", fill: "#f87171", fontSize: 12 }} />
          <Line type="monotone" dataKey="price" stroke="#60a5fa" strokeWidth={2} dot={false} />
          <Line type="monotone" dataKey="ema8" stroke="#a78bfa" strokeWidth={1} dot={false} strokeDasharray="3 3" />
          <Line type="monotone" dataKey="ema21" stroke="#f472b6" strokeWidth={1} dot={false} strokeDasharray="3 3" />
        </LineChart>
      </ResponsiveContainer>
    </div>
  );
}
