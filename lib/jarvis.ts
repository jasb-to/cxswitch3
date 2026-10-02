// lib/jarvis.ts — CXSwitch JARVIS interpretation layer
import { Redis } from "./supabase-kv";
import { sendJarvisUpdate } from "./telegram";

const redis = new Redis();
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
  currentAnalysis?: string;
  tradeDecision?: "STAY IN TRADE"|"EXIT TRADE";
  entry1Watch?: string;
}

export interface JarvisSnapshot {
  portfolioState: "RISK-ON" | "RISK-ON WEAKENING" | "RISK TRANSITION" | "RISK-OFF";
  whatChanged: string;
  pairs: Record<string, JarvisPairState>;
  updatedAt: number;
}

const stateRank:Record<JarvisState,number>={ACCUMULATING:0,TRANSITIONING:1,DETERIORATING:2,BROKEN:3};

function directionOf(m:any):"LONG"|"SHORT"|"NEUTRAL" {
  const d=String(m?.dailyDirection||"");
  if(d==="BULL"||d==="LONG"||d==="BULLISH") return "LONG";
  if(d==="BEAR"||d==="SHORT"||d==="BEARISH") return "SHORT";
  return "NEUTRAL";
}

function currentAnalysis(m:any, active:any, momentum:"SUPPORTIVE"|"WEAKENING"|"BREAKDOWN", verdict:JarvisVerdict):string {
  const price=Number(m?.price), entry=Number(active?.entry);
  const dir=active?.direction==="SHORT"?"SHORT":active?.direction==="LONG"?"LONG":directionOf(m);
  const tl=Number(m?.trendlinePrice), dist=Number(m?.distToTrendline);
  const k=Number(m?.stochK), d=Number(m?.stochD);
  const parts:string[]=[];
  if(active && Number.isFinite(price)&&Number.isFinite(entry)&&entry!==0){
    const move=((price-entry)/entry*100)*(dir==="SHORT"?-1:1);
    parts.push(`${move>=0?"Up":"Down"} ${Math.abs(move).toFixed(1)}% from entry`);
  }
  if(Number.isFinite(price)&&Number.isFinite(tl)&&tl>0){
    if(Number.isFinite(dist)&&Math.abs(dist)<=1) parts.push(`testing the ${dir==="SHORT"?"support":"resistance"} trendline`);
    else if((dir==="LONG"&&price>tl)||(dir==="SHORT"&&price<tl)) parts.push(`price is beyond the ${dir==="LONG"?"resistance":"support"} trendline`);
    else parts.push(`price is ${Math.abs(dist).toFixed(1)}% from the trendline`);
  }
  if(Number.isFinite(k)&&Number.isFinite(d)) parts.push(`4H Stoch K ${k}/${d} ${k>d?"above":"below"} signal`);
  if(!parts.length) return active?"Position unchanged; monitoring the next closed 4H candle.":"Monitoring the clean 1D/4H setup.";
  return parts.slice(0,3).join(". ")+".";
}

function entry1Watch(m:any):string {
  const dir=directionOf(m);
  if(dir==="NEUTRAL") return "No ENTRY_1: 1D EMA8/EMA21 is neutral.";
  const dist=Number(m?.distToTrendline),k=Number(m?.stochK);
  if(!Number.isFinite(dist)) return `${dir} ENTRY_1: waiting for a valid 4H trendline.`;
  const near=Math.abs(dist)<=1;
  const extreme=dir==="LONG"?k<25:k>75;
  if(near&&extreme) return `${dir} ENTRY_1 setup present; ENTRY_1 remains silent.`;
  if(near) return `${dir} ENTRY_1 watch: near trendline · waiting for Stoch K ${dir==="LONG"?"< 25":"> 75"}`;
  return `${dir} ENTRY_1 watch: waiting for trendline approach · Stoch K ${Number.isFinite(k)?k:"—"}`;
}

function pairState(m:any, active:any):JarvisPairState {
  const dir=(active?.direction||directionOf(m)) as "LONG"|"SHORT"|"NEUTRAL";
  const k=Number(m?.stochK), d=Number(m?.stochD), r=Number(m?.rsi), dist=Number(m?.distToTrendline);
  const tl=Number(m?.trendlinePrice);
  const trend=String(m?.trend||"");
  const entryType=String(active?.type||"");
  const exhaustionLong=dir==="LONG" && ((k>=99)||(k>95&&Number.isFinite(dist)&&dist>1)||(r>=80));
  const exhaustionShort=dir==="SHORT" && ((k<=1)||(k<5&&Number.isFinite(dist)&&dist< -1)||(r<=20));
  const exhaustion=exhaustionLong||exhaustionShort;
  const managementExit=active?.positionManagementState==="EXIT"||active?.positionManagementRecommendation==="EXIT TRADE";
  const opposite1D=(dir==="LONG"&&m?.dailyDirection==="BEAR")||(dir==="SHORT"&&m?.dailyDirection==="BULL");
  let momentum:"SUPPORTIVE"|"WEAKENING"|"BREAKDOWN"="SUPPORTIVE";
  if(managementExit) momentum="BREAKDOWN";
  else if(opposite1D) momentum="WEAKENING";
  else if(exhaustion) momentum="WEAKENING";
  const verdict:JarvisVerdict=managementExit?"BAD":exhaustion||opposite1D?"CAUTION":"GOOD";
  const state:JarvisState=verdict==="BAD"?"BROKEN":verdict==="CAUTION"?"DETERIORATING":"ACCUMULATING";
  const reasons:string[]=[];
  if(active) reasons.push(`active ${active.direction} ${entryType||"position"}`);
  reasons.push(`1D ${m?.dailyDirection||"NEUTRAL"}`);
  if(trend) reasons.push(trend);
  if(Number.isFinite(dist)) reasons.push(`trendline distance ${dist.toFixed(2)}%`);
  if(Number.isFinite(k)&&Number.isFinite(d)) reasons.push(`4H Stoch ${k}/${d}`);
  if(exhaustion) reasons.push("ENTRY_1 exhaustion condition present");
  const thesis=active
    ? verdict==="BAD"?"Position management says EXIT.":verdict==="CAUTION"?"Position is under pressure; the clean strategy context is weakening.":"The clean strategy context remains intact."
    : verdict==="CAUTION"?"The setup is developing but has a caution condition.":"The clean 1D/4H setup is being monitored.";
  const watch=verdict==="BAD"?"Follow the position management exit state.":exhaustion?"ENTRY_1 is blocked by exhaustion; ENTRY_2 is not blocked by exhaustion.":"Watch the next closed 4H candle and trendline interaction.";
  const changed=`${verdict} · ${reasons.join(" · ")||"market context only"}`;
  const momentumSignature=active?`${dir}:${momentum}:${k}:${d}`:"NO_POSITION";
  const tradeDecision=active?(managementExit?"EXIT TRADE":"STAY IN TRADE"):undefined;
  return {pair:m?.pair||active?.pair||"?",state,direction:dir,verdict,thesis,whatChanged:changed,watch,management:active?.positionManagementReason,position:active?{direction:active.direction,entry:active.entry,stop:active.stop,tp1:active.tp1,tp2:active.tp2}:undefined,updatedAt:Date.now(),momentum,momentumSignature,currentAnalysis:currentAnalysis(m,active,momentum,verdict),tradeDecision,entry1Watch:entry1Watch(m)};
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
  const prompt="You are JARVIS for CX Switch V28. V28 ENTRY_1 is intentionally early and does not require full 4H alignment. 1D is context, not a veto. A temporary opposing 4H label during a price-action reversal is expected and is not automatically a failed thesis. Call failure only when opposite structure is confirmed, continuation clearly invalidates the setup, or management says EXIT. ENTRY_2 is the confirmed breakout/retest setup. Be concise and factual." +
    "\n\nPORTFOLIO: " + snapshot.portfolioState +
    "\nCHANGES:\n" + JSON.stringify(changes);
  try{
    const res=await fetch("https://router.huggingface.co/v1/chat/completions",{method:"POST",headers:{"Authorization":`Bearer ${key}`,"Content-Type":"application/json"},body:JSON.stringify({model:MODEL,messages:[{role:"system",content:"You are JARVIS: concise, factual, calm, risk-aware."},{role:"user",content:prompt}],temperature:0.2,max_tokens:300})});
    if(!res.ok){console.warn(`[JARVIS] Hugging Face ${res.status}`);return undefined;}
    const data=await res.json();
    return data?.choices?.[0]?.message?.content?.trim() || undefined;
  }catch(error){console.warn("[JARVIS] model unavailable",error);return undefined;}
}


function deterministicTradeVerdict(signal:any,market:any):{ verdict:JarvisVerdict; summary:string; why:string; watch:string }{
  const direction=signal.direction==="SHORT"?"SHORT":"LONG";
  const k=Number(market?.stochK), d=Number(market?.stochD), r=Number(market?.rsi), dist=Number(market?.distToTrendline);
  const entry1=signal.type==="ENTRY_1";
  const exhausted=entry1 && (direction==="LONG" ? k>=99 || (k>95&&dist>1) || r>=80 : k<=1 || (k<5&&dist< -1) || r<=20);
  const verdict:JarvisVerdict=exhausted?"CAUTION":"GOOD";
  const summary=exhausted
    ? `CAUTION — ${signal.type} ${direction} is showing the ENTRY_1 exhaustion condition.`
    : `GOOD — ${signal.type} ${direction} passed the clean strategy context.`;
  const why=[signal.type,`1D ${market?.dailyDirection||"NEUTRAL"}`,`4H Stoch ${k}/${d}`,`RSI ${r}`,Number.isFinite(dist)?`trendline distance ${dist}%`:null].filter(Boolean).join(" · ");
  const watch=exhausted
    ? "ENTRY_1 is blocked; ENTRY_2 bypasses exhaustion."
    : "Watch the next closed 4H candle and trendline interaction.";
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
  for(const p of all){ if(!p.position) console.log("[JARVIS ENTRY] "+p.pair+" | "+p.entry1Watch); }
  const portfolio=portfolioState(all);
  const changes=all.filter(p=>p.previousState&&p.previousState!==p.state);
  const decisionChanges=all.filter(p=>{
    if(!p.position||!p.tradeDecision) return false;
    const old=previous?.pairs?.[p.pair]?.tradeDecision;
    return !!old && old!==p.tradeDecision;
  });
  const whatChanged=changes.length
    ? changes.map(p=>`${p.pair}: ${p.previousState} → ${p.state}`).join(" · ")
    : "No material JARVIS state change.";
  const snapshot:JarvisSnapshot={portfolioState:portfolio,whatChanged,pairs,updatedAt:Date.now()};
  const modelText=await interpretWithModel(snapshot);
  if(modelText) snapshot.whatChanged=modelText;

  await redis.set(JARVIS_KEY,snapshot);

  // Rich JARVIS state remains internal. Telegram is an action layer for
  // active trades only: STAY IN TRADE or EXIT TRADE, and only when that
  // binary decision actually changes. Portfolio regime changes and momentum
  // diagnostics stay on the dashboard and never become exit prompts.
  if(decisionChanges.length){
    try{
      await sendJarvisUpdate({
        portfolioState:portfolio,
        location:"TRADE_DECISION_CHANGE",
        summary:"Active-trade decision changed.",
        changes:decisionChanges.map(p=>({
          pair:p.pair,
          decision:p.tradeDecision!,
          reason:p.tradeDecision==="EXIT TRADE"
            ? (p.management||"Confirmed V28 management exit.")
            : "V28 management still says the trade thesis is intact."
        })),
        timestamp:new Date().toISOString()
      });
      console.log(`[JARVIS] Trade decision update sent: ${decisionChanges.map(p=>`${p.pair}=${p.tradeDecision}`).join(" · ")}`);
    }catch(error){console.warn("[JARVIS] Telegram update failed",error);}
  }
  return snapshot;
}
