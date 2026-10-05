// lib/jarvis.ts — deterministic bounded veto layer for the simple directional strategy
import { Redis } from "./supabase-kv";

import { evaluateGates } from "./strategy";
import type { Candle, Signal } from "./strategy";

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
  if(signal.signalClass==="REVERSAL" || signal.type==="REVERSAL_SHORT" || signal.type==="REVERSAL_LONG"){
    return { verdict:"WARN", reason:"counter-trend reversal — reduce size, tighter management" };
  }
  const oneD = directionFromDaily(snapshot?.dailyDirection);
  const dailyStrength = String(snapshot?.dailyStrength || "NEUTRAL");
  if(oneD === "BULL" && signal.direction === "SHORT" && dailyStrength === "HIGH") {
    return { verdict:"VETO", reason:"SHORT against HIGH-strength BULL 1D" };
  }
  if(oneD === "BEAR" && signal.direction === "LONG" && dailyStrength === "HIGH") {
    return { verdict:"VETO", reason:"LONG against HIGH-strength BEAR 1D" };
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

function roundState(n:number,d=1){const m=10**d;return Math.round(n*m)/m}
function emaState(a:number[],p:number){if(!a.length)return[];const k=2/(p+1),o=[a[0]];for(let i=1;i<a.length;i++)o.push(a[i]*k+o[i-1]*(1-k));return o}
function atrState(c:Candle[],p=14){if(c.length<2)return 0;const v:number[]=[];for(let i=Math.max(1,c.length-p);i<c.length;i++){const x=c[i],q=c[i-1];v.push(Math.max(x.high-x.low,Math.abs(x.high-q.close),Math.abs(x.low-q.close)))}return v.reduce((a,b)=>a+b,0)/v.length}
function dailyState(c:Candle[]){const m=new Map<string,Candle[]>();for(const x of [...c].sort((a,b)=>a.timestamp-b.timestamp)){const k=new Date(x.timestamp).toISOString().slice(0,10),b=m.get(k)??[];b.push(x);m.set(k,b)}return[...m.values()].map(b=>({timestamp:b[0].timestamp,open:b[0].open,high:Math.max(...b.map(x=>x.high)),low:Math.min(...b.map(x=>x.low)),close:b.at(-1)!.close,volume:b.reduce((s,x)=>s+x.volume,0)}))}
function swingsState(c:Candle[],high:boolean){const o:{index:number;price:number}[]=[];for(let i=2;i<c.length-2;i++){const p=high?c[i].high:c[i].low;let ok=true;for(let j=1;j<=2;j++)if(high?(p<=c[i-j].high||p<=c[i+j].high):(p>=c[i-j].low||p>=c[i+j].low))ok=false;if(ok)o.push({index:i,price:p})}return o}
function zoneState(c:Candle[],dir:"LONG"|"SHORT",p:number,a:number,e21:number){if(!a)return null;const z:{type:string;price:number;distance:number}[]=[];const sw=swingsState(c,dir==="SHORT"),n=sw.length;if(n>=2){const pts=sw.slice(-5),sx=pts.reduce((s,x)=>s+x.index,0),sy=pts.reduce((s,x)=>s+x.price,0),sxy=pts.reduce((s,x)=>s+x.index*x.price,0),sx2=pts.reduce((s,x)=>s+x.index*x.index,0),den=pts.length*sx2-sx*sx;if(den){const slope=(pts.length*sxy-sx*sy)/pts.length,intercept=(sy-slope*sx)/pts.length,lp=slope*(c.length-1)+intercept;if((dir==="LONG"&&slope>0)||(dir==="SHORT"&&slope<0))z.push({type:"trendline",price:lp,distance:Math.abs(p-lp)})}}z.push({type:"EMA21",price:e21,distance:Math.abs(p-e21)});const s=sw.at(-1);if(s)z.push({type:dir==="LONG"?"swing low":"swing high",price:s.price,distance:Math.abs(p-s.price)});z.sort((x,y)=>x.distance-y.distance);return z[0]??null}
function stochState(a:number[]){const rs:number[]=[];if(a.length<=14)return{k:50,d:50,pk:50,pd:50};let g=0,l=0;for(let i=1;i<=14;i++){const x=a[i]-a[i-1];if(x>=0)g+=x;else l-=x}let ag=g/14,al=l/14;rs.push(al===0?100:100-100/(1+ag/al));for(let i=15;i<a.length;i++){const x=a[i]-a[i-1];ag=(ag*13+Math.max(x,0))/14;al=(al*13+Math.max(-x,0))/14;rs.push(al===0?100:100-100/(1+ag/al))}const raw:number[]=[];for(let i=13;i<rs.length;i++){const w=rs.slice(i-13,i+1),lo=Math.min(...w),hi=Math.max(...w);raw.push(hi===lo?50:(rs[i]-lo)/(hi-lo)*100)}const k:number[]=[],d:number[]=[];for(let i=2;i<raw.length;i++)k.push(raw.slice(i-2,i+1).reduce((x,y)=>x+y,0)/3);for(let i=2;i<k.length;i++)d.push(k.slice(i-2,i+1).reduce((x,y)=>x+y,0)/3);return{k:k.at(-1)??50,d:d.at(-1)??50,pk:k.at(-2)??50,pd:d.at(-2)??50}}
function exhaustionState(dir:"LONG"|"SHORT",k:number,rsi:number,p:number,e21:number){if(dir==="LONG"&&k>=95)return"K "+roundState(k)+" > 95";if(dir==="SHORT"&&k<=5)return"K "+roundState(k)+" < 5";if(dir==="LONG"&&rsi>=78)return"RSI "+roundState(rsi)+" > 78";if(dir==="SHORT"&&rsi<=22)return"RSI "+roundState(rsi)+" < 22";if(dir==="LONG"&&p>e21*1.03)return"price >3% above EMA21";if(dir==="SHORT"&&p<e21*.97)return"price >3% below EMA21";return null}

export function narratePairState(pair:string,market:any,candles4h:Candle[],signal:Signal|undefined,candles15m:Candle[]=[]):string{
  void candles15m;
  const c=[...candles4h].sort((a,b)=>a.timestamp-b.timestamp);
  if(!c.length)return "[JARVIS STATE] "+pair+" — Status unavailable. Missing: —";

  const p=Number(market?.currentPrice??market?.price??c.at(-1)?.close??0);
  const evaluation=evaluateGates(pair,c,p);
  const dailyDir=directionFromDaily(market?.dailyDirection ?? market?.trend);
  const dailyStrength=String(market?.dailyStrength || "NEUTRAL");
  const tacticalDir=evaluation.direction ?? directionFrom4H(market);

  const dailyText=dailyDir==="BULL"?"BULL":dailyDir==="BEAR"?"BEAR":"NEUTRAL";
  const tacticalText=tacticalDir==="BULL"?"BULL":tacticalDir==="BEAR"?"BEAR":"NEUTRAL";

  if(!evaluation.direction){
    const blockReason=dailyDir==="NEUTRAL"
      ? "1D direction is NEUTRAL."
      : "4H tactical "+tacticalText+" is not permitted by the current 1D "+dailyText+" "+dailyStrength+" regime.";
    return "[JARVIS STATE] "+pair+" — Quiet. 1D "+dailyText+" · "+dailyStrength+" | 4H tactical "+tacticalText+". "+blockReason+" Missing: direction.";
  }

  const dir=evaluation.direction;
  const trendlinePrice=evaluation.zone?.price??0;
  const distancePct=evaluation.zone?.distancePct??Infinity;
  const trendText=dir==="LONG"?"ascending support":"descending resistance";

  // Use the exact gate evaluation for the Stoch narration. This removes the
  // duplicated Stoch implementation that could say ENTRY_2 was live while
  // evaluateGates still reported stoch_cross missing.
  const st=evaluation.trigger;
  const k=evaluation.trigger.signalType==="ENTRY_1"
    ? (dir==="LONG"?20:80)
    : undefined;
  const q=c.map(x=>x.close);
  const rawStoch=stochState(q);
  const kNow=rawStoch.k;
  const dNow=rawStoch.d;
  let stochText:string;
  if(st.entry1){
    stochText=`4H Stoch K ${kNow.toFixed(1)} / D ${dNow.toFixed(1)} — ENTRY_1 active.`;
  }else if(st.entry2){
    stochText=`4H Stoch K ${kNow.toFixed(1)} / D ${dNow.toFixed(1)} — ENTRY_2 active.`;
  }else if(dir==="LONG" && kNow>dNow && kNow>55){
    stochText=`4H Stoch K ${kNow.toFixed(1)} / D ${dNow.toFixed(1)} — K/D bullish but outside the ENTRY_2 window.`;
  }else if(dir==="SHORT" && kNow<dNow && kNow<45){
    stochText=`4H Stoch K ${kNow.toFixed(1)} / D ${dNow.toFixed(1)} — K/D bearish but outside the ENTRY_2 window.`;
  }else{
    stochText=`4H Stoch K ${kNow.toFixed(1)} / D ${dNow.toFixed(1)} — ENTRY_2 not active.`;
  }

  const missingText=evaluation.missing.length?evaluation.missing.join(", "):"—";
  const suffix=` Missing: ${missingText}.`;
  const contextText=`1D ${dailyText} · ${dailyStrength} | 4H tactical ${dir}.`;

  if(signal){
    const stopCtx=signal.context?.stopCalc;
    const riskText=stopCtx?" Stop "+signal.stop.toFixed(2)+" ("+stopCtx.riskPct.toFixed(1)+"% risk).":"";
    const reversal=signal.signalClass==="REVERSAL";
    if(reversal){
      const reversalLine=signal.context?.zone==="REVERSAL_RESISTANCE"?"descending resistance":"ascending support";
      const cross=signal.direction==="SHORT"?"crossed down":"crossed up";
      return "[JARVIS STATE] "+pair+" — Fired "+signal.type+" at market ("+signal.entry.toFixed(2)+"). "+contextText+" 4H "+reversalLine+" at "+Number(signal.context?.zonePrice??0).toFixed(2)+". Stoch "+cross+" from "+signal.stochK.toFixed(1)+". TP1 "+signal.tp1.toFixed(2)+", TP2 "+signal.tp2.toFixed(2)+". Counter-trend, 50% size."+riskText+suffix;
    }
    return "[JARVIS STATE] "+pair+" — Fired "+signal.type+" at market ("+signal.entry.toFixed(2)+"). "+contextText+" Price at "+trendText+". "+stochText+riskText+suffix;
  }

  if(!evaluation.zone){
    return "[JARVIS STATE] "+pair+" — Watching. "+contextText+" Waiting for a validated 4H "+trendText+". "+stochText+suffix;
  }

  if(distancePct>1.2){
    return "[JARVIS STATE] "+pair+" — Watching. "+contextText+" 4H "+trendText+" at "+trendlinePrice.toFixed(2)+". Price is "+distancePct.toFixed(1)+"% away from the line. "+stochText+suffix;
  }

  return "[JARVIS STATE] "+pair+" — Watching. "+contextText+" 4H "+trendText+" at "+trendlinePrice.toFixed(2)+". Price is "+distancePct.toFixed(1)+"% from the line. "+stochText+suffix;
}
