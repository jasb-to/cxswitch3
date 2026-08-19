"use client";

import { useEffect, useMemo, useState } from "react";
import { Activity, ArrowUpRight, Brain, CircleAlert, Clock3, ExternalLink, Gauge, Radio, ShieldCheck, Zap } from "lucide-react";

interface Signal {
  id: string; pair: string; direction: "LONG" | "SHORT"; type: string;
  entry: number; stop: number; target: number; rr: number; timestamp: number; expectedMove: number;
  adx?: number; rsi?: number; stochK?: number; stochD?: number; reason?: string;
  trend?: string; location?: string; trigger?: string;
  context?: { marketPhase?: string; structure?: string; momentum?: string; pullback?: string };
  meta?: { status: string; ageMinutes: number; actionable: boolean; state?: string };
}
interface HistoryEntry {
  id: string; pair: string; direction: "LONG" | "SHORT"; type: string; entry: number; stop: number; target: number;
  timestamp: number; status: string; exitReason?: string; exitPrice?: number; exitTimestamp?: number;
}
interface MarketData {
  pair: string; price: number; trend: string; location: string; trigger: string; adx: number; rsi: number;
  stochK: number; stochD: number; timestamp: number; trendlinePrice: number; distToTrendline: number | null;
  positionState?: "ACTIVE"; positionDirection?: "LONG" | "SHORT"; positionEntry?: number; positionStop?: number; positionTarget?: number;
  marketPhase?: string; setup?: string; momentum?: string;
}
interface SystemState { lastCronRun: number; lastCronAgeMs: number | null; activePositions: number; }

const PAIRS = ["BTC", "ETH", "SOL", "HYPE"];
const KRAKEN_PAIRS: Record<string, string> = { BTC: "XBTUSD", ETH: "ETHUSD", SOL: "SOLUSD", HYPE: "HYPEUSD" };
const SHADOW_URL = "https://www.shadowsignals.live";

const money = (n?: number) => typeof n === "number" && Number.isFinite(n)
  ? new Intl.NumberFormat("en-US", { style: "currency", currency: "USD", maximumFractionDigits: n >= 1000 ? 0 : n >= 1 ? 2 : 4 }).format(n)
  : "—";
const pct = (n: number) => `${n >= 0 ? "+" : ""}${n.toFixed(2)}%`;
function timeAgo(ts?: number) { if (!ts) return "—"; const m = Math.max(0, Math.floor((Date.now() - ts) / 60000)); if (m < 1) return "just now"; if (m < 60) return `${m}m ago`; const h = Math.floor(m / 60); if (h < 24) return `${h}h ${m % 60}m ago`; return `${Math.floor(h / 24)}d ago`; }
function currentR(s: Signal, p: number) { const risk = Math.abs(s.entry - s.stop); return risk ? (s.direction === "LONG" ? (p - s.entry) / risk : (s.entry - p) / risk) : 0; }
function phase(m?: MarketData) {
  if (!m) return "WAITING FOR DATA";
  if (m.location === "NEAR_TL" && m.trigger === "READY") return "ENTRY ZONE";
  if (m.location === "NEAR_TL") return "RETEST WATCH";
  if (m.location === "BEYOND_TL") return "BREAKOUT / EXPANSION";
  return "WATCHING";
}
function phaseTone(m?: MarketData) { return m?.trend?.startsWith("LONG") ? "text-[#dc6b27]" : m?.trend?.startsWith("SHORT") ? "text-red-400" : "text-white/30"; }
async function fetchKrakenPrice(pair: string): Promise<number | null> { try { const r = await fetch(`https://api.kraken.com/0/public/Ticker?pair=${KRAKEN_PAIRS[pair]}`, { cache: "no-store" }); const d = await r.json(); if (d.error?.length) return null; return parseFloat(d.result[Object.keys(d.result)[0]].c[0]); } catch { return null; } }

export default function Dashboard() {
  const [signals, setSignals] = useState<Record<string, Signal | null>>({});
  const [history, setHistory] = useState<HistoryEntry[]>([]);
  const [market, setMarket] = useState<Record<string, MarketData>>({});
  const [prices, setPrices] = useState<Record<string, number>>({});
  const [system, setSystem] = useState<SystemState | null>(null);
  const [loading, setLoading] = useState(true);
  const [lastFetch, setLastFetch] = useState(0);

  async function loadState() {
    try {
      const r = await fetch("/api/signals", { cache: "no-store" });
      const d = await r.json();
      const nextSignals: Record<string, Signal | null> = {};
      const nextMarket: Record<string, MarketData> = {};
      for (const p of PAIRS) nextSignals[p] = d.activeSignals?.find((x: Signal) => x.pair === p) || null;
      for (const x of d.marketData || []) if (x?.pair) nextMarket[x.pair] = x;
      setSignals(nextSignals); setHistory(d.signalHistory || []); setMarket(nextMarket); setSystem(d.system || null); setLastFetch(Date.now());
    } catch (e) { console.error("CXSwitch state load failed", e); }
    finally { setLoading(false); }
  }

  useEffect(() => { loadState(); const i = setInterval(loadState, 30000); return () => clearInterval(i); }, []);
  useEffect(() => {
    async function loadPrices() {
      const next: Record<string, number> = {};
      await Promise.all(PAIRS.map(async p => { const x = await fetchKrakenPrice(p); if (x) next[p] = x; }));
      setPrices(next);
    }
    loadPrices(); const i = setInterval(loadPrices, 10000); return () => clearInterval(i);
  }, []);

  const activeCount = system?.activePositions ?? Object.values(signals).filter(Boolean).length;
  const recent = useMemo(() => history.slice().reverse().slice(0, 10), [history]);
  const strongMarkets = PAIRS.map(p => market[p]).filter(Boolean).filter(m => m.trend?.includes("STRONG")).length;

  if (loading) return <main className="min-h-screen bg-[#070707] text-white flex items-center justify-center"><span className="text-sm text-white/35">Loading CXSwitch…</span></main>;

  return (
    <main className="min-h-screen bg-[#070707] text-white">
      <nav className="border-b border-white/[0.08]">
        <div className="mx-auto max-w-7xl px-6 py-5 flex flex-col gap-5 lg:flex-row lg:items-center lg:justify-between">
          <div className="flex items-center gap-3">
            <div className="flex h-9 w-9 items-center justify-center rounded-lg bg-[#dc6b27] text-sm font-black text-black">CX</div>
            <div>
              <div className="text-sm font-bold tracking-[0.18em]">CXSWITCH</div>
              <div className="mt-0.5 text-[9px] uppercase tracking-[0.2em] text-white/30">Personal Trading Intelligence</div>
            </div>
          </div>
          <div className="flex flex-wrap items-center gap-2">
            <Badge icon={<Radio size={12}/>} text="LIVE · 10s" />
            <Badge icon={<Clock3 size={12}/>} text={`CRON ${system?.lastCronRun ? timeAgo(system.lastCronRun) : "—"}`} />
            <a href={SHADOW_URL} target="_blank" rel="noreferrer" className="inline-flex items-center gap-2 rounded-lg bg-[#dc6b27] px-4 py-2.5 text-xs font-semibold text-black hover:opacity-90">
              ShadowSignals <ExternalLink size={13}/>
            </a>
          </div>
        </div>
      </nav>

      <section className="relative overflow-hidden border-b border-white/[0.08]">
        <div className="pointer-events-none absolute left-1/2 top-0 h-[520px] w-[520px] -translate-x-1/2 rounded-full bg-[#dc6b27]/[0.06] blur-[140px]" />
        <div className="relative mx-auto max-w-7xl px-6 py-14 md:py-20">
          <div className="max-w-4xl">
            <div className="mb-6 inline-flex items-center gap-2 rounded-full border border-[#dc6b27]/20 bg-[#dc6b27]/[0.06] px-3 py-1.5 text-[10px] uppercase tracking-[0.16em] text-[#dc6b27]">
              <span className="h-1.5 w-1.5 rounded-full bg-[#dc6b27]" /> v28 entry architecture · 5/13 daily bias
            </div>
            <h1 className="text-5xl font-semibold leading-[1.02] tracking-[-0.045em] sm:text-7xl">
              Read the move.
              <br />
              <span className="text-white/30">Get there early.</span>
            </h1>
            <p className="mt-7 max-w-2xl text-base leading-7 text-white/45 md:text-lg">
              CXSwitch watches the structure you actually trade: a faster 5/13 daily bias, stateful 4H trendlines, StochRSI timing and continuation alerts — built for a hands-off manual trading workflow.
            </p>
          </div>

          <div className="mt-12 grid gap-px overflow-hidden rounded-2xl border border-white/[0.08] bg-white/[0.08] md:grid-cols-4">
            <Stat icon={<Activity size={18}/>} label="SYSTEM" value={system?.lastCronRun && system.lastCronAgeMs !== null && system.lastCronAgeMs < 1200000 ? "RUNNING" : "CHECK"} detail={system?.lastCronRun ? `Last analysis ${timeAgo(system.lastCronRun)}` : "No run recorded"} />
            <Stat icon={<Gauge size={18}/>} label="TRACKING" value={`${PAIRS.length} MARKETS`} detail={`${strongMarkets} strong trend${strongMarkets === 1 ? "" : "s"}`} />
            <Stat icon={<Zap size={18}/>} label="WORKING" value={`${activeCount} SIGNAL${activeCount === 1 ? "" : "S"}`} detail="Local trade state" />
            <Stat icon={<ShieldCheck size={18}/>} label="EXECUTION" value="MANUAL" detail="No exchange credentials" />
          </div>
        </div>
      </section>

      <section className="mx-auto max-w-7xl px-6 py-10">
        <div className="mb-6 flex items-end justify-between">
          <div><div className="text-[10px] uppercase tracking-[0.18em] text-white/25">Market board</div><h2 className="mt-2 text-2xl font-semibold tracking-tight">Where is the market now?</h2></div>
          <div className="hidden text-[10px] text-white/25 md:block">Updated {lastFetch ? new Date(lastFetch).toLocaleTimeString() : "—"}</div>
        </div>

        <div className="grid gap-px overflow-hidden rounded-2xl border border-white/[0.08] bg-white/[0.08] md:grid-cols-2 xl:grid-cols-4">
          {PAIRS.map(pair => {
            const s = signals[pair], m = market[pair], price = prices[pair] ?? m?.price ?? 0;
            const active = !!s && s.meta?.status === "ACTIVE";
            const r = active && s ? currentR(s, price) : 0;
            const pnl = active && s ? (s.direction === "LONG" ? (price - s.entry) / s.entry * 100 : (s.entry - price) / s.entry * 100) : 0;
            const progress = active && s && s.target !== s.entry ? Math.max(0, Math.min(100, s.direction === "LONG" ? (price - s.entry) / (s.target - s.entry) * 100 : (s.entry - price) / (s.entry - s.target) * 100)) : 0;
            return (
              <article key={pair} className="bg-[#0b0b0b] p-6 hover:bg-[#0f0f0f] transition-colors min-h-[430px] flex flex-col">
                <div className="flex items-start justify-between">
                  <div><div className="text-[10px] uppercase tracking-[0.18em] text-white/25">{pair}/USD</div><div className="mt-2 text-3xl font-semibold tracking-tight">{money(price)}</div></div>
                  <span className={`text-[9px] font-bold uppercase tracking-widest ${phaseTone(m)}`}>{m?.trend?.split(" ")[0] || "—"}</span>
                </div>

                <div className="mt-7 border-y border-white/[0.06] py-5">
                  <div className="flex items-center gap-2 text-[9px] uppercase tracking-[0.18em] text-white/25"><span className={`h-1.5 w-1.5 rounded-full ${m?.trend?.startsWith("LONG") ? "bg-[#dc6b27]" : m?.trend?.startsWith("SHORT") ? "bg-red-400" : "bg-white/20"}`} /> Market state</div>
                  <div className={`mt-2 text-xl font-semibold ${phaseTone(m)}`}>{active ? `${s?.direction} · ${s?.type}` : phase(m)}</div>
                  <div className="mt-2 text-[10px] uppercase tracking-wider text-white/25">{m?.location || "NO STRUCTURE"} · {m?.trigger || "WAITING"}</div>
                </div>

                {active && s ? (
                  <div className="mt-5 space-y-5">
                    <div className="grid grid-cols-2 gap-y-4">
                      <Metric label="ENTRY" value={money(s.entry)} />
                      <Metric label="NOW" value={money(price)} accent={pnl >= 0} />
                      <Metric label="P&L" value={pct(pnl)} accent={pnl >= 0} />
                      <Metric label="R" value={`${r.toFixed(2)}R`} accent />
                    </div>
                    <div><div className="flex justify-between text-[9px] text-white/25 mb-2"><span>STOP {money(s.stop)}</span><span>TP {money(s.target)}</span></div><div className="h-1.5 bg-white/[0.06] rounded-full overflow-hidden"><div className="h-full bg-[#dc6b27]" style={{ width: `${progress}%` }} /></div></div>
                    <div className="grid grid-cols-2 gap-2"><Mini label="R:R" value={s.rr?.toFixed(2)} /><Mini label="EXPECTED" value={`${s.expectedMove?.toFixed(1)}%`} /><Mini label="ADX" value={s.adx?.toFixed(1)} /><Mini label="STOCH" value={`${s.stochK?.toFixed(1)} / ${s.stochD?.toFixed(1)}`} /></div>
                  </div>
                ) : (
                  <div className="mt-5 space-y-4">
                    <Step label="Trend" value={m?.trend || "—"} good={!!m?.trend && m.trend !== "FLAT"} />
                    <Step label="Location" value={m?.location || "—"} good={m?.location === "NEAR_TL" || m?.location === "BEYOND_TL"} />
                    <Step label="Trigger" value={m?.trigger || "—"} good={m?.trigger === "READY"} />
                    <div className="grid grid-cols-2 gap-2 pt-2"><Mini label="ADX" value={m?.adx?.toFixed(1)} /><Mini label="RSI" value={m?.rsi?.toFixed(1)} /><Mini label="STOCH K" value={m?.stochK?.toFixed(1)} /><Mini label="4H TL" value={m?.trendlinePrice ? money(m.trendlinePrice) : "—"} /></div>
                  </div>
                )}

                <div className="mt-auto pt-6">
                  <a href={`${SHADOW_URL}/?asset=${pair}`} target="_blank" rel="noreferrer" className="group flex items-center justify-between border-t border-white/[0.06] pt-4 text-[10px] uppercase tracking-[0.14em] text-white/30 hover:text-[#dc6b27]">
                    <span className="flex items-center gap-2"><Brain size={13}/> ShadowSignals intelligence</span><ArrowUpRight size={13} className="transition-transform group-hover:translate-x-0.5 group-hover:-translate-y-0.5" />
                  </a>
                </div>
              </article>
            );
          })}
        </div>
      </section>

      <section className="mx-auto max-w-7xl px-6 pb-12">
        <div className="border border-white/[0.08] bg-[#0b0b0b] rounded-2xl overflow-hidden">
          <div className="flex items-center justify-between border-b border-white/[0.08] px-6 py-5"><div><div className="text-[10px] uppercase tracking-[0.18em] text-white/25">Signal history</div><h2 className="mt-1 text-lg font-semibold">What CXSwitch actually fired</h2></div><span className="text-[9px] uppercase tracking-widest text-white/20">{recent.length} recent</span></div>
          {recent.length ? <div className="overflow-x-auto"><table className="w-full text-xs"><thead className="text-[9px] uppercase tracking-[0.14em] text-white/20"><tr>{["Pair","Dir","Type","Entry","Status","Reason","Age"].map(x => <th key={x} className="px-6 py-3 text-left font-medium">{x}</th>)}</tr></thead><tbody className="divide-y divide-white/[0.06]">{recent.map(h => <tr key={h.id} className="hover:bg-white/[0.02]"><td className="px-6 py-4 font-semibold">{h.pair}</td><td className={`px-6 py-4 font-semibold ${h.direction === "LONG" ? "text-[#dc6b27]" : "text-red-400"}`}>{h.direction}</td><td className="px-6 py-4 text-white/45">{h.type}</td><td className="px-6 py-4 font-mono">{money(h.entry)}</td><td className="px-6 py-4"><span className="border border-white/[0.08] rounded-md px-2 py-1 text-[9px] text-white/40">{h.status}</span></td><td className="px-6 py-4 text-white/25">{h.exitPrice ? money(h.exitPrice) : h.exitReason || "—"}</td><td className="px-6 py-4 text-white/20">{timeAgo(h.exitTimestamp || h.timestamp)}</td></tr>)}</tbody></table></div> : <div className="p-10 text-center text-sm text-white/25">No signals recorded yet.</div>}
        </div>
      </section>

      <footer className="border-t border-white/[0.08] px-6 py-8"><div className="mx-auto max-w-7xl flex flex-col gap-3 sm:flex-row sm:items-center sm:justify-between"><div><div className="text-[10px] font-bold uppercase tracking-[0.18em] text-white/25">CXSWITCH</div><div className="mt-1 text-[10px] text-white/15">Personal trading system · manual execution · no exchange credentials</div></div><div className="text-[10px] text-white/15">ShadowSignals · AI market intelligence · {new Date().getFullYear()}</div></div></footer>
    </main>
  );
}

function Badge({ icon, text }: { icon: React.ReactNode; text: string }) { return <span className="inline-flex items-center gap-2 rounded-lg border border-white/[0.08] bg-white/[0.02] px-3 py-2 text-[9px] uppercase tracking-wider text-white/35">{icon}{text}</span>; }
function Stat({ icon, label, value, detail }: { icon: React.ReactNode; label: string; value: string; detail: string }) { return <div className="bg-[#0b0b0b] p-6"><div className="text-[#dc6b27]">{icon}</div><div className="mt-5 text-[9px] uppercase tracking-[0.18em] text-white/20">{label}</div><div className="mt-1 text-sm font-semibold">{value}</div><div className="mt-1 text-[10px] text-white/25">{detail}</div></div>; }
function Metric({ label, value, accent = false }: { label: string; value: string; accent?: boolean }) { return <div><div className="text-[9px] uppercase tracking-[0.16em] text-white/20">{label}</div><div className={`mt-1 font-mono text-sm ${accent ? "text-[#dc6b27]" : "text-white/75"}`}>{value}</div></div>; }
function Mini({ label, value }: { label: string; value?: string }) { return <div className="border border-white/[0.06] bg-black/20 p-3 rounded-lg"><div className="text-[8px] uppercase tracking-wider text-white/20">{label}</div><div className="mt-1 text-[11px] font-mono text-white/55">{value || "—"}</div></div>; }
function Step({ label, value, good }: { label: string; value: string; good: boolean }) { return <div className="flex items-center justify-between border-b border-white/[0.05] pb-3"><span className="flex items-center gap-2 text-[10px] text-white/30"><span className={`h-1.5 w-1.5 rounded-full ${good ? "bg-[#dc6b27]" : "bg-white/10"}`} />{label}</span><span className={`text-[10px] font-mono ${good ? "text-white/60" : "text-white/20"}`}>{value}</span></div>; }
