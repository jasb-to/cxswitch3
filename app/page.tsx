"use client";

import { useEffect, useState } from "react";

interface Signal {
  pair: string;
  direction: "LONG" | "SHORT";
  type: "BREAKOUT" | "PULLBACK" | "CONTINUATION" | "REVERSAL";
  confidence: number;
  entry: number;
  stop: number;
  target: number;
  rr: number;
  timestamp: number;
  expectedMove: number;
  version: number;
  reason?: string;
  adx?: number;
  rsi?: number;
  stochK?: number;
  stochD?: number;
  meta?: {
    tier: string;
    confidenceScore: number;
    actionable: boolean;
  };
  holdAdvice?: {
    shouldHold: boolean;
    reason: string;
  } | null;
}

interface SignalHistory {
  pair: string;
  direction: "LONG" | "SHORT";
  type: string;
  entry: number;
  stop: number;
  target: number;
  exitedAt: number;
  exitReason: "stop_hit" | "target_hit" | "expired" | "hold_exit";
  exitPrice: number | null;
}

interface MarketData {
  pair: string;
  price: number;
  structure: string;
  health: string;
  adx: number;
  rsi: number;
  stochK: number;
  stochD: number;
  timestamp: number;
}

const PAIRS = ["BTC", "ETH", "SOL"];
const SIGNAL_STALE_MS = 48 * 60 * 60 * 1000;
const HISTORY_DISPLAY_MS = 24 * 60 * 60 * 1000;

const money = (n?: number) =>
  typeof n === "number" && isFinite(n)
    ? new Intl.NumberFormat("en-US", { style: "currency", currency: "USD", maximumFractionDigits: n >= 1000 ? 0 : 2 }).format(n)
    : "—";

const KRAKEN_PAIRS: Record<string, string> = { BTC: "XBTUSD", ETH: "ETHUSD", SOL: "SOLUSD" };

async function fetchKrakenPrice(pair: string): Promise<number | null> {
  try {
    const res = await fetch(`https://api.kraken.com/0/public/Ticker?pair=${KRAKEN_PAIRS[pair]}`, { cache: "no-store" });
    const data = await res.json();
    if (data.error?.length) return null;
    const ticker = data.result[Object.keys(data.result)[0]];
    return parseFloat(ticker.c[0]);
  } catch { return null; }
}

function timeAgo(ts: number): string {
  const mins = Math.floor((Date.now() - ts) / 60000);
  if (mins < 1) return "just now";
  if (mins < 60) return `${mins}m ago`;
  const hrs = Math.floor(mins / 60);
  if (hrs < 24) return `${hrs}h ${mins % 60}m ago`;
  return `${Math.floor(hrs / 24)}d ago`;
}

function getHealthColor(health: string): string {
  if (health === "STRONG") return "text-green-400";
  if (health === "WEAK") return "text-yellow-400";
  return "text-gray-400";
}

function getHealthBg(health: string): string {
  if (health === "STRONG") return "bg-green-500/20 border-green-500/50";
  if (health === "WEAK") return "bg-yellow-500/20 border-yellow-500/50";
  return "bg-gray-500/20 border-gray-500/50";
}

function getConfidenceColor(score: number): string {
  if (score >= 80) return "text-emerald-400";
  if (score >= 60) return "text-green-400";
  if (score >= 40) return "text-yellow-400";
  if (score >= 20) return "text-orange-400";
  return "text-red-400";
}

function getConfidenceBarColor(score: number): string {
  if (score >= 80) return "bg-emerald-500";
  if (score >= 60) return "bg-green-500";
  if (score >= 40) return "bg-yellow-500";
  if (score >= 20) return "bg-orange-500";
  return "bg-red-500";
}

export default function Dashboard() {
  const [signals, setSignals] = useState<Record<string, Signal | null>>({});
  const [history, setHistory] = useState<Record<string, SignalHistory>>({});
  const [livePrices, setLivePrices] = useState<Record<string, number>>({});
  const [marketData, setMarketData] = useState<Record<string, MarketData>>({});
  const [loading, setLoading] = useState(true);
  const [fetchCount, setFetchCount] = useState(0);
  const [lastFetch, setLastFetch] = useState<number>(0);

  useEffect(() => {
    async function load() {
      try {
        const res = await fetch("/api/signals");
        const data = await res.json();
        const sigMap: Record<string, Signal | null> = {};
        const histMap: Record<string, SignalHistory> = {};
        const mktMap: Record<string, MarketData> = {};

        for (const p of PAIRS) {
          const s = data.signals?.find((sig: Signal) => sig.pair === p);
          sigMap[p] = s || null;
        }
        for (const h of data.history || []) {
          if (h?.pair && (Date.now() - h.exitedAt) < HISTORY_DISPLAY_MS) histMap[h.pair] = h;
        }
        for (const m of data.marketData || []) {
          if (m?.pair) mktMap[m.pair] = m;
        }

        setSignals(sigMap);
        setHistory(histMap);
        setMarketData(mktMap);
        setFetchCount(c => c + 1);
        setLastFetch(Date.now());
      } catch (e) { console.error(e); }
      finally { setLoading(false); }
    }
    load();
    const i = setInterval(load, 30000);
    return () => clearInterval(i);
  }, []);

  useEffect(() => {
    async function loadPrices() {
      const liveMap: Record<string, number> = {};
      await Promise.all(PAIRS.map(async (pair) => {
        const price = await fetchKrakenPrice(pair);
        if (price) liveMap[pair] = price;
      }));
      setLivePrices(liveMap);
    }
    loadPrices();
    const i = setInterval(loadPrices, 10000);
    return () => clearInterval(i);
  }, []);

  if (loading) {
    return <div className="min-h-screen bg-gray-900 text-white flex items-center justify-center">Loading...</div>;
  }

  return (
    <div className="min-h-screen bg-gray-900 text-white p-6">
      <div className="max-w-6xl mx-auto">
        <div className="flex justify-between items-center mb-6">
          <h1 className="text-2xl font-bold">CX Switch v23</h1>
          <div className="text-xs text-gray-400">
            Fetches: {fetchCount} | Last: {lastFetch ? new Date(lastFetch).toLocaleTimeString() : "—"}
          </div>
        </div>

        <div className="grid md:grid-cols-3 gap-6">
          {PAIRS.map((pair) => {
            const signal = signals[pair];
            const hist = history[pair];
            const mkt = marketData[pair];
            const livePrice = livePrices[pair];
            const now = Date.now();
            const hasSignal = !!signal;
            const signalFresh = signal && (now - signal.timestamp < SIGNAL_STALE_MS);
            const currentPrice = livePrice ?? mkt?.price ?? signal?.entry;
            const priceLive = !!livePrice;
            const entry = signal?.entry ?? 0;
            const stop = signal?.stop ?? 0;
            const target = signal?.target ?? 0;

            const unrealizedPnL = hasSignal && signalFresh && currentPrice && entry
              ? signal.direction === "LONG" ? ((currentPrice - entry) / entry) * 100 : ((entry - currentPrice) / entry) * 100
              : 0;
            const targetHit = hasSignal && signalFresh && currentPrice && target
              ? signal.direction === "LONG" ? currentPrice >= target : currentPrice <= target
              : false;
            const stopHit = hasSignal && signalFresh && currentPrice && stop
              ? signal.direction === "LONG" ? currentPrice <= stop : currentPrice >= stop
              : false;
            const hasHistory = !!hist;

            const progress = hasSignal && signalFresh && entry && target && stop
              ? signal.direction === "LONG"
                ? Math.max(0, Math.min(100, ((currentPrice - entry) / (target - entry)) * 100))
                : Math.max(0, Math.min(100, ((entry - currentPrice) / (entry - target)) * 100))
              : 0;

            let borderClass = "border-gray-700 bg-gray-800";
            let bannerText: string | null = null;
            let bannerClass = "";
            let statusBadge = "";

            if (targetHit) {
              borderClass = "border-purple-500 bg-purple-900/10";
              bannerText = "🎯 TARGET HIT — TAKE PROFIT";
              bannerClass = "bg-purple-500 text-white";
              statusBadge = "TAKE PROFIT";
            } else if (stopHit) {
              borderClass = "border-red-500 bg-red-900/10";
              bannerText = "🛑 STOPPED OUT — EXIT NOW";
              bannerClass = "bg-red-500 text-white";
              statusBadge = "EXIT";
            } else if (hasSignal && signalFresh) {
              borderClass = signal.direction === "LONG" ? "border-green-500 bg-green-900/10" : "border-red-500 bg-red-900/10";
              if (signal.holdAdvice) {
                if (signal.holdAdvice.shouldHold) {
                  statusBadge = "HOLD ✓";
                } else {
                  bannerText = `⚠️ ${signal.holdAdvice.reason}`;
                  bannerClass = "bg-yellow-500 text-black";
                  statusBadge = "EXIT";
                }
              } else {
                statusBadge = "ACTIVE";
              }
            } else if (hasHistory && !hasSignal) {
              borderClass = "border-yellow-500 bg-yellow-900/10";
              bannerText = hist.exitReason === "target_hit" ? "🎯 TARGET HIT" : hist.exitReason === "stop_hit" ? "🛑 STOPPED" : "⚠️ HOLD EXIT";
              bannerClass = hist.exitReason === "target_hit" ? "bg-purple-500 text-white" : hist.exitReason === "stop_hit" ? "bg-red-500 text-white" : "bg-yellow-500 text-black";
              statusBadge = "CLOSED";
            } else {
              statusBadge = "WAIT";
            }

            const confScore = signal?.meta?.confidenceScore ?? signal?.confidence ?? 0;

            return (
              <div key={pair} className={`rounded-lg p-5 border-2 transition-all ${borderClass}`}>
                {bannerText && (
                  <div className={`mb-3 py-2 px-3 rounded text-center font-bold text-sm ${bannerClass}`}>{bannerText}</div>
                )}

                <div className="flex justify-between items-start mb-4">
                  <div>
                    <div className="font-bold text-lg">{pair}/USD</div>
                    <div className="flex items-center gap-2">
                      <div className="text-2xl font-mono">{money(currentPrice)}</div>
                      {priceLive && <span className="text-xs bg-green-600/50 text-green-300 px-1.5 py-0.5 rounded animate-pulse">LIVE</span>}
                    </div>
                  </div>
                  <div className="flex flex-col items-end gap-1">
                    {hasSignal && signalFresh ? (
                      <>
                        <span className={`px-2 py-1 rounded text-xs font-bold ${signal.direction === "LONG" ? "bg-green-600 text-white" : "bg-red-600 text-white"}`}>
                          {signal.type}
                        </span>
                        <span className={`text-xs font-bold ${signal.direction === "LONG" ? "text-green-400" : "text-red-400"}`}>
                          {signal.direction}
                        </span>
                        <span className={`text-[10px] px-1.5 py-0.5 rounded font-bold ${
                          statusBadge === "HOLD ✓" ? "bg-green-500/30 text-green-300" :
                          statusBadge === "EXIT" ? "bg-red-500/30 text-red-300" :
                          "bg-blue-500/30 text-blue-300"
                        }`}>
                          {statusBadge}
                        </span>
                      </>
                    ) : hasSignal && !signalFresh ? (
                      <span className="px-2 py-1 rounded text-xs bg-yellow-600 text-white">EXPIRED</span>
                    ) : hasHistory ? (
                      <span className="px-2 py-1 rounded text-xs bg-gray-600 text-gray-300">CLOSED</span>
                    ) : (
                      <span className="px-2 py-1 rounded text-xs bg-gray-600 text-gray-300">WAIT</span>
                    )}
                  </div>
                </div>

                {hasSignal && signalFresh && signal.holdAdvice && (
                  <div className={`mb-3 p-2 rounded border text-xs font-semibold ${
                    signal.holdAdvice.shouldHold
                      ? "bg-green-500/10 border-green-500/30 text-green-300"
                      : "bg-red-500/10 border-red-500/30 text-red-300"
                  }`}>
                    <div className="flex items-center gap-2">
                      <span className="text-lg">{signal.holdAdvice.shouldHold ? "✅" : "❌"}</span>
                      <span>{signal.holdAdvice.reason}</span>
                    </div>
                  </div>
                )}

                {mkt && (
                  <div className={`mb-3 p-2 rounded border text-xs ${getHealthBg(mkt.health)}`}>
                    <div className="flex justify-between items-center">
                      <span className="text-gray-400">4H Trend:</span>
                      <span className={`font-bold ${getHealthColor(mkt.health)}`}>
                        {mkt.structure} {mkt.health}
                      </span>
                    </div>
                    <div className="flex justify-between mt-1">
                      <span className="text-gray-500">ADX: {mkt.adx?.toFixed(1)}</span>
                      <span className="text-gray-500">RSI: {mkt.rsi?.toFixed(1)}</span>
                    </div>
                    <div className="flex justify-between">
                      <span className="text-gray-500">Stoch K: {mkt.stochK?.toFixed(1)}</span>
                      <span className="text-gray-500">D: {mkt.stochD?.toFixed(1)}</span>
                    </div>
                  </div>
                )}

                {hasSignal && signalFresh && !targetHit && !stopHit && (
                  <div className="mb-3">
                    <div className="flex justify-between text-xs text-gray-400 mb-1">
                      <span>Entry</span>
                      <span className={unrealizedPnL > 0 ? "text-green-400" : unrealizedPnL < 0 ? "text-red-400" : "text-gray-400"}>
                        {unrealizedPnL > 0 ? "+" : ""}{unrealizedPnL.toFixed(2)}%
                      </span>
                      <span>Target</span>
                    </div>
                    <div className="h-2 bg-gray-700 rounded-full overflow-hidden">
                      <div
                        className={`h-full rounded-full transition-all ${
                          unrealizedPnL > 0 ? "bg-green-500" : "bg-red-500"
                        }`}
                        style={{ width: `${progress}%` }}
                      />
                    </div>
                    <div className="flex justify-between text-[10px] text-gray-500 mt-1">
                      <span>{money(entry)}</span>
                      <span>{money(target)}</span>
                    </div>
                  </div>
                )}

                {hasHistory && !hasSignal && (
                  <div className="mb-4 p-3 bg-gray-900/50 rounded text-sm space-y-2">
                    <div className="flex justify-between">
                      <span className="text-gray-400">Last Signal</span>
                      <span className={`font-bold ${hist.direction === "LONG" ? "text-green-400" : "text-red-400"}`}>
                        {hist.type} {hist.direction}
                      </span>
                    </div>
                    <div className="flex justify-between"><span className="text-gray-400">Entry</span><span className="font-mono">{money(hist.entry)}</span></div>
                    <div className="flex justify-between"><span className="text-gray-400">Exit</span><span className="font-mono">{money(hist.exitPrice || hist.stop)}</span></div>
                    <div className="flex justify-between"><span className="text-gray-400">Time</span><span className="text-gray-500">{new Date(hist.exitedAt).toLocaleTimeString()}</span></div>
                  </div>
                )}

                {hasSignal && signalFresh && (
                  <div className="mb-4 space-y-2">
                    <div className="flex justify-between text-sm">
                      <span className="text-gray-400">Entry</span>
                      <span className="font-mono">{money(signal.entry)}</span>
                    </div>
                    <div className="flex justify-between text-sm">
                      <span className="text-gray-400">Stop</span>
                      <span className="font-mono text-red-400">{money(signal.stop)}</span>
                    </div>
                    <div className="flex justify-between text-sm">
                      <span className="text-gray-400">Target</span>
                      <span className="font-mono text-purple-400">{money(signal.target)}</span>
                    </div>
                    <div className="flex justify-between text-sm">
                      <span className="text-gray-400">R:R</span>
                      <span className="font-mono text-yellow-400">{signal.rr?.toFixed(2)}</span>
                    </div>
                    <div className="flex justify-between text-sm">
                      <span className="text-gray-400">Strategy Conf</span>
                      <span className="font-mono">{signal.confidence}%</span>
                    </div>

                    <div className="pt-1">
                      <div className="flex justify-between text-sm mb-1">
                        <span className="text-gray-400">Confidence Score</span>
                        <span className={`font-mono font-bold ${getConfidenceColor(confScore)}`}>
                          {confScore.toFixed(0)}/100
                        </span>
                      </div>
                      <div className="h-2.5 bg-gray-700 rounded-full overflow-hidden">
                        <div
                          className={`h-full rounded-full transition-all ${getConfidenceBarColor(confScore)}`}
                          style={{ width: `${Math.min(100, Math.max(0, confScore))}%` }}
                        />
                      </div>
                      <div className="text-[10px] text-gray-500 mt-1 text-right">
                        {confScore >= 80 ? "Excellent — High conviction trade" :
                         confScore >= 60 ? "Good — Solid setup" :
                         confScore >= 40 ? "Fair — Manage risk carefully" :
                         confScore >= 20 ? "Weak — Consider skipping" : "Poor — Avoid"}
                      </div>
                    </div>

                    <div className="flex justify-between text-sm">
                      <span className="text-gray-400">Age</span>
                      <span className="font-mono text-gray-300">{timeAgo(signal.timestamp)}</span>
                    </div>
                  </div>
                )}

                {hasSignal && signalFresh && signal.reason && (
                  <div className="text-xs text-gray-500 border-t border-gray-700 pt-3 mb-2">
                    <p className="leading-relaxed">{signal.reason}</p>
                  </div>
                )}

                {hasSignal && signalFresh && (
                  <div className="text-xs text-gray-500">
                    <p><span className="text-gray-400">Expected:</span> {signal.expectedMove?.toFixed(1)}% move</p>
                  </div>
                )}
              </div>
            );
          })}
        </div>
      </div>
    </div>
  );
}
