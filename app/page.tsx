"use client";

import useSWR from "swr";
import { useState, useEffect } from "react";
import type { SymbolCardState } from "@/lib/strategy-v6";
import { getMarketStatus } from "@/lib/market-status";
import { EMPTY_SNAPSHOT } from "@/lib/canonical-snapshot";
import {
  getFinalState,
  safePercent,
  safeBarWidth,
  getReadinessColorClass,
  getReadinessBarClass,
  getStateColorClass,
  type UIState,
} from "@/lib/final-clean-state-machine";

const VERSION = "vFINAL";
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
    marketReadinessState: "BUILDING",
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
    marketReadinessState: "BUILDING",
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
    marketReadinessState: "BUILDING",
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

function fmt(n: number) {
  return n.toLocaleString("en-US", { minimumFractionDigits: 2, maximumFractionDigits: 2 });
}

/**
 * LIVE TRADE ANALYSIS: Operator-grade market intelligence
 * Rules:
 * - BTC: If sniper=false and no expansion → BLOCKED
 * - ETH: If breakout pending → WATCH
 * - SOL: If sniper passed but execution blocked → CLOSEST SETUP
 */
function getLiveTradeAnalysis(
  symbol: string,
  state: UIState,
  execution15mState?: string
): { label: string; color: string; description: string } {
  if (symbol === "BTC") {
    if (state === "BUILDING" && execution15mState !== "EXPANDING") {
      return {
        label: "BLOCKED",
        color: "text-red-400",
        description: "No expansion/compression"
      };
    }
    return {
      label: "MONITORING",
      color: "text-yellow-400",
      description: "Awaiting structure"
    };
  }
  
  if (symbol === "ETH") {
    if (state === "SNIPER" && execution15mState === "BREAKOUT_READY") {
      return {
        label: "WATCH",
        color: "text-amber-400",
        description: "Needs breakout confirmation"
      };
    }
    if (state === "SNIPER") {
      return {
        label: "WATCH",
        color: "text-amber-400",
        description: "Entry forming"
      };
    }
    return {
      label: "STANDBY",
      color: "text-zinc-400",
      description: "Awaiting signal"
    };
  }
  
  if (symbol === "SOL") {
    if (state === "SNIPER") {
      return {
        label: "CLOSEST SETUP",
        color: "text-cyan-400",
        description: "Blocked by 4H structure"
      };
    }
    return {
      label: "MONITORING",
      color: "text-yellow-400",
      description: "Awaiting expansion"
    };
  }
  
  return {
    label: "NEUTRAL",
    color: "text-zinc-400",
    description: "No setup"
  };
}

function getDecisionText(state: UIState): { action: string; guidance: string } {
  // Decision text derives from marketReadinessState, not score
  switch (state) {
    case "BUILDING":
      return {
        action: "DO NOT TRADE",
        guidance: "Waiting for structure"
      };
    case "SNIPER":
      return {
        action: "WATCH ZONE",
        guidance: "Entry forming"
      };
    case "CONFIRMED":
      return {
        action: "READY TO TRADE",
        guidance: "Entry active"
      };
    default:
      return {
        action: "DO NOT TRADE",
        guidance: "Waiting for structure"
      };
  }
}

function TradeDecisionPanel({ card }: { card: SymbolCardState }) {
  const uiState: UIState = getFinalState(card);
  
  // Trade readiness from backend (canonical field)
  const readiness = card.tradeReadinessScore ?? 0;
  
  // Direction colors
  const directionColor = card.direction === "LONG" ? "text-green-400" : card.direction === "SHORT" ? "text-red-400" : "text-zinc-400";
  const directionBg = card.direction === "LONG" ? "bg-green-950" : card.direction === "SHORT" ? "bg-red-950" : "bg-zinc-900";
  const directionBorder = card.direction === "LONG" ? "border-green-700" : card.direction === "SHORT" ? "border-red-700" : "border-zinc-700";
  
  // Trade readiness styling - use normalized readiness value
  const readinessScoreColor = getReadinessColorClass(readiness);
  const readinessBgBar = getReadinessBarClass(readiness);
  
  // Decision text derives from state
  const { action, guidance } = getDecisionText(uiState);
  
  // v1 FIX: Display signal state from card (ACTIVE_SNIPER, BUILDING, etc)
  const signalState = (card as any).signalState || "NEUTRAL";
  const isActiveSignal = signalState === "ACTIVE_SNIPER" || signalState === "ACTIVE_CONFIRMED";

  return (
    <div className={`rounded-lg border ${directionBorder} p-5 bg-[#0f0f0f] text-white space-y-4`}>
      {/* HEADER: Symbol, Status, Direction, Price */}
      <div className="flex items-start justify-between gap-4">
        <div className="flex-1">
          <h2 className="text-2xl font-bold tracking-tight">{card.symbol}/USD</h2>
          <span className={`text-sm font-semibold ${directionColor}`}>{card.direction}</span>
        </div>
        <div className="text-right">
          <span className={`inline-block text-xs px-3 py-1 rounded border ${directionBg} ${directionBorder} ${directionColor} mb-2`}>
            {uiState.toUpperCase()}
          </span>
          {/* v1 FIX: Show signal state badge if ACTIVE */}
          {isActiveSignal && (
            <span className={`inline-block text-xs px-3 py-1 rounded border ml-2 ${
              signalState === "ACTIVE_SNIPER" ? "border-cyan-700 bg-cyan-950 text-cyan-400" : "border-green-700 bg-green-950 text-green-400"
            }`}>
              {signalState}
            </span>
          )}
          <p className="text-2xl font-mono font-bold text-white">${fmt(card.price)}</p>
        </div>
      </div>

      {/* MARKET BIAS: Single line 4H / 15M */}
      <div className="border-t border-zinc-800 pt-3 flex items-center justify-between text-sm">
        <span className="text-zinc-500">Market Bias:</span>
        <span className="flex gap-4">
          <span>
            4H: <span className={card.htf4hTrend === "BULLISH" ? "text-green-400" : card.htf4hTrend === "BEARISH" ? "text-red-400" : "text-zinc-400"}>
              {card.htf4hTrend || "—"}
            </span>
          </span>
          <span>
            15M: <span className={
              card.execution15mState === "BREAKOUT_READY" ? "text-cyan-400" : 
              card.execution15mState === "EXPANDING" ? "text-green-400" : 
              card.execution15mState === "COMPRESSING" ? "text-amber-400" : 
              "text-zinc-400"
            }>
              {card.execution15mState || "—"}
            </span>
          </span>
        </span>
      </div>

      {/* TRADE READINESS BAR: 0-100% with colors - uses normalized readiness */}
      <div className="border-t border-zinc-800 pt-3 space-y-2">
        <div className="flex items-center justify-between">
          <p className="text-xs text-zinc-500 uppercase tracking-wider font-semibold">Trade Readiness</p>
          <span className={`text-lg font-mono font-bold ${readinessScoreColor}`}>
            {safePercent(readiness)}
          </span>
        </div>
        <div className="w-full bg-zinc-800 rounded h-3">
          <div 
            className={`${readinessBgBar} h-3 rounded transition-all`} 
            style={{ width: safeBarWidth(readiness) }} 
          />
        </div>
      </div>

      {/* DECISION BOX: Big and obvious - the main decision */}
      <div className="border-t border-zinc-800 pt-4 bg-zinc-900 p-4 rounded border border-zinc-700">
        <p className={`text-lg font-bold ${
          action === "DO NOT TRADE" ? "text-red-400" :
          action === "WATCH ZONE" ? "text-amber-400" :
          "text-green-400"
        }`}>
          {action}
        </p>
        <p className="text-sm text-zinc-400 mt-1">{guidance}</p>
      </div>

      {/* ENTRY DATA: Only if SNIPER or CONFIRMED */}
      {(uiState === "SNIPER" || uiState === "CONFIRMED") && card.targetPrices && (
        <div className="border-t border-zinc-800 pt-3 text-sm font-mono space-y-1">
          <div className="flex justify-between"><span className="text-zinc-400">Entry:</span> <span className="text-cyan-400">${fmt(card.price)}</span></div>
          <div className="flex justify-between"><span className="text-zinc-400">TP1:</span> <span className="text-green-400">${fmt(card.targetPrices.tp1)}</span></div>
          <div className="flex justify-between"><span className="text-zinc-400">TP2:</span> <span className="text-green-400">${fmt(card.targetPrices.tp2)}</span></div>
          <div className="flex justify-between"><span className="text-zinc-400">SL:</span> <span className="text-red-400">${fmt(card.targetPrices.sl)}</span></div>
          <div className="flex justify-between mt-2 pt-2 border-t border-zinc-700"><span className="text-zinc-400">R:R:</span> <span className="text-green-400 font-bold">{card.riskReward?.toFixed(1) ?? "—"}:1</span></div>
        </div>
      )}
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
    { revalidateOnFocus: false, dedupingInterval: 2000 }
  );

  // NORMALIZE API RESPONSE: Handle both nested and flat response shapes
  // API may return { snapshot: { ready, cards, ... } } or { ready, cards, ... }
  const raw = data?.snapshot ?? data ?? null;

  // STRICT VALIDATION: Only Dashboard interprets SWR data
  const isValid =
    raw &&
    raw?.ready === true &&
    Array.isArray(raw?.cards) &&
    raw.cards.length === 3;

  if (!isValid) {
    return <DashboardBootstrap />;
  }

  // SANITISED SNAPSHOT: Only pass validated data downstream
  // No child component may access raw SWR data
  const snapshot = {
    cards: raw.cards,
    setups: raw.setups ?? [],
    updatedAt: raw.updatedAt ?? "",
  };

  return (
    <DashboardLive
      snapshot={snapshot}
      now={now}
      isHydrated={isHydrated}
      isValidating={isValidating}
      mutate={mutate}
      tg={tg}
      setTg={setTg}
      tgMsg={tgMsg}
      setTgMsg={setTgMsg}
      testTelegram={async () => {
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
      }}
    />
  );
}

function DashboardBootstrap() {
  return (
    <main className="min-h-screen bg-[#0a0a0a] text-white font-mono">
      <header className="border-b border-zinc-800 px-6 py-3 flex items-center justify-between">
        <p className="text-[11px] tracking-[0.22em] text-zinc-500">
          MULTI-TIMEFRAME CRYPTO SIGNAL ANALYZER &nbsp;·&nbsp; REAL-TIME INTELLIGENCE
        </p>
        <p className="text-[11px] tracking-[0.15em] text-zinc-600">{VERSION}</p>
      </header>

      <div className="px-6 py-6 max-w-[1400px] mx-auto flex flex-col gap-6">
        <div className="grid grid-cols-1 md:grid-cols-3 gap-4">
          <div className="col-span-full md:col-span-2">
            <div className="border border-zinc-800 bg-zinc-950 p-8 flex items-center justify-center text-center">
              <p className="text-zinc-400 text-sm">Loading market data...</p>
            </div>
          </div>
          <div className="border border-zinc-800 bg-zinc-950 p-5">
            <p className="text-[10px] tracking-[0.22em] text-zinc-500 mb-4">STATUS</p>
            <p className="text-sm text-zinc-500">Awaiting snapshot...</p>
          </div>
        </div>

        <div className="grid grid-cols-1 md:grid-cols-3 gap-4">
          {BOOTSTRAP_CARDS.map((card) => (
            <TradeDecisionPanel key={card.symbol} card={card} />
          ))}
        </div>
      </div>
    </main>
  );
}

function DashboardLive({
  snapshot,
  now,
  isHydrated,
  isValidating,
  mutate,
  tg,
  setTg,
  tgMsg,
  setTgMsg,
  testTelegram,
}: {
  snapshot: {
    cards: SymbolCardState[];
    setups: any[];
    updatedAt: string;
  };
  now: number;
  isHydrated: boolean;
  isValidating: boolean;
  mutate: () => void;
  tg: "idle" | "sending" | "ok" | "error";
  setTg: (v: "idle" | "sending" | "ok" | "error") => void;
  tgMsg: string;
  setTgMsg: (v: string) => void;
  testTelegram: () => Promise<void>;
}) {
  const { cards, setups, updatedAt } = snapshot;
  const fetchedAtMs = updatedAt ? new Date(updatedAt).getTime() : 0;
  const isStale = isHydrated && fetchedAtMs > 0 && now > 0 && (now - fetchedAtMs) > STALE_THRESHOLD_MS;
  const lastUpdateTime = isHydrated && updatedAt ? new Date(updatedAt).toLocaleTimeString("en-GB", { hour12: false }) : "—";
  const assetCount = cards.length;
  const activeCount = (raw as any)?.signalCount ?? 0;  // Use derived field from snapshot contract

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

            {/* LIVE TRADE ANALYSIS: Operator-grade market intelligence */}
            <div className="border-t border-zinc-800 pt-4 space-y-2">
              <p className="text-[10px] tracking-[0.22em] text-zinc-500 mb-3">LIVE TRADE ANALYSIS</p>
              {cards.map((card) => {
                const state = getFinalState(card);
                const analysis = getLiveTradeAnalysis(card.symbol, state, card.execution15mState);
                return (
                  <div key={card.symbol} className="flex items-center justify-between text-sm">
                    <span className="text-zinc-400">{card.symbol}</span>
                    <span className={`${analysis.color} font-semibold text-sm`}>{analysis.label}</span>
                    <span className="text-zinc-600 text-xs">{analysis.description}</span>
                  </div>
                );
              })}
            </div>

            {/* BUTTONS: TEST TG & REFRESH */}
            <div className="border-t border-zinc-800 pt-4 flex gap-2">
              <button
                onClick={testTelegram}
                className={`flex-1 border text-[10px] tracking-[0.15em] py-2 transition-colors ${
                  tg === "ok"
                    ? "border-green-700 text-green-400"
                    : tg === "error"
                    ? "border-red-700 text-red-400"
                    : "border-zinc-700 text-zinc-500 hover:border-zinc-600 hover:text-zinc-300"
                }`}
              >
                {tg === "sending" ? "TEST..." : "TEST TG"}
              </button>
              <button
                onClick={() => mutate()}
                className="flex-1 border border-zinc-700 text-zinc-500 hover:border-zinc-600 hover:text-zinc-300 text-[10px] tracking-[0.15em] py-2 transition-colors"
              >
                {isValidating ? "REFRESH..." : "REFRESH"}
              </button>
            </div>

            {tgMsg && (
              <p className={`text-[10px] text-center ${tg === "ok" ? "text-green-400" : "text-red-400"}`}>
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
              <TradeDecisionPanel key={card.symbol} card={card} />
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
