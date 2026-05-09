"use client";

import useSWR from "swr";
import { useState, useEffect, useMemo } from "react";
import type { SymbolCardState } from "@/lib/strategy-v6";
import { getMarketStatus } from "@/lib/market-status";

const VERSION = "v7.3.0";
const STALE_THRESHOLD_MS = 6 * 60_000;

// Bootstrap cards for initial page load - minimal data, no fakes
const BOOTSTRAP_CARDS: SymbolCardState[] = [
  {
    symbol: "BTC",
    price: 0,
    source: "bootstrap",
    degraded: true,
    direction: "NEUTRAL",
    mode: "NONE",
    confidence: 0,
    stochRsi: null,
    emaSlope: null,
    volatilityLevel: null,
    htf4hTrend: "NEUTRAL",
    htf4hMomentum: null,
    htf1hAlignment: null,
    htf15mCompression: null,
    marketReadinessState: "AWAITING_DATA",
    tradeReadinessScore: null,
    expectedMovePercent: null,
    targetPrices: null,
    riskReward: null,
    notes: "Waiting for live market feed…",
    updatedAt: "",
  },
  {
    symbol: "ETH",
    price: 0,
    source: "bootstrap",
    degraded: true,
    direction: "NEUTRAL",
    mode: "NONE",
    confidence: 0,
    stochRsi: null,
    emaSlope: null,
    volatilityLevel: null,
    htf4hTrend: "NEUTRAL",
    htf4hMomentum: null,
    htf1hAlignment: null,
    htf15mCompression: null,
    marketReadinessState: "AWAITING_DATA",
    tradeReadinessScore: null,
    expectedMovePercent: null,
    targetPrices: null,
    riskReward: null,
    notes: "Waiting for live market feed…",
    updatedAt: "",
  },
  {
    symbol: "SOL",
    price: 0,
    source: "bootstrap",
    degraded: true,
    direction: "NEUTRAL",
    mode: "NONE",
    confidence: 0,
    stochRsi: null,
    emaSlope: null,
    volatilityLevel: null,
    htf4hTrend: "NEUTRAL",
    htf4hMomentum: null,
    htf1hAlignment: null,
    htf15mCompression: null,
    marketReadinessState: "AWAITING_DATA",
    tradeReadinessScore: null,
    expectedMovePercent: null,
    targetPrices: null,
    riskReward: null,
    notes: "Waiting for live market feed…",
    updatedAt: "",
  },
];

const fetcher = (url: string) =>
  fetch(url, { cache: "no-store" }).then((r) => r.json());

/**
 * Validate snapshot and filter valid cards (v7.2.3 HOTFIX)
 * MINIMAL validation: only check symbol + price > 0
 * Accept partial hydration - valid cards shown immediately
 * Optional fields hydrate later
 */
function validateSnapshot(snapshot: any): SymbolCardState[] | null {
  // Reject if no snapshot or no cards array
  if (!snapshot || !Array.isArray(snapshot.cards)) {
    console.log("[VALIDATION_FAIL] snapshot.cards missing or not array");
    return null;
  }

  if (snapshot.cards.length === 0) {
    console.log("[VALIDATION_FAIL] snapshot.cards empty");
    return null;
  }

  // Filter cards: accept if symbol + price > 0
  const validCards: SymbolCardState[] = [];
  const rejectedCards: string[] = [];

  for (const card of snapshot.cards) {
    if (typeof card.symbol === "string" && typeof card.price === "number" && card.price > 0) {
      validCards.push(card);
      console.log(`[VALIDATION_PASS] ${card.symbol}: price=${card.price}`);
    } else {
      rejectedCards.push(`${card.symbol || "unknown"} (price: ${card.price})`);
      console.log(`[VALIDATION_FAIL] ${card.symbol}: price invalid (${card.price})`);
    }
  }

  // If ANY valid cards exist, accept and return
  if (validCards.length > 0) {
    console.log(`[LIVE_ACCEPTED] ${validCards.length} valid cards`);
    return validCards;
  }

  if (rejectedCards.length > 0) {
    console.log(`[LIVE_REJECTED] All ${rejectedCards.length} cards invalid:`, rejectedCards);
  }

  return null;
}

function fmt(n: number) {
  return n.toLocaleString("en-US", { minimumFractionDigits: 2, maximumFractionDigits: 2 });
}

function SymbolCard({ card }: { card: SymbolCardState }) {
  const isLoading = card.source === "bootstrap";
  // FIX #1, #2, #3: Use signalState to determine display + TP visibility
  const isActiveSignal = card.signalState === "ACTIVE_SNIPER" || card.signalState === "ACTIVE_CONFIRMED";
  const hasSignal = card.mode === "SNIPER" || card.mode === "CONFIRMED";
  
  // FIX #8: Remove "WATCHING" - use signalState to show meaningful states (v7.2.8 adds SNIPER_IMMINENT)
  const statusBadge = isLoading ? "LOADING" : 
    card.signalState === "ACTIVE_CONFIRMED" ? "CONFIRMED" :
    card.signalState === "ACTIVE_SNIPER" ? "SNIPER" :
    card.signalState === "CONFIRMED_READY" ? "CONFIRMED READY" :
    card.signalState === "SNIPER_READY" ? "SNIPER READY" :
    card.signalState === "SNIPER_IMMINENT" ? "SNIPER IMMINENT" :
    card.signalState === "BUILDING" ? "BUILDING" :
    card.marketReadinessState;
  
  // Direction colors
  const directionColor = card.direction === "LONG" ? "text-green-400" : card.direction === "SHORT" ? "text-red-400" : "text-zinc-400";
  const directionBg = card.direction === "LONG" ? "bg-green-950" : card.direction === "SHORT" ? "bg-red-950" : "bg-zinc-900";
  const directionBorder = card.direction === "LONG" ? "border-green-700" : card.direction === "SHORT" ? "border-red-700" : "border-zinc-700";
  
  // Market readiness colors (v7.2.4: updated with new live market states)
  const readinessColor: Record<string, string> = {
    "BULLISH BUILDING": "text-green-400",
    "BULLISH IGNITION": "text-green-300",
    "BULLISH EXPANSION": "text-green-200",
    "BULLISH MOMENTUM": "text-green-400",
    "BULLISH OVEREXTENDED": "text-orange-400",
    "BEARISH BUILDING": "text-red-400",
    "BEARISH IGNITION": "text-red-300",
    "BEARISH EXPANSION": "text-red-200",
    "BEARISH MOMENTUM": "text-red-400",
    "BEARISH OVEREXTENDED": "text-orange-400",
    "CHOPPY": "text-zinc-400",
    "BUILDING PRESSURE": "text-amber-400",
    "EXTREME READS": "text-orange-400",
    "NEUTRAL": "text-zinc-400",
  };
  
  const currentReadinessColor = readinessColor[card.marketReadinessState] || "text-zinc-400";

  // Trade readiness score color bands
  const readinessScoreColor = card.tradeReadinessScore === null 
    ? "text-zinc-500" 
    : card.tradeReadinessScore < 40 
    ? "text-red-400" 
    : card.tradeReadinessScore < 60 
    ? "text-amber-400" 
    : card.tradeReadinessScore < 75 
    ? "text-cyan-400" 
    : "text-green-400";

  const readinessBgBar = card.tradeReadinessScore === null 
    ? "bg-zinc-900" 
    : card.tradeReadinessScore < 40 
    ? "bg-red-500" 
    : card.tradeReadinessScore < 60 
    ? "bg-amber-500" 
    : card.tradeReadinessScore < 75 
    ? "bg-cyan-500" 
    : "bg-green-500";

  return (
    <div className={`rounded-lg border ${directionBorder} p-6 bg-[#0f0f0f] text-white space-y-5`}>
      {/* HEADER: Symbol + Status Badge + Price */}
      <div className="space-y-3">
        <div className="flex items-center justify-between">
          <h2 className="text-2xl font-bold tracking-tight">{card.symbol}/USD</h2>
          <span className={`text-xs px-3 py-1 rounded border ${directionBg} ${directionBorder} ${directionColor}`}>
            {statusBadge}
          </span>
        </div>
        <div className="flex items-center justify-between">
          <span className={`text-sm font-semibold ${directionColor}`}>{card.direction}</span>
          <span className="text-2xl font-mono font-bold text-white">${fmt(card.price)}</span>
        </div>
      </div>

      {/* MARKET READINESS STATE (Live) */}
      <div className="border-t border-zinc-800 pt-4">
        <p className="text-xs text-zinc-500 mb-2 uppercase tracking-wider">Market State</p>
        <p className={`text-sm font-semibold ${currentReadinessColor}`}>
          {card.marketReadinessState}
        </p>
      </div>

      {/* DIRECTIONAL BIAS PANEL */}
      <div className="border-t border-zinc-800 pt-4 space-y-2 bg-zinc-900 p-3 rounded border border-zinc-700">
        <p className="text-xs text-zinc-500 uppercase tracking-wider">Market Bias</p>
        <div className="flex items-center justify-between text-sm">
          <span className="text-zinc-400">4H:</span>
          <span className={card.htf4hTrend === "BULLISH" ? "text-green-400" : card.htf4hTrend === "BEARISH" ? "text-red-400" : "text-zinc-400"}>
            {card.htf4hTrend}
          </span>
        </div>
        <div className="flex items-center justify-between text-sm">
          <span className="text-zinc-400">15M:</span>
          <span className={
            card.execution15mState === "BREAKOUT_READY" ? "text-cyan-400" : 
            card.execution15mState === "EXPANDING" ? "text-green-400" : 
            card.execution15mState === "COMPRESSING" ? "text-amber-400" : 
            "text-zinc-400"
          }>
            {card.execution15mState}
          </span>
        </div>
        <div className="flex items-center justify-between text-sm">
          <span className="text-zinc-400">Overall:</span>
          <span className={card.direction === "LONG" ? "text-green-400" : card.direction === "SHORT" ? "text-red-400" : "text-zinc-400"}>
            {card.direction === "LONG" ? "LONG BIAS" : card.direction === "SHORT" ? "SHORT BIAS" : "NO TRADE"}
          </span>
        </div>
      </div>

      {/* TRADE READINESS SCORE - PRIMARY FOCUS */}
      <div className="border-t border-zinc-800 pt-4 bg-zinc-900 p-4 rounded border border-zinc-700">
        <div className="flex items-center justify-between mb-3">
          <p className="text-xs text-zinc-500 uppercase tracking-wider">Trade Readiness</p>
          <span className={`text-lg font-mono font-bold ${readinessScoreColor}`}>
            {card.tradeReadinessScore === null ? "—" : Math.round(card.tradeReadinessScore)}%
          </span>
        </div>
        <div className="w-full bg-zinc-800 rounded h-3">
          <div 
            className={`${readinessBgBar} h-3 rounded transition-all`} 
            style={{ width: card.tradeReadinessScore === null ? "0%" : `${card.tradeReadinessScore}%` }} 
          />
        </div>
        <p className="text-xs text-zinc-500 mt-2">
          {card.tradeReadinessScore === null 
            ? "No signal" 
            : card.tradeReadinessScore < 40 
            ? "Dead market" 
            : card.tradeReadinessScore < 60 
            ? "Building momentum" 
            : card.tradeReadinessScore < 75 
            ? "SNIPER zone" 
            : "CONFIRMED zone"}
        </p>
      </div>

      {/* CONDITIONAL: Show targets ONLY if signal is ACTIVE (FIX #3) */}
      {isActiveSignal && card.targetPrices && (
        <div className="border-t border-zinc-800 pt-4 space-y-2">
          <p className="text-xs text-zinc-500 uppercase tracking-wider">{card.mode} Entry</p>
          <div className="text-sm font-mono space-y-1">
            <div className="flex justify-between"><span className="text-zinc-400">Entry Zone:</span> <span className="text-cyan-400">${fmt(card.price)}</span></div>
            <div className="flex justify-between"><span className="text-zinc-400">TP1:</span> <span className="text-green-400">${fmt(card.targetPrices.tp1)}</span></div>
            <div className="flex justify-between"><span className="text-zinc-400">TP2:</span> <span className="text-green-400">${fmt(card.targetPrices.tp2)}</span></div>
            <div className="flex justify-between"><span className="text-zinc-400">SL:</span> <span className="text-red-400">${fmt(card.targetPrices.sl)}</span></div>
            <div className="flex justify-between mt-2 pt-2 border-t border-zinc-700"><span className="text-zinc-400">R:R:</span> <span className="text-green-400 font-bold">{card.riskReward?.toFixed(1) ?? "—"}:1</span></div>
          </div>
        </div>
      )}

      {/* Status message */}
      <div className="text-xs text-zinc-500 text-center pt-2">
        {isLoading ? "Loading market snapshot..." : card.notes}
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

  // HYDRATION DEBUG LOGGING (v7.2.3)
  const validLiveCards = data ? validateSnapshot(data) : null;
  
  useEffect(() => {
    if (validLiveCards && validLiveCards.length > 0) {
      console.log("[HYDRATION] Live snapshot validated");
      console.log("[LIVE_SWAP] Accepting", validLiveCards.length, "cards from snapshot");
    } else if (data) {
      console.log("[HYDRATION] Snapshot validation returned no valid cards");
    } else if (isValidating) {
      console.log("[HYDRATION] Fetch in progress...");
    } else {
      console.log("[BOOTSTRAP] Using skeleton cards - no fetch response");
    }
  }, [validLiveCards, isValidating, data]);

  // Card selection: prefer valid live cards, fallback to bootstrap
  const cards = validLiveCards && validLiveCards.length > 0 ? validLiveCards : BOOTSTRAP_CARDS;
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
