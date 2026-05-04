"use client";

import useSWR from "swr";
import { useState, useEffect } from "react";
import type { Signal } from "@/lib/strategy";

const VERSION = "v1.0.0";
const SYMBOLS = ["BTC/USD", "ETH/USD", "SOL/USD"];

const fetcher = (url: string) => fetch(url).then((r) => r.json());

function p(n: number) {
  return n.toLocaleString("en-US", { minimumFractionDigits: 2, maximumFractionDigits: 2 });
}

// ── Badge ─────────────────────────────────────────────────────────────────────

function Badge({ state }: { state: Signal["state"] }) {
  const cls =
    state === "EARLY"
      ? "border-[#d4a017] text-[#d4a017]"
      : state === "CONFIRMED"
      ? "border-[#22c55e] text-[#22c55e]"
      : "border-[#444] text-[#444]";
  return (
    <span className={`border text-[10px] px-2 py-0.5 tracking-[0.15em] font-mono ${cls}`}>
      {state}
    </span>
  );
}

// ── Signal card ───────────────────────────────────────────────────────────────

function SignalCard({ symbol, signal }: { symbol: string; signal?: Signal }) {
  const active = signal && signal.state !== "END";
  return (
    <article className="border border-[#1e1e1e] bg-[#111] p-5 flex flex-col gap-5">
      {/* header */}
      <div className="flex items-center justify-between">
        <span className="font-mono font-bold text-[#e8e8e8] tracking-wide">{symbol}</span>
        {active ? (
          <Badge state={signal.state} />
        ) : (
          <span className="border border-[#2a2a2a] text-[10px] px-2 py-0.5 tracking-[0.15em] font-mono text-[#3a3a3a]">
            NO SIGNAL
          </span>
        )}
      </div>

      {/* price */}
      <div>
        <p className="text-[9px] tracking-[0.2em] text-[#444] mb-1">PRICE</p>
        <p className="font-mono text-2xl font-bold text-[#e8e8e8] tabular-nums">
          {active ? `$${p(signal.entry)}` : "—"}
        </p>
      </div>

      {/* entry / tp / sl — only when EARLY or CONFIRMED */}
      {active && (
        <div className="grid grid-cols-3 gap-3 border-t border-[#1e1e1e] pt-4">
          <div>
            <p className="text-[9px] tracking-[0.2em] text-[#444] mb-1">ENTRY</p>
            <p className="font-mono text-[13px] text-[#e8e8e8] tabular-nums">${p(signal.entry)}</p>
          </div>
          <div>
            <p className="text-[9px] tracking-[0.2em] text-[#444] mb-1">TP1</p>
            <p className="font-mono text-[13px] text-[#22c55e] tabular-nums">${p(signal.tp)}</p>
          </div>
          <div>
            <p className="text-[9px] tracking-[0.2em] text-[#444] mb-1">SL</p>
            <p className="font-mono text-[13px] text-[#ef4444] tabular-nums">${p(signal.sl)}</p>
          </div>
        </div>
      )}

      {/* confidence bar */}
      <div className="border-t border-[#1e1e1e] pt-4">
        <div className="flex items-center justify-between mb-2">
          <p className="text-[9px] tracking-[0.2em] text-[#444]">CONFIDENCE</p>
          <p className="font-mono text-[11px] text-[#555]">
            {active ? `${signal.confidence}%` : "0%"}
          </p>
        </div>
        <div className="h-px bg-[#1e1e1e]">
          <div
            className="h-px bg-[#555] transition-all duration-700"
            style={{ width: `${active ? signal.confidence : 0}%` }}
          />
        </div>
      </div>

      {/* direction or awaiting */}
      {active ? (
        <div>
          <p className="text-[9px] tracking-[0.2em] text-[#444] mb-1">DIRECTION</p>
          <p
            className={`font-mono text-sm font-bold ${
              signal.direction === "LONG" ? "text-[#22c55e]" : "text-[#ef4444]"
            }`}
          >
            {signal.direction}
          </p>
        </div>
      ) : (
        <p className="text-[9px] tracking-[0.2em] text-[#2a2a2a]">AWAITING BREAKOUT</p>
      )}
    </article>
  );
}

// ── Dashboard ─────────────────────────────────────────────────────────────────

export default function Dashboard() {
  const [tg, setTg] = useState<"idle" | "sending" | "ok" | "error">("idle");
  const [tgMsg, setTgMsg] = useState("");
  const [scanning, setScanning] = useState(false);
  const [lastUpdate, setLastUpdate] = useState("");

  // Avoid SSR/client hydration mismatch — only set time on client
  useEffect(() => {
    setLastUpdate(new Date().toLocaleTimeString("en-GB", { hour12: false }));
  }, []);

  const { data: signals = [], mutate, isValidating } = useSWR<Signal[]>(
    "/api/signals",
    fetcher,
    { refreshInterval: 60_000, keepPreviousData: true, revalidateOnFocus: false }
  );

  const signalMap = new Map<string, Signal>(signals.map((s) => [s.symbol, s]));
  const activeCount = signals.filter((s) => s.state !== "END").length;

  async function scanNow() {
    if (scanning) return;
    setScanning(true);
    try {
      await fetch("/api/cron");
      await mutate();
      setLastUpdate(new Date().toLocaleTimeString("en-GB", { hour12: false }));
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
    <main className="min-h-screen bg-[#0a0a0a] text-[#e8e8e8] font-mono">
      {/* Top bar */}
      <header className="border-b border-[#1a1a1a] px-6 py-3 flex items-center justify-between">
        <p className="text-[10px] tracking-[0.22em] text-[#444]">
          MULTI-TIMEFRAME CRYPTO SIGNAL ANALYZER &nbsp;·&nbsp; REAL-TIME INTELLIGENCE
        </p>
        <p className="text-[10px] tracking-[0.15em] text-[#2e2e2e]">{VERSION}</p>
      </header>

      <div className="px-6 py-6 max-w-[1400px] mx-auto flex flex-col gap-6">
        {/* Status + Data panels */}
        <div className="grid grid-cols-1 md:grid-cols-3 gap-4">
          {/* System status */}
          <div className="md:col-span-2 border border-[#1a1a1a] bg-[#0e0e0e] p-5 flex flex-col gap-5">
            <p className="text-[9px] tracking-[0.22em] text-[#444]">SYSTEM STATUS</p>

            <div className="flex flex-col gap-3">
              <div className="flex items-center justify-between">
                <span className="text-[12px] text-[#888]">Terminal</span>
                <span className="flex items-center gap-1.5 text-[12px] text-[#22c55e]">
                  <span className="w-1.5 h-1.5 rounded-full bg-[#22c55e]" aria-hidden />
                  LIVE
                </span>
              </div>
              <div className="flex items-center justify-between">
                <span className="text-[12px] text-[#888]">Telegram Bot</span>
                <span
                  className={`flex items-center gap-1.5 text-[12px] ${
                    tg === "ok"
                      ? "text-[#22c55e]"
                      : tg === "error"
                      ? "text-[#ef4444]"
                      : "text-[#666]"
                  }`}
                >
                  <span
                    className={`w-1.5 h-1.5 rounded-full ${
                      tg === "ok"
                        ? "bg-[#22c55e]"
                        : tg === "error"
                        ? "bg-[#ef4444]"
                        : "bg-[#444]"
                    }`}
                    aria-hidden
                  />
                  ACTIVE
                </span>
              </div>
              <div className="flex items-center justify-between">
                <span className="text-[12px] text-[#888]">Last Update</span>
                <span className="text-[12px] text-[#e8e8e8] tabular-nums">{lastUpdate}</span>
              </div>
            </div>

            <div className="flex flex-col gap-2">
              <button
                onClick={testTelegram}
                disabled={tg === "sending"}
                className={`w-full border text-[10px] tracking-[0.2em] py-3 transition-colors disabled:opacity-40 ${
                  tg === "ok"
                    ? "border-[#22c55e] text-[#22c55e]"
                    : tg === "error"
                    ? "border-[#ef4444] text-[#ef4444]"
                    : "border-[#2a2a2a] text-[#666] hover:border-[#444] hover:text-[#aaa]"
                }`}
              >
                {tg === "sending" ? "SENDING..." : tg === "ok" ? "SENT OK" : tg === "error" ? "SEND FAILED" : "TEST TELEGRAM"}
              </button>
              {tgMsg && (
                <p className={`text-[10px] text-center ${tg === "ok" ? "text-[#22c55e]" : "text-[#ef4444]"}`}>
                  {tgMsg}
                </p>
              )}
              <button
                onClick={scanNow}
                disabled={scanning}
                className="w-full border border-[#2a2a2a] text-[#666] hover:border-[#444] hover:text-[#aaa] text-[10px] tracking-[0.2em] py-3 transition-colors disabled:opacity-40"
              >
                {scanning ? "SCANNING..." : "SCAN NOW"}
              </button>
            </div>
          </div>

          {/* Data points */}
          <div className="border border-[#1a1a1a] bg-[#0e0e0e] p-5 flex flex-col gap-5">
            <p className="text-[9px] tracking-[0.22em] text-[#444]">DATA POINTS</p>
            <div className="grid grid-cols-2 gap-6 flex-1 items-start">
              <div>
                <p className="text-[9px] tracking-[0.22em] text-[#444] mb-3">ASSETS</p>
                <p className="font-bold text-5xl text-[#22c55e] tabular-nums">{SYMBOLS.length}</p>
              </div>
              <div>
                <p className="text-[9px] tracking-[0.22em] text-[#444] mb-3">SIGNALS</p>
                <p className="font-bold text-5xl text-[#22c55e] tabular-nums">{activeCount}</p>
              </div>
            </div>
            <div className="border-t border-[#1a1a1a] pt-3">
              <p className="text-[9px] tracking-[0.18em] text-[#2e2e2e]">
                AUTO-REFRESH 60s &nbsp;·&nbsp; KRAKEN API
              </p>
            </div>
          </div>
        </div>

        {/* Cards */}
        <div>
          <div className="flex items-center justify-between mb-4">
            <p className="text-[9px] tracking-[0.22em] text-[#444]">TRENDLINE BREAK SIGNALS</p>
            <button
              onClick={() => { mutate(); setLastUpdate(new Date().toLocaleTimeString("en-GB", { hour12: false })); }}
              className="text-[9px] tracking-[0.2em] text-[#333] hover:text-[#888] transition-colors"
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

        {/* Footer */}
        <footer className="border-t border-[#1a1a1a] pt-4 flex items-center justify-between">
          <p className="text-[9px] tracking-[0.2em] text-[#2a2a2a]">SIGNAL DASHBOARD {VERSION}</p>
          <p className="text-[9px] tracking-[0.2em] text-[#2a2a2a]">
            4H BREAKOUT &nbsp;·&nbsp; 15M CONFIDENCE &nbsp;·&nbsp; 5M TRIGGER
          </p>
        </footer>
      </div>
    </main>
  );
}
