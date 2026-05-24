"use client";

import { useEffect, useState } from "react";
import type { SymbolCardState } from "@/lib/types";
import { EMPTY_SNAPSHOT } from "@/lib/canonical-snapshot";

const VERSION = "vFINAL";
const STALE_THRESHOLD_MS = 6 * 60_000;

function fmt(n: number) {
  return n.toLocaleString("en-US", { minimumFractionDigits: 2, maximumFractionDigits: 2 });
}


function TradeDecisionPanel({ card }: { card: SymbolCardState }) {
  // STRICT CONTRACT: Read ONLY from canonical state, NO fallbacks, NO inference
  const canonicalDirection = card.direction;
  const canonicalActivation = (card as any).signalState;
  const canonicalMacro = card.htf4hTrend;
  const canonicalConfidence = card.confidence ?? 0;
  
  // DEBUG: Confirm UI matches backend exactly
  console.log("[CANONICAL TRACE]", JSON.stringify({
    symbol: card.symbol,
    direction: canonicalDirection ?? null,
    activation: canonicalActivation ?? null,
    macro: canonicalMacro ?? null,
    confidence: canonicalConfidence,
  }));
  
  // If canonical activation is missing, don't render card at all
  if (!canonicalActivation) {
    return null;
  }
  
  // Direction colors - use canonical direction or default to neutral
  const directionColor = canonicalDirection === "LONG" ? "text-green-400" : canonicalDirection === "SHORT" ? "text-red-400" : "text-zinc-400";
  const directionBg = canonicalDirection === "LONG" ? "bg-green-950" : canonicalDirection === "SHORT" ? "bg-red-950" : "bg-zinc-900";
  const directionBorder = canonicalDirection === "LONG" ? "border-green-700" : canonicalDirection === "SHORT" ? "border-red-700" : "border-zinc-700";
  
  // Activation colors
  const activationColor = canonicalActivation === "ACTIVE_SNIPER" ? "text-cyan-400" : 
                          canonicalActivation === "SNIPER" ? "text-blue-400" : 
                          canonicalActivation === "CONFIRMED" ? "text-green-400" :
                          canonicalActivation === "DO_NOT_TRADE" ? "text-red-400" :
                          "text-zinc-400";
  
  return (
    <div className={`rounded-lg border ${directionBorder} p-5 bg-[#0f0f0f] text-white space-y-4`}>
      {/* HEADER: Symbol, Status, Direction, Price */}
      <div className="flex items-start justify-between gap-4">
        <div className="flex-1">
          <h2 className="text-2xl font-bold tracking-tight">{card.symbol}/USD</h2>
          <span className={`text-sm font-semibold ${directionColor}`}>{card.direction}</span>
        </div>
        <div className="text-right">
          {/* ACTIVATION BADGE: Pure display of canonicalActivation */}
          <span className={`inline-block text-xs px-3 py-1 rounded border mb-2 ${activationColor}`}>
            {canonicalActivation}
          </span>
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

      {/* STATE OF PLAY: Pure print of canonicalState - NO COMMENTARY, NO FALLBACK */}
      <div className="border-t border-zinc-800 pt-3 text-xs space-y-1">
        <p className="text-zinc-600 font-semibold uppercase tracking-wider">State of Play</p>
        <div className="flex justify-between text-zinc-400">
          <span>Direction:</span>
          <span className={canonicalDirection === "LONG" ? "text-green-400" : canonicalDirection === "SHORT" ? "text-red-400" : "text-zinc-500"}>
            {canonicalDirection ?? "—"}
          </span>
        </div>
        <div className="flex justify-between text-zinc-400">
          <span>Activation:</span>
          <span className={activationColor}>
            {canonicalActivation}
          </span>
        </div>
        <div className="flex justify-between text-zinc-400">
          <span>Macro:</span>
          <span className={canonicalMacro === "BULLISH" ? "text-green-400" : canonicalMacro === "BEARISH" ? "text-red-400" : "text-zinc-500"}>
            {canonicalMacro ?? "—"}
          </span>
        </div>
      </div>

      {/* CONFIDENCE SCORE: Signal quality indicator */}
      <div className="border-t border-zinc-800 pt-3">
        <div className="flex items-center justify-between mb-2">
          <p className="text-xs text-zinc-500 uppercase tracking-wider font-semibold">Signal Quality</p>
          <span className={`text-sm font-mono font-bold ${
            canonicalConfidence >= 75 ? "text-green-400" :
            canonicalConfidence >= 50 ? "text-yellow-400" :
            canonicalConfidence >= 25 ? "text-amber-400" :
            "text-red-400"
          }`}>
            {Math.round(canonicalConfidence)}%
          </span>
        </div>
        <div className="w-full bg-zinc-800 rounded h-2">
          <div 
            className={`${
              canonicalConfidence >= 75 ? "bg-green-500" :
              canonicalConfidence >= 50 ? "bg-yellow-500" :
              canonicalConfidence >= 25 ? "bg-amber-500" :
              "bg-red-500"
            } h-2 rounded transition-all`} 
            style={{ width: `${Math.min(100, Math.max(0, canonicalConfidence))}%` }} 
          />
        </div>
      </div>

      {/* ENTRY DATA: Only if targetPrices exists */}
      {card.targetPrices && (
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

/**
 * DETERMINISTIC RENDERING FROM BACKEND TRUTH
 *
 * Architecture:
 * - Backend owns snapshot state (cards, ready flag)
 * - Frontend is pure renderer: SWR data → render decision
 * - No derived state, no intermediate mutations, no UI state machines
 *
 * Render contract (immutable):
 * if (snap?.ready && cards.length > 0) → render LIVE
 * else → render BOOTSTRAP
 *
 * One-way data flow:
 * Backend snapshot → SWR fetch → hard type safety → deterministic render
 */

export default function Dashboard() {
  const [snap, setSnap] = useState(null);
  const [tg, setTg] = useState<"idle" | "sending" | "ok" | "error">("idle");
  const [tgMsg, setTgMsg] = useState("");
  const [now, setNow] = useState(0);
  const [isValidating, setIsValidating] = useState(false);

  // Clock tick (UI only, no state derivation)
  useEffect(() => {
    setNow(Date.now());
    const id = setInterval(() => setNow(Date.now()), 1000);
    return () => clearInterval(id);
  }, []);

  // Signals polling - 15s interval (backend cron updates canonical state)
  // NEVER poll faster than 15s - this creates unnecessary Vercel executions
  useEffect(() => {
    const POLL_INTERVAL = 15000; // 15 seconds max
    
    const poll = async () => {
      try {
        const res = await fetch("/api/signals", { cache: "no-store" });
        const json = await res.json();
        setSnap(json);
      } catch (error) {
        console.error("[POLL_ERROR] /api/signals:", error);
      }
    };

    // Initial fetch on mount
    console.log("[POLL_INIT] Signals polling started (15000ms)");
    poll();
    
    const id = setInterval(poll, POLL_INTERVAL);
    return () => {
      clearInterval(id);
      console.log("[POLL_CLEANUP] Signals polling stopped");
    };
  }, []);

  // Manual refresh handler
  const handleRefresh = async () => {
    setIsValidating(true);
    try {
      const res = await fetch("/api/signals", { cache: "no-store" });
      const json = await res.json();
      setSnap(json);
    } catch (error) {
      console.error("[REFRESH_ERROR] /api/signals:", error);
    } finally {
      setIsValidating(false);
    }
  };

  // ZERO LOGIC: Backend truth only
  // No interpretation, no derivation, no state machine
  if (!snap?.ready) {
    return <DashboardBootstrap />;
  }

  // snap.ready === true → render LIVE
  // That's it. No snapshotReady logic, no cards.length check, no conditions
  return (
    <DashboardLive
      snapshot={snap}
      now={now}
      isHydrated={true}
      isValidating={isValidating}
      mutate={handleRefresh}
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
    signalCount: number;
    activeSnipers: number;
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
  const { cards, signalCount, activeSnipers, updatedAt } = snapshot;
  const fetchedAtMs = updatedAt ? new Date(updatedAt).getTime() : 0;
  const isStale = isHydrated && fetchedAtMs > 0 && now > 0 && (now - fetchedAtMs) > STALE_THRESHOLD_MS;
  const lastUpdateTime = isHydrated && updatedAt ? new Date(updatedAt).toLocaleTimeString("en-GB", { hour12: false }) : "—";
  const assetCount = cards.length;
  // Pure render: counts come from snapshot, zero derivation
  const activeCount = signalCount;

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
