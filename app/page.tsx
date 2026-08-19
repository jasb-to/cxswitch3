"use client";

import { useEffect, useMemo, useState } from "react";

interface Signal {
  id: string; pair: string; direction: "LONG" | "SHORT"; type: string;
  entry: number; stop: number; target: number; rr: number; timestamp: number; expectedMove: number;
  adx?: number; rsi?: number; stochK?: number; stochD?: number; reason?: string;
  trend?: string; location?: string; trigger?: string;
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
}
interface SystemState { lastCronRun: number; lastCronAgeMs: number | null; exchangeSyncConfigured: boolean; activePositions: number; }

const PAIRS = ["BTC", "ETH", "SOL", "HYPE"];
const KRAKEN_PAIRS: Record<string, string> = { BTC: "XBTUSD", ETH: "ETHUSD", SOL: "SOLUSD", HYPE: "HYPEUSD" };
const money = (n?: number) => typeof n === "number" && Number.isFinite(n) ? new Intl.NumberFormat("en-US", { style: "currency", currency: "USD", maximumFractionDigits: n >= 1000 ? 0 : n >= 1 ? 2 : 4 }).format(n) : "—";
const pct = (n: number) => `${n >= 0 ? "+" : ""}${n.toFixed(2)}%`;
function timeAgo(ts?: number) { if (!ts) return "—"; const m = Math.max(0, Math.floor((Date.now() - ts) / 60000)); if (m < 1) return "just now"; if (m < 60) return `${m}m ago`; const h = Math.floor(m / 60); if (h < 24) return `${h}h ${m % 60}m ago`; return `${Math.floor(h / 24)}d ago`; }
function currentR(s: Signal, p: number) { const risk = Math.abs(s.entry - s.stop); return risk ? (s.direction === "LONG" ? (p - s.entry) / risk : (s.entry - p) / risk) : 0; }
function setupLabel(m?: MarketData) { if (!m) return "WAITING FOR DATA"; if (m.trigger === "READY" && m.location === "NEAR_TL") return "ENTRY ZONE"; if (m.location === "NEAR_TL") return "WATCHING RETEST"; if (m.location === "BEYOND_TL") return "BREAKOUT / RETEST"; return "WATCHING"; }
async function fetchKrakenPrice(pair: string): Promise<number | null> { try { const r = await fetch(`https://api.kraken.com/0/public/Ticker?pair=${KRAKEN_PAIRS[pair]}`, { cache: "no-store" }); const d = await r.json(); if (d.error?.length) return null; return parseFloat(d.result[Object.keys(d.result)[0]].c[0]); } catch { return null; } }

export default function Dashboard() {
  const [signals, setSignals] = useState<Record<string, Signal | null>>({});
  const [history, setHistory] = useState<HistoryEntry[]>([]);
  const [market, setMarket] = useState<Record<string, MarketData>>({});
  const [prices, setPrices] = useState<Record<string, number>>({});
  const [system, setSystem] = useState<SystemState | null>(null);
  const [loading, setLoading] = useState(true); const [lastFetch, setLastFetch] = useState(0);

  async function loadState() {
    try {
      const r = await fetch("/api/signals", { cache: "no-store" }); const d = await r.json();
      const s: Record<string, Signal | null> = {}; const m: Record<string, MarketData> = {};
      for (const p of PAIRS) s[p] = d.activeSignals?.find((x: Signal) => x.pair === p) || null;
      for (const x of d.marketData || []) if (x?.pair) m[x.pair] = x;
      setSignals(s); setHistory(d.signalHistory || []); setMarket(m); setSystem(d.system || null); setLastFetch(Date.now());
    } catch (e) { console.error("CXSwitch state load failed", e); } finally { setLoading(false); }
  }
  useEffect(() => { loadState(); const i = setInterval(loadState, 30000); return () => clearInterval(i); }, []);
  useEffect(() => { async function loadPrices() { const n: Record<string, number> = {}; await Promise.all(PAIRS.map(async p => { const x = await fetchKrakenPrice(p); if (x) n[p] = x; })); setPrices(n); } loadPrices(); const i = setInterval(loadPrices, 10000); return () => clearInterval(i); }, []);

  const activeCount = system?.activePositions ?? Object.values(signals).filter(Boolean).length;
  const recent = useMemo(() => history.slice().reverse().slice(0, 12), [history]);
  if (loading) return <main className="min-h-screen bg-[#080a0f] text-white flex items-center justify-center"><span className="text-sm text-gray-500">Loading CXSwitch…</span></main>;

  return <main className="min-h-screen bg-[#080a0f] text-white p-4 md:p-6"><div className="max-w-[1500px] mx-auto">
    <header className="flex flex-col md:flex-row md:justify-between gap-4 mb-6"><div className="flex items-center gap-3"><div className="w-9 h-9 rounded-xl bg-white text-black flex items-center justify-center font-black">CX</div><div><h1 className="text-xl font-bold">CXSwitch</h1><p className="text-[11px] text-gray-500">v56 · v28 entry architecture · personal trading console</p></div></div><div className="flex flex-wrap gap-2 text-[10px]"><Pill text="Live prices · 10s"/><Pill text={`${activeCount} position${activeCount === 1 ? "" : "s"} active`} good={activeCount > 0}/><Pill text={`Cron ${system?.lastCronRun ? timeAgo(system.lastCronRun) : "—"}`}/></div></header>
    <section className="grid md:grid-cols-3 gap-3 mb-5"><Summary label="SYSTEM" value={system?.lastCronRun && system.lastCronAgeMs !== null && system.lastCronAgeMs < 1200000 ? "RUNNING" : "CHECK CRON"} detail={system?.lastCronRun ? `Last analysis ${timeAgo(system.lastCronRun)}` : "No cron run recorded"} good={!!system?.lastCronRun && system.lastCronAgeMs !== null && system.lastCronAgeMs < 1200000}/><Summary label="POSITIONS" value={activeCount ? `${activeCount} ACTIVE` : "NONE"} detail={activeCount ? "Position state is persisted" : "No live position tracked"} good={activeCount > 0}/><Summary label="EXCHANGE SYNC" value={system?.exchangeSyncConfigured ? "CONNECTED" : "LOCAL STATE"} detail={system?.exchangeSyncConfigured ? "Kraken can reconcile open positions" : "No private Kraken credentials — local state is preserved"} good={!system?.exchangeSyncConfigured}/></section>
    <section className="grid md:grid-cols-2 xl:grid-cols-4 gap-4">{PAIRS.map(pair => {
      const s = signals[pair], m = market[pair], live = prices[pair], price = live ?? m?.price ?? 0, active = !!s && s.meta?.status === "ACTIVE";
      const r = active && s ? currentR(s, price) : 0; const pnl = active && s ? (s.direction === "LONG" ? (price - s.entry) / s.entry * 100 : (s.entry - price) / s.entry * 100) : 0;
      const progress = active && s && s.target !== s.entry ? Math.max(0, Math.min(100, s.direction === "LONG" ? (price - s.entry) / (s.target - s.entry) * 100 : (s.entry - price) / (s.entry - s.target) * 100)) : 0;
      const long = m?.trend?.startsWith("LONG"), short = m?.trend?.startsWith("SHORT");
      return <article key={pair} className={`rounded-2xl border overflow-hidden ${active ? (s!.direction === "LONG" ? "border-green-500/30 bg-[#0b120e]" : "border-red-500/30 bg-[#130b0b]") : "border-gray-800 bg-[#0d1016]"}`}>
        <div className="p-4 border-b border-gray-800/80 flex justify-between"><div><div className="text-xs text-gray-500 tracking-widest">{pair}/USD</div><div className="mt-1 flex items-center gap-2"><span className="text-2xl font-mono font-semibold">{money(price)}</span>{live && <span className="text-[9px] px-1.5 py-0.5 rounded bg-green-500/10 text-green-400">LIVE</span>}</div></div>{active ? <div className={`text-right ${s!.direction === "LONG" ? "text-green-400" : "text-red-400"}`}><div className="text-[10px] font-bold">{s!.direction === "LONG" ? "🟢" : "🔴"} POSITION ACTIVE</div><div className="text-[9px] text-gray-500 mt-1">{timeAgo(s!.timestamp)}</div></div> : <div className={`text-[10px] font-bold ${long ? "text-green-400" : short ? "text-red-400" : "text-gray-500"}`}>{long ? "LONG BIAS" : short ? "SHORT BIAS" : "FLAT"}</div>}</div>
        <div className="p-4 space-y-3">{active && s ? <>
          <div className="rounded-xl bg-green-500/5 border border-green-500/15 p-3"><div className="flex justify-between mb-2"><span className="text-[10px] uppercase tracking-widest text-gray-500">Trade</span><b className="text-[10px] text-green-400">{s.type}</b></div><div className="grid grid-cols-2 gap-3"><Metric l="Entry" v={money(s.entry)}/><Metric l="Now" v={money(price)} c={pnl >= 0 ? "text-green-300" : "text-red-300"}/><Metric l="P&L" v={pct(pnl)} c={pnl >= 0 ? "text-green-300" : "text-red-300"}/><Metric l="R" v={`${r.toFixed(2)}R`} c="text-yellow-300"/></div></div>
          <div><div className="flex justify-between text-[9px] text-gray-500 mb-1"><span>Current stop</span><span>Target</span></div><div className="h-2 rounded-full bg-gray-800 overflow-hidden"><div className={`h-full rounded-full ${pnl >= 0 ? "bg-green-500" : "bg-red-500"}`} style={{width:`${progress}%`}}/></div><div className="flex justify-between text-[9px] mt-1"><span className="text-red-400">{money(s.stop)}</span><span className="text-gray-500">{progress.toFixed(0)}% to target</span><span className="text-purple-300">{money(s.target)}</span></div></div>
          <div className="grid grid-cols-2 gap-2"><Level l="Current stop" v={money(s.stop)} c="text-red-300"/><Level l="Target" v={money(s.target)} c="text-purple-300"/><Level l="R:R" v={s.rr?.toFixed(2)} c="text-yellow-300"/><Level l="Expected" v={`${s.expectedMove?.toFixed(1)}%`} c="text-blue-300"/></div>
          <div className="rounded-xl border border-gray-800 bg-black/20 p-3"><div className="text-[9px] uppercase tracking-widest text-gray-600 mb-2">Position state</div><div className="text-xs text-gray-300 leading-relaxed"><b className="text-green-400">ENTRY LOCKED.</b> New-entry generation is paused for {pair}. Market context continues updating while the position is active.</div></div>
        </> : <>
          <div className={`rounded-xl p-3 border ${long ? "border-green-500/15 bg-green-500/5" : short ? "border-red-500/15 bg-red-500/5" : "border-gray-800 bg-black/20"}`}><div className="flex justify-between"><span className="text-[10px] uppercase tracking-widest text-gray-500">Market state</span><b className={`text-[10px] ${long ? "text-green-400" : short ? "text-red-400" : "text-gray-500"}`}>{m?.trend || "WAITING"}</b></div><div className="mt-2 text-lg font-semibold">{setupLabel(m)}</div><div className="text-[10px] text-gray-500 mt-1">{m?.location || "No structure data"} · {m?.trigger || "WAITING"}</div></div>
          <div className="rounded-xl border border-gray-800 bg-black/20 p-3"><div className="text-[9px] uppercase tracking-widest text-gray-600 mb-2">Trade steps</div><Step l="Trend" v={m?.trend || "—"} ok={!!m?.trend && m.trend !== "FLAT"}/><Step l="Location" v={m?.location || "—"} ok={m?.location === "NEAR_TL" || m?.location === "BEYOND_TL"}/><Step l="Trigger" v={m?.trigger || "—"} ok={m?.trigger === "READY"}/></div>
        </>}
        {m && <div className="grid grid-cols-2 gap-2 text-[10px] text-gray-500"><span>ADX <b className="text-gray-300">{m.adx?.toFixed(1)}</b></span><span>RSI <b className="text-gray-300">{m.rsi?.toFixed(1)}</b></span><span>Stoch K <b className="text-gray-300">{m.stochK?.toFixed(1)}</b></span><span>D <b className="text-gray-300">{m.stochD?.toFixed(1)}</b></span><span className="col-span-2">4H TL <b className="text-gray-300 font-mono">{m.trendlinePrice ? money(m.trendlinePrice) : "—"}</b> <span className="text-gray-600">({m.distToTrendline?.toFixed(2) ?? "—"}%)</span></span></div>}
        </div>
      </article>;
    })}</section>
    <section className="mt-7 rounded-2xl border border-gray-800 bg-[#0d1016] overflow-hidden"><div className="px-4 py-3 border-b border-gray-800 flex justify-between"><div><h2 className="font-semibold text-sm">Signal history</h2><p className="text-[10px] text-gray-600 mt-0.5">What CXSwitch actually fired — not every market scan.</p></div><span className="text-[9px] text-gray-600">{recent.length} recent</span></div>{recent.length ? <div className="overflow-x-auto"><table className="w-full text-xs"><thead className="text-[9px] uppercase tracking-wider text-gray-600"><tr><th className="px-4 py-2 text-left">Pair</th><th className="px-4 py-2 text-left">Dir</th><th className="px-4 py-2 text-left">Type</th><th className="px-4 py-2 text-left">Entry</th><th className="px-4 py-2 text-left">Status</th><th className="px-4 py-2 text-left">Exit / reason</th><th className="px-4 py-2 text-left">Age</th></tr></thead><tbody className="divide-y divide-gray-800">{recent.map(h => <tr key={h.id} className="hover:bg-white/[0.02]"><td className="px-4 py-2.5 font-mono font-semibold">{h.pair}</td><td className={`px-4 py-2.5 font-semibold ${h.direction === "LONG" ? "text-green-400" : "text-red-400"}`}>{h.direction}</td><td className="px-4 py-2.5 text-gray-400">{h.type}</td><td className="px-4 py-2.5 font-mono">{money(h.entry)}</td><td className="px-4 py-2.5"><Status status={h.status}/></td><td className="px-4 py-2.5 text-gray-500">{h.exitPrice ? money(h.exitPrice) : h.exitReason || "—"}</td><td className="px-4 py-2.5 text-gray-600">{timeAgo(h.exitTimestamp || h.timestamp)}</td></tr>)}</tbody></table></div> : <div className="p-8 text-center text-sm text-gray-600">No signals recorded yet.</div>}</section>
    <footer className="mt-5 flex justify-between text-[9px] text-gray-700"><span>CXSwitch · personal trading system · strategy unchanged in this release</span><span>Dashboard refreshed {lastFetch ? new Date(lastFetch).toLocaleTimeString() : "—"}</span></footer>
  </div></main>;
}

function Pill({text, good=false}:{text:string;good?:boolean}){return <span className={`px-2.5 py-1.5 rounded-full border ${good ? "border-green-500/30 bg-green-500/10 text-green-300" : "border-gray-800 bg-gray-900 text-gray-500"}`}>{text}</span>}
function Summary({label,value,detail,good}:{label:string;value:string;detail:string;good:boolean}){return <div className="rounded-xl border border-gray-800 bg-[#0d1016] p-3"><div className="flex justify-between"><span className="text-[9px] tracking-widest text-gray-600">{label}</span><span className={`w-1.5 h-1.5 rounded-full mt-1 ${good ? "bg-green-400" : "bg-yellow-400"}`}/></div><div className="mt-1 text-sm font-semibold">{value}</div><div className="mt-1 text-[9px] text-gray-600">{detail}</div></div>}
function Metric({l,v,c="text-gray-200"}:{l:string;v:string;c?:string}){return <div><div className="text-[9px] text-gray-600 uppercase tracking-wider">{l}</div><div className={`mt-0.5 text-sm font-mono ${c}`}>{v}</div></div>}
function Level({l,v,c}:{l:string;v:string;c:string}){return <div className="rounded-lg bg-black/20 border border-gray-800 p-2"><div className="text-[8px] text-gray-600 uppercase">{l}</div><div className={`mt-0.5 text-xs font-mono ${c}`}>{v}</div></div>}
function Step({l,v,ok}:{l:string;v:string;ok:boolean}){return <div className="flex justify-between py-1.5"><span className="flex items-center gap-2 text-gray-500"><span className={`w-1.5 h-1.5 rounded-full ${ok ? "bg-green-400" : "bg-gray-700"}`}/>{l}</span><span className={`font-mono text-[10px] ${ok ? "text-green-300" : "text-gray-600"}`}>{v}</span></div>}
function Status({status}:{status:string}){const c=status === "ACTIVE" ? "bg-green-500/10 text-green-300" : status === "TP_HIT" ? "bg-purple-500/10 text-purple-300" : status === "SL_HIT" ? "bg-red-500/10 text-red-300" : "bg-gray-500/10 text-gray-400"; return <span className={`px-1.5 py-0.5 rounded text-[9px] font-semibold ${c}`}>{status}</span>}
