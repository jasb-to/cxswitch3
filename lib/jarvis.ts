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
  verdict: JarvisVerdict;
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
  const dir=(active?.direction || directionOf(m)) as "LONG"|"SHORT"|"NEUTRAL";
  const e=m?.fourH513||{};
  const label=String(e.label||"");
  const fourHDir=String(e.direction||"");
  const ss=m?.structureShift||{};
  const structure=String(ss.structure||"NEUTRAL");
  const entryType=String(active?.type||"");
  const entry1=entryType==="ENTRY_1" || String(m?.entry1Decision||"NONE")!=="NONE";
  const earlySetup=entry1 || String(active?.context?.marketPhase||"").includes("PROBABILITY EARLY SETUP");
  const priceActionReversal=String(active?.context?.trigger||m?.trigger||"").includes("PRICE_ACTION_REVERSAL");
  const opposite4H=(dir==="LONG"&&fourHDir==="BEARISH")||(dir==="SHORT"&&fourHDir==="BULLISH");
  const confirmedOppositeStructure=ss?.state==="SHIFT_CONFIRMED" && ((dir==="LONG"&&structure==="SHORT")||(dir==="SHORT"&&structure==="LONG"));
  const managementExit=active?.positionManagementState==="EXIT";
  const continuationAgainst=opposite4H && ((dir==="LONG"&&/BEARISH LOW|BEARISH CROSS/.test(label))||(dir==="SHORT"&&/BULLISH LOW|BULLISH CROSS/.test(label))) && !!e.spreadContracting;
  let momentum:"SUPPORTIVE"|"WEAKENING"|"BREAKDOWN"="SUPPORTIVE";
  if(confirmedOppositeStructure||managementExit) momentum="BREAKDOWN";
  else if(continuationAgainst || (opposite4H && (!earlySetup || !priceActionReversal))) momentum="WEAKENING";
  const verdict:JarvisVerdict=confirmedOppositeStructure||managementExit?"BAD":momentum==="WEAKENING"?"CAUTION":opposite4H&&earlySetup&&priceActionReversal?"CAUTION":"GOOD";
  let state:JarvisState="ACCUMULATING";
  if(verdict==="BAD")state="BROKEN"; else if(verdict==="CAUTION")state="DETERIORATING";
  const reasons:string[]=[];
  if(active)reasons.push(`active ${active.direction} ${active.type||"position"}`);
  if(earlySetup)reasons.push("V28 early-entry thesis");
  if(priceActionReversal)reasons.push("4H price-action reversal");
  if(m?.dailyLive?.state)reasons.push(`1D ${m.dailyLive.state}`);
  if(label)reasons.push(`4H ${label}`);
  if(confirmedOppositeStructure)reasons.push("opposite structure confirmed");
  const thesis=active ? verdict==="BAD" ? "V28 thesis has materially failed: the 4H/structure evidence now confirms the move against the position." : verdict==="CAUTION" ? (earlySetup&&priceActionReversal ? "The V28 early-entry thesis is still valid, but the 4H has not fully confirmed the reversal yet." : "The V28 thesis is under pressure, but there is not yet enough evidence to call it broken.") : "The V28 thesis is behaving as intended and the 4H remains supportive." : verdict==="CAUTION" ? (earlySetup&&priceActionReversal ? "V28 is identifying an early reversal; opposing 4H direction is expected until confirmation." : "Market evidence is mixed; JARVIS is watching for the next structural move.") : verdict==="BAD" ? "The current 4H/structure evidence is materially opposed; there is no active position." : "Closed 4H evidence is currently compatible with the active V28 direction.";
  const watch=verdict==="BAD" ? "Confirmed failure. Review the position; recovery/reclaim is needed before the thesis can improve." : verdict==="CAUTION" ? (earlySetup&&priceActionReversal ? "Watch the next closed 4H candle for confirmation of the reversal — or renewed downside continuation." : "Watch the next closed 4H candle for confirmation or deterioration.") : "Keep watching each closed 4H candle for loss of momentum or structural failure.";
  const changed=`${verdict} · ${reasons.join(" · ")||"market context only"}`;
  const momentumSignature=active?`${dir}:${momentum}:${label}:${e.spreadContracting?"CONTRACTING":"EXPANDING"}`:"NO_POSITION";
  return {pair:m?.pair||active?.pair||"?",state,direction:dir,verdict,thesis,whatChanged:changed,watch,management:active?.holdAdvice?.reason||active?.positionManagementReason,position:active?{direction:active.direction,entry:active.entry,stop:active.stop,tp1:active.tp1,tp2:active.tp2}:undefined,updatedAt:Date.now(),momentum,momentumSignature};
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
  const prompt="You are JARVIS for CX Switch V28. The deterministic V28 engine is authoritative and JARVIS is never a trade gate. Understand the strategy philosophy: ENTRY_1 is a probability-based early setup, deliberately before full 4H confirmation; 1D is context/risk modifier, not a veto; 4H price-action reversal and structural response matter; an opposing 4H label during an early reversal can be EXPECTED and is not thesis failure. Only call a thesis broken when there is materially confirmed opposite structure, clear continuation against the original setup, or the existing management engine says EXIT. ENTRY_2 is the confirmed breakout/retest setup and should be judged more strictly. Explain only what changed and what matters next. Keep it concise and factual.";\n\nPORTFOLIO: ${snapshot.portfolioState}\nCHANGES:\n${JSON.stringify(changes)}`;
  try{
    const res=await fetch("https://router.huggingface.co/v1/chat/completions",{method:"POST",headers:{"Authorization":`Bearer ${key}`,"Content-Type":"application/json"},body:JSON.stringify({model:MODEL,messages:[{role:"system",content:"You are JARVIS: concise, factual, calm, risk-aware."},{role:"user",content:prompt}],temperature:0.2,max_tokens:300})});
    if(!res.ok){console.warn(`[JARVIS] Hugging Face ${res.status}`);return undefined;}
    const data=await res.json();
    return data?.choices?.[0]?.message?.content?.trim() || undefined;
  }catch(error){console.warn("[JARVIS] model unavailable",error);return undefined;}
}


function deterministicTradeVerdict(signal:any,market:any):{ verdict:JarvisVerdict; summary:string; why:string; watch:string }{
  const direction=signal.direction==="SHORT"?"SHORT":"LONG";
  const context=signal.context||{}; const e=market?.fourH513||context.fourH513||{};
  const label=String(e.label||"NEUTRAL"); const fourHDir=String(e.direction||"");
  const structure=market?.structureShift||{};
  const structureAgainst=structure?.state==="SHIFT_CONFIRMED" && ((direction==="LONG"&&String(structure.structure)==="SHORT")||(direction==="SHORT"&&String(structure.structure)==="LONG"));
  const entry1=signal.type==="ENTRY_1";
  const earlySetup=String(context.marketPhase||signal.location||"").includes("EARLY")||entry1;
  const priceActionReversal=String(context.trigger||signal.trigger||"").includes("PRICE_ACTION_REVERSAL");
  const opposite4H=(direction==="LONG"&&fourHDir==="BEARISH")||(direction==="SHORT"&&fourHDir==="BULLISH");
  const exhaustion=context?.exhaustion; const exhaustionPresent=!!exhaustion&&((direction==="LONG"&&exhaustion.longBlocked)||(direction==="SHORT"&&exhaustion.shortBlocked));
  const hardAgainst=structureAgainst||market?.positionManagementState==="EXIT";
  const expectedEarlyConflict=entry1&&earlySetup&&priceActionReversal&&opposite4H;
  const caution=exhaustionPresent||expectedEarlyConflict||(opposite4H&&!structureAgainst);
  const supportive=direction==="LONG" ? /BULLISH CROSS|BULLISH LOW|BULLISH TREND TURNING/.test(label)||fourHDir==="BULLISH" : /BEARISH CROSS|BEARISH LOW|BEARISH TREND TURNING/.test(label)||fourHDir==="BEARISH";
  const verdict:JarvisVerdict=hardAgainst?"BAD":caution?"CAUTION":supportive?"GOOD":"GOOD";
  const summary=verdict==="GOOD"?`GOOD — V28 ${signal.type} ${direction} thesis is supported by current evidence.`:verdict==="CAUTION"?(expectedEarlyConflict?`CAUTION — this is an intentional V28 early entry; 4H confirmation is still developing.`:`CAUTION — the ${signal.type} ${direction} setup is early/mixed, but not broken.`):`BAD — current 4H/structure evidence materially contradicts the V28 ${signal.type} ${direction} thesis.`;
  const why=[signal.type==="ENTRY_1"?"V28 early-entry philosophy":signal.type,signal.location?String(signal.location):null,signal.trigger?String(signal.trigger):null,`4H ${label}`,fourHDir?`direction ${fourHDir}`:null,structure?.state?`structure ${structure.state}`:null,exhaustionPresent?"exhaustion present":null].filter(Boolean).join(" · ");
  const watch=verdict==="BAD"?"Review now; JARVIS needs a recovery/reclaim before the thesis improves.":verdict==="CAUTION"?"Watch the next closed 4H candle for confirmation or renewed continuation against the setup.":"Watch the next closed 4H candle for loss of momentum or structural failure.";
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
