"use client";

import { useEffect, useState } from "react";

interface Signal {
  id: string;
  pair: string;
  direction: "LONG" | "SHORT";
  type: string;
  scale: string;
  entry: number;
  stop: number;
  target: number;
  rr: number;
  timestamp: number;
  expectedMove: number;
  adx?: number;
  rsi?: number;
  stochK?: number;
  stochD?: number;
  reason?: string;
  trend?: string;
  location?: string;
  trigger?: string;
  meta?: {
    status: string;
    ageMinutes: number;
    actionable: boolean;
  };
}

interface DirectionalContext {
  direction: "LONG" | "SHORT";
  trend: string;
  location: {
    locationType: string;
    marketPhase: string;
    structureDesc: string;
    pullbackDesc: string;
    trendlinePrice: number;
    distToTL: number;
  };
  trigger: {
    fired: boolean;
    triggerType: string;
    detail: string;
    stochK: number;
    stochD: number;
    crossAge: number;
    momentumDesc: string;
  } | null;
  addTrigger: {
    fired: boolean;
    detail: string;
    confirmations: string[];
  } | null;
  canEnter: boolean;
  reason: string;
}

interface MarketData {
  pair: string;
  price: number;
  trend: string;
  location: string;
  trigger: string;
  adx: number;
  rsi: number;
  stochK: number;
  stochD: number;
  timestamp: number;
  trendlinePrice: number;
  distToTrendline: number | null;
  locationType: string;
  ema8_4h: number;
  ema21_4h: number;
  ema50_4h: number;
  marketPhase: string;
  momentumDesc: string;
  pullbackDesc: string;
  structureDesc: string;
  crossAge: number;
  longContext?: DirectionalContext;
  shortContext?: DirectionalContext;
}

const PAIRS = ["BTC", "ETH", "SOL", "HYPE"];

const money = (n?: number) =>
  typeof n === "number" && isFinite(n)
    ? new Intl.NumberFormat("en-US", {
        style: "currency",
        currency: "USD",
        maximumFractionDigits: n >= 1000 ? 0 : n >= 1 ? 2 : 4,
      }).format(n)
    : "—";

const KRAKEN_PAIRS: Record<string, string> = {
  BTC: "XBTUSD",
  ETH: "ETHUSD",
  SOL: "SOLUSD",
  HYPE: "HYPEUSD",
};

async function fetchKrakenPrice(pair: string): Promise<number | null> {
  try {
    const res = await fetch(
      `https://api.kraken.com/0/public/Ticker?pair=${KRAKEN_PAIRS[pair]}`,
      { cache: "no-store" }
    );
    const data = await res.json();
    if (data.error?.length) return null;
    const ticker = data.result[Object.keys(data.result)[0]];
    return parseFloat(ticker.c[0]);
  } catch {
    return null;
  }
}

function timeAgo(ts: number): string {
  const mins = Math.floor((Date.now() - ts) / 60000);
  if (mins < 1) return "just now";
  if (mins < 60) return `${mins}m ago`;
  const hrs = Math.floor(mins / 60);
  if (hrs < 24) return `${hrs}h ${mins % 60}m ago`;
  return `${Math.floor(hrs / 24)}d ago`;
}

function getSignalLabel(type: string): { text: string; color: string } {
  switch (type) {
    case "ENTRY_1":
      return { text: "ENTRY ①", color: "bg-green-500/20 text-green-300" };
    case "ENTRY_2":
      return { text: "ENTRY ②", color: "bg-yellow-500/20 text-yellow-300" };
    case "ADD":
      return { text: "ADD", color: "bg-blue-500/20 text-blue-300" };
    case "EXIT":
      return { text: "EXIT", color: "bg-red-500/20 text-red-300" };
    default:
      return { text: type, color: "bg-gray-500/20 text-gray-300" };
  }
}

// ─── Stop Trail Calculator ─────────────────────────────────
interface StopMilestone {
  label: string;
  price: number;
  reached: boolean;
  isNext: boolean;
}

function calcStopTrail(signal: Signal, currentPrice: number): {
  currentR: number;
  milestones: StopMilestone[];
  distanceToNext: number;
} {
  if (!signal || (signal.type !== "ENTRY_1" && signal.type !== "ENTRY_2")) {
    return { currentR: 0, milestones: [], distanceToNext: 0 };
  }
  const entry = signal.entry;
  const initialSL = signal.stop;
  const risk = Math.abs(entry - initialSL);
  if (risk === 0) return { currentR: 0, milestones: [], distanceToNext: 0 };

  let currentR = 0;
  if (signal.direction === "LONG") {
    currentR = (currentPrice - entry) / risk;
  } else {
    currentR = (entry - currentPrice) / risk;
  }

  const milestones: StopMilestone[] = [];

  milestones.push({
    label: "Hard Stop",
    price: initialSL,
    reached: currentR >= 0,
    isNext: false,
  });

  const bePrice = entry;
  const beReached = currentR >= 1;
  milestones.push({
    label: "Breakeven",
    price: bePrice,
    reached: beReached,
    isNext: !beReached && currentR >= 0,
  });

  let lock50Price: number;
  if (signal.direction === "LONG") {
    lock50Price = entry + risk * 2 * 0.5;
  } else {
    lock50Price = entry - risk * 2 * 0.5;
  }
  const lock50Reached = currentR >= 2;
  milestones.push({
    label: "50% Lock",
    price: lock50Price,
    reached: lock50Reached,
    isNext: !lock50Reached && beReached,
  });

  let lock70Price: number;
  if (signal.direction === "LONG") {
    lock70Price = entry + risk * 3 * 0.7;
  } else {
    lock70Price = entry - risk * 3 * 0.7;
  }
  const lock70Reached = currentR >= 3;
  milestones.push({
    label: "70% Lock",
    price: lock70Price,
    reached: lock70Reached,
    isNext: !lock70Reached && lock50Reached,
  });

  let distanceToNext = 0;
  const nextMilestone = milestones.find((m) => m.isNext);
  if (nextMilestone) {
    distanceToNext = Math.abs(nextMilestone.price - currentPrice);
  }

  return { currentR, milestones, distanceToNext };
}

// ─── Signal Section ────────────────────────────────────────
function SignalSection({ signal, currentPrice }: { signal: Signal; currentPrice: number }) {
  const label = getSignalLabel(signal.type);
  const status = signal.meta?.status || "ACTIVE";
  const entry = signal.entry;
  const stop = signal.stop;
  const target = signal.target;

  const trail = calcStopTrail(signal, currentPrice);

  const progress =
    status === "ACTIVE" && entry && target && stop
      ? signal.direction === "LONG"
        ? Math.max(0, Math.min(100, ((currentPrice - entry) / (target - entry)) * 100))
        : Math.max(0, Math.min(100, ((entry - currentPrice) / (entry - target)) * 100))
      : 0;

  const unrealizedPnL =
    status === "ACTIVE" && currentPrice && entry
      ? signal.direction === "LONG"
        ? ((currentPrice - entry) / entry) * 100
        : ((entry - currentPrice) / entry) * 100
      : 0;

  return (
    <div className={`mb-3 p-3 rounded border ${signal.direction === "LONG" ? "border-green-500/30 bg-green-900/10" : "border-red-500/30 bg-red-900/10"}`}>
      {/* Signal Header */}
      <div className="flex justify-between items-center mb-2">
        <div className="flex items-center gap-2">
          <span className={`px-2 py-0.5 rounded text-[10px] font-bold ${label.color}`}>{label.text}</span>
          <span className={`text-[10px] font-bold ${signal.direction === "LONG" ? "text-green-400" : "text-red-400"}`}>
            {signal.direction}
          </span>
          <span className={`text-[9px] px-1.5 py-0.5 rounded font-bold ${status === "ACTIVE" ? "bg-green-500/30 text-green-300" : status === "STALE" ? "bg-gray-500/30 text-gray-300" : "bg-blue-500/30 text-blue-300"}`}>
            {status}
          </span>
        </div>
        <span className="text-[10px] text-gray-500">{timeAgo(signal.timestamp)}</span>
      </div>

      {/* Progress Bar */}
      {status === "ACTIVE" && (
        <div className="mb-3">
          <div className="flex justify-between text-[10px] text-gray-400 mb-1">
            <span>SL</span>
            <span className={unrealizedPnL > 0 ? "text-green-400" : unrealizedPnL < 0 ? "text-red-400" : "text-gray-400"}>
              {unrealizedPnL > 0 ? "+" : ""}{unrealizedPnL.toFixed(2)}%
            </span>
            <span>Target</span>
          </div>
          <div className="relative h-2 bg-gray-700 rounded-full">
            <div
              className="absolute top-0 bottom-0 w-0.5 bg-white/50 z-10"
              style={{
                left: `${Math.max(0, Math.min(100, signal.direction === "LONG"
                  ? ((entry - stop) / (target - stop)) * 100
                  : ((stop - entry) / (stop - target)) * 100
                ))}%`
              }}
            />
            <div
              className={`absolute top-0 bottom-0 rounded-full transition-all ${unrealizedPnL >= 0 ? "bg-green-500" : "bg-red-500"}`}
              style={{
                left: 0,
                width: `${Math.max(0, Math.min(100, signal.direction === "LONG"
                  ? ((currentPrice - stop) / (target - stop)) * 100
                  : ((stop - currentPrice) / (stop - target)) * 100
                ))}%`
              }}
            />
          </div>
          <div className="flex justify-between text-[9px] text-gray-500 mt-0.5">
            <span>{money(stop)}</span>
            <span className="text-gray-400">Entry {money(entry)}</span>
            <span>{money(target)}</span>
          </div>
        </div>
      )}

      {/* Levels */}
      <div className="mb-3 p-2 rounded bg-gray-900/70 border border-gray-700/50">
        <div className="grid grid-cols-2 gap-x-3 gap-y-1.5">
          <LevelRow label="Entry" value={money(signal.entry)} />
          <LevelRow label="Target" value={money(signal.target)} color="text-purple-400" />
          <LevelRow label="Initial SL" value={money(signal.stop)} color="text-red-400" />
          <LevelRow label="R:R" value={signal.rr?.toFixed(2)} color="text-yellow-400" />
          <LevelRow label="Expected" value={`${signal.expectedMove?.toFixed(1)}%`} color="text-blue-400" />
          <LevelRow label="Stoch" value={`K=${signal.stochK} D=${signal.stochD}`} color="text-gray-300" />
        </div>
      </div>

      {/* Stop Trail */}
      {trail.milestones.length > 0 && status === "ACTIVE" && (
        <div className="mb-2 p-2 rounded bg-gray-900/50 border border-gray-700/30">
          <div className="flex justify-between items-center mb-1">
            <span className="text-[10px] text-gray-500 uppercase">Stop Trail</span>
            <span className="text-[10px] font-mono text-yellow-400">{trail.currentR.toFixed(2)}R</span>
          </div>
          <div className="space-y-1">
            {trail.milestones.map((m, idx) => (
              <div key={idx} className="flex items-center gap-2">
                <div className={`w-2 h-2 rounded-full shrink-0 ${m.reached ? "bg-green-500" : m.isNext ? "bg-yellow-400" : "bg-gray-600"}`} />
                <div className="flex-1 flex justify-between text-[11px]">
                  <span className={m.reached ? "text-green-400" : m.isNext ? "text-yellow-400" : "text-gray-500"}>
                    {m.label} {m.isNext && "←"}
                  </span>
                  <span className="font-mono">{money(m.price)}</span>
                </div>
              </div>
            ))}
          </div>
          {trail.distanceToNext > 0 && (
            <div className="mt-1 text-center text-[10px] text-yellow-400 font-mono">
              {money(trail.distanceToNext)} to next
            </div>
          )}
        </div>
      )}

      {signal.reason && (
        <div className="text-[10px] text-gray-500 leading-relaxed border-t border-gray-700/50 pt-2">
          {signal.reason}
        </div>
      )}
    </div>
  );
}

// ─── Observer View ─────────────────────────────────────────
function ObserverView({ longContext, shortContext }: { longContext?: DirectionalContext; shortContext?: DirectionalContext }) {
  return (
    <div className="mb-3 p-3 rounded bg-gray-900/50 border border-gray-700/50">
      <div className="text-[10px] text-gray-500 uppercase tracking-wider mb-2 font-semibold">Market Observer</div>
      <div className="space-y-2">
        {longContext && (
          <ObserverRow direction="LONG" ctx={longContext} />
        )}
        {shortContext && (
          <ObserverRow direction="SHORT" ctx={shortContext} />
        )}
        {!longContext && !shortContext && (
          <div className="text-[11px] text-gray-500 text-center py-2">Analyzing both directions...</div>
        )}
      </div>
    </div>
  );
}

function ObserverRow({ direction, ctx }: { direction: "LONG" | "SHORT"; ctx: DirectionalContext }) {
  const isLong = direction === "LONG";
  const triggerFired = ctx.trigger?.fired || ctx.addTrigger?.fired;
  const triggerType = ctx.trigger?.triggerType || ctx.addTrigger ? "add" : "none";

  return (
    <div className={`p-2 rounded border ${isLong ? "border-green-500/20 bg-green-900/5" : "border-red-500/20 bg-red-900/5"}`}>
      <div className="flex justify-between items-center mb-1">
        <span className={`text-[11px] font-bold ${isLong ? "text-green-400" : "text-red-400"}`}>{direction}</span>
        <span className={`text-[9px] px-1.5 py-0.5 rounded ${triggerFired ? "bg-green-500/30 text-green-300" : "bg-gray-600/30 text-gray-400"}`}>
          {triggerFired ? "TRIGGER READY" : "WAITING"}
        </span>
      </div>
      <div className="grid grid-cols-2 gap-1 text-[10px]">
        <span className="text-gray-500">Location:</span>
        <span className="text-gray-300">{ctx.location.locationType}</span>
        <span className="text-gray-500">Phase:</span>
        <span className="text-gray-300">{ctx.location.marketPhase}</span>
        <span className="text-gray-500">Stoch:</span>
        <span className="text-gray-300">K={ctx.trigger?.stochK ?? ctx.addTrigger?.stochK ?? "—"} D={ctx.trigger?.stochD ?? ctx.addTrigger?.stochD ?? "—"}</span>
        <span className="text-gray-500">Cross:</span>
        <span className="text-gray-300">{ctx.trigger?.crossAge ? `${ctx.trigger.crossAge} candles ago` : "—"}</span>
      </div>
      {ctx.reason && !ctx.canEnter && (
        <div className="mt-1 text-[9px] text-gray-600 italic">{ctx.reason}</div>
      )}
    </div>
  );
}

// ─── Main Dashboard ────────────────────────────────────────
export default function Dashboard() {
  const [signals, setSignals] = useState<Record<string, Signal[]>>({});
  const [marketData, setMarketData] = useState<Record<string, MarketData>>({});
  const [livePrices, setLivePrices] = useState<Record<string, number>>({});
  const [loading, setLoading] = useState(true);
  const [fetchCount, setFetchCount] = useState(0);
  const [lastFetch, setLastFetch] = useState<number>(0);

  useEffect(() => {
    async function load() {
      try {
        const res = await fetch("/api/signals", { cache: "no-store" });
        const data = await res.json();
        const sigMap: Record<string, Signal[]> = {};
        const mktMap: Record<string, MarketData> = {};

        for (const p of PAIRS) {
          const s = data.signals?.filter((sig: Signal) => sig.pair === p) || [];
          sigMap[p] = s;
        }
        for (const m of data.marketData || []) {
          if (m?.pair) mktMap[m.pair] = m;
        }

        setSignals(sigMap);
        setMarketData(mktMap);
        setFetchCount((c) => c + 1);
        setLastFetch(Date.now());
      } catch (e) {
        console.error(e);
      } finally {
        setLoading(false);
      }
    }
    load();
    const i = setInterval(load, 30000);
    return () => clearInterval(i);
  }, []);

  useEffect(() => {
    async function loadPrices() {
      const liveMap: Record<string, number> = {};
      await Promise.all(
        PAIRS.map(async (pair) => {
          const price = await fetchKrakenPrice(pair);
          if (price) liveMap[pair] = price;
        })
      );
      setLivePrices(liveMap);
    }
    loadPrices();
    const i = setInterval(loadPrices, 10000);
    return () => clearInterval(i);
  }, []);

  if (loading) {
    return (
      <div className="min-h-screen bg-gray-900 text-white flex items-center justify-center">
        <div className="text-lg">Loading CX Switch v53.0...</div>
      </div>
    );
  }

  return (
    <div className="min-h-screen bg-gray-900 text-white p-6">
      <div className="max-w-7xl mx-auto">
        <div className="flex justify-between items-center mb-6">
          <h1 className="text-2xl font-bold">CX Switch v53.0</h1>
          <div className="text-xs text-gray-400">
            Fetches: {fetchCount} | Last:{" "}
            {lastFetch ? new Date(lastFetch).toLocaleTimeString() : "—"}
          </div>
        </div>

        <div className="grid md:grid-cols-2 lg:grid-cols-4 gap-4">
          {PAIRS.map((pair) => {
            const pairSignals = signals[pair] || [];
            const mkt = marketData[pair];
            const livePrice = livePrices[pair];
            const currentPrice = livePrice ?? mkt?.price ?? 0;
            const hasSignals = pairSignals.length > 0;

            // Determine card border color based on active signals
            let borderClass = "border-gray-700 bg-gray-800";
            let bannerText = "";
            let bannerClass = "";

            if (hasSignals) {
              const longActive = pairSignals.some(s => s.direction === "LONG" && s.meta?.status === "ACTIVE");
              const shortActive = pairSignals.some(s => s.direction === "SHORT" && s.meta?.status === "ACTIVE");
              if (longActive && shortActive) {
                borderClass = "border-purple-500 bg-purple-900/10";
                bannerText = "⚡ BOTH DIRECTIONS ACTIVE";
                bannerClass = "bg-purple-500 text-white";
              } else if (longActive) {
                borderClass = "border-green-500 bg-green-900/10";
                bannerText = "🟢 LONG ACTIVE";
                bannerClass = "bg-green-600 text-white";
              } else if (shortActive) {
                borderClass = "border-red-500 bg-red-900/10";
                bannerText = "🔴 SHORT ACTIVE";
                bannerClass = "bg-red-600 text-white";
              } else {
                // Only stale/exited signals
                borderClass = "border-gray-600 bg-gray-800";
              }
            } else {
              if (mkt) {
                bannerText = `⏳ ${mkt.trend} — Observing both sides`;
                bannerClass = mkt.trend === "LONG" ? "bg-green-600/30 text-green-300" : mkt.trend === "SHORT" ? "bg-red-600/30 text-red-300" : "bg-gray-600/30 text-gray-300";
              }
            }

            const trendReady = mkt?.trend === "LONG" || mkt?.trend === "SHORT" || mkt?.trend === "FLAT";
            const locationReady = !!mkt?.location && mkt.location !== "NONE";
            const triggerFired = mkt?.trigger === "FIRED";

            return (
              <div key={pair} className={`rounded-lg p-4 border-2 transition-all ${borderClass}`}>
                {bannerText && (
                  <div className={`mb-3 py-1.5 px-2 rounded text-center font-bold text-xs ${bannerClass}`}>
                    {bannerText}
                  </div>
                )}

                {/* Header */}
                <div className="flex justify-between items-start mb-3">
                  <div>
                    <div className="font-bold text-base">{pair}/USD</div>
                    <div className="flex items-center gap-2">
                      <div className="text-xl font-mono">{money(currentPrice)}</div>
                      {livePrice && (
                        <span className="text-[10px] bg-green-600/50 text-green-300 px-1 py-0.5 rounded">LIVE</span>
                      )}
                    </div>
                  </div>
                  <div className="flex flex-col items-end gap-1">
                    {hasSignals ? (
                      <span className="text-[10px] bg-gray-700 text-gray-300 px-2 py-0.5 rounded">
                        {pairSignals.length} signal{pairSignals.length > 1 ? "s" : ""}
                      </span>
                    ) : (
                      <span className="px-2 py-0.5 rounded text-[10px] bg-gray-600 text-gray-300">NO SIGNAL</span>
                    )}
                  </div>
                </div>

                {/* Trade Steps */}
                <div className="mb-3 p-2 rounded bg-gray-900/50 border border-gray-700/50">
                  <div className="text-[10px] text-gray-500 uppercase tracking-wider mb-2 font-semibold">Trade Steps</div>
                  <div className="space-y-1.5">
                    <StepRow label="Trend" ready={trendReady} value={mkt?.trend || "—"} />
                    <StepRow label="Location" ready={locationReady} value={mkt?.location || "—"} />
                    <StepRow label="Trigger" ready={triggerFired} value={mkt?.trigger || "—"} />
                  </div>
                </div>

                {/* Active Signals or Observer View */}
                {hasSignals ? (
                  <div className="space-y-2">
                    {pairSignals.map((signal) => (
                      <SignalSection key={signal.id} signal={signal} currentPrice={currentPrice} />
                    ))}
                  </div>
                ) : (
                  <ObserverView longContext={mkt?.longContext} shortContext={mkt?.shortContext} />
                )}

                {/* Market Context */}
                {mkt && (
                  <div className="mt-3 p-2 rounded border bg-gray-800/50 border-gray-600/50">
                    <div className="flex justify-between mt-1 text-[10px]">
                      <span className="text-gray-500">ADX: {mkt.adx?.toFixed(1)}</span>
                      <span className="text-gray-500">RSI: {mkt.rsi?.toFixed(1)}</span>
                    </div>
                    <div className="flex justify-between text-[10px]">
                      <span className="text-gray-500">Stoch K: {mkt.stochK?.toFixed(1)}</span>
                      <span className="text-gray-500">D: {mkt.stochD?.toFixed(1)}</span>
                    </div>
                    {mkt.trendlinePrice > 0 && (
                      <div className="flex justify-between text-[10px] mt-1">
                        <span className="text-gray-500">TL:</span>
                        <span className="text-gray-400 font-mono">{money(mkt.trendlinePrice)} ({mkt.distToTrendline?.toFixed(2)}%)</span>
                      </div>
                    )}
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

function StepRow({ label, ready, value }: { label: string; ready: boolean; value: string }) {
  return (
    <div className="flex items-center justify-between text-xs">
      <div className="flex items-center gap-2">
        <span className={`w-2 h-2 rounded-full ${ready ? "bg-green-400" : "bg-gray-600"}`} />
        <span className="text-gray-400">{label}</span>
      </div>
      <span className={`font-mono text-[10px] ${ready ? "text-green-400" : "text-gray-500"}`}>
        {value}
      </span>
    </div>
  );
}

function LevelRow({ label, value, color = "" }: { label: string; value: string | number; color?: string }) {
  return (
    <div className="flex justify-between text-sm">
      <span className="text-gray-400">{label}</span>
      <span className={`font-mono ${color || "text-gray-200"}`}>{value}</span>
    </div>
  );
}
