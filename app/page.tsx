"use client";

import useSWR from "swr";
import { useState, useEffect } from "react";
import type { Signal } from "@/lib/strategy";

const VERSION = "v1.0.0";
const SYMBOLS = ["BTC/USD", "ETH/USD", "SOL/USD"];
const SCAN_COOLDOWN_MS = 60_000;
const STALE_THRESHOLD_MS = 6 * 60_000;

const fetcher = (url: string) => fetch(url).then((r) => r.json());

function fmt(n: number) {
  return n.toLocaleString("en-US", { minimumFractionDigits: 2, maximumFractionDigits: 2 });
}

function Badge({ state }: { state: Signal["state"] | "EXPIRED" }) {
  const styles: Record<string, string> = {
    EARLY: "border-[#d4a017] text-[#d4a017]",
    CONFIRMED: "border-[#22c55e] text-[#22c55e]",
    END: "border-[#444] text-[#444]",
    EXPIRED: "border-[#444] text-[#444]",
  };
  return (
    <span className={`border text-[11px] px-2.5 py-0.5 tracking-[0.15em] font-mono ${styles[state] ?? styles.END}`}>
      {state === "END" ? "EXPIRED" : state}
    </span>
  );
}

function SignalCard({ symbol, signal }: { symbol: string; signal?: Signal }) {
  const isEnd = signal?.state === "END";
  const active = signal && !isEnd;

  let cardBorder = "border-[#1e1e1e]";
  let cardBg = "bg-[#111]";
  let headerBg = "bg-[#111]";

  if (active) {
    if (signal.direction === "LONG") {
      cardBorder = "border-[#166534]";
      cardBg = "bg-[#0a0a0a]";
      headerBg = "bg-[#052e16]";
    } else {
      cardBorder = "border-[#7f1d1d]";
      cardBg = "bg-[#0a0a0a]";
      headerBg = "bg-[#450a0a]";
    }
  }

  const confidence = active ? signal.confidence : 0;
  const confColor = active && signal.direction === "LONG" ? "#22c55e" : active ? "#ef4444" : "#333";

  return (
    <article className={`border ${cardBorder} ${cardBg} flex flex-col overflow-hidden`}>
      <div className={`${headerBg} px-5 py-4 flex items-center justify-between border-b ${cardBorder}`}>
        <span className="font-mono font-bold text-white text-lg tracking-wide">{symbol}</span>
        {active ? (
          <Badge state={signal.state} />
        ) : isEnd ? (
          <Badge state="END" />
        ) : (
          <span className="border border-[#2a2a2a] text-[11px] px-2.5 py-0.5 tracking-[0.15em] font-mono text-[#444]">
            NO SIGNAL
          </span>
        )}
      </div>

      <div className="p-5 flex flex-col gap-5">
        <div>
          <p className="text-[10px] tracking-[0.2em] text-[#666] mb-1">PRICE</p>
          <p className="font-mono text-3xl font-bold text-white tabular-nums">
            {active ? `$${fmt(signal.entry)}` : "—"}
          </p>
        </div>

        {active && (
          <div className="grid grid-cols-3 gap-3 border-t border-[#1e1e1e] pt-4">
            <div>
              <p className="text-[10px] tracking-[0.2em] text-[#666] mb-1.5">ENTRY</p>
              <p className="font-mono text-[14px] text-white tabular-nums">${fmt(signal.entry)}</p>
            </div>
            <div>
              <p className="text-[10px] tracking-[0.2em] text-[#666] mb-1.5">TP1</p>
              <p className="font-mono text-[14px] text-[#22c55e] tabular-nums">${fmt(signal.tp)}</p>
            </div>
            <div>
              <p className="text-[10px] tracking-[0.2em] text-[#666] mb-1.5">SL</p>
              <p className="font-mono text-[14px] text-[#ef4444] tabular-nums">${fmt(signal.sl)}</p>
            </div>
          </div>
        )}

        <div className="border-t border-[#1e1e1e] pt-4">
          <div className="flex items-center justify-between mb-2">
            <p className="text-[10px] tracking-[0.2em] text-[#666]">CONFIDENCE</p>
            <p className="font-mono text-[12px] text-[#888] tabular-nums">{confidence}%</p>
          </div>
          <div className="h-px bg-[#1e1e1e]">
            <div
              className="h-px transition-all duration-700"
              style={{ width: `${confidence}%`, backgroundColor: confColor }}
            />
          </div>
        </div>

        {active ? (
          <div>
            <p className="text-[10px] tracking-[0.2em] text-[#666] mb-1.5">DIRECTION</p>
            <p className={`font-mono text-base font-bold tracking-widest ${signal.direction === "LONG" ? "text-[#22c55e]" : "text-[#ef4444]"}`}>
              {signal.direction}
            </p>
          </div>
        ) : (
          <p className="text-[11px] tracking-[0.2em] text-[#2a2a2a]">
            {isEnd ? "SIGNAL EXPIRED" : "AWAITING BREAKOUT"}
          </p>
        )}
      </div>
    </article>
  );
}

export default function Dashboard() {
  const [tg, setTg] = useState<"idle" | "sending" | "ok" | "error">("idle");
  const [tgMsg, setTgMsg] = useState("");
  const [scanning, setScanning] = useState(false);
  const [scanCooldownEnd, setScanCooldownEnd] = useState(0);
  const [cooldownSec, setCooldownSec] = useState(0);
  const [now, setNow] = useState(0);
  const [isHydrated, setIsHydrated] = useState(false);

  useEffect(() => {
    setIsHydrated(true);
    setNow(Date.now());
    const id = setInterval(() => setNow(Date.now()), 1000);
    return () => clearInterval(id);
  }, []);

  useEffect(() => {
    if (scanCooldownEnd <= 0) { setCooldownSec(0); return; }
    const remaining = Math.max(0, Math.ceil((scanCooldownEnd - now) / 1000));
    setCooldownSec(remaining);
  }, [now, scanCooldownEnd]);

  const { data, mutate, isValidating } = useSWR<{ signals: Signal[]; fetchedAt: number }>(
    "/api/signals",
    fetcher,
    { refreshInterval: 30_000, keepPreviousData: true, revalidateOnFocus: false }
  );

  const signals: Signal[] = data?.signals ?? [];
  const fetchedAt: number = data?.fetchedAt ?? 0;
  const isStale = isHydrated && fetchedAt > 0 && now > 0 && (now - fetchedAt) > STALE_THRESHOLD_MS;
  const lastUpdateTime = isHydrated ? new Date().toLocaleTimeString("en-GB", { hour12: false }) : "—";

  const signalMap = new Map<string, Signal>(signals.map((s) => [s.symbol, s]));
  const activeCount = signals.filter((s) => s.state !== "END").length;

  const scanOnCooldown = cooldownSec > 0;

  async function scanNow() {
    if (scanning || scanOnCooldown) return;
    setScanning(true);
    try {
      await fetch("/api/scan-now", { method: "POST" });
      await mutate();
      setScanCooldownEnd(Date.now() + SCAN_COOLDOWN_MS);
    } finally {
      setScanning(false);
    }
  }

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

            <div className="flex flex-col gap-2">
              <button
                onClick={testTelegram}
                disabled={tg === "sending"}
                className={`w-full border text-[11px] tracking-[0.2em] py-3 transition-colors disabled:opacity-40 ${
                  tg === "ok"
                    ? "border-[#22c55e] text-[#22c55e]"
                    : tg === "error"
                    ? "border-[#ef4444] text-[#ef4444]"
                    : "border-[#2a2a2a] text-[#888] hover:border-[#555] hover:text-white"
                }`}
              >
                {tg === "sending" ? "SENDING..." : tg === "ok" ? "SENT OK" : tg === "error" ? "SEND FAILED" : "TEST TELEGRAM"}
              </button>
              {tgMsg && (
                <p className={`text-[11px] text-center ${tg === "ok" ? "text-[#22c55e]" : "text-[#ef4444]"}`}>
                  {tgMsg}
                </p>
              )}

              <button
                onClick={scanNow}
                disabled={scanning || scanOnCooldown}
                className="w-full border border-[#2a2a2a] text-[#888] hover:border-[#555] hover:text-white text-[11px] tracking-[0.2em] py-3 transition-colors disabled:opacity-40"
              >
                {scanning
                  ? "SCANNING..."
                  : scanOnCooldown
                  ? `NEXT MANUAL SCAN IN ${cooldownSec}s`
                  : "SCAN NOW"}
              </button>
            </div>
          </div>

          <div className="border border-[#1a1a1a] bg-[#0e0e0e] p-5 flex flex-col gap-5">
            <p className="text-[10px] tracking-[0.22em] text-[#555]">DATA POINTS</p>
            <div className="grid grid-cols-2 gap-6 flex-1 items-start">
              <div>
                <p className="text-[10px] tracking-[0.22em] text-[#555] mb-3">ASSETS</p>
                <p className="font-bold text-5xl text-[#22c55e] tabular-nums">{SYMBOLS.length}</p>
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
          <div className="flex items-center justify-between mb-4">
            <p className="text-[10px] tracking-[0.22em] text-[#555]">TRENDLINE BREAK SIGNALS</p>
            <button
              onClick={() => mutate()}
              className="text-[10px] tracking-[0.2em] text-[#444] hover:text-[#aaa] transition-colors"
            >
              {isValidating ? "REFRESHING..." : "REFRESH"}
            </button>
          </div>

          <div className="grid grid-cols-1 md:grid-cols-3 gap-4">
            {SYMBOLS.map((sym) => (
              <SignalCard key={sym} symbol={sym} signal={signalMap.get(sym)} />
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
