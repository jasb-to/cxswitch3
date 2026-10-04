// lib/jarvis.ts — deterministic bounded veto layer for the simple directional strategy
import { Redis } from "./supabase-kv";
import type { Signal } from "./strategy";

const redis = new Redis();
const JARVIS_KEY = "cxswitch:jarvis_state";

export type JarvisVerdict = "GOOD" | "WARN" | "VETO";

export interface JarvisReview {
  verdict: JarvisVerdict;
  reason: string;
}

export interface JarvisPairState {
  pair: string;
  direction: "LONG" | "SHORT" | "NEUTRAL";
  verdict: JarvisVerdict;
  reason: string;
  currentAnalysis: string;
  updatedAt: number;
  position?: { direction: "LONG" | "SHORT"; entry: number; stop: number; tp1?: number; tp2?: number };
}

export interface JarvisSnapshot {
  portfolioState: "GOOD" | "WARN" | "VETO";
  whatChanged: string;
  pairs: Record<string, JarvisPairState>;
  updatedAt: number;
}

function directionFromDaily(value:any): "BULL" | "BEAR" | "NEUTRAL" {
  if(value === "BULL" || value === "LONG" || value === "BULLISH") return "BULL";
  if(value === "BEAR" || value === "SHORT" || value === "BEARISH") return "BEAR";
  return "NEUTRAL";
}

function directionFrom4H(snapshot:any): "BULL" | "BEAR" | "NEUTRAL" {
  if(snapshot?.fourHDirection === "BULL" || snapshot?.fourHDirection === "LONG" || snapshot?.fourHDirection === "BULLISH") return "BULL";
  if(snapshot?.fourHDirection === "BEAR" || snapshot?.fourHDirection === "SHORT" || snapshot?.fourHDirection === "BEARISH") return "BEAR";
  const e8=Number(snapshot?.ema8_4h), e21=Number(snapshot?.ema21_4h);
  if(Number.isFinite(e8)&&Number.isFinite(e21)) return e8>e21?"BULL":e8<e21?"BEAR":"NEUTRAL";
  return "NEUTRAL";
}

export function reviewFiredSignal(signal: Signal, snapshot:any): JarvisReview {
  const oneD = directionFromDaily(snapshot?.dailyDirection);
  if(oneD === "BULL" && signal.direction === "SHORT") {
    return { verdict:"VETO", reason:"SHORT into BULL 1D" };
  }
  if(oneD === "BEAR" && signal.direction === "LONG") {
    return { verdict:"VETO", reason:"LONG into BEAR 1D" };
  }

  const fourH = directionFrom4H(snapshot);
  if(signal.direction === "LONG" && fourH === "BEAR") {
    return { verdict:"WARN", reason:"LONG with 4H BEAR" };
  }
  if(signal.direction === "SHORT" && fourH === "BULL") {
    return { verdict:"WARN", reason:"SHORT with 4H BULL" };
  }

  const k = Number(snapshot?.stochK);
  if(signal.direction === "LONG" && Number.isFinite(k) && k >= 90) {
    return { verdict:"WARN", reason:`LONG with Stoch K ${k} already extended` };
  }
  if(signal.direction === "SHORT" && Number.isFinite(k) && k <= 10) {
    return { verdict:"WARN", reason:`SHORT with Stoch K ${k} already extended` };
  }

  return { verdict:"GOOD", reason:"Aligned with 1D and 4H context" };
}

function pairState(m:any, active:any): JarvisPairState {
  const direction=(active?.direction || m?.dailyLive?.direction || m?.direction || "NEUTRAL") as "LONG"|"SHORT"|"NEUTRAL";
  const review = active
    ? reviewFiredSignal({
        id:String(active.id||"active"),
        pair:String(active.pair||m?.pair||"?"),
        direction:active.direction,
        type:"ENTRY",
        entry:Number(active.entry||0),
        stop:Number(active.stop||0),
        tp1:Number(active.tp1||0),
        tp2:Number(active.tp2||active.target||0),
        rr:Number(active.rr||0),
        adx:Number(active.adx||0),
        rsi:Number(active.rsi||0),
        stochK:Number(active.stochK||m?.stochK||0),
        stochD:Number(active.stochD||m?.stochD||0),
        expectedMove:5,
        reason:String(active.reason||""),
        timestamp:Number(active.timestamp||Date.now()),
        version:Number(active.version||0),
      }, m)
    : {verdict:"GOOD",reason:"No active signal; monitoring deterministic context"};

  const price=Number(m?.price), entry=Number(active?.entry);
  const move=Number.isFinite(price)&&Number.isFinite(entry)&&entry!==0
    ? ((price-entry)/entry*100)*(active?.direction==="SHORT"?-1:1)
    : null;
  const currentAnalysis=active && move!==null
    ? `${move>=0?"Up":"Down"} ${Math.abs(move).toFixed(1)}% from entry · ${review.reason}`
    : review.reason;

  return {
    pair:String(m?.pair||active?.pair||"?"),
    direction,
    verdict:review.verdict,
    reason:review.reason,
    currentAnalysis,
    updatedAt:Date.now(),
    position:active?{direction:active.direction,entry:Number(active.entry),stop:Number(active.stop),tp1:active.tp1,tp2:active.tp2}:undefined,
  };
}

export async function getJarvisSnapshot(): Promise<JarvisSnapshot|null> {
  return await redis.get<JarvisSnapshot>(JARVIS_KEY);
}

export async function runJarvis(marketData:any[], active:any[]): Promise<JarvisSnapshot> {
  const activeByPair=new Map(active.map(x=>[x.pair,x]));
  const pairs:Record<string,JarvisPairState>={};
  for(const m of marketData) pairs[m.pair]=pairState(m,activeByPair.get(m.pair));
  const all=Object.values(pairs);
  const hasVeto=all.some(x=>x.verdict==="VETO");
  const hasWarn=all.some(x=>x.verdict==="WARN");
  const snapshot:JarvisSnapshot={
    portfolioState:hasVeto?"VETO":hasWarn?"WARN":"GOOD",
    whatChanged:hasVeto?"One or more signals are vetoed by 1D direction.":hasWarn?"One or more signals have a deterministic warning.":"All monitored signals are aligned with the bounded Jarvis rules.",
    pairs,
    updatedAt:Date.now(),
  };
  await redis.set(JARVIS_KEY,snapshot);
  return snapshot;
}
