"use client";

import useSWR from "swr";
import { useState, useEffect, useMemo } from "react";
import type { SymbolCardState } from "@/lib/strategy-v6";

const VERSION = "v6.2.0";
const STALE_THRESHOLD_MS = 6 * 60_000;

const fetcher = (url: string) => fetch(url).then((r) => r.json());

function fmt(n: number) {
  return n.toLocaleString("en-US", { minimumFractionDigits: 2, maximumFractionDigits: 2 });
}

function ModeBadge({ mode }: { mode: string }) {
  const styles: Record<string, string> = {
    SNIPER: "border-[#d4a017] text-[#d4a017]",
    CONFIRMED: "border-[#22c55e] text-[#22c55e]",
    NONE: "border-[#444] text-[#444]",
  };
  return (
    <span className={`border text-[11px] px-2.5 py-0.5 tracking-[0.15em] font-mono ${styles[mode] ?? styles.NONE}`}>
      {mode}
    </span>
  );
}

function DirectionBadge({ direction }: { direction: string }) {
  const styles: Record<string, string> = {
    LONG: "border-[#22c55e] text-[#22c55e]",
    SHORT: "border-[#ef4444] text-[#ef4444]",
    NEUTRAL: "border-[#666] text-[#666]",
  };
  return (
    <span className={`text-[11px] px-2 py-0.5 tracking-[0.1em] font-mono ${styles[direction] ?? styles.NEUTRAL}`}>
      {direction}
    </span>
  );
}

function SymbolCard({ card }: { card: SymbolCardState }) {
  let cardBorder = "border-[#1e1e1e]";
  let cardBg = "bg-[#111]";
  let headerBg = "bg-[#111]";

  if (card.degraded) {
    cardBorder = "border-[#b45309]";
    cardBg = "bg-[#0a0a0a]";
    headerBg = "bg-[#451a03]";
  } else if (card.mode === "SNIPER" || card.mode === "CONFIRMED") {
    if (card.direction === "LONG") {
      cardBorder = "border-[#166534]";
      cardBg = "bg-[#0a0a0a]";
      headerBg = "bg-[#052e16]";
    } else if (card.direction === "SHORT") {
      cardBorder = "border-[#7f1d1d]";
      cardBg = "bg-[#0a0a0a]";
      headerBg = "bg-[#450a0a]";
    }
  }

  const displayPrice = card.price > 0 ? `$${fmt(card.price)}` : "—";
  const sourceStatus = card.degraded ? "DEGRADED" : "LIVE";
  const sourceColor = card.degraded ? "text-[#b45309]" : "text-[#22c55e]";

  return (
    <article className={`border ${cardBorder} ${cardBg} flex flex-col overflow-hidden`}>
      {/* HEADER */}
      <div className={`${headerBg} px-5 py-4 flex items-center justify-between border-b ${cardBorder}`}>
        <div className="flex items-center gap-3">
          <span className="text-[13px] font-bold tracking-[0.05em]">{card.symbol}/USD</span>
          <span className={`text-[10px] px-2 py-0.5 tracking-[0.1em] border ${sourceColor} ${card.degraded ? "border-[#b45309]" : "border-[#22c55e]"}`}>
            {sourceStatus}
          </span>
        </div>
        <span className="font-mono text-[13px]">{displayPrice}</span>
      </div>

      {/* STRUCTURE + MODE + CONFIDENCE */}
      <div className="px-5 py-3 border-b border-[#1e1e1e] flex items-center justify-between gap-3">
        <div className="flex items-center gap-2">
          <span className="text-[11px] text-[#888]">{card.structure}</span>
          <span className="text-[11px] text-[#666]">{card.direction}</span>
        </div>
        <div className="flex items-center gap-2">
          <ModeBadge mode={card.mode} />
          <span className="text-[11px] text-[#aaa] font-mono">
            {card.confidence}%
          </span>
        </div>
      </div>

      {/* CHECKLIST */}
      <div className="px-5 py-4 border-b border-[#1e1e1e] flex flex-col gap-2">
        <p className="text-[10px] text-[#666] tracking-[0.1em] mb-2">CHECKLIST</p>
        <div className="grid grid-cols-2 gap-2 text-[11px]">
          <div className="flex items-center gap-2">
            <span className={`w-4 h-4 flex items-center justify-center text-[9px] border ${
              card.checklist.trend4H ? "border-[#22c55e] text-[#22c55e]" : "border-[#444] text-[#444]"
            }`}>
              {card.checklist.trend4H ? "✓" : "○"}
            </span>
            <span className={card.checklist.trend4H ? "text-[#aaa]" : "text-[#666]"}>4H Trend</span>
          </div>
          <div className="flex items-center gap-2">
            <span className={`w-4 h-4 flex items-center justify-center text-[9px] border ${
              card.checklist.breakout15M ? "border-[#22c55e] text-[#22c55e]" : "border-[#444] text-[#444]"
            }`}>
              {card.checklist.breakout15M ? "✓" : "○"}
            </span>
            <span className={card.checklist.breakout15M ? "text-[#aaa]" : "text-[#666]"}>15M Structure</span>
          </div>
          <div className="flex items-center gap-2">
            <span className={`w-4 h-4 flex items-center justify-center text-[9px] border ${
              card.checklist.trigger5M ? "border-[#22c55e] text-[#22c55e]" : "border-[#444] text-[#444]"
            }`}>
              {card.checklist.trigger5M ? "✓" : "○"}
            </span>
            <span className={card.checklist.trigger5M ? "text-[#aaa]" : "text-[#666]"}>5M Trigger</span>
          </div>
          <div className="flex items-center gap-2">
            <span className={`w-4 h-4 flex items-center justify-center text-[9px] border ${
              card.checklist.volatility ? "border-[#22c55e] text-[#22c55e]" : "border-[#444] text-[#444]"
            }`}>
              {card.checklist.volatility ? "✓" : "○"}
            </span>
            <span className={card.checklist.volatility ? "text-[#aaa]" : "text-[#666]"}>Volatility</span>
          </div>
          <div className="col-span-2 flex items-center gap-2">
            <span className={`w-4 h-4 flex items-center justify-center text-[9px] border ${
              card.checklist.volume ? "border-[#22c55e] text-[#22c55e]" : "border-[#444] text-[#444]"
            }`}>
              {card.checklist.volume ? "✓" : "○"}
            </span>
            <span className={card.checklist.volume ? "text-[#aaa]" : "text-[#666]"}>Volume Confirmation</span>
          </div>
        </div>
      </div>

      {/* NOTES */}
      {card.notes && (
        <div className="px-5 py-3 flex flex-col gap-1">
          <p className="text-[10px] text-[#666] tracking-[0.1em]">STATUS</p>
          <p className="text-[11px] text-[#aaa] italic">{card.notes}</p>
        </div>
      )}
    </article>
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

  const { data, mutate, isValidating } = useSWR<{ cards: SymbolCardState[]; setups: any[]; fetchedAt: number }>(
    "/api/signals",
    fetcher,
    { refreshInterval: 30_000, keepPreviousData: true, revalidateOnFocus: false }
  );

  const cards = data?.cards ?? [];
  const setups = data?.setups ?? [];
  const fetchedAt = data?.fetchedAt ?? 0;
  const isStale = isHydrated && fetchedAt > 0 && now > 0 && (now - fetchedAt) > STALE_THRESHOLD_MS;
  const lastUpdateTime = isHydrated && fetchedAt > 0 ? new Date(fetchedAt).toLocaleTimeString("en-GB", { hour12: false }) : "—";

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
      <header className="border-b border-[#1a1a1a] px-6 py-3 flex items-center justify-between">
        <p className="text-[11px] tracking-[0.22em] text-[#666]">
          MULTI-TIMEFRAME CRYPTO SIGNAL ANALYZER &nbsp;·&nbsp; REAL-TIME INTELLIGENCE
        </p>
        <p className="text-[11px] tracking-[0.15em] text-[#333]">{VERSION}</p>
      </header>

      <div className="px-6 py-6 max-w-[1400px] mx-auto flex flex-col gap-6">
        {isStale && (
          <div className="border border-[#7f6a00] bg-[#1a1400] px-4 py-3 text-[12px] tracking-[0.1em] text-[#d4a017]">
            STALE DATA — WAITING FOR NEXT SCAN
          </div>
        )}

        <div className="grid grid-cols-1 md:grid-cols-3 gap-4">
          <div className="md:col-span-2 border border-[#1a1a1a] bg-[#0e0e0e] p-5 flex flex-col gap-5">
            <p className="text-[10px] tracking-[0.22em] text-[#555]">SYSTEM STATUS</p>

            <div className="flex flex-col gap-4">
              <div className="flex items-center justify-between">
                <span className="text-[13px] text-[#aaa]">Terminal</span>
                <span className="flex items-center gap-2 text-[13px] text-[#22c55e]">
                  <span className="w-2 h-2 rounded-full bg-[#22c55e]" aria-hidden />
                  LIVE
                </span>
              </div>
              <div className="flex items-center justify-between">
                <span className="text-[13px] text-[#aaa]">Telegram Bot</span>
                <span className={`flex items-center gap-2 text-[13px] ${tg === "ok" ? "text-[#22c55e]" : tg === "error" ? "text-[#ef4444]" : "text-[#888]"}`}>
                  <span className={`w-2 h-2 rounded-full ${tg === "ok" ? "bg-[#22c55e]" : tg === "error" ? "bg-[#ef4444]" : "bg-[#555]"}`} aria-hidden />
                  ACTIVE
                </span>
              </div>
              <div className="flex items-center justify-between">
                <span className="text-[13px] text-[#aaa]">Last Update</span>
                <span className="text-[13px] text-white tabular-nums">{lastUpdateTime}</span>
              </div>
            </div>

            <div className="flex gap-2">
              <button
                onClick={testTelegram}
                disabled={tg === "sending"}
                className={`flex-1 border text-[11px] tracking-[0.2em] py-3 transition-colors disabled:opacity-40 ${
                  tg === "ok"
                    ? "border-[#22c55e] text-[#22c55e]"
                    : tg === "error"
                    ? "border-[#ef4444] text-[#ef4444]"
                    : "border-[#2a2a2a] text-[#888] hover:border-[#555] hover:text-white"
                }`}
              >
                {tg === "sending" ? "SENDING..." : tg === "ok" ? "SENT OK" : tg === "error" ? "SEND FAILED" : "TEST TELEGRAM"}
              </button>
              <button
                onClick={() => mutate()}
                className="flex-1 border border-[#2a2a2a] text-[#888] hover:border-[#555] hover:text-white text-[11px] tracking-[0.2em] py-3 transition-colors"
              >
                {isValidating ? "REFRESHING..." : "REFRESH"}
              </button>
            </div>
            {tgMsg && (
              <p className={`text-[11px] text-center ${tg === "ok" ? "text-[#22c55e]" : "text-[#ef4444]"}`}>
                {tgMsg}
              </p>
            )}
          </div>

          <div className="border border-[#1a1a1a] bg-[#0e0e0e] p-5 flex flex-col gap-5">
            <p className="text-[10px] tracking-[0.22em] text-[#555]">DATA POINTS</p>
            <div className="grid grid-cols-2 gap-6 flex-1 items-start">
              <div>
                <p className="text-[10px] tracking-[0.22em] text-[#555] mb-3">ASSETS</p>
                <p className="font-bold text-5xl text-[#22c55e] tabular-nums">{assetCount}</p>
              </div>
              <div>
                <p className="text-[10px] tracking-[0.22em] text-[#555] mb-3">SIGNALS</p>
                <p className="font-bold text-5xl text-[#22c55e] tabular-nums">{activeCount}</p>
              </div>
            </div>
            <div className="border-t border-[#1a1a1a] pt-3">
              <p className="text-[10px] tracking-[0.18em] text-[#333]">
                AUTO-REFRESH 30s &nbsp;·&nbsp; KRAKEN API
              </p>
            </div>
          </div>
        </div>

        <div>
          <p className="text-[10px] tracking-[0.22em] text-[#555] mb-4">SYMBOL CARDS</p>

          <div className="grid grid-cols-1 md:grid-cols-3 gap-4">
            {cards.map((card) => (
              <SymbolCard key={card.symbol} card={card} />
            ))}
          </div>
        </div>

        <footer className="border-t border-[#1a1a1a] pt-4 flex items-center justify-between">
          <p className="text-[10px] tracking-[0.2em] text-[#2a2a2a]">SIGNAL DASHBOARD {VERSION}</p>
          <p className="text-[10px] tracking-[0.2em] text-[#2a2a2a]">
            4H BREAKOUT &nbsp;·&nbsp; 15M CONFIDENCE &nbsp;·&nbsp; 5M TRIGGER
          </p>
        </footer>
      </div>
    </main>
  );
}
