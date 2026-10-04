// lib/jarvis.ts — deterministic bounded veto layer for the simple directional strategy
import { Redis } from "./supabase-kv";
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

function roundState(n:number,d=1){const m=10**d;return Math.round(n*m)/m}
function emaState(a:number[],p:number){if(!a.length)return[];const k=2/(p+1),o=[a[0]];for(let i=1;i<a.length;i++)o.push(a[i]*k+o[i-1]*(1-k));return o}
function atrState(c:Candle[],p=14){if(c.length<2)return 0;const v:number[]=[];for(let i=Math.max(1,c.length-p);i<c.length;i++){const x=c[i],q=c[i-1];v.push(Math.max(x.high-x.low,Math.abs(x.high-q.close),Math.abs(x.low-q.close)))}return v.reduce((a,b)=>a+b,0)/v.length}
function dailyState(c:Candle[]){const m=new Map<string,Candle[]>();for(const x of [...c].sort((a,b)=>a.timestamp-b.timestamp)){const k=new Date(x.timestamp).toISOString().slice(0,10),b=m.get(k)??[];b.push(x);m.set(k,b)}return[...m.values()].map(b=>({timestamp:b[0].timestamp,open:b[0].open,high:Math.max(...b.map(x=>x.high)),low:Math.min(...b.map(x=>x.low)),close:b.at(-1)!.close,volume:b.reduce((s,x)=>s+x.volume,0)}))}
function swingsState(c:Candle[],high:boolean){const o:{index:number;price:number}[]=[];for(let i=2;i<c.length-2;i++){const p=high?c[i].high:c[i].low;let ok=true;for(let j=1;j<=2;j++)if(high?(p<=c[i-j].high||p<=c[i+j].high):(p>=c[i-j].low||p>=c[i+j].low))ok=false;if(ok)o.push({index:i,price:p})}return o}
function zoneState(c:Candle[],dir:"LONG"|"SHORT",p:number,a:number,e21:number){if(!a)return null;const z:{type:string;price:number;distance:number}[]=[];const sw=swingsState(c,dir==="SHORT"),n=sw.length;if(n>=2){const pts=sw.slice(-5),sx=pts.reduce((s,x)=>s+x.index,0),sy=pts.reduce((s,x)=>s+x.price,0),sxy=pts.reduce((s,x)=>s+x.index*x.price,0),sx2=pts.reduce((s,x)=>s+x.index*x.index,0),den=pts.length*sx2-sx*sx;if(den){const slope=(pts.length*sxy-sx*sy)/den,intercept=(sy-slope*sx)/pts.length,lp=slope*(c.length-1)+intercept;if((dir==="LONG"&&slope>0)||(dir==="SHORT"&&slope<0))if(Math.abs(p-lp)<=a)z.push({type:"trendline",price:lp,distance:Math.abs(p-lp)})}}if(Math.abs(p-e21)<=a)z.push({type:"EMA21",price:e21,distance:Math.abs(p-e21)});const s=[...sw].reverse().find(x=>Math.abs(p-x.price)<=a);if(s)z.push({type:dir==="LONG"?"swing low":"swing high",price:s.price,distance:Math.abs(p-s.price)});z.sort((x,y)=>x.distance-y.distance);return z[0]??null}
function stochState(a:number[]){const rs:number[]=[];if(a.length<=14)return{k:50,d:50,pk:50,pd:50};let g=0,l=0;for(let i=1;i<=14;i++){const x=a[i]-a[i-1];if(x>=0)g+=x;else l-=x}let ag=g/14,al=l/14;rs.push(al===0?100:100-100/(1+ag/al));for(let i=15;i<a.length;i++){const x=a[i]-a[i-1];ag=(ag*13+Math.max(x,0))/14;al=(al*13+Math.max(-x,0))/14;rs.push(al===0?100:100-100/(1+ag/al))}const raw:number[]=[];for(let i=13;i<rs.length;i++){const w=rs.slice(i-13,i+1),lo=Math.min(...w),hi=Math.max(...w);raw.push(hi===lo?50:(rs[i]-lo)/(hi-lo)*100)}const k:number[]=[],d:number[]=[];for(let i=2;i<raw.length;i++)k.push(raw.slice(i-2,i+1).reduce((x,y)=>x+y,0)/3);for(let i=2;i<k.length;i++)d.push(k.slice(i-2,i+1).reduce((x,y)=>x+y,0)/3);return{k:k.at(-1)??50,d:d.at(-1)??50,pk:k.at(-2)??50,pd:d.at(-2)??50}}
function exhaustionState(dir:"LONG"|"SHORT",k:number,rsi:number,p:number,e21:number){if(dir==="LONG"&&k>=95)return"K "+roundState(k)+" > 95";if(dir==="SHORT"&&k<=5)return"K "+roundState(k)+" < 5";if(dir==="LONG"&&rsi>=78)return"RSI "+roundState(rsi)+" > 78";if(dir==="SHORT"&&rsi<=22)return"RSI "+roundState(rsi)+" < 22";if(dir==="LONG"&&p>e21*1.03)return"price >3% above EMA21";if(dir==="SHORT"&&p<e21*.97)return"price >3% below EMA21";return null}

export function narratePairState(pair:string,market:any,candles4h:Candle[],signal:Signal|undefined,candles15m:Candle[]=[]):string{
  const oneD=directionFromDaily(market?.dailyDirection);
  const fourHLabel=String(market?.fourH513?.label||"—");
  const c=[...candles4h].sort((a,b)=>a.timestamp-b.timestamp),c15=[...candles15m].sort((a,b)=>a.timestamp-b.timestamp);
  if(!c.length || !c15.length) return "[JARVIS STATE] "+pair+" — Status unavailable.";
  if(oneD==="NEUTRAL")return "[JARVIS STATE] "+pair+" — Quiet. The daily trend has no clear direction because the 8/21 EMA spread is under 0.5%. Waiting for the daily trend to establish itself. Nothing to do yet.";
  const dir=oneD==="BULL"?"LONG":"SHORT",p=Number(market?.price||c.at(-1)?.close||0);
  const q=c.map(x=>x.close),q15=c15.map(x=>x.close),e8=emaState(q,8).at(-1)??0,e21=emaState(q,21).at(-1)??0,a=atrState(c),st=stochState(q),st15=stochState(q15),d=market?.stochK!=null?Number(market.stochK):st.k,dd=market?.stochD!=null?Number(market.stochD):st.d;
  const zone=zoneState(c,dir,p,a,e21),distAtr=zone&&a?zone.distance/a:Infinity,zoneStateName=distAtr<=1?"in zone":distAtr<=2?"approaching zone":"far from zone";
  const dCandles=dailyState(c),de8=emaState(dCandles.map(x=>x.close),8).at(-1)??0,de21=emaState(dCandles.map(x=>x.close),21).at(-1)??0,dailySpread=Math.abs(de8-de21)/Math.max(p,1e-12)*100;
  const directionPass=oneD!=="NEUTRAL",zonePass=!!zone&&distAtr<=2;
  const fired=!!signal;
  const trigger=dir==="LONG"?st15.pk<=st15.pd&&st15.k>st15.d&&st15.k<20:st15.pk>=st15.pd&&st15.k<st15.d&&st15.k>80;
  const wrongSide=dir==="LONG"?st15.k>=20&&st15.k>st15.d:st15.k<=80&&st15.k<st15.d;
  const ex4=exhaustionState(dir,st.k,Number(market?.rsi??50),p,e21),ex15=dir==="LONG"?(st15.k>=95?"K "+roundState(st15.k)+" > 95":null):(st15.k<=5?"K "+roundState(st15.k)+" < 5":null),ex=ex4??ex15;
  let rrEligible=false;
  if(signal)rrEligible=signal.rr>=1.5;
  else if(zone){const c15Closed=c15.slice(-20),lows15=swingsState(c15Closed,false),highs15=swingsState(c15Closed,true),sl15=lows15.at(-1)?.price??Math.min(...c15Closed.map(x=>x.low)),sh15=highs15.at(-1)?.price??Math.max(...c15Closed.map(x=>x.high)),a15=atrState(c15),stop=dir==="LONG"?sl15-.5*a15:sh15+.5*a15,tp1=dir==="LONG"?p*1.05:p*.95,risk=dir==="LONG"?p-stop:stop-p;rrEligible=risk>0&&((dir==="LONG"?tp1-p:p-tp1)/risk)>=1.5}
  const missing:string[]=[];
  if(!directionPass)missing.push("direction");
  if(!zonePass)missing.push("zone");
  if(!trigger)missing.push(wrongSide?"trigger_side":"trigger");
  if(ex)missing.push("exhaustion ("+ex+")");
  if(!rrEligible)missing.push("rr");
  let verdict:"QUIET"|"WATCHING"|"NEAR"|"BLOCKED"|"FIRED"="QUIET";
  if(fired)verdict="FIRED";else if(ex||(!rrEligible&&zonePass&&trigger))verdict="BLOCKED";else if(directionPass&&zonePass&&trigger&&!ex&&rrEligible)verdict="NEAR";else if(directionPass&&zoneStateName!=="far from zone")verdict="WATCHING";
  let watching="—";const first=missing[0];
  if(first==="direction")watching="1D spread > 0.5% (currently "+dailySpread.toFixed(1)+"%)";
  else if(first==="zone")watching=zone?"pullback to "+roundState(zone.price)+" ("+zone.type+")":"price to a valid 4H zone within 2 ATR";
  else if(first==="trigger")watching=dir==="LONG"?"15M Stoch K to cross above D and stay < 20":"15M Stoch K to cross below D and stay > 80";
  else if(first==="trigger_side")watching=dir==="LONG"?"15M Stoch K below 20 (currently "+roundState(st15.k)+")":"15M Stoch K above 80 (currently "+roundState(st15.k)+")";
  else if(first?.startsWith("exhaustion"))watching="exhaustion clear (currently K "+roundState(st.k)+")";
  else if(first==="rr")watching="4H setup stop to improve TP1 RR above 1.5";
  const zoneText=zone
    ? (zoneStateName==="in zone"?"Price is at the zone":zoneStateName==="approaching zone"?"Price is approaching the zone":"Price is well away from the zone")+
      (zone.type==="EMA21"?(p>=zone.price?", just above the 4H EMA21":", just below the 4H EMA21"):zone.type==="swing low"?", near the swing-low support":zone.type==="swing high"?", near the swing-high resistance":"")+
      (zoneStateName==="far from zone"?", about "+roundState(Math.abs(p-zone.price)/Math.max(p,1e-12)*100,1)+"% away":"")
    : "Price is away from a valid 4H support or resistance zone";
  const fourHText=oneD==="BULL"
    ? (fourHLabel.includes("CROSS")?"4H has crossed up":fourHLabel.includes("TURNING")?"4H is turning up":fourHLabel.includes("LOW")?"4H has turned up":"4H is bullish")
    : (fourHLabel.includes("CROSS")?"4H has crossed down":fourHLabel.includes("TURNING")?"4H is turning down":fourHLabel.includes("LOW")?"4H has turned down":"4H is bearish");
  const directionText="1D "+(oneD==="BULL"?"bullish":"bearish")+", "+fourHText+".";
  const stochText=()=>{
    const value=Math.round(st15.k);
    if(ex)return "Stoch is at "+value+" and momentum is stretched beyond the entry limit.";
    if(first==="trigger")return dir==="LONG"
      ?"Stoch is at "+value+" on the 15M and needs to cross up while still below 20."
      :"Stoch is at "+value+" on the 15M and needs to cross down while still above 80.";
    if(first==="trigger_side")return dir==="LONG"
      ?"Stoch is at "+value+" on the 15M and needs to pull back below 20 before a long can fire."
      :"Stoch is at "+value+" on the 15M and needs to rise above 80 before a short can fire.";
    if(first==="rr")return "The setup is visible, but the risk-reward is too tight for the required 1.5 minimum.";
    if(first==="zone")return "Waiting for price to return to a valid 4H support or resistance zone.";
    return "The entry conditions are aligned.";
  };
  const opening=verdict==="FIRED"?"Fired.":verdict==="BLOCKED"?"Blocked.":verdict==="NEAR"?"Near.":verdict==="WATCHING"?"Watching.":"Quiet.";
  let body="";
  if(verdict==="FIRED"&&signal){
    body=" "+signal.direction+" at "+signal.entry.toFixed(2)+", stop "+signal.stop.toFixed(2)+", TP1 "+signal.tp1.toFixed(2)+", TP2 "+signal.tp2.toFixed(2)+". Setup: "+directionText+" "+(signal.direction==="LONG"?"Stoch crossed up.":"Stoch crossed down.");
  }else if(verdict==="BLOCKED"){
    body=" "+directionText+" "+zoneText+". "+stochText()+" No entry while this condition blocks the setup.";
  }else if(verdict==="NEAR"){
    body=" "+directionText+" "+zoneText+". "+stochText()+" The setup is close; wait for the confirming 4H close.";
  }else if(verdict==="WATCHING"){
    body=" "+directionText+" "+zoneText+". "+stochText()+" Not yet.";
  }else{
    body=" "+directionText+" "+zoneText+". "+stochText()+" Nothing to do until the next condition is met.";
  }
  return "[JARVIS STATE] "+pair+" — "+opening+body;
}
