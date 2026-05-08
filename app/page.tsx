"use client";

import useSWR from "swr";
import { useState, useEffect, useMemo } from "react";
import type { Signal, MarketContext } from "@/lib/strategy";

const VERSION = "v2.9.3";
const SCAN_COOLDOWN_MS = 60_000;
const STALE_THRESHOLD_MS = 6 * 60_000;

const fetcher = (url: string) => fetch(url).then((r) => r.json());

function fmt(n: number) {
  return n.toLocaleString("en-US", { minimumFractionDigits: 2, maximumFractionDigits: 2 });
}

function Badge({ state }: { state: Signal["state"] }) {
  const styles: Record<string, string> = {
    EARLY_OPEN: "border-[#d4a017] text-[#d4a017]",
    CONFIRMED: "border-[#22c55e] text-[#22c55e]",
    END: "border-[#444] text-[#444]",
  };
  return (
    <span className={`border text-[11px] px-2.5 py-0.5 tracking-[0.15em] font-mono ${styles[state] ?? styles.END}`}>
      {state}
    </span>
  );
}

function SignalCard({ symbol, signal, market, onEndTradeClick }: { symbol: string; signal?: Signal; market?: MarketContext; onEndTradeClick?: (signalId: number, symbol: string, entryPrice: number) => void }) {
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
  
  // CRITICAL: Always use live market price, never stale signal.entry_price
  const livePrice = market?.price ?? 0;
  const displayPrice = livePrice > 0 ? `$${fmt(livePrice)}` : "—";
  
  // [UI PRICE] Debug logging for price reconciliation
  if (active && signal && market?.price) {
    console.log(`[UI PRICE] ${symbol} signalPrice=${signal.entry_price.toFixed(2)} livePrice=${market.price.toFixed(2)} diff=${((market.price - signal.entry_price) / signal.entry_price * 100).toFixed(2)}%`);
  }
  
  // Direction-aware TP/SL hit detection against live price
  // LONG: TP hit when price >= TP, SL hit when price <= SL
  // SHORT: TP hit when price <= TP, SL hit when price >= SL
  const isLong = active && signal.direction === "LONG";
  const tpHit = active && (isLong ? livePrice >= signal.take_profit : livePrice <= signal.take_profit);
  const slHit = active && (isLong ? livePrice <= signal.stop_loss : livePrice >= signal.stop_loss);
  
  // Frontend validation: if TP/SL already hit, signal should be considered closed (DB mismatch)
  const shouldBeClosed = tpHit || slHit;
  
  const tpStatus = active ? tpHit ? "TP HIT" : 
    isLong ? `${((signal.take_profit - livePrice) / livePrice * 100).toFixed(1)}% to TP` :
    `${((livePrice - signal.take_profit) / livePrice * 100).toFixed(1)}% to TP` : "";
  const slStatus = active ? slHit ? "SL HIT" : 
    isLong ? `${((livePrice - signal.stop_loss) / signal.stop_loss * 100).toFixed(1)}% above SL` :
    `${((signal.stop_loss - livePrice) / signal.stop_loss * 100).toFixed(1)}% below SL` : "";

  return (
    <article className={`border ${cardBorder} ${cardBg} flex flex-col overflow-hidden`}>
      <div className={`${headerBg} px-5 py-4 flex items-center justify-between border-b ${cardBorder}`}>
        <span className="font-mono font-bold text-white text-lg tracking-wide">{symbol}</span>
        {active && shouldBeClosed ? (
          <span className="border border-[#fbbf24] bg-[#fbbf24]/10 text-[11px] px-2.5 py-0.5 tracking-[0.15em] font-mono text-[#fbbf24]">
            {tpHit ? "TP HIT" : "SL HIT"} — CLOSING
          </span>
        ) : active ? (
          <Badge state={signal.state} />
        ) : market?.setup?.includes("SETUP") ? (
          <span className="border border-[#d4a017] text-[11px] px-2.5 py-0.5 tracking-[0.15em] font-mono text-[#d4a017]">
            SETUP ACTIVE
          </span>
        ) : (
          <span className="border border-[#2a2a2a] text-[11px] px-2.5 py-0.5 tracking-[0.15em] font-mono text-[#444]">
            NO SIGNAL
          </span>
        )}
      </div>

      <div className="p-5 flex flex-col gap-5">
        {/* STATE OF PLAY — one line */}
        {market && !market.error && (
          <div className="flex flex-col gap-1">
            <p className={`text-lg font-semibold leading-tight ${
              active
                ? signal.direction === "LONG"
                  ? "text-[#22c55e]"
                  : "text-[#ef4444]"
                : "text-white"
            }`}>
              {active
                ? signal.state === "EARLY_OPEN"
                  ? `${signal.direction} ENTRY OPENED — awaiting retest`
                  : signal.state === "CONFIRMED"
                  ? `${signal.direction} CONFIRMED — RETEST ADD-ON`
                  : "ENDED — setup expired"
                : "SCANNING FOR SETUP"}
            </p>
          </div>
        )}

        {/* PRICE */}
        <div>
          <p className="text-[10px] tracking-[0.2em] text-[#666] mb-1">PRICE</p>
          <p className="font-mono text-3xl font-bold text-white tabular-nums">{displayPrice}</p>
        </div>

        {/* SIGNAL DETAILS (if active) */}
        {active && (
          <div className="grid grid-cols-3 gap-3 border-t border-[#1e1e1e] pt-4">
            <div>
              <p className="text-[10px] tracking-[0.2em] text-[#666] mb-1.5">ENTRY</p>
              <p className="font-mono text-[14px] text-white tabular-nums">${fmt(signal.entry_price)}</p>
            </div>
            <div>
              <p className="text-[10px] tracking-[0.2em] text-[#666] mb-1.5">TP1</p>
              <p className={`font-mono text-[14px] ${tpHit ? "text-[#fbbf24]" : "text-[#22c55e]"} tabular-nums`}>${fmt(signal.take_profit)}</p>
              {tpHit && <p className="text-[10px] text-[#fbbf24] mt-1">✓ TP HIT</p>}
            </div>
            <div>
              <p className="text-[10px] tracking-[0.2em] text-[#666] mb-1.5">SL</p>
              <p className={`font-mono text-[14px] ${slHit ? "text-[#fca5a5]" : "text-[#ef4444]"} tabular-nums`}>${fmt(signal.stop_loss)}</p>
              {slHit && <p className="text-[10px] text-[#fca5a5] mt-1">✗ SL HIT</p>}
            </div>
            <div className="col-span-3 flex items-center justify-between text-sm">
              <span className="text-[#888]">Confidence: {signal.confidence}%</span>
              <div className="flex gap-3 text-[10px]">
                {tpStatus && <span className="text-[#22c55e]">{tpStatus}</span>}
                {slStatus && <span className="text-[#ef4444]">{slStatus}</span>}
              </div>
            </div>
          </div>
        )}

        {/* 4-Point Checklist */}
        {(active || market) && (
          <div className="border-t border-[#1e1e1e] pt-4">
            <p className="text-[10px] tracking-[0.2em] text-[#666] mb-3">CHECKLIST</p>
            <div className="flex flex-col gap-2">
              <div className="flex items-center gap-2 text-[12px]">
                <span className={`w-4 h-4 border rounded flex items-center justify-center text-[10px] ${
                  active && (signal.state === "EARLY_OPEN" || signal.state === "CONFIRMED") ? "border-[#22c55e] text-[#22c55e]" : "border-[#444] text-[#444]"
                }`}>
                  {active && (signal.state === "EARLY_OPEN" || signal.state === "CONFIRMED") ? "✓" : "○"}
                </span>
                <span className={active && (signal.state === "EARLY_OPEN" || signal.state === "CONFIRMED") ? "text-[#22c55e]" : "text-[#666]"}>4H Breakout</span>
              </div>
              <div className="flex items-center gap-2 text-[12px]">
                <span className={`w-4 h-4 border rounded flex items-center justify-center text-[10px] ${
                  active && signal.confidence > 50 ? "border-[#22c55e] text-[#22c55e]" : "border-[#444] text-[#444]"
                }`}>
                  {active && signal.confidence > 50 ? "✓" : "○"}
                </span>
                <span className={active && signal.confidence > 50 ? "text-[#22c55e]" : "text-[#666]"}>15M Setup</span>
              </div>
              <div className="flex items-center gap-2 text-[12px]">
                <span className={`w-4 h-4 border rounded flex items-center justify-center text-[10px] ${
                  signal?.state === "CONFIRMED" ? "border-[#22c55e] text-[#22c55e]" : "border-[#444] text-[#444]"
                }`}>
                  {signal?.state === "CONFIRMED" ? "✓" : "○"}
                </span>
                <span className={signal?.state === "CONFIRMED" ? "text-[#22c55e]" : "text-[#666]"}>Retest Add-On</span>
              </div>
              <div className="flex items-center gap-2 text-[12px]">
                <span className={`w-4 h-4 border rounded flex items-center justify-center text-[10px] ${
                  active && signal.confidence > 70 ? "border-[#22c55e] text-[#22c55e]" : "border-[#444] text-[#444]"
                }`}>
                  {active && signal.confidence > 70 ? "✓" : "○"}
                </span>
                <span className={active && signal.confidence > 70 ? "text-[#22c55e]" : "text-[#666]"}>Momentum {active ? `${signal.confidence}%` : "—"}</span>
              </div>
              <div className="flex items-center gap-2 text-[12px]">
                <span className={`w-4 h-4 border rounded flex items-center justify-center text-[10px] font-mono text-[9px] ${
                  market?.adx !== undefined && market.adx >= 20 ? "border-[#22c55e] text-[#22c55e]" : "border-[#444] text-[#444]"
                }`}>
                  {market?.adx !== undefined ? Math.round(market.adx) : "—"}
                </span>
                <span className={market?.adx !== undefined && market.adx >= 20 ? "text-[#22c55e]" : "text-[#666]"}>ADX Trend {market?.adx !== undefined ? `${market.adx.toFixed(1)}` : "—"}</span>
              </div>
            </div>
          </div>
        )}

        {/* Error state */}
        {market?.error && (
          <div className="border-t border-[#1e1e1e] pt-4">
            <p className="text-[12px] text-[#ef4444] font-mono">{market.setupText}</p>
          </div>
        )}

        {/* Confidence bar (if signal active) */}
        {active && (
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
        )}

        {/* End Trade button (if CONFIRMED) */}
        {signal?.state === "CONFIRMED" && onEndTradeClick && (
          <div className="border-t border-[#1e1e1e] pt-4">
            <button
              onClick={() => onEndTradeClick(signal.id!, symbol, signal.entry_price)}
              className="w-full border border-[#1e1e1e] hover:border-[#2a2a2a] bg-[#0f0f0f] hover:bg-[#151515] text-[#888] hover:text-[#aaa] text-[11px] tracking-[0.2em] py-2.5 transition-colors"
            >
              END TRADE
            </button>
          </div>
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
  const [endTradeModal, setEndTradeModal] = useState<{ signalId: number; symbol: string; entryPrice: number } | null>(null);
  const [endTradeExitPrice, setEndTradeExitPrice] = useState("");
  const [endTradeLoading, setEndTradeLoading] = useState(false);
  const [forceScanLoading, setForceScanLoading] = useState(false);
  const [dataSourceStatus, setDataSourceStatus] = useState<{ source: "KRAKEN" | "COINGECKO" | "CACHE"; time: number } | null>(null);

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

  const { data, mutate, isValidating } = useSWR<{ signals: Signal[]; market: MarketContext[]; fetchedAt: number }>(
    "/api/signals",
    fetcher,
    { refreshInterval: 30_000, keepPreviousData: true, revalidateOnFocus: false }
  );

  const signals: Signal[] = data?.signals ?? [];
  const market: MarketContext[] = data?.market ?? [];
  const fetchedAt: number = data?.fetchedAt ?? 0;
  const isStale = isHydrated && fetchedAt > 0 && now > 0 && (now - fetchedAt) > STALE_THRESHOLD_MS;
  const lastUpdateTime = isHydrated ? new Date().toLocaleTimeString("en-GB", { hour12: false }) : "—";

  // Update data source status from market data
  useMemo(() => {
    if (market.length > 0 && market[0].dataSource) {
      setDataSourceStatus({
        source: market[0].dataSource,
        time: market[0].dataSourceTime ?? Date.now(),
      });
    }
  }, [market]);

  // Memoize signalMap to prevent unnecessary re-renders of market cards
  const signalMap = useMemo(
    () => new Map<string, Signal>(signals.map((s) => [s.symbol, s])),
    [signals]
  );
  const activeCount = signals.filter((s) => s.state === "EARLY_OPEN" || s.state === "CONFIRMED").length;

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

  async function forceScan() {
    setForceScanLoading(true);
    try {
      const res = await fetch("/api/scan-now", { method: "POST" });
      const json = await res.json();
      if (json.ok) {
        await mutate();
      } else {
        alert("Scan failed");
      }
    } catch (err) {
      alert(`Error: ${err}`);
    } finally {
      setForceScanLoading(false);
    }
  }

  async function submitEndTrade() {
    if (!endTradeModal || !endTradeExitPrice) return;
    setEndTradeLoading(true);
    try {
      const exitPrice = parseFloat(endTradeExitPrice);
      if (isNaN(exitPrice) || exitPrice <= 0) {
        alert("Invalid exit price");
        return;
      }
      const res = await fetch("/api/signals", {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ 
          symbol: endTradeModal.symbol, 
          state: "END",
          outcome: "MANUAL",
          exitPrice 
        }),
      });
      const json = await res.json();
      if (json.ok) {
        setEndTradeModal(null);
        setEndTradeExitPrice("");
        await mutate();
      } else {
        alert(`Failed to end trade: ${json.error}`);
      }
    } catch (err) {
      alert(`Error: ${err}`);
    } finally {
      setEndTradeLoading(false);
    }
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
              <div className="flex items-center justify-between">
                <span className="text-[13px] text-[#aaa]">Data Source</span>
                <span className="flex items-center gap-2 text-[12px] font-mono text-[#22c55e]">
                  <span className="w-2 h-2 rounded-full bg-[#22c55e]" aria-hidden />
                  {dataSourceStatus ? `${dataSourceStatus.source}` : "—"}
                </span>
              </div>
            </div>

            <div className="grid grid-cols-4 gap-2">
              <button
                onClick={testTelegram}
                disabled={tg === "sending"}
                className={`border text-[11px] tracking-[0.2em] py-3 transition-colors disabled:opacity-40 ${
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
                <p className={`col-span-4 text-[11px] text-center ${tg === "ok" ? "text-[#22c55e]" : "text-[#ef4444]"}`}>
                  {tgMsg}
                </p>
              )}

              <button
                onClick={scanNow}
                disabled={scanning || scanOnCooldown}
                className="border border-[#2a2a2a] text-[#888] hover:border-[#555] hover:text-white text-[11px] tracking-[0.2em] py-3 transition-colors disabled:opacity-40"
              >
                {scanning
                  ? "SCANNING..."
                  : scanOnCooldown
                  ? `NEXT IN ${cooldownSec}s`
                  : "SCAN NOW"}
              </button>

              <button
                onClick={forceScan}
                disabled={forceScanLoading}
                className="border border-[#1e3a1f] text-[#4ade80] hover:border-[#22c55e] hover:text-[#22c55e] text-[11px] tracking-[0.2em] py-3 transition-colors disabled:opacity-40"
              >
                {forceScanLoading ? "FORCING..." : "FORCE SCAN"}
              </button>

            </div>
          </div>

          <div className="border border-[#1a1a1a] bg-[#0e0e0e] p-5 flex flex-col gap-5">
            <p className="text-[10px] tracking-[0.22em] text-[#555]">DATA POINTS</p>
            <div className="grid grid-cols-2 gap-6 flex-1 items-start">
              <div>
                <p className="text-[10px] tracking-[0.22em] text-[#555] mb-3">ASSETS</p>
                <p className="font-bold text-5xl text-[#22c55e] tabular-nums">{market.length}</p>
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
            {market.map((m) => {
              const signal = signalMap.get(m.symbol);
              return (
                <SignalCard key={m.symbol} symbol={m.symbol} signal={signal} market={m} onEndTradeClick={(id, sym, entry) => { setEndTradeModal({ signalId: id, symbol: sym, entryPrice: entry }); setEndTradeExitPrice(""); }} />
              );
            })}
          </div>
        </div>

        <footer className="border-t border-[#1a1a1a] pt-4 flex items-center justify-between">
          <p className="text-[10px] tracking-[0.2em] text-[#2a2a2a]">SIGNAL DASHBOARD {VERSION}</p>
          <p className="text-[10px] tracking-[0.2em] text-[#2a2a2a]">
            4H BREAKOUT &nbsp;·&nbsp; 15M CONFIDENCE &nbsp;·&nbsp; 5M TRIGGER
          </p>
        </footer>

        {/* End Trade Modal */}
        {endTradeModal && (
          <div className="fixed inset-0 bg-black/50 flex items-center justify-center z-50">
            <div className="bg-[#111] border border-[#1e1e1e] rounded p-6 max-w-sm w-full mx-4">
              <h2 className="text-lg font-mono font-bold text-white mb-1">{endTradeModal.symbol}</h2>
              <p className="text-[12px] text-[#888] mb-4">Entry: ${fmt(endTradeModal.entryPrice)}</p>

              <div className="mb-4">
                <label className="text-[11px] tracking-[0.15em] text-[#666] block mb-2">EXIT PRICE</label>
                <input
                  type="number"
                  step="0.01"
                  value={endTradeExitPrice}
                  onChange={(e) => setEndTradeExitPrice(e.target.value)}
                  placeholder="Enter exit price"
                  className="w-full bg-[#0f0f0f] border border-[#1e1e1e] text-white font-mono px-3 py-2 text-sm focus:outline-none focus:border-[#2a2a2a]"
                  disabled={endTradeLoading}
                />
              </div>

              <div className="flex gap-3">
                <button
                  onClick={() => { setEndTradeModal(null); setEndTradeExitPrice(""); }}
                  disabled={endTradeLoading}
                  className="flex-1 border border-[#1e1e1e] text-[#888] hover:border-[#2a2a2a] text-[11px] tracking-[0.15em] py-2 transition-colors disabled:opacity-40"
                >
                  CANCEL
                </button>
                <button
                  onClick={submitEndTrade}
                  disabled={endTradeLoading || !endTradeExitPrice}
                  className="flex-1 border border-[#22c55e] text-[#22c55e] hover:bg-[#052e16] text-[11px] tracking-[0.15em] py-2 transition-colors disabled:opacity-40"
                >
                  {endTradeLoading ? "ENDING..." : "CLOSE TRADE"}
                </button>
              </div>
            </div>
          </div>
        )}
      </div>
    </main>
  );
}
