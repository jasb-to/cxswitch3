// lib/jarvis.ts — deterministic observation and review layer for the single-direction V28 strategy
import { Redis } from "./supabase-kv";

import { evaluateGates } from "./strategy";
import { get4HEmaDiagnostic } from "./ema-diagnostic";
import type { Candle, Signal } from "./strategy";

const redis = new Redis();
const JARVIS_KEY = "cxswitch:jarvis_state";

export type JarvisVerdict = "GOOD" | "WARN" | "VETO";

export interface JarvisReview {
  verdict: JarvisVerdict;
  reason: string;
}

export interface JarvisOpportunity {
  direction: "LONG" | "SHORT";
  strength: "DEVELOPING" | "CONFIRMED";
  reason: string;
  activePosition?: "LONG" | "SHORT";
  positionConflict?: boolean;
}

export interface JarvisPairState {
  pair: string;
  direction: "LONG" | "SHORT" | "NEUTRAL";
  verdict: JarvisVerdict;
  reason: string;
  currentAnalysis: string;
  opportunity?: JarvisOpportunity;
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
  // 4H EMA5/13 is trade-management context; it never gates a V28 entry.
  const tacticalDirection=String(snapshot?.fourHTacticalDirection||"").toUpperCase();
  if(tacticalDirection==="BULL"||tacticalDirection==="LONG")return "BULL";
  if(tacticalDirection==="BEAR"||tacticalDirection==="SHORT")return "BEAR";
  const tacticalLabel=String(snapshot?.fourH513?.label || snapshot?.fourH513?.stage || "");
  if(tacticalLabel.includes("BEARISH")) return "BEAR";
  if(tacticalLabel.includes("BULLISH")) return "BULL";
  if(snapshot?.fourHDirection === "BULL" || snapshot?.fourHDirection === "LONG" || snapshot?.fourHDirection === "BULLISH") return "BULL";
  if(snapshot?.fourHDirection === "BEAR" || snapshot?.fourHDirection === "SHORT" || snapshot?.fourHDirection === "BEARISH") return "BEAR";
  const e8=Number(snapshot?.ema8_4h), e21=Number(snapshot?.ema21_4h);
  if(Number.isFinite(e8)&&Number.isFinite(e21)) return e8>e21?"BULL":e8<e21?"BEAR":"NEUTRAL";
  return "NEUTRAL";
}

export function reviewFiredSignal(signal: Signal, snapshot:any): JarvisReview {
  if(signal.signalClass==="REVERSAL" || signal.type==="REVERSAL_SHORT" || signal.type==="REVERSAL_LONG"){
    return { verdict:"WARN", reason:"counter-trend reversal — reduce size, tighter management" };
  }
  const oneD = directionFromDaily(snapshot?.dailyDirection);
  const dailyStrength = String(snapshot?.dailyStrength || "NEUTRAL");
  if(oneD === "BULL" && signal.direction === "SHORT" && dailyStrength === "HIGH") {
    return { verdict:"WARN", reason:"SHORT against HIGH-strength BULL 1D context" };
  }
  if(oneD === "BEAR" && signal.direction === "LONG" && dailyStrength === "HIGH") {
    return { verdict:"WARN", reason:"LONG against HIGH-strength BEAR 1D context" };
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

function detectOpportunity(m:any, evaluation:any): JarvisOpportunity|undefined {
  const tactical=directionFrom4H(m);
  const tacticalDirection=tactical==="BULL"?"LONG":tactical==="BEAR"?"SHORT":null;
  if(!tacticalDirection)return undefined;

  const k1=Number(m?.stochK1d),d1=Number(m?.stochD1d),pk1=Number(m?.stochK1dPrev),pd1=Number(m?.stochD1dPrev);
  const k4=Number(m?.stochK4h),d4=Number(m?.stochD4h),pk4=Number(m?.stochK4hPrev),pd4=Number(m?.stochD4hPrev);
  if(![k1,d1,k4,d4].every(Number.isFinite))return undefined;

  // Opportunity recognition is deliberately separate from the trade gates.
  // The 4H tactical direction is the anchor: a Stoch move against it is
  // context/noise, not an opportunity. This prevents false alerts such as
  // "BULL opportunity" while 4H tactical direction is BULL but Stoch is bearish.
  const fourHTurn=tacticalDirection==="LONG"
    ? (Number.isFinite(pk4)&&Number.isFinite(pd4)&&pk4<=pd4&&k4>d4) || k4>d4
    : (Number.isFinite(pk4)&&Number.isFinite(pd4)&&pk4>=pd4&&k4<d4) || k4<d4;

  if(!fourHTurn)return undefined;

  const dailyTurn=tacticalDirection==="LONG"
    ? (Number.isFinite(pk1)&&Number.isFinite(pd1)&&pk1<=pd1&&k1>d1) || k1>d1
    : (Number.isFinite(pk1)&&Number.isFinite(pd1)&&pk1>=pd1&&k1<d1) || k1<d1;

  const both=dailyTurn;
  const dirText=tacticalDirection==="LONG"?"bullish":"bearish";

  return {
    direction:tacticalDirection,
    strength:both?"CONFIRMED":"DEVELOPING",
    reason:both
      ? `The 1D and 4H Stoch are turning ${dirText} together. Momentum is lining up.`
      : `The 4H is leaning ${dirText} and its Stoch agrees. The 1D has not joined it yet — watch, don’t chase.`
  };
}

/** Advisory-only radar: consumes existing snapshot values and never changes V28 gates or execution. */
export function buildJarvisNarrative(marketSnapshot:any[], activeSignals:any[]):Record<string,string> {
  const activeByPair=new Map((activeSignals||[]).map(x=>[String(x?.pair||""),x]));
  const narratives:Record<string,string>={};
  for(const m of marketSnapshot||[]){
    const pair=String(m?.pair||"?"); const active=activeByPair.get(pair);
    const regime=String(m?.regime||"UNKNOWN").replace(/_/g," "); const adx=Number(m?.adx);
    const context=[regime!=="UNKNOWN"?regime+" regime":null,Number.isFinite(adx)&&adx>25?"Strong trend":null].filter(Boolean).join(" · ");
    if(active){
      const price=Number(m?.currentPrice??m?.price),entry=Number(active.entry);
      const pnl=Number.isFinite(price)&&Number.isFinite(entry)&&entry>0?((price-entry)/entry*100)*(active.direction==="SHORT"?-1:1):null;
      const aligned=m?.momentumAligned??m?.alignment?.momentumAligned;
      const momentum=aligned===true?"4H EMA5/13 momentum is aligned, holding for target.":aligned===false?"4H EMA5/13 momentum is misaligned; tighten stop and monitor exit conditions.":"4H EMA5/13 momentum is unavailable.";
      const pnlText=pnl===null?"PnL unavailable":(pnl>=0?"+":"")+pnl.toFixed(2)+"% PnL";
      narratives[pair]="ACTIVE "+String(active.direction||"").toUpperCase()+" · "+pnlText+". "+momentum+(context?" "+context+".":""); continue;
    }
    const macro=String(m?.dailyDirection||"NEUTRAL").toUpperCase(),fast=String(m?.entry1Direction||"NEUTRAL").toUpperCase();
    const side=(v:string):"LONG"|"SHORT"|null=>v==="LONG"||v==="BULL"||v==="BULLISH"?"LONG":v==="SHORT"||v==="BEAR"||v==="BEARISH"?"SHORT":null;
    const macroSide=side(macro),fastSide=side(fast),dir=macroSide||fastSide;
    const distance=Number(m?.trendlineDistancePct??m?.distToTrendline);
    const k=Number(m?.entry1ClosedStochK??m?.stochK4h??m?.stochK);
    const nearLine=Number.isFinite(distance)&&distance<=1.2;
    let analysis:string;
    if(!macroSide||!fastSide) analysis="Macro "+macro+" · fast 5/13 bias "+fast+". Waiting for both directional readings.";
    else if(macroSide!==fastSide) analysis="Watching "+pair+" · macro "+macroSide+" conflicts with fast 5/13 "+fastSide+". No aligned V28 setup yet.";
    else if(!nearLine) analysis="Watching "+pair+" "+dir+". Trend is aligned, but price is "+(Number.isFinite(distance)?distance.toFixed(2)+"%":"an unknown distance")+" from the trendline. Need a pullback to the line.";
    else if(!Number.isFinite(k)) analysis="Watching "+pair+" "+dir+". Price is at the trendline, but Stoch K is unavailable; waiting for the V28 Stoch condition.";
    else if(dir==="LONG"?k<=20:k>=80) analysis="READY: "+pair+" "+dir+". Price is at the trendline and Stoch K is "+k.toFixed(1)+" (extreme). Waiting for the next candle close to confirm the V28 trigger.";
    else analysis="Watching "+pair+" "+dir+". Price is at the trendline, but Stoch K is "+k.toFixed(1)+". Waiting for Stoch to hit "+(dir==="LONG"?"20":"80")+" to trigger.";
    narratives[pair]=analysis+(context?" "+context+".":"");
  }
  return narratives;
}
function pairState(m:any, active:any): JarvisPairState {
  const candles=Array.isArray(m?.momentumCandles4h)?m.momentumCandles4h:[];
  const evaluation=candles.length?evaluateGates(String(m?.pair||"?"),candles,Number(m?.price||m?.currentPrice||0)):null;
  let opportunity=detectOpportunity(m,evaluation);
  if(opportunity && (active?.direction==="LONG" || active?.direction==="SHORT")){
    const activeDirection=active.direction as "LONG"|"SHORT";
    opportunity={...opportunity,activePosition:activeDirection,positionConflict:activeDirection!==opportunity.direction};
  }
  const direction=(active?.direction || m?.dailyLive?.direction || m?.direction || "NEUTRAL") as "LONG"|"SHORT"|"NEUTRAL";
  const review: JarvisReview = active
    ? reviewFiredSignal({
        id:String(active.id||"active"),
        pair:String(active.pair||m?.pair||"?"),
        direction:active.direction,
        type:active.type==="REVERSAL_SHORT"?"REVERSAL_SHORT":active.type==="REVERSAL_LONG"?"REVERSAL_LONG":active.type==="ENTRY_2"?"ENTRY_2":"ENTRY_1",
        signalClass:active.signalClass==="REVERSAL"?"REVERSAL":"TREND",
        sizeMultiplier:active.sizeMultiplier===0.5?0.5:1,
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
    opportunity,
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
  const narratives=buildJarvisNarrative(marketData,active);
  for(const [pair,narrative] of Object.entries(narratives)){if(pairs[pair])pairs[pair].currentAnalysis=narrative;}
  const all=Object.values(pairs);
  const hasVeto=false;
  const hasWarn=all.some(x=>x.verdict==="WARN");
  const watched=all.filter(x=>!x.position).length;
  const closest=marketData.filter(m=>!activeByPair.has(m.pair)&&Number.isFinite(Number(m.trendlineDistancePct??m.distToTrendline))).sort((a,b)=>Number(a.trendlineDistancePct??a.distToTrendline)-Number(b.trendlineDistancePct??b.distToTrendline))[0];
  const closestText=closest?" Closest is "+closest.pair+" "+String(closest.dailyDirection||"")+": "+Number(closest.trendlineDistancePct??closest.distToTrendline).toFixed(2)+"% from the trendline.":"";
  const snapshot:JarvisSnapshot={
    portfolioState:hasVeto?"VETO":hasWarn?"WARN":"GOOD",
    whatChanged:"Watching "+watched+" setups."+closestText,
    pairs,
    updatedAt:Date.now(),
  };
  await redis.set(JARVIS_KEY,snapshot);
  return snapshot;
}

function roundState(n:number,d=1){const m=10**d;return Math.round(n*m)/m}
function emaState(a:number[],p:number){if(!a.length)return[];const k=2/(p+1),o=[a[0]];for(let i=1;i<a.length;i++)o.push(a[i]*k+o[i-1]*(1-k));return o}
function atrState(c:Candle[],p=14){if(c.length<2)return 0;const v:number[]=[];for(let i=Math.max(1,c.length-p);i<c.length;i++){const x=c[i],q=c[i-1];v.push(Math.max(x.high-x.low,Math.abs(x.high-q.close),Math.abs(x.low-q.close)))}return v.reduce((a,b)=>a+b,0)/v.length}
function dailyState(c:Candle[]){const m=new Map<string,Candle[]>();for(const x of [...c].sort((a,b)=>a.timestamp-b.timestamp)){const k=new Date(x.timestamp).toISOString().slice(0,10),b=m.get(k)??[];b.push(x);m.set(k,b)}return[...m.values()].map(b=>({timestamp:b[0].timestamp,open:b[0].open,high:Math.max(...b.map(x=>x.high)),low:Math.min(...b.map(x=>x.low)),close:b.at(-1)!.close,volume:b.reduce((s,x)=>s+x.volume,0)}))}
function swingsState(c:Candle[],high:boolean){const o:{index:number;price:number}[]=[];for(let i=2;i<c.length-2;i++){const p=high?c[i].high:c[i].low;let ok=true;for(let j=1;j<=2;j++)if(high?(p<=c[i-j].high||p<=c[i+j].high):(p>=c[i-j].low||p>=c[i+j].low))ok=false;if(ok)o.push({index:i,price:p})}return o}
function zoneState(c:Candle[],dir:"LONG"|"SHORT",p:number,a:number,e21:number){if(!a)return null;const z:{type:string;price:number;distance:number}[]=[];const sw=swingsState(c,dir==="SHORT"),n=sw.length;if(n>=2){const pts=sw.slice(-5),sx=pts.reduce((s,x)=>s+x.index,0),sy=pts.reduce((s,x)=>s+x.price,0),sxy=pts.reduce((s,x)=>s+x.index*x.price,0),sx2=pts.reduce((s,x)=>s+x.index*x.index,0),den=pts.length*sx2-sx*sx;if(den){const slope=(pts.length*sxy-sx*sy)/pts.length,intercept=(sy-slope*sx)/pts.length,lp=slope*(c.length-1)+intercept;if((dir==="LONG"&&slope>0)||(dir==="SHORT"&&slope<0))z.push({type:"trendline",price:lp,distance:Math.abs(p-lp)})}}z.push({type:"EMA21",price:e21,distance:Math.abs(p-e21)});const s=sw.at(-1);if(s)z.push({type:dir==="LONG"?"swing low":"swing high",price:s.price,distance:Math.abs(p-s.price)});z.sort((x,y)=>x.distance-y.distance);return z[0]??null}
function stochState(a:number[]){const rs:number[]=[];if(a.length<=14)return{k:50,d:50,pk:50,pd:50};let g=0,l=0;for(let i=1;i<=14;i++){const x=a[i]-a[i-1];if(x>=0)g+=x;else l-=x}let ag=g/14,al=l/14;rs.push(al===0?100:100-100/(1+ag/al));for(let i=15;i<a.length;i++){const x=a[i]-a[i-1];ag=(ag*13+Math.max(x,0))/14;al=(al*13+Math.max(-x,0))/14;rs.push(al===0?100:100-100/(1+ag/al))}const raw:number[]=[];for(let i=13;i<rs.length;i++){const w=rs.slice(i-13,i+1),lo=Math.min(...w),hi=Math.max(...w);raw.push(hi===lo?50:(rs[i]-lo)/(hi-lo)*100)}const k:number[]=[],d:number[]=[];for(let i=2;i<raw.length;i++)k.push(raw.slice(i-2,i+1).reduce((x,y)=>x+y,0)/3);for(let i=2;i<k.length;i++)d.push(k.slice(i-2,i+1).reduce((x,y)=>x+y,0)/3);return{k:k.at(-1)??50,d:d.at(-1)??50,pk:k.at(-2)??50,pd:d.at(-2)??50}}

export function narratePairState(pair:string,market:any,candles4h:Candle[],signal:Signal|undefined,candles15m:Candle[]=[]):string{
  void candles15m;
  const c=[...candles4h].sort((a,b)=>a.timestamp-b.timestamp);
  if(!c.length)return "[JARVIS STATE] "+pair+" — Status unavailable.";
  const p=Number(market?.currentPrice??market?.price??c.at(-1)?.close??0);
  const evaluation=evaluateGates(pair,c,p);
  const daily=String(market?.dailyDirection??evaluation.direction??"NEUTRAL").toUpperCase();
  const dailyText=daily==="LONG"||daily==="SHORT"?daily:"NEUTRAL";
  const momentum=market?.momentumAligned??evaluation.momentumAligned;
  const exhaustion=market?.exhaustion??evaluation.exhaustion;
  const tlDistance=Number(market?.trendlineDistancePct??market?.distToTrendline);
  const tlText=Number.isFinite(tlDistance)?" Trendline distance "+tlDistance.toFixed(2)+"%.":" Trendline distance unavailable.";
  const filterText=" 4H EMA5/13 momentum is "+(momentum?"aligned":"misaligned")+" (trade-management context only)."+(exhaustion?" Stoch hard cap: "+exhaustion+".":"");
  if(!evaluation.direction)return "[JARVIS STATE] "+pair+" — DAILY MACRO (1D EMA8/21): "+dailyText+"."+filterText+tlText+" Waiting for the V28 trendline/Stoch trigger.";
  const dir=evaluation.direction,st=evaluation.trigger,q=c.map(x=>x.close),rawStoch=stochState(q),kNow=rawStoch.k,dNow=rawStoch.d;
  let stochSummary="Stoch is waiting for confirmation.";
  if(st.entry1)stochSummary="Stoch is at the daily-direction extreme for ENTRY_1.";
  else if(st.entry2)stochSummary="Stoch is turning in the daily direction for ENTRY_2.";
  else if(dir==="LONG"&&kNow>dNow)stochSummary="Stoch is turning bullish, but entry timing is not ready yet.";
  else if(dir==="SHORT"&&kNow<dNow)stochSummary="Stoch is turning bearish, but entry timing is not ready yet.";
  if(signal)return "[JARVIS STATE] "+pair+" — "+signal.type+" "+dir+" fired using the dual-track daily EMA8/21 macro and EMA5/13 ENTRY_1 bias."+filterText+tlText+" "+stochSummary+" TP "+signal.tp1.toFixed(2)+".";
  return "[JARVIS STATE] "+pair+" — DAILY MACRO (1D EMA8/21): "+dailyText+"."+filterText+tlText+" "+stochSummary+" Waiting for a V28 trendline/Stoch trigger.";
}
