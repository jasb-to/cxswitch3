// lib/jarvis.ts — CXSwitch JARVIS interpretation layer
import { Redis } from "@upstash/redis";
import { sendAlert } from "./telegram";

const redis = new Redis({ url: process.env.KV_REST_API_URL!, token: process.env.KV_REST_API_TOKEN! });
const JARVIS_KEY = "cxswitch:jarvis_state";
const MODEL = process.env.HUGGINGFACE_MODEL || "Qwen/Qwen3-4B-Instruct-2507";

export type JarvisState = "ACCUMULATING" | "TRANSITIONING" | "DETERIORATING" | "BROKEN";

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
  if(brokenStructure) state="BROKEN";
  else if(against && (shift==="WEAKENING"||shift==="WATCHING")) state="DETERIORATING";
  else if(shift==="WEAKENING" || (active && against) || /BEARISH TREND TURNING|BEARISH LOW|BULLISH TREND TURNING|BULLISH LOW/.test(fourH)) state="TRANSITIONING";
  else if(entryDecision!=="NONE" || /BULLISH CROSS|BEARISH CROSS/.test(fourH)) state="ACCUMULATING";

  const reasons:string[]=[];
  if(active) reasons.push(`active ${active.direction} position`);
  if(daily) reasons.push(`1D ${daily}`);
  if(fourH) reasons.push(`4H ${fourH}`);
  if(shift) reasons.push(`structure ${shift.toLowerCase()}`);
  if(m?.entry1Exhaustion && m.entry1Exhaustion!=="NONE") reasons.push("exhaustion present");
  const thesis=state==="BROKEN"
    ?"Original trade thesis is broken; the current structure no longer supports the position."
    :state==="DETERIORATING"
    ?"Trade thesis is weakening. The higher-timeframe context may still support it, but lower-timeframe price action is moving against the position."
    :state==="TRANSITIONING"
    ?"Trade thesis is still active, but price action is transitioning. This is a watch state, not an automatic exit."
    :"Trade thesis remains intact and price action is currently supportive.";
  const watch=state==="BROKEN"
    ?"Watch for confirmation that the broken structure persists; management has the hard exit decision."
    :state==="DETERIORATING"
    ?"Watch for failure to reclaim structure followed by a new lower high/lower low (or the inverse for shorts)."
    :state==="TRANSITIONING"
    ?"Watch the next closed 4H candle for continuation or rejection of the developing move."
    :"Watch for a failed extension and loss of the structure supporting the setup.";
  const changed=`${state.toLowerCase()} · ${reasons.join(" · ")||"market context only"}`;
  return {pair:m?.pair||active?.pair||"?",state,direction:dir,thesis,whatChanged:changed,watch,management:active?.holdAdvice?.reason,position:active?{direction:active.direction,entry:active.entry,stop:active.stop,tp1:active.tp1,tp2:active.tp2}:undefined,updatedAt:Date.now()};
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
  const whatChanged=changes.length
    ? changes.map(p=>`${p.pair}: ${p.previousState} → ${p.state}`).join(" · ")
    : "No material JARVIS state change.";
  const snapshot:JarvisSnapshot={portfolioState:portfolio,whatChanged,pairs,updatedAt:Date.now()};
  const modelText=await interpretWithModel(snapshot);
  if(modelText) snapshot.whatChanged=modelText;

  await redis.set(JARVIS_KEY,snapshot);

  if(changes.length){
    const material=changes.filter(p=>stateRank[p.state]!==stateRank[p.previousState!] || p.state==="TRANSITIONING" || p.state==="BROKEN");
    if(material.length){
      const lines=material.map(p=>`• ${p.pair}: ${p.previousState} → ${p.state}\n  ${p.thesis}\n  Watch: ${p.watch}`).join("\n");
      try{
        await sendAlert({symbol:"JARVIS",state:"JARVIS UPDATE",bias:portfolio==="RISK-OFF"?"SHORT":"LONG",price:0,stopLoss:0,takeProfit:0,rr:0,expectedMove:0,adx:0,rsi:0,stochK:0,stochD:0,reason:modelText||whatChanged,trend:`PORTFOLIO · ${portfolio}`,location:"STATE_CHANGE",trigger:"JARVIS",updatedAt:new Date().toISOString(),signalType:"JARVIS",signalEmoji:portfolio==="RISK-OFF"?"🔴":portfolio.includes("WEAKENING")||portfolio==="RISK TRANSITION"?"🟡":"🟢",context:{jarvis:{portfolioState:portfolio,whatChanged:modelText||whatChanged,changes:material}}});
        console.log(`[JARVIS] Telegram update sent: ${whatChanged}`);
      }catch(error){console.warn("[JARVIS] Telegram update failed",error);}
    }
  }
  return snapshot;
}
