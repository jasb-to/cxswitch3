"use client";

import useSWR from "swr";
import { useState, useEffect, useMemo } from "react";
import type { SymbolCardState } from "@/lib/strategy-v6";
import { getMarketStatus } from "@/lib/market-status";

const VERSION = "v6.8.0";
const STALE_THRESHOLD_MS = 6 * 60_000;

// Bootstrap cards for initial page load (before first cron run)
const BOOTSTRAP_CARDS: SymbolCardState[] = [
  {
    symbol: "BTC",
    price: 0,
    source: "bootstrap",
    degraded: true,
    direction: "NEUTRAL",
    mode: "NONE",
    confidence: 0,
    structure: "NO_STRUCTURE",
    checklist: { trend4H: false, breakout15M: false, trigger5M: false, volatility: false, volume: false },
    triggerActive: false,
    notes: "Loading market snapshot...",
    updatedAt: new Date().toISOString(),
  },
  {
    symbol: "ETH",
    price: 0,
    source: "bootstrap",
    degraded: true,
    direction: "NEUTRAL",
    mode: "NONE",
    confidence: 0,
    structure: "NO_STRUCTURE",
    checklist: { trend4H: false, breakout15M: false, trigger5M: false, volatility: false, volume: false },
    triggerActive: false,
    notes: "Loading market snapshot...",
    updatedAt: new Date().toISOString(),
  },
  {
    symbol: "SOL",
    price: 0,
    source: "bootstrap",
    degraded: true,
    direction: "NEUTRAL",
    mode: "NONE",
    confidence: 0,
    structure: "NO_STRUCTURE",
    checklist: { trend4H: false, breakout15M: false, trigger5M: false, volatility: false, volume: false },
    triggerActive: false,
    notes: "Loading market snapshot...",
    updatedAt: new Date().toISOString(),
  },
];

const fetcher = (url: string) =>
  fetch(url, { cache: "no-store" }).then((r) => r.json());

function fmt(n: number) {
  return n.toLocaleString("en-US", { minimumFractionDigits: 2, maximumFractionDigits: 2 });
}

function StrategyRow({ title, setups, mode }: { title: string; setups: any[]; mode: string }) {
  const filtered = setups.filter((s) => s.mode === mode);
  
  if (filtered.length === 0) {
    return (
      <div className="border border-zinc-800 bg-zinc-950 p-5 rounded-lg">
        <p className="text-[10px] tracking-[0.22em] text-zinc-500 mb-4">{title}</p>
        <p className="text-[12px] text-zinc-600">No {mode.toLowerCase()} signals</p>
      </div>
    );
  }

  return (
    <div className="border border-zinc-800 bg-zinc-950 p-5 rounded-lg">
      <p className="text-[10px] tracking-[0.22em] text-zinc-500 mb-4">{title}</p>
      <div className="flex flex-col gap-3">
        {filtered.map((setup, idx) => {
          const directionColor = setup.direction === "LONG" ? "text-green-400" : setup.direction === "SHORT" ? "text-red-400" : "text-zinc-400";
          return (
            <div key={idx} className="border border-zinc-700 bg-zinc-900 p-3 rounded flex items-center justify-between">
              <div className="flex items-center gap-3">
                <span className="font-bold text-[14px] text-white">{setup.symbol}</span>
                <span className={`text-[11px] tracking-[0.15em] font-semibold ${directionColor}`}>
                  {setup.direction}
                </span>
              </div>
              <div className="flex items-center gap-4">
                <span className="text-[12px] text-zinc-400">
                  Price: <span className="text-white font-mono">${fmt(setup.price)}</span>
                </span>
                <span className="text-[12px] text-zinc-400">
                  Score: <span className="text-green-400 font-mono">{setup.score}</span>
                </span>
              </div>
            </div>
          );
        })}
      </div>
    </div>
  );
}

function SymbolCard({ card }: { card: SymbolCardState }) {
  // Direction-only coloring
  let directionBorder = "border-[#2a2a2a]";
  let directionText = "text-zinc-400";
  
  if (card.direction === "LONG") {
    directionBorder = "border-green-500";
    directionText = "text-green-400";
  } else if (card.direction === "SHORT") {
    directionBorder = "border-red-500";
    directionText = "text-red-400";
  }

  // Get market status from source
  const marketStatus = getMarketStatus(card.source);
  
  // Status badge colors
  const statusBgMap = {
    "green": "bg-emerald-950",
    "yellow": "bg-amber-950",
    "gray": "bg-zinc-900",
  };
  
  const statusBorderMap = {
    "green": "border-emerald-700",
    "yellow": "border-amber-700",
    "gray": "border-zinc-700",
  };
  
  const statusTextMap = {
    "green": "text-emerald-300",
    "yellow": "text-amber-300",
    "gray": "text-zinc-400",
  };

  // Price always displays (never null)
  const displayPrice = card.price > 0 ? `$${fmt(card.price)}` : "NO DATA";

  // FIX 5: Show clean state labels instead of NO_STRUCTURE
  let displayStructure = card.structure;
  let displayMode = card.mode;
  
  if (displayStructure === "NO_STRUCTURE") {
    displayStructure = "MONITORING";
  }
  if (displayMode === "NONE") {
    displayMode = "WATCHING";
  }

  return (
    <div className="rounded-xl border border-[#2a2a2a] p-5 bg-[#111111] text-white">
      {/* HEADER: Symbol + Status Badge + Price */}
      <div className="flex items-start justify-between mb-4">
        <div className="flex items-center gap-3">
          <h3 className="text-lg font-bold tracking-tight">{card.symbol}/USD</h3>
          <span className={`text-xs px-2.5 py-1 rounded border ${statusBgMap[marketStatus.color]} ${statusBorderMap[marketStatus.color]} ${statusTextMap[marketStatus.color]}`}>
            {marketStatus.label}
          </span>
        </div>
      </div>

      {/* PRICE - Large display (ALWAYS shown) */}
      <div className="mb-4">
        <div className="text-3xl font-bold text-white">{displayPrice}</div>
        <div className="mt-2 text-sm text-zinc-400">
          {displayStructure} • {displayMode}
        </div>
        <div className="text-sm text-zinc-500">
          Confidence {card.confidence}%
        </div>
      </div>

      {/* CHECKLIST - Monochrome */}
      <div className="space-y-2 mt-4 border-t border-zinc-800 pt-4">
        <ChecklistItem label="4H Trend" pass={card.checklist.trend4H} />
        <ChecklistItem label="15M Structure" pass={card.checklist.breakout15M} />
        <ChecklistItem label="5M Trigger" pass={card.checklist.trigger5M} />
        <ChecklistItem label="Volatility" pass={card.checklist.volatility} />
        <ChecklistItem label="Volume" pass={card.checklist.volume} />
      </div>

      {/* STATUS NOTE - Subtle */}
      {card.notes && (
        <div className="mt-4 text-xs text-zinc-500">
          {card.notes}
        </div>
      )}
    </div>
  );
}

function ChecklistItem({ label, pass }: { label: string; pass: boolean }) {
  return (
    <div className="flex items-center justify-between text-sm">
      <span className="text-zinc-300">{label}</span>
      <span className={pass ? "text-green-400" : "text-zinc-600"}>
        {pass ? "✓" : "•"}
      </span>
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

        {/* SNIPER & CONFIRMED STRATEGIES - 1 COLUMN, 2 ROWS */}
        <div className="flex flex-col gap-4">
          <StrategyRow title="🚀 SNIPER SIGNALS" setups={setups} mode="SNIPER" />
          <StrategyRow title="✅ CONFIRMED SIGNALS" setups={setups} mode="CONFIRMED" />
        </div>

        <footer className="border-t border-zinc-800 pt-4 flex items-center justify-between">
          <p className="text-[10px] tracking-[0.2em] text-zinc-700">{VERSION} SCANNER</p>
          <p className="text-[10px] tracking-[0.2em] text-zinc-700">
            4H BREAKOUT &nbsp;·&nbsp; 15M CONFIDENCE &nbsp;·&nbsp; 5M TRIGGER
          </p>
        </footer>
      </div>
    </main>
  );
}
