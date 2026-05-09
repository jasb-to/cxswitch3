"use client";

import useSWR from "swr";
import { useState, useEffect, useMemo } from "react";
import type { SymbolCardState } from "@/lib/strategy-v6";
import { getMarketStatus } from "@/lib/market-status";

const VERSION = "v7.2.0";
const STALE_THRESHOLD_MS = 6 * 60_000;

// Bootstrap cards for initial page load (before first cron run)
const BOOTSTRAP_CARDS: SymbolCardState[] = [
  {
    symbol: "BTC",
    price: 45000,
    source: "bootstrap",
    degraded: true,
    direction: "NEUTRAL",
    mode: "NONE",
    confidence: 0,
    stochRsi: 50,
    emaSlope: 0,
    volatilityLevel: 50,
    htf4hTrend: "NEUTRAL",
    htf4hMomentum: 50,
    htf1hAlignment: false,
    htf15mCompression: false,
    marketPhase: "NEUTRAL",
    compressionLevel: 50,
    expectedMovePercent: { sniper: { min: 0.8, max: 1.5 }, confirmed: { min: 2.5, max: 4.5 } },
    targetPrices: { tp1: 45675, tp2: 46125, tp3: 46950, sl: 44325 },
    riskReward: 3,
    signalQuality: 50,
    notes: "Loading market snapshot...",
    updatedAt: new Date().toISOString(),
  },
  {
    symbol: "ETH",
    price: 2500,
    source: "bootstrap",
    degraded: true,
    direction: "NEUTRAL",
    mode: "NONE",
    confidence: 0,
    stochRsi: 50,
    emaSlope: 0,
    volatilityLevel: 50,
    htf4hTrend: "NEUTRAL",
    htf4hMomentum: 50,
    htf1hAlignment: false,
    htf15mCompression: false,
    marketPhase: "NEUTRAL",
    compressionLevel: 50,
    expectedMovePercent: { sniper: { min: 0.8, max: 1.5 }, confirmed: { min: 2.5, max: 4.5 } },
    targetPrices: { tp1: 2537.5, tp2: 2562.5, tp3: 2612.5, sl: 2462.5 },
    riskReward: 3,
    signalQuality: 50,
    notes: "Loading market snapshot...",
    updatedAt: new Date().toISOString(),
  },
  {
    symbol: "SOL",
    price: 150,
    source: "bootstrap",
    degraded: true,
    direction: "NEUTRAL",
    mode: "NONE",
    confidence: 0,
    stochRsi: 50,
    emaSlope: 0,
    volatilityLevel: 50,
    htf4hTrend: "NEUTRAL",
    htf4hMomentum: 50,
    htf1hAlignment: false,
    htf15mCompression: false,
    marketPhase: "NEUTRAL",
    compressionLevel: 50,
    expectedMovePercent: { sniper: { min: 0.8, max: 1.5 }, confirmed: { min: 2.5, max: 4.5 } },
    targetPrices: { tp1: 152.25, tp2: 153.75, tp3: 156.75, sl: 147.75 },
    riskReward: 3,
    signalQuality: 50,
    notes: "Loading market snapshot...",
    updatedAt: new Date().toISOString(),
  },
];

const fetcher = (url: string) =>
  fetch(url, { cache: "no-store" }).then((r) => r.json());

function fmt(n: number) {
  return n.toLocaleString("en-US", { minimumFractionDigits: 2, maximumFractionDigits: 2 });
}

function SymbolCard({ card }: { card: SymbolCardState }) {
  const directionColor = card.direction === "LONG" ? "text-green-400" : card.direction === "SHORT" ? "text-red-400" : "text-zinc-400";
  const directionBg = card.direction === "LONG" ? "bg-green-950" : card.direction === "SHORT" ? "bg-red-950" : "bg-zinc-900";
  const directionBorder = card.direction === "LONG" ? "border-green-700" : card.direction === "SHORT" ? "border-red-700" : "border-zinc-700";
  
  const phaseColor = {
    "COMPRESSION": "text-amber-400",
    "IGNITION": "text-cyan-400",
    "EXPANSION": "text-green-400",
    "EXHAUSTION": "text-red-400",
    "REVERSAL_RISK": "text-orange-400",
    "NEUTRAL": "text-zinc-400",
  }[card.marketPhase] || "text-zinc-400";

  return (
    <div className={`rounded-lg border ${directionBorder} p-6 bg-[#0f0f0f] text-white space-y-5`}>
      {/* HEADER: Symbol, Status, Price */}
      <div className="space-y-3">
        <div className="flex items-center justify-between">
          <h2 className="text-2xl font-bold tracking-tight">{card.symbol}/USD</h2>
          <span className={`text-xs px-3 py-1 rounded border ${directionBg} ${directionBorder} ${directionColor}`}>
            {card.source === "bootstrap" ? "LOADING" : "LIVE"}
          </span>
        </div>
        <div className="flex items-center justify-between">
          <span className={`text-sm font-semibold ${directionColor}`}>{card.direction}</span>
          <span className="text-2xl font-mono font-bold text-white">${fmt(card.price)}</span>
        </div>
      </div>

      {/* MARKET PHASE */}
      <div className="border-t border-zinc-800 pt-4">
        <p className="text-xs text-zinc-500 mb-2 uppercase tracking-wider">Market Phase</p>
        <p className={`text-sm font-semibold ${phaseColor}`}>{card.marketPhase.replace("_", " ")}</p>
      </div>

      {/* HTF BIAS */}
      <div className="border-t border-zinc-800 pt-4 space-y-2">
        <p className="text-xs text-zinc-500 uppercase tracking-wider">HTF Bias</p>
        <div className="flex items-center justify-between text-sm">
          <span className="text-zinc-400">4H Trend:</span>
          <span className={card.htf4hTrend === "BULLISH" ? "text-green-400" : card.htf4hTrend === "BEARISH" ? "text-red-400" : "text-zinc-400"}>
            {card.htf4hTrend} {card.htf4hTrend === "BULLISH" ? "↑" : card.htf4hTrend === "BEARISH" ? "↓" : "•"}
          </span>
        </div>
        <div className="flex items-center justify-between text-sm">
          <span className="text-zinc-400">1H Momentum:</span>
          <span className={card.htf1hAlignment ? "text-green-400" : "text-red-400"}>
            {card.htf1hAlignment ? "ALIGNED ↑" : "DIVERGED ↓"}
          </span>
        </div>
      </div>

      {/* LTF ENTRY ENGINE */}
      <div className="border-t border-zinc-800 pt-4 space-y-2">
        <p className="text-xs text-zinc-500 uppercase tracking-wider">LTF Entry Engine</p>
        <div className="flex items-center justify-between text-sm">
          <span className="text-zinc-400">15M Compression:</span>
          <span className="text-cyan-400 font-mono">{Math.round(card.compressionLevel)}%</span>
        </div>
        <div className="flex items-center justify-between text-sm">
          <span className="text-zinc-400">5M Trigger:</span>
          <span className="text-cyan-400">{card.stochRsi > 60 || card.stochRsi < 40 ? "STOCH CROSS" : "EMA FLIP"}</span>
        </div>
      </div>

      {/* MOMENTUM METRICS */}
      <div className="border-t border-zinc-800 pt-4 space-y-2">
        <p className="text-xs text-zinc-500 uppercase tracking-wider">Momentum Metrics</p>
        <div className="text-sm font-mono space-y-1">
          <div className="flex justify-between"><span className="text-zinc-400">Stoch RSI:</span> <span className={card.stochRsi > 60 ? "text-green-400" : card.stochRsi < 40 ? "text-red-400" : "text-zinc-400"}>{card.stochRsi.toFixed(1)}</span></div>
          <div className="flex justify-between"><span className="text-zinc-400">EMA Spread:</span> <span className={Math.abs(card.emaSlope) > 0.5 ? "text-green-400" : "text-zinc-400"}>{card.emaSlope > 0 ? "EXPANDING" : "CONTRACTING"}</span></div>
          <div className="flex justify-between"><span className="text-zinc-400">Strength:</span> <span className="text-cyan-400">{(card.confidence * 10 / 100).toFixed(1)}/10</span></div>
        </div>
      </div>

      {/* PROJECTED MOVE RANGE */}
      <div className="border-t border-zinc-800 pt-4 space-y-2">
        <p className="text-xs text-zinc-500 uppercase tracking-wider">Projected Move Range</p>
        <div className="text-sm space-y-1">
          <div className="flex justify-between"><span className="text-zinc-400">SNIPER:</span> <span className="text-yellow-400">{card.expectedMovePercent.sniper.min.toFixed(1)}–{card.expectedMovePercent.sniper.max.toFixed(1)}%</span></div>
          <div className="flex justify-between"><span className="text-zinc-400">CONFIRMED:</span> <span className="text-green-400">{card.expectedMovePercent.confirmed.min.toFixed(1)}–{card.expectedMovePercent.confirmed.max.toFixed(1)}%</span></div>
          <div className="mt-2 space-y-1 text-xs">
            <div><span className="text-zinc-500">TP1:</span> <span className="text-cyan-400 font-mono ml-2">${fmt(card.targetPrices.tp1)}</span></div>
            <div><span className="text-zinc-500">TP2:</span> <span className="text-cyan-400 font-mono ml-2">${fmt(card.targetPrices.tp2)}</span></div>
            <div><span className="text-zinc-500">TP3:</span> <span className="text-cyan-400 font-mono ml-2">${fmt(card.targetPrices.tp3)}</span></div>
            <div><span className="text-zinc-500">SL:</span> <span className="text-red-400 font-mono ml-2">${fmt(card.targetPrices.sl)}</span></div>
            <div><span className="text-zinc-500">R:R:</span> <span className="text-green-400 font-mono ml-2">{card.riskReward.toFixed(1)}</span></div>
          </div>
        </div>
      </div>

      {/* SIGNAL QUALITY METER */}
      <div className="border-t border-zinc-800 pt-4">
        <div className="flex items-center justify-between mb-2">
          <p className="text-xs text-zinc-500 uppercase tracking-wider">Signal Quality</p>
          <span className="text-sm font-mono text-cyan-400">{Math.round(card.signalQuality)}%</span>
        </div>
        <div className="w-full bg-zinc-900 rounded h-2">
          <div className="bg-cyan-500 h-2 rounded transition-all" style={{ width: `${card.signalQuality}%` }} />
        </div>
      </div>
    </div>
  );
}

export default function Dashboard() {
  const [tg, setTg] = useState<"idle" | "sending" | "ok" | "error">("idle");
  const [tgMsg, setTgMsg] = useState("");
  const [now, setNow] = useState(0);
  const [isHydrated, setIsHydrated] = useState(false);

  useEffect(() => {
    setIsHydrated(true);
    setNow(Date.now());
    const id = setInterval(() => setNow(Date.now()), 1000);
    return () => clearInterval(id);
  }, []);

  const { data, mutate, isValidating } = useSWR<{ updatedAt: string; cards: SymbolCardState[]; setups: any[] }>(
    "/api/signals",
    fetcher,
    { refreshInterval: 30_000, keepPreviousData: true, revalidateOnFocus: false }
  );

  const cards = data?.cards && data.cards.length > 0 ? data.cards : BOOTSTRAP_CARDS;
  const setups = data?.setups ?? [];
  const updatedAt = data?.updatedAt ?? "";
  const isBootstrap = !data?.cards || data.cards.length === 0;
  const fetchedAtMs = updatedAt ? new Date(updatedAt).getTime() : 0;
  const isStale = !isBootstrap && isHydrated && fetchedAtMs > 0 && now > 0 && (now - fetchedAtMs) > STALE_THRESHOLD_MS;
  const lastUpdateTime = isHydrated && updatedAt ? new Date(updatedAt).toLocaleTimeString("en-GB", { hour12: false }) : "—";

  const assetCount = cards.length;
  const activeCount = setups.length;

  async function testTelegram() {
    setTg("sending");
    setTgMsg("");
    try {
      const res = await fetch("/api/test-telegram", { method: "POST" });
      const json = await res.json();
      setTg(json.ok ? "ok" : "error");
      setTgMsg(json.ok ? "Message sent" : (json.error ?? "Failed"));
    } catch {
      setTg("error");
      setTgMsg("Network error");
    }
    setTimeout(() => { setTg("idle"); setTgMsg(""); }, 4000);
  }

  return (
    <main className="min-h-screen bg-[#0a0a0a] text-white font-mono">
      <header className="border-b border-zinc-800 px-6 py-3 flex items-center justify-between">
        <p className="text-[11px] tracking-[0.22em] text-zinc-500">
          MULTI-TIMEFRAME CRYPTO SIGNAL ANALYZER &nbsp;·&nbsp; REAL-TIME INTELLIGENCE
        </p>
        <p className="text-[11px] tracking-[0.15em] text-zinc-600">{VERSION}</p>
      </header>

      <div className="px-6 py-6 max-w-[1400px] mx-auto flex flex-col gap-6">
        {isStale && (
          <div className="border border-zinc-700 bg-zinc-900 px-4 py-3 text-[12px] tracking-[0.1em] text-zinc-400">
            STALE DATA — WAITING FOR NEXT SCAN
          </div>
        )}

        <div className="grid grid-cols-1 md:grid-cols-3 gap-4">
          <div className="md:col-span-2 border border-zinc-800 bg-zinc-950 p-5 flex flex-col gap-5">
            <p className="text-[10px] tracking-[0.22em] text-zinc-500">SYSTEM STATUS</p>

            <div className="flex flex-col gap-4">
              <div className="flex items-center justify-between">
                <span className="text-[13px] text-zinc-400">Terminal</span>
                <span className="flex items-center gap-2 text-[13px] text-green-400">
                  <span className="w-2 h-2 rounded-full bg-green-400" aria-hidden />
                  LIVE
                </span>
              </div>
              <div className="flex items-center justify-between">
                <span className="text-[13px] text-zinc-400">Telegram Bot</span>
                <span className={`flex items-center gap-2 text-[13px] ${tg === "ok" ? "text-green-400" : tg === "error" ? "text-red-400" : "text-zinc-500"}`}>
                  <span className={`w-2 h-2 rounded-full ${tg === "ok" ? "bg-green-400" : tg === "error" ? "bg-red-400" : "bg-zinc-600"}`} aria-hidden />
                  ACTIVE
                </span>
              </div>
              <div className="flex items-center justify-between">
                <span className="text-[13px] text-zinc-400">Last Update</span>
                <span className="text-[13px] text-white tabular-nums">{lastUpdateTime}</span>
              </div>
            </div>

            <div className="flex gap-2">
              <button
                onClick={testTelegram}
                disabled={tg === "sending"}
                className={`flex-1 border text-[11px] tracking-[0.2em] py-3 transition-colors disabled:opacity-40 ${
                  tg === "ok"
                    ? "border-green-400 text-green-400"
                    : tg === "error"
                    ? "border-red-400 text-red-400"
                    : "border-zinc-700 text-zinc-500 hover:border-zinc-600 hover:text-zinc-300"
                }`}
              >
                {tg === "sending" ? "SENDING..." : tg === "ok" ? "SENT OK" : tg === "error" ? "SEND FAILED" : "TEST TELEGRAM"}
              </button>
              <button
                onClick={() => mutate()}
                className="flex-1 border border-zinc-700 text-zinc-500 hover:border-zinc-600 hover:text-zinc-300 text-[11px] tracking-[0.2em] py-3 transition-colors"
              >
                {isValidating ? "REFRESHING..." : "REFRESH"}
              </button>
            </div>
            {tgMsg && (
              <p className={`text-[11px] text-center ${tg === "ok" ? "text-green-400" : "text-red-400"}`}>
                {tgMsg}
              </p>
            )}
          </div>

          <div className="border border-zinc-800 bg-zinc-950 p-5 flex flex-col gap-5">
            <p className="text-[10px] tracking-[0.22em] text-zinc-500">DATA POINTS</p>
            <div className="grid grid-cols-2 gap-6 flex-1 items-start">
              <div>
                <p className="text-[10px] tracking-[0.22em] text-zinc-500 mb-3">ASSETS</p>
                <p className="font-bold text-5xl text-green-400 tabular-nums">{assetCount}</p>
              </div>
              <div>
                <p className="text-[10px] tracking-[0.22em] text-zinc-500 mb-3">SIGNALS</p>
                <p className="font-bold text-5xl text-green-400 tabular-nums">{activeCount}</p>
              </div>
            </div>
            <div className="border-t border-zinc-800 pt-3">
              <p className="text-[10px] tracking-[0.18em] text-zinc-600">
                AUTO-REFRESH 30s &nbsp;·&nbsp; KRAKEN API
              </p>
            </div>
          </div>
        </div>

        <div>
          <p className="text-[10px] tracking-[0.22em] text-zinc-500 mb-4">SYMBOL CARDS</p>

          <div className="grid grid-cols-1 md:grid-cols-3 gap-4">
            {cards.map((card) => (
              <SymbolCard key={card.symbol} card={card} />
            ))}
          </div>
        </div>

        <footer className="border-t border-zinc-800 pt-4 flex items-center justify-between">
          <p className="text-[10px] tracking-[0.2em] text-zinc-700">{VERSION} MOMENTUM ENGINE</p>
          <p className="text-[10px] tracking-[0.2em] text-zinc-700">
            STOCH RSI &nbsp;·&nbsp; EMA STACK &nbsp;·&nbsp; VOLATILITY COMPRESSION
          </p>
        </footer>
      </div>
    </main>
  );
}
