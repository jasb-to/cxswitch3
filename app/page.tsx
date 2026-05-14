"use client";

import useSWR from "swr";
import { useState, useEffect } from "react";
import type { SymbolCardState } from "@/lib/strategy-v6";
import { getMarketStatus } from "@/lib/market-status";

const VERSION = "v18.3.0";
const STALE_THRESHOLD_MS = 6 * 60_000;

// Bootstrap cards for initial page load - minimal data, no fakes
const BOOTSTRAP_CARDS: SymbolCardState[] = [
  {
    symbol: "BTC",
    price: 0,
    source: "bootstrap",
    degraded: true,
    direction: "NEUTRAL",
    signalState: "NONE",
    marketClass: "CHOP",
    ignitionProbability: 0,
    tradeReadinessScore: null,
    stochRsi: null,
    emaSlope: null,
    emaPressure: 0,
    volatilityLevel: null,
    htf4hTrend: "NEUTRAL",
    htf4hMomentum: null,
    htf1hAlignment: null,
    htf15mCompression: null,
    execution15mState: "CHOP",
    marketReadinessState: "AWAITING_DATA",
    expectedMovePercent: null,
    targetPrices: null,
    riskReward: null,
    cycleId: "",
    notes: "Waiting for live market feed…",
    updatedAt: "",
  },
  {
    symbol: "ETH",
    price: 0,
    source: "bootstrap",
    degraded: true,
    direction: "NEUTRAL",
    signalState: "NONE",
    marketClass: "CHOP",
    ignitionProbability: 0,
    tradeReadinessScore: null,
    stochRsi: null,
    emaSlope: null,
    emaPressure: 0,
    volatilityLevel: null,
    htf4hTrend: "NEUTRAL",
    htf4hMomentum: null,
    htf1hAlignment: null,
    htf15mCompression: null,
    execution15mState: "CHOP",
    marketReadinessState: "AWAITING_DATA",
    expectedMovePercent: null,
    targetPrices: null,
    riskReward: null,
    cycleId: "",
    notes: "Waiting for live market feed…",
    updatedAt: "",
  },
  {
    symbol: "SOL",
    price: 0,
    source: "bootstrap",
    degraded: true,
    direction: "NEUTRAL",
    signalState: "NONE",
    marketClass: "CHOP",
    ignitionProbability: 0,
    tradeReadinessScore: null,
    stochRsi: null,
    emaSlope: null,
    emaPressure: 0,
    volatilityLevel: null,
    htf4hTrend: "NEUTRAL",
    htf4hMomentum: null,
    htf1hAlignment: null,
    htf15mCompression: null,
    execution15mState: "CHOP",
    marketReadinessState: "AWAITING_DATA",
    expectedMovePercent: null,
    targetPrices: null,
    riskReward: null,
    cycleId: "",
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

/**
 * v17.1.0: PURE SNAPSHOT RENDERER - SINGLE CANONICAL STATE SOURCE
 * 
 * UI renders snapshot directly with NO state derivation.
 * Only signalState determines EVERYTHING shown:
 * - Badge label (BUILDING/SNIPER/CONFIRMED)
 * - Border color (amber/cyan/green)
 * - Display score (calculated from signalState only)
 * - Trade readiness (calculated from signalState only)
 * - Rendering flags (renderable/hasActiveTrade)
 * 
 * NO parallel systems. NO independent derivations. NO cross-field logic.
 */

// v17.3.0: MINIMAL STATE AUTHORITY - signalState determines badge only
function getCardDisplay(card: SymbolCardState) {
  const state = card.signalState || "NONE";
  
  let badgeLabel: string;
  let borderClass: string;
  let badgeClass: string;
  
  switch (state) {
    case "ACTIVE_CONFIRMED":
      badgeLabel = "CONFIRMED";
      borderClass = "border-green-500";
      badgeClass = "bg-green-950 text-green-300 border-green-700";
      break;
      
    case "ACTIVE_SNIPER":
      badgeLabel = "SNIPER";
      borderClass = "border-cyan-500";
      badgeClass = "bg-cyan-950 text-cyan-300 border-cyan-700";
      break;
      
    case "BUILDING":
      badgeLabel = "BUILDING";
      borderClass = "border-amber-600";
      badgeClass = "bg-amber-950 text-amber-300 border-amber-700";
      break;
      
    default: // NONE
      badgeLabel = "NO SETUP";
      borderClass = "border-zinc-800";
      badgeClass = "bg-zinc-900 text-zinc-500 border-zinc-700";
      break;
  }
  
  return {
    badgeLabel,
    borderClass,
    badgeClass,
    hasTradePlan: card.targetPrices !== null && card.riskReward !== null,
  };
}

function SymbolCard({ card }: { card: SymbolCardState }) {
  const isLoading = card.source === "bootstrap";
  
  // v17.3.0: Get minimal display info from signalState only
  const display = getCardDisplay(card);
  
  // v17.3.0: Bias colors (from htf4hTrend only)
  const biasColor = (bias: string): string => {
    if (bias === "BULLISH") return "text-green-400";
    if (bias === "BEARISH") return "text-red-400";
    return "text-zinc-400";
  };

  const htfBias = card.htf4hTrend;
  const isFallback = card.degraded;

  return (
    <div className={`rounded-lg border ${display.borderClass} p-5 bg-[#0f0f0f] text-white flex flex-col gap-4`}>

      {/* HEADER: Symbol + Price + Badge */}
      <div className="flex items-start justify-between">
        <div>
          <div className="flex items-center gap-2">
            <h2 className="text-xl font-bold tracking-tight">{card.symbol}/USD</h2>
            {isFallback && (
              <span className="text-[10px] px-2 py-0.5 rounded border border-orange-800 bg-orange-950 text-orange-400 tracking-wider">
                FALLBACK
              </span>
            )}
          </div>
          <span className="text-2xl font-mono font-bold text-white tabular-nums mt-0.5 block">
            {isLoading ? "—" : `$${fmt(card.price)}`}
          </span>
          {/* v17.3.0: Canonical subtitle - signalState, direction, marketClass only */}
          <p className="text-[10px] text-zinc-500 mt-1">
            {isLoading ? "Loading..." : `${card.signalState} ${card.direction} - ${card.marketClass}`}
          </p>
        </div>
        <span className={`text-xs px-3 py-1.5 rounded border font-semibold tracking-wider ${display.badgeClass}`}>
          {isLoading ? "LOADING" : display.badgeLabel}
        </span>
      </div>

      {/* MARKET STRUCTURE */}
      <div className="border border-zinc-800 rounded p-3 space-y-2">
        <p className="text-[10px] tracking-[0.2em] text-zinc-500 uppercase">Market Structure</p>
        <div className="grid grid-cols-2 gap-x-4 gap-y-1.5">
          <div className="flex items-center justify-between">
            <span className="text-xs text-zinc-500">HTF (4H)</span>
            <span className={`text-xs font-semibold ${biasColor(htfBias)}`}>{htfBias}</span>
          </div>
          <div className="flex items-center justify-between">
            <span className="text-xs text-zinc-500">LTF (15M)</span>
            <span className={`text-xs font-semibold ${biasColor(card.execution15mState === "EXPANDING" ? "BULLISH" : card.execution15mState === "COMPRESSING" ? "BEARISH" : "NEUTRAL")}`}>
              {card.execution15mState}
            </span>
          </div>
        </div>
      </div>

      {/* v17.3.0: Trade Readiness (only show if score exists) */}
      {card.tradeReadinessScore !== null && (
        <div className="border border-zinc-800 rounded p-3">
          <div className="flex items-center justify-between">
            <p className="text-[10px] tracking-[0.2em] text-zinc-500 uppercase">Readiness</p>
            <span className="text-lg font-mono font-bold text-white tabular-nums">
              {Math.round(card.tradeReadinessScore)}%
            </span>
          </div>
          <div className="w-full bg-zinc-800 rounded h-1 mt-1.5">
            <div
              className={`${
                card.tradeReadinessScore >= 75 ? "bg-green-500" :
                card.tradeReadinessScore >= 60 ? "bg-cyan-500" :
                "bg-amber-500"
              } h-1 rounded transition-all`}
              style={{ width: `${card.tradeReadinessScore}%` }}
            />
          </div>
        </div>
      )}

      {/* v17.3.0: CONDITIONAL - Trade plan only when tradePlan !== null */}
      {card.targetPrices && card.riskReward !== null && (
        <div className="border border-zinc-800 rounded p-3 space-y-1.5">
          <div className="flex items-center justify-between">
            <p className="text-[10px] tracking-[0.2em] text-zinc-500 uppercase">{display.badgeLabel} Entry</p>
            <p className={`text-xs font-bold tracking-wider uppercase ${
              card.direction === "LONG" ? "text-cyan-400" : "text-pink-400"
            }`}>
              {card.direction}
            </p>
          </div>
          <div className="text-sm font-mono space-y-1">
            <div className="flex justify-between"><span className="text-zinc-400">Entry</span><span className="text-cyan-400">${fmt(card.price)}</span></div>
            <div className="flex justify-between"><span className="text-zinc-400">TP1</span><span className="text-green-400">${fmt(card.targetPrices?.tp1)}</span></div>
            <div className="flex justify-between"><span className="text-zinc-400">TP2</span><span className="text-green-400">${fmt(card.targetPrices?.tp2)}</span></div>
            <div className="flex justify-between"><span className="text-zinc-400">SL</span><span className="text-red-400">${fmt(card.targetPrices?.sl)}</span></div>
            <div className="flex justify-between pt-1.5 border-t border-zinc-700">
              <span className="text-zinc-400">R:R</span>
              <span className="text-green-400 font-bold">{card.riskReward.toFixed(1)}:1</span>
            </div>
          </div>
        </div>
      )}

      {/* Footer: source note */}
      <p className="text-[10px] text-zinc-600 text-center">
        {isLoading ? "Waiting for live feed..." : card.notes}
      </p>
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
