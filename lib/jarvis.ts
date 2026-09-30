// lib/jarvis.ts — CXSwitch JARVIS interpretation layer
import { Redis } from "@upstash/redis";
import { sendJarvisUpdate } from "./telegram";

const redis = new Redis({ url: process.env.KV_REST_API_URL!, token: process.env.KV_REST_API_TOKEN! });
const JARVIS_KEY = "cxswitch:jarvis_state";
const MODEL = process.env.HUGGINGFACE_MODEL || "Qwen/Qwen3-4B-Instruct-2507";

export type JarvisState = "ACCUMULATING" | "TRANSITIONING" | "DETERIORATING" | "BROKEN";
export type JarvisVerdict = "GOOD" | "CAUTION" | "BAD";

export interface JarvisPairState {
  pair: string;
  state: JarvisState;
  previousState?: JarvisState;
  direction: "LONG" | "SHORT" | "NEUTRAL";
  thesis: string;
  whatChanged: string;
  watch: string;
  management?: string;
  position?: { direction: string; entry: number; stop: number; tp1?: number; tp2?: number };
  updatedAt: number;
  momentum?: "SUPPORTIVE"|"WEAKENING"|"BREAKDOWN";
  momentumSignature?: string;
}

export interface JarvisSnapshot {
  portfolioState: "RISK-ON" | "RISK-ON WEAKENING" | "RISK TRANSITION" | "RISK-OFF";
  whatChanged: string;
  pairs: Record<string, JarvisPairState>;
  updatedAt: number;
}

const stateRank:Record<JarvisState,number>={ACCUMULATING:0,TRANSITIONING:1,DETERIORATING:2,BROKEN:3};

function directionOf(m:any):"LONG"|"SHORT"|"NEUTRAL" {
  const d=m?.entry1Direction || m?.fourH513?.direction || m?.dailyLive?.direction;
  if(d==="LONG"||d==="BULLISH"||String(d).startsWith("BULL")) return "LONG";
  if(d==="SHORT"||d==="BEARISH"||String(d).startsWith("BEAR")) return "SHORT";
  return "NEUTRAL";
}

function pairState(m:any, active:any):JarvisPairState {
  const dir=active?.direction || directionOf(m);
  const e=m?.fourH513||{};
  const label=String(e.label||"");
  let momentum:"SUPPORTIVE"|"WEAKENING"|"BREAKDOWN"="SUPPORTIVE";
  if(active){
    const longBreak=dir==="LONG" && (/BEARISH CROSS|BEARISH LOW/.test(label) || (Number(e.ema5)<Number(e.ema13) && Number(e.ema5Slope)<0 && Number(e.ema13Slope)<0 && e.spreadContracting));
    const shortBreak=dir==="SHORT" && (/BULLISH CROSS|BULLISH LOW/.test(label) || (Number(e.ema5)>Number(e.ema13) && Number(e.ema5Slope)>0 && Number(e.ema13Slope)>0 && e.spreadContracting));
    const longWeak=dir==="LONG" && (/BEARISH TREND TURNING/.test(label) || Number(e.ema5)<Number(e.ema13));
    const shortWeak=dir==="SHORT" && (/BULLISH TREND TURNING/.test(label) || Number(e.ema5)>Number(e.ema13));
    if(longBreak||shortBreak) momentum="BREAKDOWN";
    else if(longWeak||shortWeak) momentum="WEAKENING";
  }
  const momentumSignature=active ? `${dir}:${momentum}:${label}:${e.spreadContracting?"CONTRACTING":"EXPANDING"}` : "NO_POSITION";

  const ss=m?.structureShift;
  const fourH=String(m?.fourH513?.label||"");
  const fourHDir=String(m?.fourH513?.direction||"");
  const daily=String(m?.dailyLive?.state||m?.daily513?.label||"");
  const entryDecision=String(m?.entry1Decision||"NONE");
  const structure=String(ss?.structure||"NEUTRAL");
  const shift=String(ss?.state||"");
  const against=active && ((active.direction==="LONG"&&fourHDir==="BEARISH")||(active.direction==="SHORT"&&fourHDir==="BULLISH"));
  const brokenStructure=ss?.state==="SHIFT_CONFIRMED" && active && ((active.direction==="LONG"&&structure==="SHORT")||(active.direction==="SHORT"&&structure==="LONG"));
  let state:JarvisState="ACCUMULATING";
  if(brokenStructure || (active && momentum==="BREAKDOWN")) state="BROKEN";
  else if(against && (shift==="WEAKENING"||shift==="WATCHING")) state="DETERIORATING";
  else if(shift==="WEAKENING" || (active && against) || /BEARISH TREND TURNING|BEARISH LOW|BULLISH TREND TURNING|BULLISH LOW/.test(fourH)) state="TRANSITIONING";
  else if(entryDecision!=="NONE" || /BULLISH CROSS|BEARISH CROSS/.test(fourH)) state="ACCUMULATING";

  const reasons:string[]=[];
  if(active) reasons.push(`active ${active.direction} position`);
  if(daily) reasons.push(`1D ${daily}`);
  if(fourH) reasons.push(`4H ${fourH}`);
  if(shift) reasons.push(`structure ${shift.toLowerCase()}`);
  if(m?.entry1Exhaustion && m.entry1Exhaustion!=="NONE") reasons.push("exhaustion present");
  const thesis=active
    ? state==="BROKEN" ? "4H momentum/structure has broken against the position; review it now." : state==="DETERIORATING" ? "4H momentum is weakening against the active position; the thesis is under pressure." : state==="TRANSITIONING" ? "The position thesis remains active, but closed 4H price action is transitioning; JARVIS is watching the next structural move." : "The position thesis remains intact and the closed 4H is supportive."
    : state==="BROKEN" ? "4H momentum/structure has broken, but there is no active position on this asset." : state==="DETERIORATING" ? "4H momentum is weakening; there is no active position currently exposed." : state==="TRANSITIONING" ? "Closed 4H price action is transitioning; JARVIS is monitoring the next structural move." : "No active position. Closed 4H price action is currently supportive.";
  const watch=active
    ? state==="BROKEN" ? "4H breakdown detected. Review the position now." : state==="DETERIORATING" ? "Watch the next closed 4H candle for continuation against the position and failure to reclaim structure." : state==="TRANSITIONING" ? "Watch the next closed 4H candle for confirmation or recovery." : "Continue monitoring every closed 4H candle for loss of momentum or structural failure."
    : state==="BROKEN" ? "No position to manage; monitor for a reclaim before any new setup is considered." : state==="DETERIORATING" ? "Watch the next closed 4H candle for continuation or recovery." : state==="TRANSITIONING" ? "Watch the next closed 4H candle for confirmation or recovery." : "Continue monitoring every closed 4H candle for loss of momentum or structural failure.";
  const changed=`${state.toLowerCase()} · ${reasons.join(" · ")||"market context only"}`;
  return {pair:m?.pair||active?.pair||"?",state,direction:dir,thesis,whatChanged:changed,watch,management:active?.holdAdvice?.reason,position:active?{direction:active.direction,entry:active.entry,stop:active.stop,tp1:active.tp1,tp2:active.tp2}:undefined,updatedAt:Date.now(),momentum,momentumSignature};
}

function portfolioState(pairs:JarvisPairState[]):JarvisSnapshot["portfolioState"]{
  const active=pairs.filter(p=>p.position);
  const broken=active.filter(p=>p.state==="BROKEN").length;
  const deteriorating=active.filter(p=>p.state==="DETERIORATING").length;
  const transitioning=pairs.filter(p=>p.state==="TRANSITIONING").length;
  if(active.length && broken>=Math.max(1,Math.ceil(active.length/2))) return "RISK-OFF";
  if(active.length && (deteriorating>0 || broken>0)) return "RISK TRANSITION";
  if(transitioning>=Math.max(2,Math.ceil(pairs.length/2))) return "RISK-ON WEAKENING";
  return "RISK-ON";
}

async function interpretWithModel(snapshot:JarvisSnapshot):Promise<string|undefined>{
  const key=process.env.HUGGINGFACE_API_KEY;
  if(!key) return undefined;
  const changes=Object.values(snapshot.pairs).filter(p=>p.previousState&&p.previousState!==p.state).map(p=>({pair:p.pair,from:p.previousState,to:p.state,thesis:p.thesis,watch:p.watch}));
  if(!changes.length) return undefined;
  const prompt=`You are JARVIS for a crypto signal dashboard. Interpret facts only; never invent market data and never give certainty. Existing deterministic engine remains authoritative and JARVIS is NOT a trade gate. Explain what changed, whether active trade theses are intact/weakening/broken, and what should be watched. Keep it under 900 characters. State is decision support for a human.\n\nPORTFOLIO: ${snapshot.portfolioState}\nCHANGES:\n${JSON.stringify(changes)}`;
  try{
    const res=await fetch("https://router.huggingface.co/v1/chat/completions",{method:"POST",headers:{"Authorization":`Bearer ${key}`,"Content-Type":"application/json"},body:JSON.stringify({model:MODEL,messages:[{role:"system",content:"You are JARVIS: concise, factual, calm, risk-aware."},{role:"user",content:prompt}],temperature:0.2,max_tokens:300})});
    if(!res.ok){console.warn(`[JARVIS] Hugging Face ${res.status}`);return undefined;}
    const data=await res.json();
    return data?.choices?.[0]?.message?.content?.trim() || undefined;
  }catch(error){console.warn("[JARVIS] model unavailable",error);return undefined;}
}


function deterministicTradeVerdict(signal:any,market:any):{ verdict:JarvisVerdict; summary:string; why:string; watch:string }{
  const direction=signal.direction==="SHORT"?"SHORT":"LONG";
  const e=market?.fourH513||{}; const label=String(e.label||"NEUTRAL"); const fourHDir=String(e.direction||"");
  const structure=market?.structureShift||{};
  const structureAgainst=structure?.state==="SHIFT_CONFIRMED" && ((direction==="LONG"&&String(structure.structure)==="SHORT")||(direction==="SHORT"&&String(structure.structure)==="LONG"));
  const exhaustion=market?.entry1Exhaustion && market.entry1Exhaustion!=="NONE";
  const hardAgainst=direction==="LONG" ? structureAgainst || (/BEARISH CROSS/.test(label) && fourHDir==="BEARISH") : structureAgainst || (/BULLISH CROSS/.test(label) && fourHDir==="BULLISH");
  const transitionAgainst=direction==="LONG" ? /BEARISH TREND TURNING|BEARISH LOW/.test(label) || fourHDir==="BEARISH" : /BULLISH TREND TURNING|BULLISH LOW/.test(label) || fourHDir==="BULLISH";
  const supportive=direction==="LONG" ? /BULLISH CROSS|BULLISH LOW|BULLISH TREND TURNING/.test(label) || fourHDir==="BULLISH" : /BEARISH CROSS|BEARISH LOW|BEARISH TREND TURNING/.test(label) || fourHDir==="BEARISH";
  const verdict:JarvisVerdict=hardAgainst ? "BAD" : exhaustion || transitionAgainst ? "CAUTION" : supportive ? "GOOD" : "GOOD";
  const summary=verdict==="GOOD" ? `GOOD — current evidence broadly supports the fired ${signal.type} ${direction}.` : verdict==="CAUTION" ? `CAUTION — the ${signal.type} ${direction} is early/mixed; opposing 4H pressure is present.` : `BAD — current 4H/structure evidence materially contradicts the fired ${signal.type} ${direction}.`;
  const why=[`4H ${label}`,fourHDir?`direction ${fourHDir}`:null,structure?.state?`structure ${structure.state}`:null,exhaustion?`exhaustion ${market.entry1Exhaustion}`:null,market?.dailyLive?.state?`1D ${market.dailyLive.state}`:null].filter(Boolean).join(" · ");
  const watch=verdict==="BAD" ? "Wait for recovery/reclaim; JARVIS will flag a material improvement." : verdict==="CAUTION" ? "Watch the next closed 4H candle for confirmation or deterioration." : "Watch the next closed 4H candle for loss of momentum or structural failure.";
  return {verdict,summary,why,watch};
}

export async function reviewFiredSignal(signal:any,market:any){
  if(!signal || !["ENTRY_1","ENTRY_2"].includes(signal.type)) return undefined;
  const review=deterministicTradeVerdict(signal,market);
  console.log(`[JARVIS] Fired-trade verdict: ${signal.pair} ${signal.type} ${review.verdict}`);
  return review;
}
export async function getJarvisSnapshot():Promise<JarvisSnapshot|null>{
  return await redis.get<JarvisSnapshot>(JARVIS_KEY);
}

export async function runJarvis(marketData:any[],active:any[]):Promise<JarvisSnapshot>{
  const previous=await getJarvisSnapshot();
  const activeByPair=new Map(active.map(t=>[t.pair,t]));
  const pairs:Record<string,JarvisPairState>={};
  for(const m of marketData){
    const p=pairState(m,activeByPair.get(m.pair));
    const old=previous?.pairs?.[m.pair];
    if(old){p.previousState=old.state;}
    pairs[m.pair]=p;
  }
  const all=Object.values(pairs);
  const portfolio=portfolioState(all);
  const changes=all.filter(p=>p.previousState&&p.previousState!==p.state);
  const momentumChanges=all.filter(p=>p.position && previous?.pairs?.[p.pair]?.momentum && previous.pairs[p.pair].momentum!==p.momentum);
  const whatChanged=changes.length
    ? changes.map(p=>`${p.pair}: ${p.previousState} → ${p.state}`).join(" · ")
    : "No material JARVIS state change.";
  const snapshot:JarvisSnapshot={portfolioState:portfolio,whatChanged,pairs,updatedAt:Date.now()};
  const modelText=await interpretWithModel(snapshot);
  if(modelText) snapshot.whatChanged=modelText;

  await redis.set(JARVIS_KEY,snapshot);

  if(changes.length || momentumChanges.length){
    const material=[...new Map([...changes.filter(p=>stateRank[p.state]!==stateRank[p.previousState!] || p.state==="TRANSITIONING" || p.state==="BROKEN"),...momentumChanges].map(p=>[p.pair,p])).values()];
    if(material.length){
      const lines=material.map(p=>`• ${p.pair}: ${p.previousState||"—"} → ${p.state} · 4H ${p.momentum||"—"}\n  ${p.thesis}\n  Watch: ${p.watch}`).join("\n");
      try{
        await sendJarvisUpdate({portfolioState:portfolio,location:material.some(p=>p.momentum==="BREAKDOWN"||p.state==="BROKEN")?"4H_BREAKDOWN":"4H_MOMENTUM_CHANGE",summary:modelText||whatChanged,changes:material.map(p=>({pair:p.pair,from:p.previousState,to:p.state,momentum:p.momentum,thesis:p.thesis,watch:p.watch})),timestamp:new Date().toISOString()});
        console.log(`[JARVIS] Telegram update sent: ${whatChanged}`);
      }catch(error){console.warn("[JARVIS] Telegram update failed",error);}
    }
  }
  return snapshot;
}
