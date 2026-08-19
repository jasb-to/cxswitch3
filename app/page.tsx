"use client";

import { useEffect, useMemo, useState } from "react";

interface Signal {
  id: string;
  pair: string;
  direction: "LONG" | "SHORT";
  type: "ENTRY_1" | "ENTRY_2" | "ADD" | string;
  entry: number;
  stop: number;
  target: number;
  tp1?: number;
  tp3?: number;
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
    state?: string;
  };
}

interface HistoryEntry {
  id: string;
  pair: string;
  direction: "LONG" | "SHORT";
  type: string;
  entry: number;
  stop: number;
  target: number;
  timestamp: number;
  status: string;
  exitReason?: string;
  exitPrice?: number;
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
  positionState?: "ACTIVE";
  positionDirection?: "LONG" | "SHORT";
  positionEntry?: number;
  positionStop?: number;
  positionTarget?: number;
}

interface SystemState {
  lastCronRun: number;
  lastCronAgeMs: number | null;
  exchangeSyncConfigured: boolean;
  activePositions: number;
}

const PAIRS = ["BTC", "ETH", "SOL", "HYPE"];
const KRAKEN_PAIRS: Record<string, string> = { BTC: "XBTUSD", ETH: "ETHUSD", SOL: "SOLUSD", HYPE: "HYPEUSD" };

const money = (n?: number) =>
  typeof n === "number" && Number.isFinite(n)
    ? new Intl.NumberFormat("en-US", {
        style: "currency",
        currency: "USD",
        maximumFractionDigits: n >= 1000 ? 0 : n >= 1 ? 2 : 4,
      }).format(n)
    : "—";

const pct = (n: number) => `${n >= 0 ? "+" : ""}${n.toFixed(2)}%`;

function timeAgo(ts?: number): string {
  if (!ts) return "—";
  const mins = Math.max(0, Math.floor((Date.now() - ts) / 60000));
  if (mins < 1) return "just now";
  if (mins < 60) return `${mins}m ago`;
  const hrs = Math.floor(mins / 60);
  if (hrs < 24) return `${hrs}h ${mins % 60}m ago`;
  return `${Math.floor(hrs / 24)}d ago`;
}

function currentR(signal: Signal, price: number): number {
  const risk = Math.abs(signal.entry - signal.stop);
  if (!risk) return 0;
  return signal.direction === "LONG" ? (price - signal.entry) / risk : (signal.entry - price) / risk;
}

function setupLabel(mkt?: MarketData): string {
  if (!mkt) return "WAITING FOR DATA";
  if (mkt.trigger === "READY" && mkt.location === "NEAR_TL") return "ENTRY ZONE";
  if (mkt.location === "NEAR_TL") return "WATCHING RETEST";
  if (mkt.location === "BEYOND_TL") return "BREAKOUT / RETEST";
  return "WATCHING";
}

async function fetchKrakenPrice(pair: string): Promise<number | null> {
  try {
    const res = await fetch(`https://api.kraken.com/0/public/Ticker?pair=${KRAKEN_PAIRS[pair]}`, { cache: "no-store" });
    const data = await res.json();
    if (data.error?.length) return null;
    const ticker = data.result[Object.keys(data.result)[0]];
    return parseFloat(ticker.c[0]);
  } catch {
    return null;
  }
}

export default function Dashboard() {
  const [signals, setSignals] = useState<Record<string, Signal | null>>({});
  const [history, setHistory] = useState<HistoryEntry[]>([]);
  const [marketData, setMarketData] = useState<Record<string, MarketData>>({});
  const [livePrices, setLivePrices] = useState<Record<string, number>>({});
  const [system, setSystem] = useState<SystemState | null>(null);
  const [loading, setLoading] = useState(true);
  const [lastFetch, setLastFetch] = useState(0);

  async function loadState() {
    try {
      const res = await fetch("/api/signals", { cache: "no-store" });
      const data = await res.json();
      const sigMap: Record<string, Signal | null> = {};
      const mktMap: Record<string, MarketData> = {};
      for (const p of PAIRS) sigMap[p] = data.activeSignals?.find((s: Signal) => s.pair === p) || null;
      for (const m of data.marketData || []) if (m?.pair) mktMap[m.pair] = m;
      setSignals(sigMap);
      setHistory(data.signalHistory || []);
      setMarketData(mktMap);
      setSystem(data.system || null);
      setLastFetch(Date.now());
    } catch (e) {
      console.error("CXSwitch state load failed", e);
    } finally {
      setLoading(false);
    }
  }

  useEffect(() => {
    loadState();
    const interval = setInterval(loadState, 30000);
    return () => clearInterval(interval);
  }, []);

  useEffect(() => {
    async function loadPrices() {
      const next: Record<string, number> = {};
      await Promise.all(PAIRS.map(async (pair) => {
        const price = await fetchKrakenPrice(pair);
        if (price) next[pair] = price;
      }));
      setLivePrices(next);
    }
    loadPrices();
    const interval = setInterval(loadPrices, 10000);
    return () => clearInterval(interval);
  }, []);

  const activeCount = system?.activePositions ?? Object.values(signals).filter(Boolean).length;
  const recentHistory = useMemo(() => history.slice().reverse().slice(0, 12), [history]);

  if (loading) {
    return <main className="min-h-screen bg-[#080a0f] text-white flex items-center justify-center"><div className="text-sm text-gray-400">Loading CXSwitch…</div></main>;
  }

  return (
    <main className="min-h-screen bg-[#080a0f] text-white p-4 md:p-6">
      <div className="max-w-[1500px] mx-auto">
        <header className="flex flex-col md:flex-row md:items-center md:justify-between gap-4 mb-6">
          <div>
            <div className="flex items-center gap-3">
              <div className="w-9 h-9 rounded-xl bg-white text-black flex items-center justify-center font-black">CX</div>
              <div>
                <h1 className="text-xl font-bold tracking-tight">CXSwitch</h1>
                <p className="text-[11px] text-gray-500">v56 · v28 entry architecture · personal trading console</p>
              </div>
            </div>
          </div>
          <div className="flex flex-wrap items-center gap-2 text-[10px]">
            <span className="px-2.5 py-1.5 rounded-full border border-gray-800 bg-gray-900 text-gray-400">Live prices · 10s</span>
            <span className={`px-2.5 py-1.5 rounded-full border ${activeCount ? "border-green-500/30 bg-green-500/10 text-green-300" : "border-gray-800 bg-gray-900 text-gray-400"}`}>
              {activeCount} position{activeCount === 1 ? "" : "s"} active
            </span>
            <span className="px-2.5 py-1.5 rounded-full border border-gray-800 bg-gray-900 text-gray-500">
              Cron {system?.lastCronRun ? timeAgo(system.lastCronRun) : "—"}
            </span>
          </div>
        </header>

        <section className="grid md:grid-cols-3 gap-3 mb-5">
          <SummaryCard label="SYSTEM" value={system?.lastCronRun && system.lastCronAgeMs !== null && system.lastCronAgeMs < 20 * 60 * 1000 ? "RUNNING" : "CHECK CRON"} detail={system?.lastCronRun ? `Last analysis ${timeAgo(system.lastCronRun)}` : "No cron run recorded"} good={!!system?.lastCronRun && !!system?.lastCronAgeMs && system.lastCronAgeMs < 20 * 60 * 1000} />
          <SummaryCard label="POSITIONS" value={activeCount ? `${activeCount} ACTIVE` : "NONE"} detail={activeCount ? "Position state is persisted" : "No live position tracked"} good={activeCount > 0} />
          <SummaryCard label="EXCHANGE SYNC" value={system?.exchangeSyncConfigured ? "CONNECTED" : "LOCAL STATE"} detail={system?.exchangeSyncConfigured ? "Kraken can reconcile open positions" : "No Kraken private API credentials — state is preserved locally"} good={!system?.exchangeSyncConfigured || !!system?.exchangeSyncConfigured} />
        </section>

        <section className="grid md:grid-cols-2 xl:grid-cols-4 gap-4">
          {PAIRS.map((pair) => {
            const signal = signals[pair];
            const mkt = marketData[pair];
            const livePrice = livePrices[pair];
            const price = livePrice ?? mkt?.price ?? 0;
            const active = !!signal && signal.meta?.status === "ACTIVE";
            const r = active && signal ? currentR(signal, price) : 0;
            const pnl = active && signal ? (signal.direction === "LONG" ? ((price - signal.entry) / signal.entry) * 100 : ((signal.entry - price) / signal.entry) * 100) : 0;
            const targetProgress = active && signal && signal.target !== signal.entry
              ? Math.max(0, Math.min(100, signal.direction === "LONG" ? ((price - signal.entry) / (signal.target - signal.entry)) * 100 : ((signal.entry - price) / (signal.entry - signal.target)) * 100))
              : 0;
            const biasLong = mkt?.trend?.startsWith("LONG");
            const biasShort = mkt?.trend?.startsWith("SHORT");

            return (
              <article key={pair} className={`rounded-2xl border overflow-hidden ${active ? (signal!.direction === "LONG" ? "border-green-500/30 bg-[#0b120e]" : "border-red-500/30 bg-[#130b0b]") : "border-gray-800 bg-[#0d1016]"}`}>
                <div className="p-4 border-b border-gray-800/80">
                  <div className="flex justify-between items-start gap-3">
                    <div>
                      <div className="text-xs text-gray-500 tracking-widest">{pair}/USD</div>
                      <div className="mt-1 flex items-center gap-2">
                        <span className="text-2xl font-mono font-semibold">{money(price)}</span>
                        {livePrice && <span className="text-[9px] px-1.5 py-0.5 rounded bg-green-500/10 text-green-400">LIVE</span>}
                      </div>
                    </div>
                    {active ? (
                      <div className={`text-right ${signal!.direction === "LONG" ? "text-green-400" : "text-red-400"}`}>
                        <div className="text-[10px] font-bold">{signal!.direction === "LONG" ? "🟢" : "🔴"} POSITION ACTIVE</div>
                        <div className="text-[9px] text-gray-500 mt-1">{timeAgo(signal!.timestamp)}</div>
                      </div>
                    ) : (
                      <div className={`text-[10px] font-bold ${biasLong ? "text-green-400" : biasShort ? "text-red-400" : "text-gray-500"}`}>
                        {biasLong ? "LONG BIAS" : biasShort ? "SHORT BIAS" : "FLAT"}
                      </div>
                    )}
                  </div>
                </div>

                <div className="p-4 space-y-3">
                  {active && signal ? (
                    <>
                      <div className="rounded-xl bg-green-500/5 border border-green-500/15 p-3">
                        <div className="flex justify-between items-center mb-2">
                          <span className="text-[10px] uppercase tracking-widest text-gray-500">Trade</span>
                          <span className="text-[10px] font-bold text-green-400">{signal.type}</span>
                        </div>
                        <div className="grid grid-cols-2 gap-3">
                          <Metric label="Entry" value={money(signal.entry)} />
                          <Metric label="Now" value={money(price)} valueClass={pnl >= 0 ? "text-green-300" : "text-red-300"} />
                          <Metric label="P&L" value={pct(pnl)} valueClass={pnl >= 0 ? "text-green-300" : "text-red-300"} />
                          <Metric label="R" value={`${r.toFixed(2)}R`} valueClass="text-yellow-300" />
                        </div>
                      </div>

                      <div>
                        <div className="flex justify-between text-[9px] text-gray-500 mb-1.5"><span>Initial SL</span><span>Target</span></div>
                        <div className="h-2 rounded-full bg-gray-800 overflow-hidden">
                          <div className={`h-full rounded-full ${pnl >= 0 ? "bg-green-500" : "bg-red-500"}`} style={{ width: `${targetProgress}%` }} />
                        </div>
                        <div className="flex justify-between text-[9px] mt-1"><span className="text-red-400">{money(signal.stop)}</span><span className="text-gray-500">{targetProgress.toFixed(0)}% to target</span><span className="text-purple-300">{money(signal.target)}</span></div>
                      </div>

                      <div className="grid grid-cols-2 gap-2">
                        <MiniLevel label="Current stop" value={money(signal.stop)} tone="red" />
                        <MiniLevel label="Target" value={money(signal.target)} tone="purple" />
                        <MiniLevel label="R:R" value={signal.rr?.toFixed(2)} tone="yellow" />
                        <MiniLevel label="Expected" value={`${signal.expectedMove?.toFixed(1)}%`} tone="blue" />
                      </div>

                      <div className="rounded-xl border border-gray-800 bg-black/20 p-3">
                        <div className="text-[9px] uppercase tracking-widest text-gray-600 mb-2">Position state</div>
                        <div className="text-xs text-gray-300 leading-relaxed">
                          <span className="text-green-400 font-semibold">ENTRY LOCKED.</span> The entry engine is paused for {pair} while this position is active. Market context continues updating.
                        </div>
                      </div>
                    </>
                  ) : (
                    <>
                      <div className={`rounded-xl p-3 border ${biasLong ? "border-green-500/15 bg-green-500/5" : biasShort ? "border-red-500/15 bg-red-500/5" : "border-gray-800 bg-black/20"}`}>
                        <div className="flex justify-between items-center">
                          <span className="text-[10px] uppercase tracking-widest text-gray-500">Market state</span>
                          <span className={`text-[10px] font-bold ${biasLong ? "text-green-400" : biasShort ? "text-red-400" : "text-gray-500"}`}>{mkt?.trend || "WAITING"}</span>
                        </div>
                        <div className="mt-2 text-lg font-semibold">{setupLabel(mkt)}</div>
                        <div className="text-[10px] text-gray-500 mt-1">{mkt?.location || "No structure data"} · {mkt?.trigger || "WAITING"}</div>
                      </div>

                      <div className="rounded-xl border border-gray-800 bg-black/20 p-3">
                        <div className="text-[9px] uppercase tracking-widest text-gray-600 mb-2">Trade steps</div>
                        <Step label="Trend" value={mkt?.trend || "—"} ready={!!mkt?.trend && mkt.trend !== "FLAT"} />
                        <Step label="Location" value={mkt?.location || "—"} ready={mkt?.location === "NEAR_TL" || mkt?.location === "BEYOND_TL"} />
                        <Step label="Trigger" value={mkt?.trigger || "—"} ready={mkt?.trigger === "READY"} />
                      </div>
                    </>
                  )}

                  {mkt && (
                    <div className="grid grid-cols-2 gap-x-4 gap-y-2 text-[10px] text-gray-500 pt-1">
                      <span>ADX <b className="text-gray-300">{mkt.adx?.toFixed(1)}</b></span>
                      <span>RSI <b className="text-gray-300">{mkt.rsi?.toFixed(1)}</b></span>
                      <span>Stoch K <b className="text-gray-300">{mkt.stochK?.toFixed(1)}</b></span>
                      <span>D <b className="text-gray-300">{mkt.stochD?.toFixed(1)}</b></span>
                      <span className="col-span-2">4H Trendline <b className="text-gray-300 font-mono">{mkt.trendlinePrice ? money(mkt.trendlinePrice) : "—"}</b> <span className="text-gray-600">({mkt.distToTrendline?.toFixed(2) ?? "—"}%)</span></span>
                    </div>
                  )}
                </div>
              </article>
            );
          })}
        </section>

        <section className="mt-7 rounded-2xl border border-gray-800 bg-[#0d1016] overflow-hidden">
          <div className="px-4 py-3 border-b border-gray-800 flex justify-between items-center">
            <div><h2 className="font-semibold text-sm">Signal history</h2><p className="text-[10px] text-gray-600 mt-0.5">The record of what CXSwitch actually fired — not every market scan.</p></div>
            <span className="text-[9px] text-gray-600">{recentHistory.length} recent</span>
          </div>
          {recentHistory.length ? (
            <div className="overflow-x-auto"><table className="w-full text-xs"><thead className="text-[9px] uppercase tracking-wider text-gray-600"><tr><th className="px-4 py-2 text-left">Pair</th><th className="px-4 py-2 text-left">Direction</th><th className="px-4 py-2 text-left">Type</th><th className="px-4 py-2 text-left">Entry</th><th className="px-4 py-2 text-left">Status</th><th className="px-4 py-2 text-left">Exit / reason</th><th className="px-4 py-2 text-left">Age</th></tr></thead><tbody className="divide-y divide-gray-800">
              {recentHistory.map((h) => <tr key={h.id} className="hover:bg-white/[0.02]"><td className="px-4 py-2.5 font-mono font-semibold">{h.pair}</td><td className={`px-4 py-2.5 font-semibold ${h.direction === "LONG" ? "text-green-400" : "text-red-400"}`}>{h.direction}</td><td className="px-4 py-2.5 text-gray-400">{h.type}</td><td className="px-4 py-2.5 font-mono">{money(h.entry)}</td><td className="px-4 py-2.5"><StatusBadge status={h.status} /></td><td className="px-4 py-2.5 text-gray-500">{h.exitPrice ? money(h.exitPrice) : h.exitReason || "—"}</td><td className="px-4 py-2.5 text-gray-600">{timeAgo(h.exitTimestamp || h.timestamp)}</td></tr>)}
            </tbody></table></div>
          ) : <div className="p-8 text-center text-sm text-gray-600">No signals recorded yet.</div>}
        </section>

        <footer className="mt-5 flex flex-col md:flex-row md:justify-between gap-2 text-[9px] text-gray-700">
          <span>CXSwitch · personal trading system · strategy unchanged in this release</span>
          <span>Dashboard refreshed {lastFetch ? new Date(lastFetch).toLocaleTimeString() : "—"}</span>
        </footer>
      </div>
    </main>
  );
}

function SummaryCard({ label, value, detail, good }: { label: string; value: string; detail: string; good: boolean }) {
  return <div className="rounded-xl border border-gray-800 bg-[#0d1016] p-3"><div className="flex justify-between"><span className="text-[9px] tracking-widest text-gray-600">{label}</span><span className={`w-1.5 h-1.5 rounded-full mt-1 ${good ? "bg-green-400" : "bg-yellow-400"}`} /></div><div className="mt-1 text-sm font-semibold">{value}</div><div className="mt-1 text-[9px] text-gray-600 leading-relaxed">{detail}</div></div>;
}

function Metric({ label, value, valueClass = "text-gray-200" }: { label: string; value: string; valueClass?: string }) {
  return <div><div className="text-[9px] text-gray-600 uppercase tracking-wider">{label}</div><div className={`mt-0.5 text-sm font-mono ${valueClass}`}>{value}</div></div>;
}

function MiniLevel({ label, value, tone }: { label: string; value: string; tone: "red" | "purple" | "yellow" | "blue" }) {
  const classes = { red: "text-red-300", purple: "text-purple-300", yellow: "text-yellow-300", blue: "text-blue-300" };
  return <div className="rounded-lg bg-black/20 border border-gray-800 p-2"><div className="text-[8px] text-gray-600 uppercase">{label}</div><div className={`mt-0.5 text-xs font-mono ${classes[tone]}`}>{value}</div></div>;
}

function Step({ label, value, ready }: { label: string; value: string; ready: boolean }) {
  return <div className="flex justify-between items-center py-1.5"><span className="flex items-center gap-2 text-gray-500"><span className={`w-1.5 h-1.5 rounded-full ${ready ? "bg-green-400" : "bg-gray-700"}`} />{label}</span><span className={`font-mono text-[10px] ${ready ? "text-green-300" : "text-gray-600"}`}>{value}</span></div>;
}

function StatusBadge({ status }: { status: string }) {
  const cls = status === "ACTIVE" ? "bg-green-500/10 text-green-300" : status === "TP_HIT" ? "bg-purple-500/10 text-purple-300" : status === "SL_HIT" ? "bg-red-500/10 text-red-300" : "bg-gray-500/10 text-gray-400";
  return <span className={`px-1.5 py-0.5 rounded text-[9px] font-semibold ${cls}`}>{status}</span>;
}
