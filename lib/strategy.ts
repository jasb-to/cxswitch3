export interface Candle { timestamp:number; open:number; high:number; low:number; close:number; volume:number }
export interface Signal {
  id:string; pair:string; direction:"LONG"|"SHORT"; type:"ENTRY_1"|"ENTRY_2"|"REVERSAL_SHORT"|"REVERSAL_LONG"; signalClass:"TREND"|"REVERSAL"; sizeMultiplier:1|0.5;
  entry:number; stop:number; tp1:number; tp2:number; rr:number;
  adx:number; rsi:number; stochK:number; stochD:number; expectedMove:number;
  reason:string; timestamp:number; version:number; context?:any;
}
export interface BreakoutRecord { direction:Direction; price:number; timestamp:number; candleIndex:number }
export interface SignalResult { signal?:Signal; market?:any; debug:string[]; breakoutRecord?:BreakoutRecord }
import { get4HEmaDiagnostic } from "./ema-diagnostic";

export const CURRENT_SIGNAL_VERSION=39;
type Direction="LONG"|"SHORT";
const MIN_RR=1.35, TTL=24*60*60*1000, EPS=1e-12;
const r=(n:number,d=2)=>{const m=10**d;return Math.round(n*m)/m};
const priceRound=(n:number)=>{if(!Number.isFinite(n))return n;const d=Math.abs(n)>=1000?0:Math.abs(n)>=1?2:Math.abs(n)>=0.1?3:5;return r(n,d)};
function ema(a:number[],p:number){if(!a.length)return[];const k=2/(p+1),o=[a[0]];for(let i=1;i<a.length;i++)o.push(a[i]*k+o[i-1]*(1-k));return o}
function rsiSeries(a:number[],p=14){if(a.length<=p)return[];let g=0,l=0;for(let i=1;i<=p;i++){const x=a[i]-a[i-1];if(x>=0)g+=x;else l-=x}let ag=g/p,al=l/p,o=[al===0?100:100-100/(1+ag/al)];for(let i=p+1;i<a.length;i++){const x=a[i]-a[i-1];ag=(ag*(p-1)+Math.max(x,0))/p;al=(al*(p-1)+Math.max(-x,0))/p;o.push(al===0?100:100-100/(1+ag/al))}return o}
function rsi(a:number[]){const x=rsiSeries(a);return x.at(-1)??50}
function stoch(a:number[]){const rv=rsiSeries(a),raw:number[]=[],k:number[]=[],d:number[]=[];for(let i=13;i<rv.length;i++){const w=rv.slice(i-13,i+1),lo=Math.min(...w),hi=Math.max(...w);raw.push(hi===lo?50:(rv[i]-lo)/(hi-lo)*100)}for(let i=2;i<raw.length;i++)k.push(raw.slice(i-2,i+1).reduce((x,y)=>x+y,0)/3);for(let i=2;i<k.length;i++)d.push(k.slice(i-2,i+1).reduce((x,y)=>x+y,0)/3);return{k:r(k.at(-1)??50,1),d:r(d.at(-1)??50,1),pk:r(k.at(-2)??50,1),pd:r(d.at(-2)??50,1)}}
function atr(c:Candle[],p=14){if(c.length<2)return 0;const v:number[]=[];for(let i=Math.max(1,c.length-p);i<c.length;i++){const x=c[i],q=c[i-1];v.push(Math.max(x.high-x.low,Math.abs(x.high-q.close),Math.abs(x.low-q.close)))}return v.reduce((a,b)=>a+b,0)/v.length}
function adx(c:Candle[],p=14){if(c.length<p+2)return 0;const tr:number[]=[],pl:number[]=[],mi:number[]=[];for(let i=1;i<c.length;i++){const x=c[i],q=c[i-1];tr.push(Math.max(x.high-x.low,Math.abs(x.high-q.close),Math.abs(x.low-q.close)));const u=x.high-q.high,d=q.low-x.low;pl.push(u>d?Math.max(u,0):0);mi.push(d>u?Math.max(d,0):0)}const sm=(a:number[])=>{if(a.length<p)return[];const o=[a.slice(0,p).reduce((x,y)=>x+y,0)/p];for(let i=p;i<a.length;i++)o.push((o.at(-1)!*(p-1)+a[i])/p);return o};const t=sm(tr),pp=sm(pl),mm=sm(mi),dx:number[]=[];for(let i=0;i<t.length;i++){const a=pp[i]/Math.max(t[i],EPS)*100,b=mm[i]/Math.max(t[i],EPS)*100;dx.push(a+b?Math.abs(a-b)/(a+b)*100:0)}if(dx.length<p)return 0;let x=dx.slice(0,p).reduce((a,b)=>a+b,0)/p;for(let i=p;i<dx.length;i++)x=(x*(p-1)+dx[i])/p;return r(x,1)}
function daily(c:Candle[]){const m=new Map<string,Candle[]>();for(const x of [...c].sort((a,b)=>a.timestamp-b.timestamp)){const z=new Date(x.timestamp),k=z.toISOString().slice(0,10),b=m.get(k)??[];b.push(x);m.set(k,b)}return[...m.values()].map(b=>({timestamp:b[0].timestamp,open:b[0].open,high:Math.max(...b.map(x=>x.high)),low:Math.min(...b.map(x=>x.low)),close:b.at(-1)!.close,volume:b.reduce((s,x)=>s+x.volume,0)}))}
interface DailyRegime {
  direction: Direction|null;
  strength: "LOW"|"MEDIUM"|"HIGH"|"STRONG"|"NEUTRAL";
  e8:number; e21:number; spread:number; spreadContracting:boolean; e8Slope:number; e21Slope:number;
}
function dailyTrend(c:Candle[]):DailyRegime{
  const d=daily(c);
  if(d.length<25)return{direction:null,strength:"NEUTRAL",e8:0,e21:0,spread:0,spreadContracting:false,e8Slope:0,e21Slope:0};
  const closes=d.map(x=>x.close),ema8=ema(closes,8),ema21=ema(closes,21);
  const e8=ema8.at(-1)!,e21=ema21.at(-1)!,e8Prev=ema8.at(-2)!,e21Prev=ema21.at(-2)!,price=closes.at(-1)!;
  const spread=Math.abs(e8-e21)/Math.max(price,EPS)*100;
  const spreadContracting=Math.abs(e8-e21)<Math.abs(e8Prev-e21Prev);
  const e8Slope=e8-e8Prev,e21Slope=e21-e21Prev;
  // Exact pasted V28 daily bias: EMA8/EMA21 chooses direction; the most recent
  // daily candle's 20-day HH/LL structure determines whether that bias is strong.
  const direction:Direction|null=e8>e21?"LONG":"SHORT";
  if(!direction)return{direction:null,strength:"NEUTRAL",e8,e21,spread,spreadContracting,e8Slope,e21Slope};
  const highs=d.slice(-20).map(x=>x.high),lows=d.slice(-20).map(x=>x.low);
  const hh=highs.at(-1)!>Math.max(...highs.slice(0,-1));
  const ll=lows.at(-1)!<Math.min(...lows.slice(0,-1));
  const strength=(direction==="LONG"&&hh)||(direction==="SHORT"&&ll)?"STRONG":"MEDIUM";
  return{direction,strength,e8,e21,spread,spreadContracting,e8Slope,e21Slope};
}
function tacticalDirection(c:Candle[]):{direction:Direction|null;turning:boolean;label:string}{
  const x=get4HEmaDiagnostic(c);
  if(x.turning)return{direction:x.spread>0?"SHORT":x.spread<0?"LONG":null,turning:true,label:x.label};
  if(x.stage.includes("BEARISH"))return{direction:"SHORT",turning:false,label:x.label};
  if(x.stage.includes("BULLISH"))return{direction:"LONG",turning:false,label:x.label};
  return{direction:null,turning:false,label:x.label};
}
interface Swing{index:number;price:number;timestamp:number}
function swings(c:Candle[],high:boolean){const o:Swing[]=[];for(let i=2;i<c.length-2;i++){const p=high?c[i].high:c[i].low;let ok=true;for(let j=1;j<=2;j++)if(high?(p<=c[i-j].high||p<=c[i+j].high):(p>=c[i-j].low||p>=c[i+j].low))ok=false;if(ok)o.push({index:i,price:p,timestamp:c[i].timestamp})}return o}
function trendlinePivots(c:Candle[],high:boolean):Swing[]{
  const out:Swing[]=[];
  for(let i=3;i<c.length-3;i++){
    const p=high?c[i].high:c[i].low;
    const pivot=high
      ? p>c[i-1].high&&p>c[i-2].high&&p>c[i+1].high&&p>c[i+2].high
      : p<c[i-1].low&&p<c[i-2].low&&p<c[i+1].low&&p<c[i+2].low;
    if(pivot)out.push({index:i,price:p,timestamp:c[i].timestamp});
  }
  return out;
}
export interface TrendlineState {
  slope:number;
  intercept:number;
  pivots:Swing[];
  lastUpdated:number;
  direction:Direction;
  r2:number;
  anchors:[Swing,Swing];
  middleTouch:Swing;
  touchCount:number;
  wickBreaches:number;
  closeBreaches:number;
  score:number;
}
interface TrendlineCandidate extends TrendlineState {}
const TRENDLINE_LOOKBACK_BARS=180;
const TRENDLINE_MAX_LATEST_ANCHOR_AGE=60;
const TRENDLINE_MIN_ANCHOR_GAP=8;
function lineAt(slope:number,intercept:number,index:number){return slope*index+intercept}
function trendlineCandidateScore(
  candles:Candle[],a:Swing,b:Swing,high:boolean,atrNow:number
):TrendlineCandidate|null{
  const span=b.index-a.index;
  if(span<TRENDLINE_MIN_ANCHOR_GAP)return null;
  const slope=(b.price-a.price)/span;
  // Draw the line against the current move: bearish-break setups use rising
  // support (swing lows); bullish-break setups use falling resistance (swing highs).
  // A flat or wrong-way line is not the structure this strategy is trying to break.
  if((high&&slope>=0)||(!high&&slope<=0))return null;
  const intercept=a.price-slope*a.index;
  const currentPrice=candles.at(-1)?.close??b.price;
  const tolerance=Math.max(atrNow*0.28,currentPrice*0.0012);
  const wickBreachTolerance=Math.max(atrNow*0.65,currentPrice*0.0025);
  const closeBreachTolerance=Math.max(atrNow*0.35,currentPrice*0.0015);
  const touches:Swing[]=[];
  let wickBreaches=0,closeBreaches=0,bodyIntersections=0;
  for(let i=a.index;i<candles.length;i++){
    const candle=candles[i],line=lineAt(slope,intercept,i);
    const edge=high?candle.high:candle.low;
    const gap=high?edge-line:line-edge;
    if(Math.abs(gap)<=tolerance)touches.push({index:i,price:edge,timestamp:candle.timestamp});
    if(gap>wickBreachTolerance)wickBreaches++;
    const closeGap=high?candle.close-line:line-candle.close;
    if(closeGap>closeBreachTolerance)closeBreaches++;
    const bodyEdge=high?Math.max(candle.open,candle.close):Math.min(candle.open,candle.close);
    const bodyGap=high?bodyEdge-line:line-bodyEdge;
    if(bodyGap>closeBreachTolerance)bodyIntersections++;
  }
  // A human-drawn line should have a real reaction between its two anchors.
  const middleTouches=touches.filter(t=>t.index>a.index+1&&t.index<b.index-1);
  if(!middleTouches.length)return null;
  // Keep small wick noise, but reject a line that price repeatedly traded through.
  if(wickBreaches>Math.max(2,Math.floor(span*0.035)))return null;
  if(closeBreaches>Math.max(1,Math.floor(span*0.015)))return null;
  // Require three separated reactions; adjacent candles around one swing count once.
  const distinctTouches:Swing[]=[];
  for(const touch of touches){
    const last=distinctTouches.at(-1);
    if(!last||touch.index-last.index>=3)distinctTouches.push(touch);
    else if(Math.abs(touch.price-lineAt(slope,intercept,touch.index))<
      Math.abs(last.price-lineAt(slope,intercept,last.index)))distinctTouches[distinctTouches.length-1]=touch;
  }
  if(distinctTouches.length<3)return null;
  const pivotList=trendlinePivots(candles,high).filter(p=>p.index>=a.index&&p.index<=candles.length-1);
  const pivotTouches=pivotList.filter(p=>Math.abs(p.price-lineAt(slope,intercept,p.index))<=tolerance);
  const latestAge=candles.length-1-b.index;
  const recencyScore=Math.max(0,12-latestAge/5);
  const spanScore=Math.min(10,Math.log2(span+1)*1.5);
  const score=distinctTouches.length*10+pivotTouches.length*5+middleTouches.length*4+
    recencyScore+spanScore-wickBreaches*12-closeBreaches*24-bodyIntersections*1.5;
  return {
    slope,intercept,pivots:distinctTouches,lastUpdated:candles.at(-1)!.timestamp,
    direction:high?"SHORT":"LONG",r2:0,anchors:[a,b],middleTouch:middleTouches
      .sort((x,y)=>Math.abs(x.price-lineAt(slope,intercept,x.index))-Math.abs(y.price-lineAt(slope,intercept,y.index)))[0],
    touchCount:distinctTouches.length,wickBreaches,closeBreaches,score
  };
}
export function getTrendline(pair:string,candles:Candle[],direction:Direction):TrendlineState|null{
  void pair;
  const c=[...candles].sort((a,b)=>a.timestamp-b.timestamp);
  const len=c.length,now=c.at(-1)?.timestamp;
  if(len<20||now===undefined)return null;
  // Expected break direction determines which side of price to draw:
  // LONG = falling resistance line to break upward; SHORT = rising support line to break downward.
  const high=direction==="LONG";
  const allPivots=trendlinePivots(c,high).filter(p=>p.index>=Math.max(0,len-TRENDLINE_LOOKBACK_BARS));
  if(allPivots.length<3)return null;
  const atrNow=atr(c);
  if(!Number.isFinite(atrNow)||atrNow<=0)return null;
  let best:TrendlineCandidate|null=null;
  for(let bi=1;bi<allPivots.length;bi++){
    const b=allPivots[bi];
    if(len-1-b.index>TRENDLINE_MAX_LATEST_ANCHOR_AGE)continue;
    for(let ai=0;ai<bi;ai++){
      const a=allPivots[ai];
      const candidate=trendlineCandidateScore(c,a,b,high,atrNow);
      if(candidate&&(!best||candidate.score>best.score))best=candidate;
    }
  }
  return best;
}
function structureTargets(direction:"LONG"|"SHORT",entry:number,candles:Candle[]):{tp1:number;tp2:number;tp1Source:string;tp2Source:string;tp1Pivot?:number;tp2Pivot?:number}{
  const c=[...candles].sort((a,b)=>a.timestamp-b.timestamp);
  const pivots=swings(c,direction==="LONG").slice(-12).map(x=>({price:x.price,index:x.index}));
  const above=direction==="LONG" ? pivots.filter(x=>x.price>entry) : pivots.filter(x=>x.price<entry);
  const minReward=direction==="LONG" ? entry*1.03 : entry*0.97;
  const tp1Pivot=above.find(x=>direction==="LONG" ? x.price>=minReward : x.price<=minReward);
  const tp1=tp1Pivot?.price ?? (direction==="LONG" ? entry*1.05 : entry*0.95);
  const minNext=direction==="LONG" ? tp1*1.015 : tp1*0.985;
  const tp2Pivot=above.find(x=>direction==="LONG" ? x.price>=minNext : x.price<=minNext);
  const fallbackTp2=direction==="LONG" ? Math.max(entry*1.10,tp1*1.05) : Math.min(entry*0.90,tp1*0.95);
  const tp2=tp2Pivot?.price ?? fallbackTp2;
  return {tp1,tp2,tp1Source:tp1Pivot?"4H swing pivot":"5% fallback",tp2Source:tp2Pivot?"next 4H swing pivot":"10%/runner fallback",tp1Pivot:tp1Pivot?.price,tp2Pivot:tp2Pivot?.price};
}
function exhaust(dir:Direction,k:number,rv:number,p:number,e21:number,label="4H"){if(dir==="LONG"&&k>=95)return`LONG blocked: ${label} Stoch K ${r(k,1)} >= 95`;if(dir==="SHORT"&&k<=5)return`SHORT blocked: ${label} Stoch K ${r(k,1)} <= 5`;if(dir==="LONG"&&rv>=78)return`LONG blocked: 4H RSI ${r(rv,1)} >= 78`;if(dir==="SHORT"&&rv<=22)return`SHORT blocked: 4H RSI ${r(rv,1)} <= 22`;if(dir==="LONG"&&p>e21*1.03)return"LONG blocked: 4H close is more than 3% above 4H EMA(21)";if(dir==="SHORT"&&p<e21*.97)return"SHORT blocked: 4H close is more than 3% below 4H EMA(21)";return null}
export interface GateEvaluation {
  direction: "LONG" | "SHORT" | null;
  zone: { valid: boolean; type: string; price: number; distancePct: number } | null;
  trendlineSlope: number;
  trigger: { entry1: boolean; entry2: boolean; signalType: "ENTRY_1" | "ENTRY_2" | null };
  exhaustion: string | null;
  rr: number | null;
  stopCalc: StopCalc | null;
  missing: string[];
  allPassed: boolean;
  dailyTransition: boolean;
  emaAdvisory: string[];
  breakoutRecord?: BreakoutRecord;
}

export interface StopCalc {
  structuralAnchor: number;
  atrMultiplier: number;
  riskPct: number;
  liquidationBufferPct: number;
  liquidationPrice: number;
  marginUsagePct: number;
}

const MAX_LEVERAGE = 20;
const MAINTENANCE_MARGIN_RATE = 0.01;
const MIN_LIQUIDATION_BUFFER_PCT = 0.5;

export function calculateStop(
  direction:"LONG"|"SHORT", entry:number, trendlinePrice:number, atrValue:number, candles:Candle[]
): { stop:number; calc:StopCalc; valid:boolean; invalidReason?:string } {
  if(!Number.isFinite(entry)||entry<=0||!Number.isFinite(atrValue)||atrValue<=0)
    return {stop:0,calc:{structuralAnchor:0,atrMultiplier:0,riskPct:Infinity,liquidationBufferPct:-Infinity,liquidationPrice:0,marginUsagePct:Infinity},valid:false,invalidReason:"stop_inputs"};
  const c=[...candles].sort((a,b)=>a.timestamp-b.timestamp);
  const recentSwing=swings(c,direction==="SHORT").at(-1);
  const atrStop=direction==="LONG"?entry-1.5*atrValue:entry+1.5*atrValue;
  const structuralAnchor=recentSwing?.price ?? (direction==="LONG"?trendlinePrice-1.5*atrValue:trendlinePrice+1.5*atrValue);
  const stop=direction==="LONG"?Math.min(structuralAnchor,atrStop):Math.max(structuralAnchor,atrStop);
  const riskPct=Math.abs(entry-stop)/Math.max(entry,EPS)*100;
  const atrMultiplier=Math.abs(entry-stop)/Math.max(atrValue,EPS);
  const liquidationPrice=direction==="LONG"?entry*(1-1/MAX_LEVERAGE+MAINTENANCE_MARGIN_RATE):entry*(1+1/MAX_LEVERAGE-MAINTENANCE_MARGIN_RATE);
  const liquidationBufferPct=direction==="LONG"?(stop-liquidationPrice)/Math.max(liquidationPrice,EPS)*100:(liquidationPrice-stop)/Math.max(liquidationPrice,EPS)*100;
  const valid=liquidationBufferPct>=MIN_LIQUIDATION_BUFFER_PCT;
  return {stop,calc:{structuralAnchor:r(structuralAnchor),atrMultiplier:r(atrMultiplier,2),riskPct:r(riskPct,2),liquidationBufferPct:r(liquidationBufferPct,2),liquidationPrice:r(liquidationPrice),marginUsagePct:r(riskPct*MAX_LEVERAGE,1)},valid,invalidReason:valid?undefined:"stop_too_close_to_modelled_liquidation"};
}
function fixedStopCalc(direction:"LONG"|"SHORT",entry:number,stop:number,atrValue:number,structuralAnchor:number):StopCalc{
  const riskPct=Math.abs(entry-stop)/Math.max(entry,EPS)*100;
  const atrMultiplier=Math.abs(entry-stop)/Math.max(atrValue,EPS);
  const liquidationPrice=direction==="LONG"
    ? entry*(1-1/MAX_LEVERAGE+MAINTENANCE_MARGIN_RATE)
    : entry*(1+1/MAX_LEVERAGE-MAINTENANCE_MARGIN_RATE);
  const liquidationBufferPct=direction==="LONG"
    ? (stop-liquidationPrice)/Math.max(liquidationPrice,EPS)*100
    : (liquidationPrice-stop)/Math.max(liquidationPrice,EPS)*100;
  return {
    structuralAnchor:r(structuralAnchor),
    atrMultiplier:r(atrMultiplier,2),
    riskPct:r(riskPct,2),
    liquidationBufferPct:r(liquidationBufferPct,2),
    liquidationPrice:r(liquidationPrice),
    marginUsagePct:r(riskPct*MAX_LEVERAGE,1)
  };
}

export function evaluateGates(pair:string,candles4h:Candle[],currentPrice:number,lastBreakout?:BreakoutRecord):GateEvaluation{
  void lastBreakout;
  const c=[...candles4h].sort((a,b)=>a.timestamp-b.timestamp);
  const p=currentPrice??c.at(-1)?.close??0;
  const d=dailyTrend(c);
  // V28 hierarchy: the 1D trend owns direction. The 4H is timing/structure only.
  // During a 1D transition we deliberately watch rather than flip direction early.
  const dailyTransition = d.direction && d.strength === "LOW" && d.spreadContracting;
  // V28: daily EMA 8/21 chooses direction. Weakening/contracting spread is
  // diagnostic context only; it must not delay an otherwise valid entry.
  const direction=d.direction;
  const missing:string[]=[];
  if(!direction)missing.push("direction");

  const a=atr(c);
  const e21=ema(c.map(x=>x.close),21).at(-1)??0;
  const tl=direction?getTrendline(pair,c,direction):null;
  const trendlineSlope=tl?.slope??0;
  const linePrice=tl?tl.slope*(c.length-1)+tl.intercept:0;
  const zoneValue=tl?{type:direction==="LONG"?"TRENDLINE_RESISTANCE":"TRENDLINE_SUPPORT",price:linePrice,distance:Math.abs(p-linePrice),distancePct:Math.abs(p-linePrice)/Math.max(p,EPS)*100}:null;
  if(!zoneValue)missing.push("zone");

  const st4=stoch(c.map(x=>x.close));
  // Pasted V28 entry geometry: within 1.2% of the trendline is "near".
  // Do not add the newer ATR/price proximity gate on top of this threshold.
  const near=!!zoneValue && Math.abs(p-linePrice)/Math.max(Math.abs(linePrice),EPS)<0.012;
  const breakoutRecord:BreakoutRecord|undefined=undefined;

  const extreme=!!direction&&(direction==="LONG"?st4.k<20:st4.k>80);
  const turn=!!direction&&(direction==="LONG"?st4.k>st4.d:st4.k<st4.d);
  // ENTRY_1: trendline proximity + directional extreme StochRSI.
  const entry1=!!direction&&near&&extreme;
  // ENTRY_2: trendline proximity + StochRSI turning with the daily bias,
  // provided it is not already at the extreme. No breakout/retest lifecycle.
  const entry2=!!direction&&near&&turn&&!extreme;
  let signalType:"ENTRY_1"|"ENTRY_2"|null=entry1?"ENTRY_1":entry2?"ENTRY_2":null;
  if(!signalType&&direction)missing.push("stoch_turn_or_extreme");

  // Exact pasted V28 behavior: 4H EMA is advisory context, not an entry veto.
  const ema4h=get4HEmaDiagnostic(c);
  const emaAdvisory:string[]=[];
  if(signalType && direction==="SHORT" && !ema4h.stage.includes("BEARISH"))emaAdvisory.push("4h_ema_not_bearish");
  if(signalType==="ENTRY_2" && direction==="LONG" && ema4h.stage.includes("BEARISH"))emaAdvisory.push("4h_ema_bearish");

  const rv=rsi(c.map(x=>x.close));
  const exhaustion=direction?exhaust(direction,st4.k,rv,p,e21,"4H"):null;
  if(exhaustion)missing.push("exhaustion");

  let rr:number|null=null;
  let stopCalc:StopCalc|null=null;
  if(direction&&tl&&a>0){
    const stopResult=calculateStop(direction,p,linePrice,a,c);
    stopCalc=stopResult.calc;
    // Preserve V28 eligibility: liquidation-buffer diagnostics are informational,
    // not an additional entry gate. Telegram must warn clearly when unsafe.
    const risk=direction==="LONG"?p-stopResult.stop:stopResult.stop-p;
    const targets=structureTargets(direction,p,c);
    rr=Math.abs(targets.tp2-p)/Math.max(risk,EPS);
    // R:R is informational only and is calculated from the actual TP2 target.
  }

  const deduped=[...new Set(missing.filter(Boolean))];
  return{
    direction,
    zone:zoneValue?{valid:true,type:zoneValue.type,price:zoneValue.price,distancePct:zoneValue.distancePct}:null,
    trendlineSlope,
    trigger:{entry1,entry2,signalType},
    exhaustion,
    rr,
    stopCalc,
    missing:deduped,
    allPassed:deduped.length===0,
    dailyTransition:!!dailyTransition,
    emaAdvisory,
    breakoutRecord: breakoutRecord
  };
}
export function getTrendlineDebug(pair:string,candles:Candle[],direction:"LONG"|"SHORT"){
  const c=[...candles].sort((a,b)=>a.timestamp-b.timestamp);
  const state=getTrendline(pair,c,direction);
  // Research both geometries independently of the daily bias. A rising move
  // should be tested against rising support (potential downside break); a
  // falling move against falling resistance (potential upside break).
  // The direction argument is the prevailing move: LONG selects rising
  // swing-low support; SHORT selects falling swing-high resistance.
  const support=getTrendline(pair,c,"LONG");
  const resistance=getTrendline(pair,c,"SHORT");
  const pack=(line:TrendlineState|null)=>line?({
    anchors:line.anchors.map(x=>({i:x.index,p:x.price,t:x.timestamp})),
    middleTouch:{i:line.middleTouch.index,p:line.middleTouch.price,t:line.middleTouch.timestamp},
    touchCount:line.touchCount,wickBreaches:line.wickBreaches,
    closeBreaches:line.closeBreaches,score:line.score,
    slope:line.slope,priceAtCurrent:line.slope*(c.length-1)+line.intercept
  }):null;
  const recent=c.slice(-12);
  const first=recent[0]?.close??0,last=recent.at(-1)?.close??0;
  const localMovePct=first?((last-first)/first)*100:0;
  const priceAtCurrent=state?state.slope*(c.length-1)+state.intercept:null;
  return {
    pair,
    direction,
    localMovePct,
    expectedBreakLine:localMovePct>=0?"RISING_SUPPORT_BREAKDOWN":"FALLING_RESISTANCE_BREAKOUT",
    selected:pack(state),
    risingSupport:pack(support),
    fallingResistance:pack(resistance),
    pivots:state?.pivots.map(x=>({i:x.index,p:x.price,t:x.timestamp}))??[],
    anchors:state?.anchors.map(x=>({i:x.index,p:x.price,t:x.timestamp}))??null,
    middleTouch:state?{i:state.middleTouch.index,p:state.middleTouch.price,t:state.middleTouch.timestamp}:null,
    touchCount:state?.touchCount??0,
    wickBreaches:state?.wickBreaches??null,
    closeBreaches:state?.closeBreaches??null,
    score:state?.score??null,
    slope:state?.slope??null,
    intercept:state?.intercept??null,
    priceAtCurrent
  };
}

export function generateSignal(pair:string,candles1h:Candle[],candles4h:Candle[],candles15m:Candle[],currentPrice?:number,nowOverride?:number,lastBreakout?:BreakoutRecord){
  void candles1h;
  const debug:string[]=[];
  const c=[...candles4h].sort((a,b)=>a.timestamp-b.timestamp);
  const p=currentPrice??c.at(-1)?.close??0,now=nowOverride??Date.now();
  if(daily(c).length<25){
    debug.push("[1D] NEUTRAL | fewer than 25 daily candles");
    debug.push("[ZONE] none in range");
    debug.push("[TRIGGER] unavailable | fired=false");
    debug.push("[EXHAUST] clear"); debug.push("[SIGNAL] none"); debug.push("[JARVIS] not evaluated"); debug.push("[ALERT] none");
    return{debug};
  }

  const d=dailyTrend(c),dailyCloses=daily(c).map(x=>x.close),e5_1d=ema(dailyCloses,5).at(-1)??0,e13_1d=ema(dailyCloses,13).at(-1)??0,cl=c.map(x=>x.close),e8=ema(cl,8).at(-1)!,e21=ema(cl,21).at(-1)!,rv=rsi(cl),st4=stoch(cl),a=atr(c),av=adx(c);
  const tactical=tacticalDirection(c);
  const evaluation=evaluateGates(pair,c,p,lastBreakout);
  debug.push(`[GATES] ${JSON.stringify(evaluation)}`);
  // Hard V28 direction lock: no signal may ever differ from the confirmed 1D direction.
  if(evaluation.direction && evaluation.direction!==d.direction){
    debug.push(`[LOCK] V28 direction mismatch blocked: gate=${evaluation.direction} 1D=${d.direction??"NEUTRAL"}`);
    debug.push("[SIGNAL] none — V28 direction lock");
    return{market:getMarketSnapshot(pair,candles1h,candles4h,candles15m),debug,breakoutRecord:evaluation.breakoutRecord};
  }
  debug.push(`[1D] ${d.direction??"NEUTRAL"} ${d.strength} | EMA8 ${r(d.e8)} | EMA21 ${r(d.e21)} | spread ${d.spread.toFixed(2)}%`);
  debug.push(`[4H CONTEXT] ${tactical.direction??"NEUTRAL"} | ${tactical.label} | 1D owns direction: ${d.direction??"NEUTRAL"} ${d.strength}`);

  if(!evaluation.direction){
    debug.push(d.direction
      ? (d.strength==="LOW"&&d.spreadContracting
        ? `[1D TRANSITION] ${d.direction==="LONG"?"BULLISH":"BEARISH"} weakening/turning | WATCH — no new direction until the 1D transition confirms`
        : `[DIRECTION] V28 1D ${d.direction} | 4H is timing/context only`)
      : "[1D] NEUTRAL | insufficient daily history or EMA8/EMA21 equal");
    debug.push("[ZONE] none in range"); debug.push("[TRIGGER] 4H Stoch/Trendline unavailable | fired=false");
    debug.push("[EXHAUST] clear"); debug.push("[SIGNAL] none"); debug.push("[JARVIS] not evaluated"); debug.push("[ALERT] none");
    return{market:getMarketSnapshot(pair,candles1h,candles4h,candles15m),debug,breakoutRecord:evaluation.breakoutRecord};
  }

  const trendlinePrice=evaluation.zone?.price??0;
  const trendlineDistancePct=evaluation.zone?.distancePct??Infinity;
  const trendlineType=evaluation.zone?.type??(evaluation.direction==="LONG"?"TRENDLINE_SUPPORT":"TRENDLINE_RESISTANCE");
  const zoneDistanceAtr=evaluation.zone&&a?Math.abs(p-trendlinePrice)/a:Infinity;
  debug.push(evaluation.zone
    ? `[ZONE] ${trendlineType} @ ${r(trendlinePrice)} | distance ${trendlineDistancePct.toFixed(2)}% | ${zoneDistanceAtr.toFixed(2)} ATR`
    : "[ZONE] none | validated 4H trendline unavailable");
  debug.push(`[TRIGGER] 4H Stoch K ${st4.k.toFixed(1)} / D ${st4.d.toFixed(1)} | ${trendlineType} distance ${Number.isFinite(trendlineDistancePct)?trendlineDistancePct.toFixed(2):"—"}% | ENTRY_1=${evaluation.trigger.entry1} ENTRY_2=${evaluation.trigger.entry2}`);
  const swingDebug=evaluation.direction?getTrendlineDebug(pair,c,evaluation.direction):null;
  if(swingDebug){
    debug.push(`[SWINGS] ${pair} | ${evaluation.direction==="LONG"?"lows":"highs"}: ${JSON.stringify(swingDebug.pivots)}`);
    debug.push(`[TL] ${pair} | slope ${swingDebug.slope??"—"} | intercept ${swingDebug.intercept??"—"} | price at current index ${swingDebug.priceAtCurrent??"—"}`);
    debug.push(`[TL VALIDATION] ${pair} | localMove12 ${swingDebug.localMovePct.toFixed(2)}% | expected ${swingDebug.expectedBreakLine} | selected ${JSON.stringify(swingDebug.selected)} | risingSupport ${JSON.stringify(swingDebug.risingSupport)} | fallingResistance ${JSON.stringify(swingDebug.fallingResistance)}`);
  }
  debug.push(`[EXHAUST] ${evaluation.exhaustion??"clear"}`);

  if(!evaluation.allPassed){
    debug.push(`[REVERSAL] none — V28 waits for trendline proximity and directional Stoch timing`);
    debug.push(`[SIGNAL] none — missing ${evaluation.missing.join(", ")}`);
    debug.push("[JARVIS] observation only — no trade");
    debug.push("[ALERT] none");
    return{market:getMarketSnapshot(pair,candles1h,candles4h,candles15m),debug,breakoutRecord:evaluation.breakoutRecord};
  }

  const signalType=evaluation.trigger.signalType!;
  const entryBase=p;
  debug.push(`[ENTRY] MARKET | current price ${r(entryBase)} | trendline distance ${trendlineDistancePct.toFixed(2)}%`);
  const calculatedStop=calculateStop(evaluation.direction!,entryBase,trendlinePrice,a,c);
  const stop=calculatedStop.stop;
  const targets=structureTargets(evaluation.direction!,entryBase,c);
  const risk=Math.abs(entryBase-stop);
  const actualRr=Math.abs(targets.tp2-entryBase)/Math.max(risk,EPS);
  const s:Signal={
    id:`${pair}_${signalType}_${now}`,pair,direction:evaluation.direction,type:signalType,entry:priceRound(entryBase),signalClass:"TREND",sizeMultiplier:calculatedStop.calc.liquidationBufferPct<1.5?0.5:1,
    stop:priceRound(stop),tp1:priceRound(targets.tp1),tp2:priceRound(targets.tp2),rr:r(actualRr,2),expectedMove:r(Math.abs(targets.tp2-entryBase)/Math.max(entryBase,EPS)*100),adx:r(av,1),rsi:r(rv,1),stochK:st4.k,stochD:st4.d,
    reason:`${evaluation.direction} ${signalType} | V28 trendline proximity + 4H Stoch | 4H Stoch ${st4.k}/${st4.d}`,
    timestamp:now,version:CURRENT_SIGNAL_VERSION,
    context:{zone:trendlineType,zonePrice:r(trendlinePrice),zoneDistancePct:trendlineDistancePct,zoneDistanceAtr,entryAnchor:"current price",signalClass:"TREND",sizeMultiplier:calculatedStop.calc.liquidationBufferPct<1.5?0.5:1,structuralAnchor:calculatedStop.calc.structuralAnchor,liquidationPrice:calculatedStop.calc.liquidationPrice,stopToLiquidationBufferPct:calculatedStop.calc.liquidationBufferPct,stopCalc:calculatedStop.calc,targetPlan:targets,ema8_1d:d.e8,ema21_1d:d.e21,ema5_1d:e5_1d,ema13_1d:e13_1d,ema8_4h:e8,ema21_4h:e21,stochK_4h:st4.k,stochD_4h:st4.d}
  };
  debug.push(`[STOP] ${s.direction} | SL ${s.stop} | ${s.context?.stopCalc?.riskPct ?? "—"}% risk | ${s.context?.stopCalc?.atrMultiplier ?? "—"} ATR | liq ${s.context?.stopCalc?.liquidationPrice ?? "—"} | liq buffer ${s.context?.stopCalc?.liquidationBufferPct ?? "—"}%`);
  debug.push(`[SIGNAL] ${s.direction} ${s.type} | entry ${s.entry} | trendline ${r(trendlinePrice)} | SL ${s.stop} | TP1 ${s.tp1} (${targets.tp1Source}) | TP2 ${s.tp2} (${targets.tp2Source}) | RR ${s.rr} | size ${s.sizeMultiplier===0.5?"50%":"100%"}`);
  debug.push("[JARVIS] trade conditions passed — execution remains separate from opportunity guidance");
  debug.push("[ALERT] SURFACE");
  return{signal:s,market:getMarketSnapshot(pair,candles1h,candles4h,candles15m),debug,breakoutRecord:evaluation.breakoutRecord};
}
export function shouldHold(s:Signal,c:Candle[],p:number,now?:number){
  void now;
  const x=[...c].sort((a,b)=>a.timestamp-b.timestamp);
  if((s.direction==="LONG"&&p<=s.stop)||(s.direction==="SHORT"&&p>=s.stop))
    return{shouldHold:false,reason:"stop_hit",managementState:"EXIT" as const,recommendation:"EXIT TRADE" as const};
  if((s.direction==="LONG"&&p>=s.tp2)||(s.direction==="SHORT"&&p<=s.tp2))
    return{shouldHold:false,reason:"tp2_hit",managementState:"EXIT" as const,recommendation:"EXIT TRADE" as const};

  const q=x.map(z=>z.close),d=daily(x);
  if(d.length>=22){
    const qd=d.map(z=>z.close),a5=ema(qd,5),a13=ema(qd,13);
    const dr=s.direction==="LONG"
      ? a5.at(-2)!>=a13.at(-2)!&&a5.at(-1)!<a13.at(-1)!
      : a5.at(-2)!<=a13.at(-2)!&&a5.at(-1)!>a13.at(-1)!;
    if(dr)return{shouldHold:false,reason:"1d_ema_reversal",managementState:"EXIT" as const,recommendation:"EXIT TRADE" as const};
  }

  const tp1AlreadyHit=!!(s as any).tp1HitAt;
  if(!tp1AlreadyHit&&((s.direction==="LONG"&&p>=s.tp1)||(s.direction==="SHORT"&&p<=s.tp1)))
    return{shouldHold:true,reason:"tp1_hit_scale_out",managementState:"STAY" as const,recommendation:"STAY IN TRADE" as const,newStop:s.entry,scaleOut:{level:s.tp1,size:.5,label:"TP1"}};

  if(x.length>=5){
    const a=atr(x),last5=x.slice(-5);
    const trail=s.direction==="LONG"
      ? Math.min(...last5.map(z=>z.low))-.5*a
      : Math.max(...last5.map(z=>z.high))+.5*a;
    const profitPct=s.direction==="LONG"?(p-s.entry)/s.entry:(s.entry-p)/s.entry;
    const trailImproves=s.direction==="LONG"?trail>s.stop:trail<s.stop;
    if(profitPct>=.03){
      if((s.direction==="LONG"&&p<=trail)||(s.direction==="SHORT"&&p>=trail))
        return{shouldHold:false,reason:"chandelier_trailing_stop",managementState:"EXIT" as const,recommendation:"EXIT TRADE" as const,newStop:trail};
      if(trailImproves)
        return{shouldHold:true,reason:"chandelier_stop",managementState:"STAY" as const,recommendation:"STAY IN TRADE" as const,newStop:trail};
    }
  }

  if(x.length>=3){
    const e8=ema(q,8),e21=ema(q,21);
    const cross=s.direction==="LONG"
      ? e8.at(-3)!>=e21.at(-3)!&&e8.at(-2)!<e21.at(-2)!
      : e8.at(-3)!<=e21.at(-3)!&&e8.at(-2)!>e21.at(-2)!;
    const reclaimed=s.direction==="LONG"?x.at(-1)!.close>=e8.at(-1)!:x.at(-1)!.close<=e8.at(-1)!;
    if(cross){
      if(!reclaimed)return{shouldHold:false,reason:"4h_ema_reversal_confirmed",managementState:"EXIT" as const,recommendation:"EXIT TRADE" as const};
      return{shouldHold:true,reason:"4h_reclaim_held",managementState:"STAY" as const,recommendation:"STAY IN TRADE" as const};
    }
  }

  return{shouldHold:true,reason:"thesis_intact",managementState:"STAY" as const,recommendation:"STAY IN TRADE" as const};
}
export function isSignalStillValid(s:Signal,p:number,now=Date.now()){if(now-s.timestamp>TTL)return{valid:false,reason:"expired_ttl",exited:true,state:"STALE" as const};if((s.direction==="LONG"&&p<=s.stop)||(s.direction==="SHORT"&&p>=s.stop))return{valid:false,reason:"sl_hit",exited:true,state:"INVALID" as const};if((s.direction==="LONG"&&p>=s.tp2)||(s.direction==="SHORT"&&p<=s.tp2))return{valid:false,reason:"tp2_hit",exited:true,state:"INVALID" as const};return{valid:true,reason:"active",exited:false,state:"VALID" as const}}
export function filterExpiredSignals(signals:Signal[],prices:Record<string,number>,now=Date.now()){const active:Signal[]=[],exited:{signal:Signal;reason:string}[]=[];for(const s of signals){const p=prices[s.pair];if(p===undefined){active.push(s);continue}const v=isSignalStillValid(s,p,now);v.valid?active.push(s):exited.push({signal:s,reason:v.reason})}return{active,exited}}
export type TradeStatus="ACTIVE"|"TP_HIT"|"SL_HIT"|"EXPIRED";
export function checkTradeStatus(s:Signal,p:number,now=Date.now()):TradeStatus{const v=isSignalStillValid(s,p,now);if(v.reason==="expired_ttl")return"EXPIRED";if((s.direction==="LONG"&&p<=s.stop)||(s.direction==="SHORT"&&p>=s.stop))return"SL_HIT";if((s.direction==="LONG"&&p>=s.tp2)||(s.direction==="SHORT"&&p<=s.tp2))return"TP_HIT";return"ACTIVE"}
export function getMarketSnapshot(pair:string,candles1h:Candle[],candles4h:Candle[],candles15m:Candle[]){void candles1h;void candles15m;const c=[...candles4h].sort((a,b)=>a.timestamp-b.timestamp),q=c.map(x=>x.close),dailyCandles=daily(c),dailyCloses=dailyCandles.map(x=>x.close),d=dailyTrend(c),e5d=ema(dailyCloses,5).at(-1)??0,e13d=ema(dailyCloses,13).at(-1)??0,st=stoch(q),st1d=stoch(dailyCloses),e8=ema(q,8).at(-1)??0,e21=ema(q,21).at(-1)??0;const fourHDirection=e8>e21?"BULL":"BEAR";const tactical=tacticalDirection(c);return{pair,price:c.at(-1)?.close??0,trend:d.direction??"NEUTRAL",adx:adx(c),rsi:rsi(q),stochK:st.k,stochD:st.d,stochK4h:st.k,stochD4h:st.d,stochK4hPrev:st.pk,stochD4hPrev:st.pd,ema8_4h:e8,ema21_4h:e21,ema8_1d:d.e8,ema21_1d:d.e21,ema5_1d:e5d,ema13_1d:e13d,dailyDirection:d.direction==="LONG"?"BULL":d.direction==="SHORT"?"BEAR":"NEUTRAL",dailyStrength:d.strength,fourHDirection:e8>e21?"BULL":"BEAR",fourHTacticalDirection:tactical.direction==="LONG"?"BULL":tactical.direction==="SHORT"?"BEAR":"NEUTRAL",fourHTacticalLabel:tactical.label,stochK1d:st1d.k,stochD1d:st1d.d,stochK1dPrev:st1d.pk,stochD1dPrev:st1d.pd}}
