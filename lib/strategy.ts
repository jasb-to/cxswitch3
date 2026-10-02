// lib/strategy.ts — clean CX Switch strategy engine
// 1D = directional context | 4H = timing + structure
// ENTRY_1 = probability-based early setup
// ENTRY_2 = confirmed breakout / retest
// No ADD alerts — one-shot entries only; manage the position after entry.
// Exhaustion = ENTRY_1 quality veto, not a direction generator
// Fib = primary ENTRY_1 location; trendline remains for ENTRY_2
// Management = closed-4H wave reversal + realistic TP1/TP2

import { get4HEmaDiagnostic } from "./ema-diagnostic";
import { detectStructureShift } from "./structure-shift";
import type { MarketHealth } from "./market-health";

export interface Candle { timestamp:number; open:number; high:number; low:number; close:number; volume:number; }
export interface BreakoutRecord { direction:"LONG"|"SHORT"; price:number; timestamp:number; candleIndex:number; }
export interface Signal {
  id:string; pair:string; direction:"LONG"|"SHORT"; type:"ENTRY_1"|"ENTRY_2"|"ADD";
  scale:"ENTRY_1"|"ENTRY_2"|"ADD"|null; entry:number; stop:number; target:number;
  tp1?:number; tp2?:number; confidence:number; rr:number; adx:number; rsi:number;
  stochK:number; stochD:number; expectedMove:number; reason:string; timestamp:number; version:number;
  trend?:string; location?:string; trigger?:string; context?:any;
}
export interface SignalResult { signals?:Signal[]; signal?:Signal; market?:any; debug:string[]; breakout?:BreakoutRecord; }
export const CURRENT_SIGNAL_VERSION=20;

type DailyLiveContext={
  state?:string; candidateState?:string; candidateStreak?:number;
  direction?:"BULL"|"BEAR"|"NEUTRAL"; structure?:any; ema?:any; fast513?:any;
  adx?:number; momentum?:any; protectedLevel?:number|null;
};
type Direction="LONG"|"SHORT";
type WeeklyDirection={direction:Direction|null;reason:string;ema5:number;ema13:number;ema5Slope:number;ema13Slope:number;close:number;adx:number;};
type Pivot={index:number;price:number;timestamp:number};
type Trendline={valid:boolean;slope:number;intercept:number;price:number;pivots:Pivot[];ageCandles:number;stale:boolean;staleByAge:boolean;staleByDistance:boolean;invalidated:boolean;reason:string};
type FibLevels={direction:Direction;swingLow:number;swingHigh:number;fib382:number;fib50:number;fib618:number;lowIndex:number;highIndex:number};
type FibPathState={state:"NONE"|"SHALLOW_REVERSAL"|"DEEP_TOUCHED"|"DEEP_RECLAIM"|"FAILED";touched618:boolean;reclaimed500:boolean;currentLevel:"ABOVE_382"|"BETWEEN_382_500"|"BETWEEN_500_618"|"BELOW_618";trigger:string;triggerIndex:number|null;triggerAge:number;fresh:boolean;};

function getFibPathState(c:Candle[],f:FibLevels|null,d:Direction):FibPathState{
  const none:FibPathState={state:"NONE",touched618:false,reclaimed500:false,currentLevel:"ABOVE_382",trigger:"NONE",triggerIndex:null,triggerAge:Infinity,fresh:false};
  if(!f||c.length<3)return none;
  const anchor=d==="LONG"?f.highIndex:f.lowIndex;
  let touched618=false,reclaimed500=false,shallowReversal=false,failed=false;
  let triggerIndex:number|null=null;
  for(let i=anchor;i<c.length;i++){
    const x=c[i];
    if(d==="LONG"){
      if(x.low<=f.fib618)touched618=true;
      if(!touched618&&x.low<=f.fib382&&x.close>f.fib382){shallowReversal=true;triggerIndex=i;}
      if(touched618&&!reclaimed500&&x.close>f.fib50){reclaimed500=true;triggerIndex=i;}
      if(touched618&&x.close<f.swingLow)failed=true;
    }else{
      if(x.high>=f.fib618)touched618=true;
      if(!touched618&&x.high>=f.fib382&&x.close<f.fib382){shallowReversal=true;triggerIndex=i;}
      if(touched618&&!reclaimed500&&x.close<f.fib50){reclaimed500=true;triggerIndex=i;}
      if(touched618&&x.close>f.swingHigh)failed=true;
    }
  }
  const lastIndex=c.length-1,last=c[lastIndex];
  let currentLevel:"ABOVE_382"|"BETWEEN_382_500"|"BETWEEN_500_618"|"BELOW_618";
  if(d==="LONG")currentLevel=last.close>f.fib382?"ABOVE_382":last.close>f.fib50?"BETWEEN_382_500":last.close>f.fib618?"BETWEEN_500_618":"BELOW_618";
  else currentLevel=last.close<f.fib382?"ABOVE_382":last.close<f.fib50?"BETWEEN_382_500":last.close<f.fib618?"BETWEEN_500_618":"BELOW_618";
  const state=failed?"FAILED":touched618&&reclaimed500?"DEEP_RECLAIM":touched618?"DEEP_TOUCHED":shallowReversal?"SHALLOW_REVERSAL":"NONE";
  const trigger=state==="DEEP_RECLAIM"?"0.618_TOUCH→0.5_RECLAIM":state==="SHALLOW_REVERSAL"?"0.382_REVERSAL":state==="DEEP_TOUCHED"?"0.618_TOUCHED":state==="FAILED"?"0.618_FAILED":"NONE";
  const triggerAge=triggerIndex===null?Infinity:lastIndex-triggerIndex;
  const fresh=triggerIndex!==null&&triggerAge<=2&&state!=="FAILED";
  return{state,touched618,reclaimed500,currentLevel,trigger,triggerIndex,triggerAge,fresh};
}

const DAILY_FAST=5, DAILY_SLOW=13, TF_FAST=8, TF_SLOW=21;
const BREAKOUT_PCT=0.005, RETEST_PCT=0.012, ENTRY1_FIB_ZONE_PCT=0.03, ENTRY1_PATH_ZONE_PCT=0.01;
const ENTRY1_MIN_RUNWAY_PCT=0.03;
const ENTRY1_PREFERRED_RUNWAY_PCT=0.05;
const DAILY_BREAKOUT_LOOKBACK=20;
const DAILY_BREAKOUT_RECENCY=5;
const DAILY_FADE_ZONE_PCT=0.0125;
const DAILY_FADE_STOCH=85;
const STALE_TL_PCT=0.04, STALE_TL_CANDLES=12, FRESH_LOOKBACK=30, BREAKOUT_EXPIRY_CANDLES=12;
const ENTRY1_LONG_EXHAUSTION_RSI=80, ENTRY1_SHORT_EXHAUSTION_RSI=20;
const LEVERAGE=20, MMR=0.01, LIQ_BUFFER=0.015, MIN_RR=1.25;
function volatilitySizeMultiplier(price:number,atrValue:number){const pct=price>0?(atrValue/price)*100:0;if(pct>=8)return 0.25;if(pct>=6)return 0.35;if(pct>=4)return 0.5;if(pct>=2.5)return 0.75;return 1;}

const avg=(a:number[])=>a.length?a.reduce((x,y)=>x+y,0)/a.length:0;
function round(n:number){return Math.round(n*100000)/100000;}
function ema(a:number[],p:number){if(!a.length)return[];const k=2/(p+1),r=[a[0]];for(let i=1;i<a.length;i++)r.push(a[i]*k+r[i-1]*(1-k));return r;}
function atr(c:Candle[],p=14){if(c.length<2)return 0;const r:number[]=[];for(let i=Math.max(1,c.length-p);i<c.length;i++){const x=c[i],q=c[i-1];r.push(Math.max(x.high-x.low,Math.abs(x.high-q.close),Math.abs(x.low-q.close)));}return avg(r);}
function rsi(a:number[],p=14){if(a.length<2)return 50;let g=0,l=0,n=0;for(let i=Math.max(1,a.length-p);i<a.length;i++){const d=a[i]-a[i-1];if(d>0)g+=d;else l+=Math.abs(d);n++;}if(!n)return 50;const ag=g/n,al=l/n;if(al===0)return 100;return 100-100/(1+ag/al);}
function rsiSeries(a:number[],p=14){const r:number[]=[];for(let i=p;i<a.length;i++)r.push(rsi(a.slice(i-p,i+1),p));return r;}
function stochRsi(a:number[],rp=14,sp=14,ks=3,ds=3){const rv=rsiSeries(a,rp);if(rv.length<sp+ks-1)return{k:50,d:50};const raw:number[]=[];for(let i=sp-1;i<rv.length;i++){const w=rv.slice(i-sp+1,i+1),lo=Math.min(...w),hi=Math.max(...w);raw.push(hi===lo?50:(rv[i]-lo)/(hi-lo)*100);}const kv:number[]=[];for(let i=ks-1;i<raw.length;i++)kv.push(avg(raw.slice(i-ks+1,i+1)));if(kv.length<ds)return{k:50,d:50};return{k:Math.round(kv.at(-1)!*10)/10,d:Math.round(avg(kv.slice(-ds))*10)/10};}
function wilder(a:number[],p:number){if(!a.length)return[];const r=[avg(a.slice(0,p))];for(let i=p;i<a.length;i++)r.push((r.at(-1)!*(p-1)+a[i])/p);return r;}
function adx(c:Candle[],p=14){if(c.length<p+1)return 0;const tr:number[]=[],plus:number[]=[],minus:number[]=[];for(let i=1;i<c.length;i++){const x=c[i],q=c[i-1];tr.push(Math.max(x.high-x.low,Math.abs(x.high-q.close),Math.abs(x.low-q.close)));plus.push(x.high-q.high>q.low-x.low?Math.max(x.high-q.high,0):0);minus.push(q.low-x.low>x.high-q.high?Math.max(q.low-x.low,0):0);}const t=wilder(tr,p),pd=wilder(plus,p),md=wilder(minus,p),dx:number[]=[];for(let i=0;i<t.length;i++){const a=pd[i]/(t[i]||1)*100,b=md[i]/(t[i]||1)*100;dx.push(a+b===0?0:Math.abs(a-b)/(a+b)*100);}return Math.round((wilder(dx,p).at(-1)||0)*10)/10;}
function daily(c:Candle[]){const m=new Map<string,Candle[]>();for(const x of [...c].sort((a,b)=>a.timestamp-b.timestamp)){const d=new Date(x.timestamp),k=`${d.getUTCFullYear()}-${d.getUTCMonth()}-${d.getUTCDate()}`;if(!m.has(k))m.set(k,[]);m.get(k)!.push(x);}return[...m.values()].map(b=>({timestamp:b[0].timestamp,open:b[0].open,high:Math.max(...b.map(x=>x.high)),low:Math.min(...b.map(x=>x.low)),close:b.at(-1)!.close,volume:b.reduce((s,x)=>s+x.volume,0)}));}
function bias(c:Candle[]):Direction|null{if(c.length<20)return null;const a=c.map(x=>x.close),f=ema(a,DAILY_FAST).at(-1)!,s=ema(a,DAILY_SLOW).at(-1)!;return f>s?"LONG":f<s?"SHORT":null;}
function strength(c:Candle[],d:Direction){if(c.length<2)return"MEDIUM";const h=c.slice(-20).map(x=>x.high),l=c.slice(-20).map(x=>x.low);return d==="LONG"&&h.at(-1)!>Math.max(...h.slice(0,-1))||d==="SHORT"&&l.at(-1)!<Math.min(...l.slice(0,-1))?"STRONG":"MEDIUM";}
function pivots(c:Candle[],kind:"HIGH"|"LOW",w=2){
  const r:Pivot[]=[];
  for(let i=w;i<c.length-w;i++){
    const v=kind==="LOW"?c[i].low:c[i].high;
    let ok=true;
    for(let j=1;j<=w;j++){
      if(kind==="LOW"?(v>=c[i-j].low||v>=c[i+j].low):(v<=c[i-j].high||v<=c[i+j].high)){ok=false;break;}
    }
    if(ok)r.push({index:i,price:v,timestamp:c[i].timestamp});
  }
  return r;
}

/*
 * Structural trendline engine
 * ---------------------------
 * 4H owns the line. 15M never draws its own competing line.
 *
 * A candidate line must:
 *   1. use confirmed pivots only (non-repainting)
 *   2. have >= 3 meaningful pivot touches
 *   3. survive a clean-line scan between its anchors
 *   4. have an ATR-normalised touch/violation tolerance
 *   5. be recent enough to still represent current structure
 *
 * We deliberately do NOT use chart "angle" because visual angle changes
 * with zoom. Price slope is evaluated in ATR units instead.
 */
const TL_MIN_TOUCHES=3;
const TL_MIN_SPAN=6;
const TL_MAX_PIVOTS=10;
const TL_TOUCH_ATR=0.45;
const TL_VIOLATION_ATR=0.35;
const TL_MAX_AGE=18;
const TL_MAX_DISTANCE_PCT=0.06;
const TL_BREAK_ATR=0.25;
const TL_RETEST_ATR=0.55;
const TL_RETEST_PCT=0.009;
const TL_BREAK_WINDOW_15M=32;

function buildTrendline(c:Candle[],d:Direction,lookback=80):Trendline{
  const kind=d==="LONG"?"LOW":"HIGH";
  const ps=pivots(c,kind).filter(x=>x.index>=Math.max(0,c.length-lookback)).slice(-TL_MAX_PIVOTS);
  const empty=(reason:string):Trendline=>({
    valid:false,slope:0,intercept:0,price:0,pivots:ps,
    ageCandles:ps.length?c.length-1-ps[ps.length-1].index:0,
    stale:false,staleByAge:false,staleByDistance:false,invalidated:false,reason
  });
  if(ps.length<2)return empty(`No ${d} structural trendline — ${ps.length}/2 confirmed pivots`);

  const av=atr(c);
  const tolerance=(linePrice:number)=>Math.max(Math.abs(linePrice)*BREAKOUT_PCT,av*TL_TOUCH_ATR);
  const violation=Math.max(av*TL_VIOLATION_ATR,1);
  let best:{score:number;slope:number;intercept:number;touches:Pivot[];span:number}|null=null;

  for(let ai=0;ai<ps.length-1;ai++){
    for(let bi=ai+1;bi<ps.length;bi++){
      const a=ps[ai],b=ps[bi],dx=b.index-a.index;
      if(dx<TL_MIN_SPAN)continue;
      const slope=(b.price-a.price)/dx;
      if(d==="LONG"&&slope<=0)continue;
      if(d==="SHORT"&&slope>=0)continue;

      // Reject implausibly steep lines in volatility-normalised terms.
      if(av>0&&Math.abs(slope)/av>1.75)continue;

      const intercept=a.price-slope*a.index;
      const touches=ps.filter(p=>Math.abs(p.price-(slope*p.index+intercept))<=tolerance(slope*p.index+intercept));
      if(touches.length<TL_MIN_TOUCHES)continue;

      const first=touches[0].index,last=touches[touches.length-1].index;
      if(last-first<TL_MIN_SPAN)continue;

      // A valid support/resistance line should not have closes slicing through
      // it between its defining touches. Wicks are allowed inside tolerance.
      let clean=true;
      for(let j=first+1;j<last;j++){
        const line=slope*j+intercept;
        if(d==="LONG"&&c[j].close<line-violation){clean=false;break;}
        if(d==="SHORT"&&c[j].close>line+violation){clean=false;break;}
      }
      if(!clean)continue;

      const span=last-first;
      const newestAge=(c.length-1)-last;
      const score=touches.length*100000+span*100-newestAge*10;
      if(!best||score>best.score)best={score,slope,intercept,touches,span};
    }
  }

  if(!best){
    // Fallback to the latest two structural pivots. This keeps diagnostics
    // useful, but the line is NOT eligible for ENTRY_2 until it is validated.
    const a=ps.at(-2)!,b=ps.at(-1)!,dx=b.index-a.index;
    const slope=(b.price-a.price)/Math.max(dx,1),intercept=a.price-slope*a.index;
    const price=slope*(c.length-1)+intercept;
    return{valid:false,slope,intercept,price,pivots:ps,ageCandles:c.length-1-b.index,stale:false,staleByAge:false,staleByDistance:false,invalidated:false,reason:`${d} pivots found but no clean 3-touch trendline`};
  }

  const slope=best.slope,intercept=best.intercept;
  const price=slope*(c.length-1)+intercept;
  const age=c.length-1-best.touches.at(-1)!.index;
  const distance=Math.abs((c.at(-1)!.close-price)/Math.max(Math.abs(price),1));
  const staleByAge=age>TL_MAX_AGE;
  const staleByDistance=distance>=TL_MAX_DISTANCE_PCT;

  // Only invalidate against CLOSED candles before the current bar. This is
  // important: a developing 4H candle is allowed to break the live line.
  let invalidated=false;
  for(let j=best.touches.at(-1)!.index+1;j<c.length-1;j++){
    const line=slope*j+intercept;
    if(d==="LONG"&&c[j].close<line-Math.max(av*TL_VIOLATION_ATR,1)){invalidated=true;break;}
    if(d==="SHORT"&&c[j].close>line+Math.max(av*TL_VIOLATION_ATR,1)){invalidated=true;break;}
  }

  const stale=!invalidated&&(staleByAge||staleByDistance);
  return{
    valid:true,slope,intercept,price,pivots:best.touches,ageCandles:age,stale,
    staleByAge,staleByDistance,invalidated,
    reason:invalidated?`${d} trendline invalidated by structure`:stale?`${d} trendline stale — rebuild recommended`:`${d} trendline active — ${best.touches.length} touches`
  };
}

function buildEntry2Trendline(c:Candle[],d:Direction,lookback=80):Trendline{
  // ENTRY_2 uses the opposite structural side from the ENTRY_1 diagnostic line:
  // LONG breaks descending resistance (HIGH pivots); SHORT breaks rising support (LOW pivots).
  const kind=d==="LONG"?"HIGH":"LOW";
  const ps=pivots(c,kind).filter(x=>x.index>=Math.max(0,c.length-lookback)).slice(-TL_MAX_PIVOTS);
  const empty=(reason:string):Trendline=>({valid:false,slope:0,intercept:0,price:0,pivots:ps,ageCandles:ps.length?c.length-1-ps[ps.length-1].index:0,stale:false,staleByAge:false,staleByDistance:false,invalidated:false,reason});
  if(ps.length<2)return empty("No ENTRY_2 "+d+" structural line — "+ps.length+"/2 confirmed pivots");
  const av=atr(c),tolerance=(linePrice:number)=>Math.max(Math.abs(linePrice)*BREAKOUT_PCT,av*TL_TOUCH_ATR),violation=Math.max(av*TL_VIOLATION_ATR,1);
  let best:{score:number;slope:number;intercept:number;touches:Pivot[]}|null=null;
  for(let ai=0;ai<ps.length-1;ai++)for(let bi=ai+1;bi<ps.length;bi++){
    const a=ps[ai],b=ps[bi],dx=b.index-a.index;if(dx<TL_MIN_SPAN)continue;
    const slope=(b.price-a.price)/dx;
    if(d==="LONG"&&slope>=0)continue;
    if(d==="SHORT"&&slope<=0)continue;
    if(av>0&&Math.abs(slope)/av>1.75)continue;
    const intercept=a.price-slope*a.index;
    const touches=ps.filter(p=>Math.abs(p.price-(slope*p.index+intercept))<=tolerance(slope*p.index+intercept));
    if(touches.length<TL_MIN_TOUCHES)continue;
    const first=touches[0].index,last=touches[touches.length-1].index;if(last-first<TL_MIN_SPAN)continue;
    let clean=true;
    for(let j=first+1;j<last;j++){
      const line=slope*j+intercept;
      if(d==="LONG"&&c[j].close>line+violation){clean=false;break;}
      if(d==="SHORT"&&c[j].close<line-violation){clean=false;break;}
    }
    if(!clean)continue;
    const span=last-first,newestAge=(c.length-1)-last,score=touches.length*100000+span*100-newestAge*10;
    if(!best||score>best.score)best={score,slope,intercept,touches};
  }
  if(!best)return empty("ENTRY_2 "+d+" line has no clean 3-touch structure");
  const slope=best.slope,intercept=best.intercept,price=slope*(c.length-1)+intercept;
  const age=c.length-1-best.touches.at(-1)!.index;
  const distance=Math.abs((c.at(-1)!.close-price)/Math.max(Math.abs(price),1));
  const staleByAge=age>TL_MAX_AGE,staleByDistance=distance>=TL_MAX_DISTANCE_PCT;
  let invalidated=false;
  for(let j=best.touches.at(-1)!.index+1;j<c.length-1;j++){
    const line=slope*j+intercept;
    if(d==="LONG"&&c[j].close>line+violation){invalidated=true;break;}
    if(d==="SHORT"&&c[j].close<line-violation){invalidated=true;break;}
  }
  const stale=!invalidated&&(staleByAge||staleByDistance);
  return{valid:true,slope,intercept,price,pivots:best.touches,ageCandles:age,stale,staleByAge,staleByDistance,invalidated,reason:invalidated?"ENTRY_2 "+d+" breakout line already broken":stale?"ENTRY_2 "+d+" trendline stale — rebuild recommended":"ENTRY_2 "+d+" breakout line active — "+best.touches.length+" touches"};
}
function lineAt(t:Trendline,i:number){return t.slope*i+t.intercept;}

function lineAtTimestamp(t:Trendline,c4:Candle[],timestamp:number){
  if(!t.valid||!c4.length)return null;
  const base=c4[0].timestamp;
  const step=c4.length>1?Math.max(1,c4[1].timestamp-c4[0].timestamp):4*60*60*1000;
  const fractionalIndex=(timestamp-base)/step;
  return lineAt(t,fractionalIndex);
}

/*
 * ENTRY_2 execution:
 * The 4H trendline is the only structural reference.
 * The 15M candle is only the execution layer.
 *
 * Long: 4H breaks above descending resistance, then 15M dips into the
 * broken line and finishes back above it.
 * Short: 4H breaks below ascending support, then 15M rallies into the
 * broken line and finishes back below it.
 */
function detect15mTrendlineRetest(
  c15:Candle[],
  c4:Candle[],
  tl:Trendline,
  d:Direction,
  breakoutSeen:boolean,
  breakoutTimestamp?:number
){
  if(!tl.valid||tl.stale||tl.invalidated||c15.length<4)return{breakSeen:false,retest:false,linePrice:null,reason:"NO_VALID_4H_TRENDLINE"};
  const closed15=c15.length>1?c15.slice(0,-1):c15;
  if(closed15.length<3)return{breakSeen:breakoutSeen,retest:false,linePrice:null,reason:"WAITING_FOR_15M_CLOSE"};
  const latest=closed15.at(-1)!;
  const latestLine=lineAtTimestamp(tl,c4,latest.timestamp);
  if(latestLine===null)return{breakSeen:false,retest:false,linePrice:null,reason:"NO_LINE_PRICE"};

  const startTs=breakoutTimestamp??closed15[0].timestamp;
  const window=closed15.filter(x=>x.timestamp>=startTs).slice(-TL_BREAK_WINDOW_15M);
  if(window.length<3)return{breakSeen:breakoutSeen,retest:false,linePrice:latestLine,reason:"WAITING_FOR_15M_SEQUENCE"};

  const av15=atr(closed15);
  const breakBuffer=Math.max(av15*TL_BREAK_ATR,Math.abs(latestLine)*BREAKOUT_PCT);
  const retestBuffer=Math.max(av15*TL_RETEST_ATR,Math.abs(latestLine)*TL_RETEST_PCT);

  // ENTRY_2 is a stateful sequence, not a one-candle coincidence:
  //   confirmed 4H break -> 15M closes beyond the line -> 15M returns to
  //   the broken line -> a later 15M candle rejects/reclaims the line.
  // The 4H layer owns the breakout; the 15M layer only confirms execution.
  if(!breakoutSeen)return{breakSeen:false,retest:false,linePrice:latestLine,reason:"WAITING_FOR_4H_BREAK"};

  let movedBeyond=false;
  let touched=false;
  let touchIndex=-1;
  for(let i=0;i<window.length;i++){
    const x=window[i];
    const line=lineAtTimestamp(tl,c4,x.timestamp);
    if(line===null)continue;

    const beyond=d==="LONG"
      ? x.close>line+breakBuffer
      : x.close<line-breakBuffer;

    if(!touched){
      if(beyond)movedBeyond=true;
      if(movedBeyond){
        const hit=d==="LONG"
          ? x.low<=line+retestBuffer
          : x.high>=line-retestBuffer;
        if(hit){
          touched=true;
          touchIndex=i;
        }
      }
      continue;
    }

    if(i<=touchIndex)continue;

    const reclaimed=d==="LONG"
      ? x.close>line+Math.min(retestBuffer*0.35,breakBuffer)
      : x.close<line-Math.min(retestBuffer*0.35,breakBuffer);

    const rejected=d==="LONG"
      ? x.close>x.open || x.close>window[i-1].close
      : x.close<x.open || x.close<window[i-1].close;

    if(reclaimed&&rejected){
      return{
        breakSeen:true,
        retest:true,
        linePrice:line,
        reason:"15M_BREAK→RETEST→RECLAIM_CONFIRMED"
      };
    }
  }

  if(touched)return{breakSeen:true,retest:false,linePrice:latestLine,reason:"15M_RETEST_TOUCHED_WAITING_FOR_RECLAIM"};
  if(movedBeyond)return{breakSeen:true,retest:false,linePrice:latestLine,reason:"15M_BREAK_CONFIRMED_WAITING_FOR_RETEST"};
  return{breakSeen:true,retest:false,linePrice:latestLine,reason:"WAITING_FOR_15M_BREAK_CONFIRMATION"};
}
function stochKSeries(c:Candle[]):number[]{
  const closes=c.map(x=>x.close),out:number[]=[];
  for(let i=0;i<c.length;i++)out.push(stochRsi(closes.slice(0,i+1)).k);
  return out;
}
function stochWaveAnchors(c:Candle[],d:Direction):{high:Pivot;low:Pivot}|null{
  if(c.length<35)return null;
  const k=stochKSeries(c),w=2;
  const highs:Pivot[]=[],lows:Pivot[]=[];
  for(let i=w;i<k.length-w;i++){
    let hi=true,lo=true;
    for(let j=1;j<=w;j++){
      if(k[i]<=k[i-j]||k[i]<=k[i+j])hi=false;
      if(k[i]>=k[i-j]||k[i]>=k[i+j])lo=false;
    }
    if(hi)highs.push({index:i,price:k[i],timestamp:c[i].timestamp});
    if(lo)lows.push({index:i,price:k[i],timestamp:c[i].timestamp});
  }
  if(d==="LONG"){
    for(let i=lows.length-1;i>=0;i--){
      const lo=lows[i],hi=highs.filter(x=>x.index<lo.index).at(-1);
      if(!hi)continue;
      const highEnd=Math.min(c.length-1,lo.index+2),lowStart=Math.max(0,hi.index-2);
      let hiIdx=hi.index,loIdx=lo.index,hiPrice=-Infinity,loPrice=Infinity;
      for(let j=lowStart;j<=highEnd;j++){if(c[j].high>hiPrice){hiPrice=c[j].high;hiIdx=j;}}
      for(let j=hi.index;j<=highEnd;j++){if(c[j].low<loPrice){loPrice=c[j].low;loIdx=j;}}
      if(hiPrice>loPrice)return{high:{index:hiIdx,price:hiPrice,timestamp:c[hiIdx].timestamp},low:{index:loIdx,price:loPrice,timestamp:c[loIdx].timestamp}};
    }
  }else{
    for(let i=highs.length-1;i>=0;i--){
      const hi=highs[i],lo=lows.filter(x=>x.index<hi.index).at(-1);
      if(!lo)continue;
      const highEnd=Math.min(c.length-1,hi.index+2),lowStart=Math.max(0,lo.index-2);
      let hiIdx=hi.index,loIdx=lo.index,hiPrice=-Infinity,loPrice=Infinity;
      for(let j=lo.index;j<=highEnd;j++){if(c[j].high>hiPrice){hiPrice=c[j].high;hiIdx=j;}}
      for(let j=lowStart;j<=hi.index;j++){if(c[j].low<loPrice){loPrice=c[j].low;loIdx=j;}}
      if(hiPrice>loPrice)return{high:{index:hiIdx,price:hiPrice,timestamp:c[hiIdx].timestamp},low:{index:loIdx,price:loPrice,timestamp:c[loIdx].timestamp}};
    }
  }
  return null;
}
function getFibLevels(c:Candle[],d:Direction):FibLevels|null{
  const wave=stochWaveAnchors(c,d);
  if(!wave)return null;
  const {high,low}=wave,range=high.price-low.price;
  if(!Number.isFinite(range)||range<=0)return null;
  return d==="LONG"
    ? {direction:d,swingLow:low.price,swingHigh:high.price,fib382:high.price-range*.382,fib50:high.price-range*.5,fib618:high.price-range*.618,lowIndex:low.index,highIndex:high.index}
    : {direction:d,swingLow:low.price,swingHigh:high.price,fib382:low.price+range*.382,fib50:low.price+range*.5,fib618:low.price+range*.618,lowIndex:low.index,highIndex:high.index};
}
function macd4h(c:Candle[]){const closes=c.map(x=>x.close),fast=ema(closes,12),slow=ema(closes,26),m=fast.map((v,i)=>v-(slow[i]??v)),sig=ema(m,9),h=m.map((v,i)=>v-(sig[i]??0)),i=h.length-1,p=Math.max(0,i-1),cur=h[i]??0,prev=h[p]??0;return{macd:m[i]??0,signal:sig[i]??0,histogram:cur,prevHistogram:prev,prev2Histogram:h[Math.max(0,i-2)]??prev,rising:cur>prev,falling:cur<prev,bullishShift:cur>prev||cur>=0&&prev<0,bearishShift:cur<prev||cur<=0&&prev>0,bullishCross:cur>=0&&prev<0,bearishCross:cur<=0&&prev>0,bullishColour:cur>prev&&cur<0,bearishColour:cur<prev&&cur>0,histogramPct:Math.abs(cur)>0?(cur-prev)/Math.abs(cur)*100:0};}
function weeklyDirection(c:Candle[],price:number):WeeklyDirection{
  const closed=c.length>1?c.slice(0,-1):c;
  if(closed.length<21)return{direction:null,reason:"INSUFFICIENT_WEEKLY_DATA",ema5:0,ema13:0,ema5Slope:0,ema13Slope:0,close:price,adx:0};
  const closes=closed.map(x=>x.close),f=ema(closes,5),s=ema(closes,13),ema5=f.at(-1)!,ema13=s.at(-1)!,prev5=f.at(-2)!,prev13=s.at(-2)!,close=closed.at(-1)!.close,w=adx(closed);
  const long=ema5>ema13&&ema5>prev5&&ema13>=prev13&&close>ema13;
  const short=ema5<ema13&&ema5<prev5&&ema13<=prev13&&close<ema13;
  const direction=long?"LONG":short?"SHORT":null;
  return{direction,reason:long?"WEEKLY_BULLISH":short?"WEEKLY_BEARISH":"WEEKLY_NEUTRAL",ema5,ema13,ema5Slope:ema5-prev5,ema13Slope:ema13-prev13,close,adx:w};
}
function dailyBreakoutContext(c4:Candle[]){
  const dc=daily(c4);
  const closed=dc.length>1?dc.slice(0,-1):dc;
  const result={long:false,short:false,longAge:Infinity,shortAge:Infinity,longLevel:null as number|null,shortLevel:null as number|null};
  if(closed.length<DAILY_BREAKOUT_LOOKBACK+1)return result;
  const start=Math.max(DAILY_BREAKOUT_LOOKBACK,closed.length-DAILY_BREAKOUT_RECENCY);
  for(let i=start;i<closed.length;i++){
    const prior=closed.slice(i-DAILY_BREAKOUT_LOOKBACK,i);
    const priorHigh=Math.max(...prior.map(x=>x.high));
    const priorLow=Math.min(...prior.map(x=>x.low));
    if(closed[i].close>priorHigh){result.long=true;result.longAge=closed.length-1-i;result.longLevel=priorHigh;}
    if(closed[i].close<priorLow){result.short=true;result.shortAge=closed.length-1-i;result.shortLevel=priorLow;}
  }
  return result;
}
function dailyFadeContext(c4:Candle[]){
  const dc=daily(c4),closed=dc.length>1?dc.slice(0,-1):dc,live=dc.at(-1);
  const result={shortWatch:false,failedBreak:false,level:null as number|null,distPct:Infinity,stochK:50,stochD:50,reason:""};
  if(closed.length<DAILY_BREAKOUT_LOOKBACK+1||!live)return result;
  const prior=closed.slice(-DAILY_BREAKOUT_LOOKBACK),priorHigh=Math.max(...prior.map(x=>x.high)),price=live.close;
  const dist=Math.abs((priorHigh-price)/Math.max(price,1)),st=stochRsi(closed.map(x=>x.close));
  const nearUpper=price<=priorHigh&&price>=priorHigh*(1-DAILY_FADE_ZONE_PCT),sweptAndRejected=live.high>priorHigh&&price<priorHigh;
  const overbought=st.k>=DAILY_FADE_STOCH&&st.k>=st.d,shortWatch=(nearUpper||sweptAndRejected)&&overbought;
  return{shortWatch,failedBreak:sweptAndRejected,level:priorHigh,distPct:dist*100,stochK:st.k,stochD:st.d,reason:shortWatch?(sweptAndRejected?"1D_RESISTANCE_SWEEP_REJECTED + STOCH_OVERBOUGHT":"1D_RESISTANCE_APPROACH + STOCH_OVERBOUGHT"):""};
}
function locationQuality(c:Candle[],f:FibLevels|null,tl:Trendline,price:number,d:Direction){
  const recent=c.slice(-20);
  const fibLevels=f?[f.fib382,f.fib50,f.fib618]:[];
  const nearFib=fibLevels.some(x=>Math.abs((price-x)/Math.max(price,1))<=ENTRY1_FIB_ZONE_PCT);
  const nearSwing=!!f&&Math.abs((price-(d==="LONG"?f.swingLow:f.swingHigh))/Math.max(price,1))<=0.02;
  const nearTrendline=tl.valid&&Math.abs((price-tl.price)/Math.max(price,1))<=0.025;
  const rangeHigh=Math.max(...recent.map(x=>x.high)),rangeLow=Math.min(...recent.map(x=>x.low));
  const rangePct=(rangeHigh-rangeLow)/Math.max(price,1);
  const positionPct=rangePct>0?(price-rangeLow)/(rangeHigh-rangeLow):0.5;
  const directionalLocation=d==="LONG"?positionPct<=0.45:d==="SHORT"?positionPct>=0.55:false;
  const score=[nearFib,nearSwing,nearTrendline,directionalLocation].filter(Boolean).length;
  return{score,quality:score>=3?"HIGH":score===2?"MEDIUM":"LOW",nearFib,nearSwing,nearTrendline,directionalLocation,rangePct:rangePct*100,rangePosition:positionPct*100};
}
function compressionContext(c:Candle[]){
  if(c.length<30)return{compressed:false,ratio:null,rangeRatio:null};
  const tr=(x:Candle,p:Candle)=>Math.max(x.high-x.low,Math.abs(x.high-p.close),Math.abs(x.low-p.close));
  const trs=c.slice(1).map((x,i)=>tr(x,c[i]));
  const recent=trs.slice(-6),base=trs.slice(-24,-6);
  const avg=(a:number[])=>a.reduce((s,x)=>s+x,0)/Math.max(a.length,1);
  const ratio=avg(recent)/Math.max(avg(base),1e-9);
  const rrRecent=(Math.max(...c.slice(-6).map(x=>x.high))-Math.min(...c.slice(-6).map(x=>x.low)))/Math.max(c.at(-1)!.close,1);
  const rrBase=(Math.max(...c.slice(-24,-6).map(x=>x.high))-Math.min(...c.slice(-24,-6).map(x=>x.low)))/Math.max(c.at(-1)!.close,1);
  const rangeRatio=rrRecent/Math.max(rrBase,1e-9);
  return{compressed:ratio<0.8&&rangeRatio<0.8,ratio,rangeRatio};
}
function entry1Runway(c:Candle[],f:FibLevels|null,price:number,d:Direction){
  const recent=c.slice(-20);
  const structural=d==="LONG"
    ? [f?.swingHigh,Math.max(...recent.map(x=>x.high))]
    : [f?.swingLow,Math.min(...recent.map(x=>x.low))];
  const forward=structural.filter((x):x is number=>Number.isFinite(x)&&(d==="LONG"?x>price:x<price)).sort((a,b)=>d==="LONG"?a-b:b-a);
  const firstObstacle=forward[0]??null;
  const obstacleRunway=firstObstacle===null?Infinity:Math.abs((firstObstacle-price)/Math.max(price,1));
  return{available:obstacleRunway>=ENTRY1_MIN_RUNWAY_PCT,pct:obstacleRunway*100,obstacle:firstObstacle,preferred:obstacleRunway>=ENTRY1_PREFERRED_RUNWAY_PCT};
}
function dailyDirection(live?:DailyLiveContext,local?:Direction|null):"BULL"|"BEAR"|"NEUTRAL"{
  if(live?.state==="BULL_ESTABLISHED"||live?.state==="BULL_WEAKENING")return"BULL";
  if(live?.state==="BEAR_ESTABLISHED"||live?.state==="BEAR_WEAKENING")return"BEAR";
  if(live)return"NEUTRAL";
  return local==="LONG"?"BULL":local==="SHORT"?"BEAR":"NEUTRAL";
}
function opposite(pair:string,d:Direction,trades?:any[]){return!!trades?.some(t=>(t.pair===pair||t.symbol===pair)&&t.direction!==d);}
function same(pair:string,d:Direction,trades?:any[]){return!!trades?.some(t=>(t.pair===pair||t.symbol===pair)&&t.direction===d);}
function liq(entry:number,d:Direction){return d==="LONG"?entry*(1-1/LEVERAGE+MMR):entry*(1+1/LEVERAGE-MMR);}
export function liquidationSafeStop(entry:number,d:Direction){const l=liq(entry,d),safe=d==="LONG"?l*(1+LIQ_BUFFER):l*(1-LIQ_BUFFER);return round(safe);}


function compositeMomentumState(
  c:Candle[],
  d:Direction,
  st:{k:number;d:number},
  macd:{bullishShift:boolean;bearishShift:boolean},
  fourH:{direction:string;turning:boolean;stage?:string}
){
  // ENTRY_1 is a price-action transition, not an oscillator vote.
  // Fib tells us WHERE the setup is forming. The candles tell us whether
  // price is still travelling in the old direction or has actually reacted.
  const closed=c;
  if(closed.length<3)return"DETERIORATING" as const;

  const last=closed.at(-1)!;
  const prev=closed.at(-2)!;
  const prev2=closed.at(-3)!;

  // Real price reaction:
  // LONG  = downside fails to extend and the latest candle takes back
  //         immediate price structure.
  // SHORT = upside fails to extend and the latest candle gives back
  //         immediate price structure.
  //
  // This deliberately does NOT require an EMA cross, StochRSI turn, MACD
  // turn, ADX level, or 1D/4H alignment.
  // A genuine early reversal needs BOTH a failure to extend the old
  // swing and a meaningful close back in the new direction. A single green
  // candle inside a falling sequence is not a reversal.
  const longFailureToExtend=
    last.low>=prev.low ||
    (last.low<prev.low && last.close>prev.close);
  const shortFailureToExtend=
    last.high<=prev.high ||
    (last.high>prev.high && last.close<prev.close);

  const longReaction=
    longFailureToExtend &&
    (last.close>prev.close || last.high>prev.high);
  const shortReaction=
    shortFailureToExtend &&
    (last.close<prev.close || last.low<prev.low);

  // If price is still printing lower lows/lower closes, a bullish oscillator
  // twitch cannot manufacture a LONG. Mirror this for SHORT.
  const downsideContinuation=
    last.low<prev.low && last.close<=prev.close &&
    prev.low<=prev2.low;
  const upsideContinuation=
    last.high>prev.high && last.close>=prev.close &&
    prev.high>=prev2.high;

  if(d==="LONG"){
    if(downsideContinuation&&!longReaction)return"DETERIORATING" as const;
    return longReaction?"IMPROVING":"DETERIORATING" as const;
  }

  if(upsideContinuation&&!shortReaction)return"DETERIORATING" as const;
  return shortReaction?"IMPROVING":"DETERIORATING" as const;
}
function snapshot(pair:string,c:Candle[],d:Direction,tl:Trendline,price:number,dailyLive?:DailyLiveContext){
  const closed=c.length>1?c.slice(0,-1):c,closes=closed.map(x=>x.close),st=stochRsi(closes),r=Math.round(rsi(closes)*10)/10,a=adx(closed),e8=ema(closes,TF_FAST).at(-1)??price,e21=ema(closes,TF_SLOW).at(-1)??price,m=macd4h(closed),d1=getDaily513Diagnostic(c),dist=tl.valid?(price-tl.price)/tl.price:null;
  const longTL=buildTrendline(closed,"LONG"),shortTL=buildTrendline(closed,"SHORT");
  return{pair,price:round(price),timestamp:Date.now(),trend:`${d} ${strength(daily(c),d)}`,location:dist===null?"NO_TL":Math.abs(dist)<=RETEST_PCT?"NEAR_TL":d==="LONG"?price>tl.price?"BEYOND_TL":"FAR_FROM_TL":price<tl.price?"BEYOND_TL":"FAR_FROM_TL",trigger:"WAITING",adx:a,rsi:r,stochK:st.k,stochD:st.d,trendlinePrice:tl.valid?round(tl.price):0,distToTrendline:dist===null?null:Math.round(Math.abs(dist)*10000)/100,ema8_4h:round(e8),ema21_4h:round(e21),fourH513:get4HEmaDiagnostic(c),macd4h:m,daily513:d1,dailyLive:dailyLive||null,momentumState:compositeMomentumState(closed,d,st,m,get4HEmaDiagnostic(closed)),trendlineStatus:tl.stale?"STALE_REBUILD":tl.valid?"ACTIVE":"REBUILDING",trendlineReason:tl.reason,trendlinePivots:tl.pivots.length,trendlineAgeCandles:tl.ageCandles,trendlineSlope:round(tl.slope),trendlineStaleByAge:tl.staleByAge,trendlineStaleByDistance:tl.staleByDistance,entry1Closed4hTimestamp:closed.at(-1)?.timestamp??0,entry1ClosedStochK:st.k,entry1ClosedStochD:st.d,entry1NearTL:tl.valid&&dist!==null&&Math.abs(dist)<=RETEST_PCT,entry1LongNearTL:longTL.valid&&Math.abs((price-longTL.price)/longTL.price)<=RETEST_PCT,entry1ShortNearTL:shortTL.valid&&Math.abs((price-shortTL.price)/shortTL.price)<=RETEST_PCT,entry1ShortMacdTurn:m.bearishShift,entry1ShortStochTurn:st.k<st.d,entry1LongStochTurn:st.k>st.d,entry1ShortTurn:st.k<st.d,entry1LongTrendlinePrice:longTL.valid?round(longTL.price):0,entry1ShortTrendlinePrice:shortTL.valid?round(shortTL.price):0};
}
export function getDaily513Diagnostic(c:Candle[]){
  const d=daily(c);if(d.length<21)return{stage:"NEUTRAL",label:"1D NEUTRAL",direction:"NEUTRAL" as const,ema5:0,ema13:0,spread:0,spreadPct:0,spreadContracting:false,spreadChangePct:0,ema5Slope:0,ema13Slope:0};
  const x=d.slice(0,-1).map(z=>z.close),f=ema(x,5),s=ema(x,13),ema5=f.at(-1)!,ema13=s.at(-1)!,p5=f.at(-2)!,p13=s.at(-2)!,spread=ema5-ema13,prev=p5-p13,contract=Math.abs(spread)<Math.abs(prev);let stage=spread>0?"BULLISH":"BEARISH",label=spread>0?"1D BULLISH":"1D BEARISH",direction:"BULLISH"|"BEARISH"=spread>0?"BULLISH":"BEARISH";if(spread<0&&ema5>p5&&contract){stage="EARLY_BULLISH";label="1D EARLY BULLISH";}if(spread>0&&ema5<p5&&contract){stage="EARLY_BEARISH";label="1D EARLY BEARISH";}return{stage,label,direction,ema5,ema13,spread,spreadPct:ema13?spread/ema13*100:0,spreadContracting:contract,spreadChangePct:prev?((Math.abs(spread)-Math.abs(prev))/Math.abs(prev))*100:0,ema5Slope:ema5-p5,ema13Slope:ema13-p13};
}
function logFib(debug:string[],pair:string,d:Direction,f:FibLevels|null,price:number){if(!f||![f.swingLow,f.swingHigh,f.fib382,f.fib50,f.fib618].every(Number.isFinite)){debug.push(`[FIB] ${pair} ${d} | unavailable`);return;}const levels=[["0.382",f.fib382],["0.500",f.fib50],["0.618",f.fib618]] as const,near=levels.reduce((a,b)=>Math.abs(price-b[1])<Math.abs(price-a[1])?b:a);debug.push(`[FIB] ${pair} ${d} | swingLow=${f.swingLow.toFixed(2)} swingHigh=${f.swingHigh.toFixed(2)} | 0.382=${f.fib382.toFixed(2)} 0.500=${f.fib50.toFixed(2)} 0.618=${f.fib618.toFixed(2)} | price=${price.toFixed(2)} nearest=${near[0]} @ ${near[1].toFixed(2)} dist=${(Math.abs(price-near[1])/Math.max(Math.abs(near[1]),1)*100).toFixed(2)}%`);}

function checkEntry1Exhaustion(direction:Direction,r:number,st:{k:number;d:number},trendlineDist:number,adxVal:number){
  // Directional V28.2 exhaustion protection, adapted to the current Fib-based ENTRY_1.
  if(direction==="LONG" && st.k>=99)return{blocked:true,reason:`STOCH_PINNED_LONG K${st.k}`};
  if(direction==="SHORT" && st.k<=1)return{blocked:true,reason:`STOCH_PINNED_SHORT K${st.k}`};
  if(direction==="LONG" && st.k>95 && trendlineDist>0.01)return{blocked:true,reason:`STOCH_EXTREME_LONG K${st.k} + TL ${(trendlineDist*100).toFixed(2)}%`};
  if(direction==="SHORT" && st.k<5 && trendlineDist>0.01)return{blocked:true,reason:`STOCH_EXTREME_SHORT K${st.k} + TL ${(trendlineDist*100).toFixed(2)}%`};
  if(direction==="LONG" && st.k>90 && st.d>90 && trendlineDist>0.02)return{blocked:true,reason:`STOCH_FLAT_EXTREME_LONG K${st.k}/D${st.d} + TL ${(trendlineDist*100).toFixed(2)}%`};
  if(direction==="SHORT" && st.k<10 && st.d<10 && trendlineDist>0.02)return{blocked:true,reason:`STOCH_FLAT_EXTREME_SHORT K${st.k}/D${st.d} + TL ${(trendlineDist*100).toFixed(2)}%`};
  if(direction==="LONG" && adxVal>28 && st.k>90 && st.d>90 && trendlineDist>0.025)return{blocked:true,reason:`ADX_EXTENDED_LONG ADX${adxVal} + K/D ${st.k}/${st.d}`};
  if(direction==="SHORT" && adxVal>28 && st.k<10 && st.d<10 && trendlineDist>0.025)return{blocked:true,reason:`ADX_EXTENDED_SHORT ADX${adxVal} + K/D ${st.k}/${st.d}`};
  if(direction==="LONG" && r>=ENTRY1_LONG_EXHAUSTION_RSI)return{blocked:true,reason:`RSI_EXHAUSTED_LONG RSI ${r}`};
  if(direction==="SHORT" && r<=ENTRY1_SHORT_EXHAUSTION_RSI)return{blocked:true,reason:`RSI_EXHAUSTED_SHORT RSI ${r}`};
  return{blocked:false,reason:""};
}

type Entry1State={
  dailyDirection:"BULL"|"BEAR"|"NEUTRAL";
  dailyPreBreak:boolean;
  dailyRsiTurn:boolean;
  fourHPreBreak:boolean;
  transitionTrigger:boolean;
  setupFresh:boolean;
  exhausted:boolean;
  exhaustionReason:string;
};
type Entry1Decision={direction:Direction;reason:string;trigger:string}|null;
function decideEntry1(state:Entry1State):Entry1Decision{
  if(state.exhausted||!state.setupFresh||!state.dailyPreBreak||!state.dailyRsiTurn||!state.fourHPreBreak||!state.transitionTrigger)return null;
  if(state.dailyDirection==="BULL")return{direction:"LONG",reason:"1D pre-break + RSI turn + 4H pre-break + transition trigger",trigger:"4H_TRANSITION"};
  if(state.dailyDirection==="BEAR")return{direction:"SHORT",reason:"1D pre-break + RSI turn + 4H pre-break + transition trigger",trigger:"4H_TRANSITION"};
  return null;
}
type Entry2State={longRetest:boolean;shortRetest:boolean;longBlocked:boolean;shortBlocked:boolean;};
type Entry2Decision={direction:Direction;reason:string}|null;
function decideEntry2(state:Entry2State):Entry2Decision{
  if(state.longRetest&&!state.shortRetest&&!state.longBlocked)return{direction:"LONG",reason:"4H trendline break + 15M dip/retest"};
  if(state.shortRetest&&!state.longRetest&&!state.shortBlocked)return{direction:"SHORT",reason:"4H trendline break + 15M dip/retest"};
  return null;
}

export function generateSignal(pair:string,candles1h:Candle[],candles4h:Candle[],candles15m:Candle[],activeTrades:any[]=[],currentPrice?:number,lastBreakout?:BreakoutRecord,dailyLive?:DailyLiveContext,candlesWeekly:Candle[]=[],marketHealth?:MarketHealth,nowOverride?:number):SignalResult{
  const debug:string[]=[];const now=nowOverride??Date.now();if(candles4h.length<35){debug.push("Insufficient 4H data");return{debug};}
  const dailyCandles=daily(candles4h);
  const price=currentPrice??candles4h.at(-1)!.close,closed=candles4h.slice(0,-1),localDaily=bias(candles4h),dDir=dailyDirection(dailyLive,localDaily),dailyBreakout=dailyBreakoutContext(candles4h),dailyFade=dailyFadeContext(candles4h),weekly=weeklyDirection(candlesWeekly,price);
  const structure=detectStructureShift(pair,closed),structureDir=structure.state==="HEALTHY"&&(structure.structure==="LONG"||structure.structure==="SHORT")?structure.structure as Direction:null;
  const fourH=get4HEmaDiagnostic(closed),macd=macd4h(closed),closes=closed.map(x=>x.close),st=stochRsi(closes),prevClosed=closed.length>1?closed.slice(0,-1):closed,prevSt=stochRsi(prevClosed.map(x=>x.close)),r=Math.round(rsi(closes)*10)/10,a=adx(closed),av=atr(closed);
  const longTL=buildTrendline(closed,"LONG"),shortTL=buildTrendline(closed,"SHORT"),longFib=getFibLevels(closed,"LONG"),shortFib=getFibLevels(closed,"SHORT");logFib(debug,pair,"LONG",longFib,price);logFib(debug,pair,"SHORT",shortFib,price);
  const longDist=longTL.valid?Math.abs((price-longTL.price)/Math.max(Math.abs(longTL.price),1)):Infinity,shortDist=shortTL.valid?Math.abs((price-shortTL.price)/Math.max(Math.abs(shortTL.price),1)):Infinity;
  const longBuffer=longTL.valid?Math.max(Math.abs(longTL.price)*BREAKOUT_PCT,av*.35):Infinity,shortBuffer=shortTL.valid?Math.max(Math.abs(shortTL.price)*BREAKOUT_PCT,av*.35):Infinity;
  const fibNear=(f:FibLevels|null)=>{if(!f)return null;const levels=[["0.382",f.fib382],["0.500",f.fib50],["0.618",f.fib618]] as const;return levels.reduce((a,b)=>Math.abs(price-b[1])<Math.abs(price-a[1])?b:a);};
  const longFibNearest=fibNear(longFib),shortFibNearest=fibNear(shortFib);
  const longFibDist=longFibNearest?Math.abs((price-longFibNearest[1])/Math.max(Math.abs(longFibNearest[1]),1)):Infinity;
  const shortFibDist=shortFibNearest?Math.abs((price-shortFibNearest[1])/Math.max(Math.abs(shortFibNearest[1]),1)):Infinity;
  const longNearFib=!!longFibNearest&&longFibDist<=ENTRY1_FIB_ZONE_PCT,shortNearFib=!!shortFibNearest&&shortFibDist<=ENTRY1_FIB_ZONE_PCT;
  const longFibPath=getFibPathState(closed,longFib,"LONG"),shortFibPath=getFibPathState(closed,shortFib,"SHORT");
  // A Fib path is timing evidence, not a hidden expiry gate. If price is
  // currently back inside the live Fib zone, that is still a valid location.
  const longPathLocation=!!longFib&&longFibPath.fresh&&(
    (longFibPath.state==="SHALLOW_REVERSAL"&&price<=longFib.swingHigh&&price>=longFib.fib382*(1-ENTRY1_PATH_ZONE_PCT))||
    (longFibPath.state==="DEEP_RECLAIM"&&price<=longFib.swingHigh&&price>=longFib.fib50*(1-ENTRY1_PATH_ZONE_PCT))
  );
  const shortPathLocation=!!shortFib&&shortFibPath.fresh&&(
    (shortFibPath.state==="SHALLOW_REVERSAL"&&price>=shortFib.swingLow&&price<=shortFib.fib382*(1+ENTRY1_PATH_ZONE_PCT))||
    (shortFibPath.state==="DEEP_RECLAIM"&&price>=shortFib.swingLow&&price<=shortFib.fib50*(1+ENTRY1_PATH_ZONE_PCT))
  );
  const longPreBreak=longTL.valid&&price<=longTL.price+longBuffer,shortPreBreak=shortTL.valid&&price>=shortTL.price-shortBuffer;
  // ENTRY_1 momentum diagnostics remain visible, but the decision itself
  // uses the direct 4H transition test below rather than a stacked score.
  const stochLong=st.k>st.d&&st.k>prevSt.k,stochShort=st.k<st.d&&st.k<prevSt.k;
  const macdLong=macd.bullishShift,macdShort=macd.bearishShift;
  const emaLong=fourH.direction==="BULLISH"||fourH.turning&&fourH.direction==="BULLISH";
  const emaShort=fourH.direction==="BEARISH"||fourH.turning&&fourH.direction==="BEARISH";
  const longMomentumCount=[stochLong,macdLong,emaLong].filter(Boolean).length;
  const shortMomentumCount=[stochShort,macdShort,emaShort].filter(Boolean).length;
  const longExhaustion=checkEntry1Exhaustion("LONG",r,st,longDist,a),shortExhaustion=checkEntry1Exhaustion("SHORT",r,st,shortDist,a);
  const longExhausted=longExhaustion.blocked,shortExhausted=shortExhaustion.blocked;
  // Fib decides WHERE through the path; StochRSI + 4H structure decide WHEN.
  // There is still only one ENTRY_1. Shallow/deep are internal path states only.
  const longLocation=longPathLocation||longNearFib,shortLocation=shortPathLocation||shortNearFib;

  // ENTRY_1 is the pre-break entry.
  // Keep the model deliberately simple:
  //   1D = approaching its breakout level + RSI turning from the extreme
  //   4H = approaching its breakout trendline
  //   ENTRY_1 = get positioned before the 4H break
  // ENTRY_2 remains the confirmed 4H breakout -> 15M retest.
  const entryLast=closed.at(-1)!;
  const entryPrior=closed.at(-2)??entryLast;
  const closedE8=ema(closes,TF_FAST);
  const closedE8Now=closedE8.at(-1)??entryLast.close;
  const closedE8Prev=closedE8.at(-2)??entryPrior.close;
  const recentLow=Math.min(...closed.slice(-13,-1).map(x=>x.low));
  const recentHigh=Math.max(...closed.slice(-13,-1).map(x=>x.high));
  const higherLow=entryLast.low>recentLow;
  const lowerHigh=entryLast.high<recentHigh;
  const reclaim8Long=entryLast.close>=closedE8Now&&entryPrior.close<closedE8Prev;
  const reclaim8Short=entryLast.close<=closedE8Now&&entryPrior.close>closedE8Prev;
  const priorHighBreak=entryLast.close>Math.max(...closed.slice(-4,-1).map(x=>x.high));
  const priorLowBreak=entryLast.close<Math.min(...closed.slice(-4,-1).map(x=>x.low));

  // ENTRY_1 is the TRANSITION entry — not a mature-trend entry.
  // The 4H must be leaving the opposite/neutral environment and beginning
  // to turn in the new direction. We deliberately accept the earliest
  // 5/13 transition states (EARLY_* / CROSS) rather than waiting for a
  // fully established 4H trend.
  //
  // A previous bearish 4H plus ANY single fresh bullish timing/structure
  // reaction is also enough. This is intentionally permissive: location and
  // exhaustion remain the separate quality gates. We do not stack indicators.
  const bullStageTransition=
    fourH.stage==="EARLY_BULLISH_L1" ||
    fourH.stage==="EARLY_BULLISH_L2" ||
    fourH.stage==="BULLISH_CROSS";
  const bearStageTransition=
    fourH.stage==="EARLY_BEARISH_L1" ||
    fourH.stage==="EARLY_BEARISH_L2" ||
    fourH.stage==="BEARISH_CROSS";
  const longStructuralConfirmation=
    structure.shiftTo==="LONG" ||
    (higherLow&&(reclaim8Long||priorHighBreak));
  const shortStructuralConfirmation=
    structure.shiftTo==="SHORT" ||
    (lowerHigh&&(reclaim8Short||priorLowBreak));

  // ENTRY_1 catches the transition before a mature 4H trend exists.
  // When the previous 4H was moving the other way, price itself must now
  // show a reaction. Oscillator improvement alone is never enough.
  const longPriceReaction=
    entryLast.close>entryPrior.close ||
    (entryLast.low>=entryPrior.low && entryLast.high>entryPrior.high);
  const shortPriceReaction=
    entryLast.close<entryPrior.close ||
    (entryLast.high<=entryPrior.high && entryLast.low<entryPrior.low);

  // Direction comes from price action. EMA stage/structure diagnostics
  // can describe the transition, but they cannot manufacture an ENTRY_1.
  // This preserves early entries while preventing oscillator/EMA-state
  // combinations from flipping a still-falling market into LONG (or vice versa).
  const long4HTransition=longPriceReaction&&(fourH.direction==="BULLISH"||bullStageTransition||longStructuralConfirmation);
  const short4HTransition=shortPriceReaction&&(fourH.direction==="BEARISH"||bearStageTransition||shortStructuralConfirmation);

  const weeklyLong=weekly.direction==="LONG";
  const weeklyShort=weekly.direction==="SHORT";
  const longRunway=entry1Runway(closed,longFib,price,"LONG");
  const shortRunway=entry1Runway(closed,shortFib,price,"SHORT");
  const longMomentumState=compositeMomentumState(closed,"LONG",st,macd,fourH);
  const shortMomentumState=compositeMomentumState(closed,"SHORT",st,macd,fourH);

  // 1D is directional context AND the early setup.
  // ENTRY_1 fires before the daily structural breakout, with RSI turning
  // from the lower/upper area. The 4H must also be approaching its breakout.
  const dailyClosed=dailyCandles.length>1?dailyCandles.slice(0,-1):dailyCandles;
  const dailyLiveCandle=dailyCandles.at(-1);
  const dailyCloses=dailyClosed.map(x=>x.close);
  const dailyRsiNow=Math.round(rsi(dailyCloses)*10)/10;
  const dailyRsiPrev=dailyClosed.length>1
    ?Math.round(rsi(dailyClosed.slice(0,-1).map(x=>x.close))*10)/10
    :dailyRsiNow;

  const ENTRY1_DAILY_RSI_BOTTOM=40;
  const ENTRY1_DAILY_RSI_TOP=60;
  const dailyPriorHigh=dailyClosed.length>=DAILY_BREAKOUT_LOOKBACK
    ?Math.max(...dailyClosed.slice(-DAILY_BREAKOUT_LOOKBACK).map(x=>x.high)):null;
  const dailyPriorLow=dailyClosed.length>=DAILY_BREAKOUT_LOOKBACK
    ?Math.min(...dailyClosed.slice(-DAILY_BREAKOUT_LOOKBACK).map(x=>x.low)):null;
  const dailyLivePrice=dailyLiveCandle?.close??price;
  const dailyApproachBuffer=(backtestMode==="RELAX_PREBREAK"||backtestMode==="RELAX_RSI_AND_PREBREAK")?0.05:0.015;
  const dailyPreBreakLong=!!dailyPriorHigh&&dailyLivePrice<dailyPriorHigh&&dailyLivePrice>=dailyPriorHigh*(1-dailyApproachBuffer);
  const dailyPreBreakShort=!!dailyPriorLow&&dailyLivePrice>dailyPriorLow&&dailyLivePrice<=dailyPriorLow*(1+dailyApproachBuffer);
  const backtestMode=process.env.BACKTEST_MODE||"BASELINE";
  const dailyRsiLongTurn=backtestMode==="RELAX_RSI"||backtestMode==="RELAX_RSI_AND_PREBREAK" ? dailyRsiNow>dailyRsiPrev : dailyRsiNow<=ENTRY1_DAILY_RSI_BOTTOM&&dailyRsiNow>dailyRsiPrev;
  const dailyRsiShortTurn=backtestMode==="RELAX_RSI"||backtestMode==="RELAX_RSI_AND_PREBREAK" ? dailyRsiNow<dailyRsiPrev : dailyRsiNow>=ENTRY1_DAILY_RSI_TOP&&dailyRsiNow<dailyRsiPrev;

  // ENTRY_2 already owns the breakout trendline. ENTRY_1 uses that same line
  // one step earlier, while price is approaching it.
  const longBreakLine=buildEntry2Trendline(closed,"LONG");
  const shortBreakLine=buildEntry2Trendline(closed,"SHORT");
  const fourHPreBreakBuffer=0.015;
  const longBreakPrice=longBreakLine.valid?lineAt(longBreakLine,closed.length-1):null;
  const shortBreakPrice=shortBreakLine.valid?lineAt(shortBreakLine,closed.length-1):null;
  const fourHPreBreakLong=!!longBreakPrice&&price<longBreakPrice&&
    (longBreakPrice-price)/Math.max(longBreakPrice,1)<=fourHPreBreakBuffer;
  const fourHPreBreakShort=!!shortBreakPrice&&price>shortBreakPrice&&
    (price-shortBreakPrice)/Math.max(shortBreakPrice,1)<=fourHPreBreakBuffer;

  // Fresh approach prevents the same ENTRY_1 from firing every cron cycle.
  const previousBreakIndex=Math.max(0,closed.length-2);
  const entry1PreviousLongLine=longBreakLine.valid?lineAt(longBreakLine,previousBreakIndex):null;
  const entry1PreviousShortLine=shortBreakLine.valid?lineAt(shortBreakLine,previousBreakIndex):null;
  const previousLongDistance=entry1PreviousLongLine===null?Infinity:
    (entry1PreviousLongLine-closed[previousBreakIndex].close)/Math.max(entry1PreviousLongLine,1);
  const previousShortDistance=entry1PreviousShortLine===null?Infinity:
    (closed[previousBreakIndex].close-entry1PreviousShortLine)/Math.max(entry1PreviousShortLine,1);
  const freshLongPreBreak=fourHPreBreakLong&&previousLongDistance>fourHPreBreakBuffer;
  const freshShortPreBreak=fourHPreBreakShort&&previousShortDistance>fourHPreBreakBuffer;

  const shortFadeEntry1=dailyFade.shortWatch;

  // ENTRY_1 is deliberately lean: setup + one meaningful 4H trigger + exhaustion veto.
  // The existing fresh-pre-break test is the setup dedupe; no arbitrary cooldown is added.
  const longEntry1Decision=decideEntry1({
    dailyDirection:dDir,
    dailyPreBreak:dailyPreBreakLong,
    dailyRsiTurn:dailyRsiLongTurn,
    fourHPreBreak:freshLongPreBreak,
    transitionTrigger:long4HTransition,
    setupFresh:freshLongPreBreak,
    exhausted:longExhausted,
    exhaustionReason:longExhaustion.reason
  });
  const shortEntry1Decision=decideEntry1({
    dailyDirection:dDir,
    dailyPreBreak:dailyPreBreakShort,
    dailyRsiTurn:dailyRsiShortTurn,
    fourHPreBreak:freshShortPreBreak,
    transitionTrigger:short4HTransition,
    setupFresh:freshShortPreBreak,
    exhausted:shortExhausted,
    exhaustionReason:shortExhaustion.reason
  });
  const longEntry1=!!longEntry1Decision;
  const shortEntry1=!!shortEntry1Decision;

  debug.push(`[1W] ${pair} | ${weekly.direction||"NEUTRAL"} | direction=${weekly.direction||"NEUTRAL"} | ${weekly.reason} | 5/13=${weekly.ema5.toFixed(2)}/${weekly.ema13.toFixed(2)} | ADX=${weekly.adx}`);
  debug.push(`[1D] ${pair} | ${dailyLive?.state||"LOCAL"}/${dailyLive?.candidateState||"—"} | ${dDir} | ${((weeklyLong&&dDir==="BULL")||(weeklyShort&&dDir==="BEAR"))?"SUPPORTIVE":"COUNTER/NEUTRAL"}`);
  debug.push(`[4H] ${pair} | 5/13=${fourH.label} | MACD=${macd.bullishShift?"BULL_IMPROVING":macd.bearishShift?"BEAR_IMPROVING":"NEUTRAL"} | Stoch=${st.k}/${st.d} prev=${prevSt.k}/${prevSt.d} | Momentum=${compositeMomentumState(closed,structureDir||(dDir==="BEAR"?"SHORT":"LONG"),st,macd,fourH)}`);
  debug.push(`[TL] ${pair} | LONG=${longTL.valid?longTL.price.toFixed(2):"—"} dist=${isFinite(longDist)?(longDist*100).toFixed(2)+"%":"—"} | SHORT=${shortTL.valid?shortTL.price.toFixed(2):"—"} dist=${isFinite(shortDist)?(shortDist*100).toFixed(2)+"%":"—"}`);
  debug.push(`[1D FADE WATCH] ${pair} | shortWatch=${dailyFade.shortWatch?"YES":"NO"} | failedBreak=${dailyFade.failedBreak?"YES":"NO"} | level=${dailyFade.level?.toFixed(2)||"—"} | dist=${Number.isFinite(dailyFade.distPct)?dailyFade.distPct.toFixed(2)+"%":"—"} | Stoch=${dailyFade.stochK}/${dailyFade.stochD} | ${dailyFade.reason||"NONE"}`);
  debug.push(`[ENTRY_1 EXHAUSTION] ${pair} | RSI=${r} | LONG=${longExhausted?"BLOCK":"CLEAR"}${longExhaustion.reason?` (${longExhaustion.reason})`:""} | SHORT=${shortExhausted?"BLOCK":"CLEAR"}${shortExhaustion.reason?` (${shortExhaustion.reason})`:""}`);
  debug.push(`[FIB PATH] ${pair} | LONG=${longFibPath.state}/${longFibPath.trigger} age=${Number.isFinite(longFibPath.triggerAge)?longFibPath.triggerAge:"—"} fresh=${longFibPath.fresh?"YES":"NO"} | SHORT=${shortFibPath.state}/${shortFibPath.trigger} age=${Number.isFinite(shortFibPath.triggerAge)?shortFibPath.triggerAge:"—"} fresh=${shortFibPath.fresh?"YES":"NO"}`);
  debug.push(`[ENTRY_1 DECISION] ${pair} | 1D=${dDir} | 1D_PREBREAK=${dailyPreBreakLong?"LONG":dailyPreBreakShort?"SHORT":"NONE"} | 1D_RSI=${dailyRsiNow}/${dailyRsiPrev} | RSI_TURN=${dailyRsiLongTurn?"LONG":dailyRsiShortTurn?"SHORT":"NONE"} | 4H_PREBREAK=${freshLongPreBreak?"LONG":freshShortPreBreak?"SHORT":"NONE"} | TRIGGER=${long4HTransition?"LONG":short4HTransition?"SHORT":"NONE"} | FRESH=${freshLongPreBreak||freshShortPreBreak?"YES":"NO"} | finalDecision=${longEntry1?"LONG_ENTRY_1":shortEntry1?"SHORT_ENTRY_1":"NONE"}`);

  const fallbackDir:Direction=weekly.direction||(dDir==="BEAR"?"SHORT":"LONG");
  const baseMarket=()=>snapshot(pair,candles4h,structureDir||fallbackDir,structureDir==="LONG"?longTL:structureDir==="SHORT"?shortTL:longTL,price,dailyLive);
  const market=(m:any)=>Object.assign(m||baseMarket(),{
    dailyDirection:dDir,weeklyDirection:weekly.direction,weeklyDirectionReason:weekly.reason,weeklySupportive:(weeklyLong&&dDir==="BULL")||(weeklyShort&&dDir==="BEAR"),entry1Direction:longEntry1?"LONG":shortEntry1?"SHORT":"NEUTRAL",entry1Decision:longEntry1?"LONG_ENTRY_1":shortEntry1?"SHORT_ENTRY_1":"NONE",
    entry1TriggersLong:longMomentumCount,entry1TriggersShort:shortMomentumCount,entry1MomentumStateLong:longMomentumState,entry1MomentumStateShort:shortMomentumState,entry1StructuralLocation:longLocation?"LONG":shortLocation?"SHORT":"NONE",
    entry1FibPathLong:longFibPath,entry1FibPathShort:shortFibPath,dailyFadeContext:dailyFade,
    entry1NearTL:longNearFib&&!shortNearFib?"LONG":shortNearFib&&!longNearFib?"SHORT":"NONE",entry1LiveNearTL:longNearFib&&!shortNearFib?"LONG":shortNearFib&&!longNearFib?"SHORT":"NONE",
    entry1LiveDistPct:longEntry1?longDist*100:shortEntry1?shortDist*100:null,entry1PreBreak:longPreBreak||shortPreBreak,
    entry1ExecutionAllowed:longEntry1||shortEntry1,weeklyGateLong:false,weeklyGateShort:false,volatilityPct:price>0?round((av/price)*100):0,entry1MaxEntry:longNearFib&&longFibNearest?round(longFibNearest[1]*(1+ENTRY1_FIB_ZONE_PCT)):shortNearFib&&shortFibNearest?round(shortFibNearest[1]*(1-ENTRY1_FIB_ZONE_PCT)):null,
    entry1Chase:false,entry1Exhaustion:longExhausted?"LONG":shortExhausted?"SHORT":"NONE",entry1DailyConflict:"NONE",entry1ClosedRsi:r,entry1CheckLong:{direction:"LONG",dailyPreBreak:dailyPreBreakLong,dailyPreBreakDistancePct:dailyPriorHigh?((dailyPriorHigh-dailyLivePrice)/Math.max(dailyPriorHigh,1))*100:null,dailyRsi:dailyRsiNow,dailyRsiPrev:dailyRsiPrev,dailyRsiTurn:dailyRsiLongTurn,fourHPreBreak:freshLongPreBreak,fourHPreBreakDistancePct:longBreakPrice?((longBreakPrice-price)/Math.max(longBreakPrice,1))*100:null,transition:long4HTransition,fresh:freshLongPreBreak,exhausted:longExhausted,exhaustionReason:longExhaustion.reason,decision:longEntry1?"ENTRY_1":"WAIT"},entry1CheckShort:{direction:"SHORT",dailyPreBreak:dailyPreBreakShort,dailyPreBreakDistancePct:dailyPriorLow?((dailyLivePrice-dailyPriorLow)/Math.max(dailyPriorLow,1))*100:null,dailyRsi:dailyRsiNow,dailyRsiPrev:dailyRsiPrev,dailyRsiTurn:dailyRsiShortTurn,fourHPreBreak:freshShortPreBreak,fourHPreBreakDistancePct:shortBreakPrice?((price-shortBreakPrice)/Math.max(shortBreakPrice,1))*100:null,transition:short4HTransition,fresh:freshShortPreBreak,exhausted:shortExhausted,exhaustionReason:shortExhaustion.reason,decision:shortEntry1?"ENTRY_1":"WAIT"},
    entry1Grade:longEntry1||shortEntry1?"A":null,entry1TriggerThreshold:1,entry1MomentumRequired:true,entry1ExhaustionThreshold:dDir==="BULL"?ENTRY1_LONG_EXHAUSTION_RSI:ENTRY1_SHORT_EXHAUSTION_RSI,entry1DailyPreBreakLong:dailyPreBreakLong,entry1DailyPreBreakShort:dailyPreBreakShort,entry1DailyRsi:dailyRsiNow,entry1DailyRsiPrev:dailyRsiPrev,entry1DailyRsiTurnLong:dailyRsiLongTurn,entry1DailyRsiTurnShort:dailyRsiShortTurn,entry1FourHPreBreakLong:freshLongPreBreak,entry1FourHPreBreakShort:freshShortPreBreak,entry1FourHBreakLineLong:longBreakPrice,entry1FourHBreakLineShort:shortBreakPrice,dailyFadeShortWatch:dailyFade.shortWatch,dailyFadeFailedBreak:dailyFade.failedBreak,dailyFadeLevel:dailyFade.level,dailyFadeStochK:dailyFade.stochK,dailyFadeStochD:dailyFade.stochD
  });

  const closedIndex=closed.length-1;

  // ENTRY_2 is deliberately NOT a closed-4H signal anymore.
  // The current 4H candle may break the confirmed structural line in real time,
  // but merely being beyond the line is NOT a breakout. We require a fresh
  // cross from the correct side during the current developing 4H candle.
  const developing4HIndex=candles4h.length-1;
  const developing4H=candles4h.at(-1)!;
  const previous4H=closed.at(-1)!;
  const entry2LongTL=buildEntry2Trendline(closed,"LONG");
  const entry2ShortTL=buildEntry2Trendline(closed,"SHORT");
  const developingLongLine=entry2LongTL.valid?lineAt(entry2LongTL,developing4HIndex):null;
  const developingShortLine=entry2ShortTL.valid?lineAt(entry2ShortTL,developing4HIndex):null;
  const previousLongLine=entry2LongTL.valid?lineAt(entry2LongTL,closed.length-1):null;
  const previousShortLine=entry2ShortTL.valid?lineAt(entry2ShortTL,closed.length-1):null;
  const longBreakBuffer=developingLongLine===null?0:Math.max(av*TL_BREAK_ATR,Math.abs(developingLongLine)*BREAKOUT_PCT);
  const shortBreakBuffer=developingShortLine===null?0:Math.max(av*TL_BREAK_ATR,Math.abs(developingShortLine)*BREAKOUT_PCT);

  // LONG: previous closed 4H close was at/below resistance and the current
  // developing 4H candle trades above it by the breakout buffer.
  // SHORT: previous closed 4H close was at/above support and the current
  // developing 4H candle trades below it by the breakout buffer.
  const current4HBreakLong=!!developingLongLine&&!!previousLongLine&&
    previous4H.close<=previousLongLine&&
    developing4H.high>developingLongLine+longBreakBuffer;
  const current4HBreakShort=!!developingShortLine&&!!previousShortLine&&
    previous4H.close>=previousShortLine&&
    developing4H.low<developingShortLine-shortBreakBuffer;

  // Persisted breakouts are only usable while recent. This prevents a stale
  // historical ENTRY_2 from creating a new retest long after the breakout.
  const breakoutMaxAgeMs=TL_BREAK_WINDOW_15M*15*60*1000;
  const persistedLongBreak=!!lastBreakout&&lastBreakout.direction==="LONG"&&now-lastBreakout.timestamp>=0&&now-lastBreakout.timestamp<=breakoutMaxAgeMs;
  const persistedShortBreak=!!lastBreakout&&lastBreakout.direction==="SHORT"&&now-lastBreakout.timestamp>=0&&now-lastBreakout.timestamp<=breakoutMaxAgeMs;

  // 15M is execution only. It no longer gets to invent a breakout by scanning
  // historical 15M candles. A valid 4H break must exist first.
  const longExec=detect15mTrendlineRetest(candles15m,candles4h,entry2LongTL,"LONG",persistedLongBreak||current4HBreakLong,
    persistedLongBreak?lastBreakout?.timestamp:candles15m.at(-1)?.timestamp);
  const shortExec=detect15mTrendlineRetest(candles15m,candles4h,entry2ShortTL,"SHORT",persistedShortBreak||current4HBreakShort,
    persistedShortBreak?lastBreakout?.timestamp:candles15m.at(-1)?.timestamp);

  const breakoutLong=current4HBreakLong||persistedLongBreak;
  const breakoutShort=current4HBreakShort||persistedShortBreak;
  const breakoutTimestamp=candles15m.at(-1)?.timestamp??now;
  const detectedBreakout:BreakoutRecord|undefined=current4HBreakLong
    ? {direction:"LONG",price:round(developingLongLine??price),timestamp:breakoutTimestamp,candleIndex:developing4HIndex}
    : current4HBreakShort
      ? {direction:"SHORT",price:round(developingShortLine??price),timestamp:breakoutTimestamp,candleIndex:developing4HIndex}
      : undefined;
  const retestLong=longExec.retest;
  const retestShort=shortExec.retest;

  let dir:Direction|null=null,type:"ENTRY_1"|"ENTRY_2"|null=null,reason="";
  // ENTRY_2 remains the confirmed breakout/retest path. Keep it isolated from ENTRY_1.
  const entry2Decision=decideEntry2({
    longRetest:retestLong,
    shortRetest:retestShort,
    longBlocked:same(pair,"LONG",activeTrades),
    shortBlocked:same(pair,"SHORT",activeTrades)
  });
  if(entry2Decision){dir=entry2Decision.direction;type="ENTRY_2";reason=entry2Decision.reason;}
  else if(longEntry1Decision&&!shortEntry1Decision){dir="LONG";type="ENTRY_1";reason=longEntry1Decision.reason;}
  else if(shortEntry1Decision&&!longEntry1Decision){dir="SHORT";type="ENTRY_1";reason=shortEntry1Decision.reason;}
  debug.push(`[4H BREAK] ${pair} | LONG prevClose=${previous4H.close.toFixed(2)} prevLine=${previousLongLine?.toFixed(2)||"—"} currentHigh=${developing4H.high.toFixed(2)} currentLine=${developingLongLine?.toFixed(2)||"—"} crossed=${current4HBreakLong?"YES":"NO"} | SHORT prevClose=${previous4H.close.toFixed(2)} prevLine=${previousShortLine?.toFixed(2)||"—"} currentLow=${developing4H.low.toFixed(2)} currentLine=${developingShortLine?.toFixed(2)||"—"} crossed=${current4HBreakShort?"YES":"NO"}`);
  debug.push(`[ENTRY_2] ${pair} | LONG break=${breakoutLong?"YES":"NO"} retest=${retestLong?"YES":"NO"} line=${longExec.linePrice?.toFixed(2)||"—"} reason=${longExec.reason} | SHORT break=${breakoutShort?"YES":"NO"} retest=${retestShort?"YES":"NO"} line=${shortExec.linePrice?.toFixed(2)||"—"} reason=${shortExec.reason}`);

  if(!dir||!type){debug.push(`[ENTRY_1 WAIT] ${pair} | ${longExhausted&&longLocation?`LONG exhaustion veto: ${longExhaustion.reason}`:shortExhausted&&shortLocation?`SHORT exhaustion veto: ${shortExhaustion.reason}`:!weekly.direction?"waiting for clear 1W direction":weeklyLong&&dDir!=="BULL"?"1W bullish opportunity with 1D counter-context":weeklyShort&&dDir!=="BEAR"?"1W bearish opportunity with 1D counter-context":weeklyLong&&!long4HTransition?"waiting for bullish 4H setup":weeklyShort&&!short4HTransition?"waiting for bearish 4H setup":dDir==="BULL"&&!longLocation?"waiting for price to approach bullish structural area":dDir==="BEAR"&&!shortLocation?"waiting for price to approach bearish structural area":"waiting for next valid setup"}`);return{market:market(baseMarket()),debug};}
  if(opposite(pair,dir,activeTrades)){debug.push(`[SIGNAL BLOCK] ${pair} ${dir} | opposite position active`);return{market:market(baseMarket()),debug};}
  const tl=type==="ENTRY_2"
    ? (dir==="LONG"?entry2LongTL:entry2ShortTL)
    : (dir==="LONG"?longTL:shortTL);
  if(!tl.valid&&type==="ENTRY_2"){debug.push(`[SIGNAL BLOCK] ${pair} ${dir} | no valid structural trendline`);return{market:market(baseMarket()),debug};}
  const reference=tl.valid?tl.price:price,distance=Math.abs((price-reference)/Math.max(Math.abs(reference),1));
  // ENTRY_1 no longer has a trendline-distance execution veto. Fib proximity is the location test.

  const entry=price,structuralStop=dir==="LONG"?Math.min(...closed.slice(-10).map(x=>x.low),entry-av*2):Math.max(...closed.slice(-10).map(x=>x.high),entry+av*2);
  const liquidation=liq(entry,dir),safe=dir==="LONG"?liquidation*(1+LIQ_BUFFER):liquidation*(1-LIQ_BUFFER),stop=dir==="LONG"?Math.max(structuralStop,safe):Math.min(structuralStop,safe);
  const structuralRisk=Math.abs(entry-structuralStop);if(!structuralRisk)return{debug};const risk=Math.abs(entry-stop);if(!risk)return{debug};
  const fib=dir==="LONG"?longFib:shortFib;
  // TP1/TP2 must be distinct. Prefer nearby structural/Fib targets, but if
  // the setup only exposes one valid forward level (as BTC did), use the
  // position risk to create a genuine R1.5 final target instead of collapsing
  // TP1 and TP2 onto the same level.
  const rawForwardLevels=dir==="LONG"
    ? [fib?.fib50,fib?.fib382,fib?.swingHigh].filter((x):x is number=>Number.isFinite(x)&&x>entry)
    : [fib?.fib50,fib?.fib382,fib?.swingLow].filter((x):x is number=>Number.isFinite(x)&&x<entry);
  const forwardLevels=[...new Set(rawForwardLevels)].sort((x,y)=>dir==="LONG"?x-y:y-x);
  // TP1 must be a meaningful move, not simply the nearest Fib level.
  // Reject levels that are too close to entry and step forward to the next
  // structural/Fib level. The floor is volatility-aware so this works across
  // BTC/ETH and higher-beta alts without imposing one fixed percentage.
  const minTp1Distance=Math.max(entry*0.0035,av*0.5);
  const meaningfulForwardLevels=forwardLevels.filter(x=>Math.abs(x-entry)>=minTp1Distance);
  const locationDiag=locationQuality(closed,dir==="LONG"?longFib:shortFib,dir==="LONG"?longTL:shortTL,price,dir);
  const compressionDiag=compressionContext(closed);
  const runway=type==="ENTRY_1"?(dir==="LONG"?longRunway:shortRunway):{available:true,pct:Infinity,obstacle:null,preferred:true};
  const entry1MinTarget=entry*(1+ENTRY1_MIN_RUNWAY_PCT*(dir==="LONG"?1:-1));
  const entry1PreferredTarget=entry*(1+ENTRY1_PREFERRED_RUNWAY_PCT*(dir==="LONG"?1:-1));
  const tp1=type==="ENTRY_1"
    ? (runway.obstacle!==null?(dir==="LONG"?Math.min(runway.obstacle,entry1MinTarget):Math.max(runway.obstacle,entry1MinTarget)):entry1MinTarget)
    : (meaningfulForwardLevels[0]??(dir==="LONG"?entry+minTp1Distance:entry-minTp1Distance));
  const riskTarget15=dir==="LONG"?entry+risk*1.5:entry-risk*1.5;
  const secondStructural=meaningfulForwardLevels.find(x=>dir==="LONG"?x>tp1:x<tp1);
  const tp2=type==="ENTRY_1"
    ? (runway.obstacle!==null?(dir==="LONG"?Math.min(runway.obstacle,entry1PreferredTarget):Math.max(runway.obstacle,entry1PreferredTarget)):entry1PreferredTarget)
    : (secondStructural!==undefined?(dir==="LONG"?Math.max(secondStructural,riskTarget15):Math.min(secondStructural,riskTarget15)):riskTarget15);
  const target=tp2;
  const tp1Move=Math.abs(tp1-entry)/Math.max(entry,1),tp2Move=Math.abs(tp2-entry)/Math.max(entry,1);
  const dailyAligned=(dDir==="BULL"&&dir==="LONG")||(dDir==="BEAR"&&dir==="SHORT");
  const volatilityPct=entry>0?(av/entry)*100:0;
  const volatilityMultiplier=volatilitySizeMultiplier(entry,av);
  const riskMultiplier=(dailyAligned?1:0.5)*volatilityMultiplier;
  const trendAlignment=dailyAligned?"WITH_1D":"AGAINST_1D";
  const breakoutRecord:BreakoutRecord|undefined=type==="ENTRY_2"?(dir==="LONG"?{direction:"LONG",price:round(longExec.linePrice??price),timestamp:now,candleIndex:developing4HIndex}:{direction:"SHORT",price:round(shortExec.linePrice??price),timestamp:now,candleIndex:developing4HIndex}):undefined;
  const location=type==="ENTRY_1"?"EARLY_STRUCTURAL":"15M_TRENDLINE_RETEST";
  const entry1Trigger=type==="ENTRY_1"&&dir==="SHORT"&&shortFadeEntry1?"1D_OVERBOUGHT_RESISTANCE→4H_FADE":"1D_BREAKOUT→4H_TRANSITION";
  const trigger=type==="ENTRY_1"?(entry1Trigger||"4H_STRUCTURE_REACTION"):"4H_BREAKOUT→15M_DIP";
  const actualRr=Math.abs(tp1-entry)/Math.max(risk,1e-9);
  if(actualRr<MIN_RR){debug.push(`[SIGNAL BLOCK] ${pair} ${dir} ${type} | TP1 RR ${actualRr.toFixed(2)} < MIN_RR ${MIN_RR}`);return{market:market(baseMarket()),debug};}
  const signal:Signal={id:`${pair}_${type}_${now}`,pair,direction:dir,type,scale:type,entry:round(entry),stop:round(stop),target:round(target),tp1:round(tp1),tp2:round(tp2),confidence:type==="ENTRY_1"?70:type==="ENTRY_2"?80:85,rr:Math.round(actualRr*100)/100,adx:a,rsi:r,stochK:st.k,stochD:st.d,expectedMove:Math.round(tp2Move*1000)/10,reason:`${dir} ${type} | ${reason} | ${trendAlignment}`,timestamp:now,version:CURRENT_SIGNAL_VERSION,trend:`${dir} | 1W ${weekly.direction||"NEUTRAL"} | 1D ${dDir} | 4H ${strength(dailyCandles,dir)}`,location,trigger,context:{
    marketPhase:type==="ENTRY_1"?`${dir} PROBABILITY EARLY SETUP`:`${dir} CONFIRMED ENTRY_2`,
    structure:structureDir?`4H ${structureDir}`:"4H STRUCTURE TRANSITION",momentum:`RSI ${r} | Stoch ${st.k}/${st.d} | MACD hist ${round(macd.histogram)}`,
    pullback:type==="ENTRY_2"?"15M_DIP_TO_4H_TRENDLINE":dir==="LONG"?longFibPath.trigger:shortFibPath.trigger,
    fourH513:fourH,daily513:getDaily513Diagnostic(candles4h),dailyLive:dailyLive||null,weeklyDirection:weekly.direction,weeklyContext:weekly,macd4h:macd,trendAlignment,sizeMultiplier:riskMultiplier,entry1Trigger:entry1Trigger||null,dailyBreakout:dailyBreakout||null,dailyFade:{shortWatch:!!dailyFade.shortWatch,failedBreak:!!dailyFade.sweptAndRejected,level:dailyFade.level??null,stochK:dailyFade.stochK??null,stochD:dailyFade.stochD??null},runway:{available:runway.available,pct:Number.isFinite(runway.pct)?round(runway.pct*100):null,preferred:!!runway.preferred,obstacle:runway.obstacle??null},momentumState:dir==="LONG"?longMomentumState:shortMomentumState,marketHealth:marketHealth||null,locationQuality:locationDiag,compression:compressionDiag,
    risk:{baseRisk:round(risk),structuralRisk:round(structuralRisk),positionSize:round(risk*riskMultiplier),trendAlignment,sizeMultiplier:riskMultiplier,volatilityPct:round(volatilityPct),volatilityMultiplier,estimatedLiquidation:round(liquidation),safeBoundary:round(safe),leverage:LEVERAGE},
    entryGuard:{referenceFib:dir==="LONG"?longFibNearest:shortFibNearest,referenceTrendline:dir==="LONG"?(longTL.valid?round(longTL.price):null):(shortTL.valid?round(shortTL.price):null),trendlineDistancePct:round((dir==="LONG"?longDist:shortDist)*100),executionDistancePct:round((dir==="LONG"?longFibDist:shortFibDist)*100),maxEntry:dir==="LONG"?(longFibNearest?round(longFibNearest[1]):null):(shortFibNearest?round(shortFibNearest[1]):null),maxDistancePct:ENTRY1_FIB_ZONE_PCT*100},
    entry1CandleTimestamp:entryLast.timestamp,entry1ClosedCandleIndex:closed.length-1,volatilityPct:round(volatilityPct),volatilityMultiplier,
    fibPath:dir==="LONG"?longFibPath:shortFibPath,
    exhaustion:{closedRsi:r,longBlocked:longExhausted,shortBlocked:shortExhausted,longReason:longExhaustion.reason,shortReason:shortExhaustion.reason,longThreshold:ENTRY1_LONG_EXHAUSTION_RSI,shortThreshold:ENTRY1_SHORT_EXHAUSTION_RSI,stochK:st.k,stochD:st.d,adx:a,trendlineDistanceLongPct:round(longDist*100),trendlineDistanceShortPct:round(shortDist*100)},
    breakoutRecord:breakoutRecord?{direction:breakoutRecord.direction,price:round(breakoutRecord.price),timestamp:breakoutRecord.timestamp,candleIndex:breakoutRecord.candleIndex}:undefined,
    stages:{tp1:round(tp1),tp2:round(tp2),tp1MovePct:round(tp1Move*100),tp2MovePct:round(tp2Move*100)}
  }};
  debug.push(`[RISK] ${pair} ${dir} | structuralSL=${round(structuralStop)} | liquidation=${round(liquidation)} | safeBoundary=${round(safe)} | finalSL=${round(stop)}`);
  debug.push(`[SIGNAL] ${pair} — ${type} ${dir} @ ${signal.entry} | SL ${signal.stop} | TP1 ${signal.tp1} (${(tp1Move*100).toFixed(2)}%) | TP2 ${signal.tp2} (${(tp2Move*100).toFixed(2)}%) | ${trendAlignment} | size x${riskMultiplier}`);
  return{signal,signals:[signal],market:market(snapshot(pair,candles4h,dir,tl,price,dailyLive)),debug,breakout:detectedBreakout};
}

export function getCycleRunnerSnapshot(pair:string,candles1h:Candle[],candles4h:Candle[],candlesWeekly:Candle[],currentPrice?:number){
  const price=currentPrice??candles4h.at(-1)?.close??candles1h.at(-1)?.close??0;
  const weeklyClosed=candlesWeekly.length>1?candlesWeekly.slice(0,-1):candlesWeekly;
  const weeklyCloses=weeklyClosed.map(x=>x.close),wf=ema(weeklyCloses,5).at(-1)??0,ws=ema(weeklyCloses,13).at(-1)??0;
  const weeklyDirection=wf>ws?"LONG":wf<ws?"SHORT":"NEUTRAL";
  const fourHClosed=candles4h.length>1?candles4h.slice(0,-1):candles4h;
  const oneHClosed=candles1h.length>1?candles1h.slice(0,-1):candles1h;
  const fourDir=bias(fourHClosed);
  const structure=detectStructureShift(pair,candles4h);
  const dailyTransition=getDaily513Diagnostic(candles4h);
  const fourFibLong=getFibLevels(fourHClosed,"LONG"),fourFibShort=getFibLevels(fourHClosed,"SHORT");
  const oneFibLong=getFibLevels(oneHClosed,"LONG"),oneFibShort=getFibLevels(oneHClosed,"SHORT");
  const oneCloses=oneHClosed.map(x=>x.close),oneSt=stochRsi(oneCloses),onePrev=oneHClosed.length>20?stochRsi(oneHClosed.slice(0,-1).map(x=>x.close)):oneSt;
  // Cycle Runner is a major-cycle entry, not a normal 4H bounce. Keep the
  // precision trigger on 1H, but require the higher timeframes to stop being
  // vertically extended before declaring ENTRY READY.
  const dailyClosed=daily(fourHClosed).slice(0,-1);
  const dailySt=stochRsi(dailyClosed.map(x=>x.close)),dailyStPrev=dailyClosed.length>20?stochRsi(dailyClosed.slice(0,-1).map(x=>x.close)):dailySt;
  const weeklySt=stochRsi(weeklyClosed.map(x=>x.close)),weeklyStPrev=weeklyClosed.length>20?stochRsi(weeklyClosed.slice(0,-1).map(x=>x.close)):weeklySt;
  const dailyOverheated=dailySt.k>=90;
  const weeklyOverheated=weeklySt.k>=90;
  const higherTimeframeReset=!dailyOverheated&&!weeklyOverheated;
  const oneTurnLong=oneSt.k>oneSt.d&&oneSt.k>onePrev.k,oneTurnShort=oneSt.k<oneSt.d&&oneSt.k<onePrev.k;
  const near=(levels:{level:number;name:string}[]|undefined)=>levels?.length?levels.map(x=>({...x,distPct:Math.abs((price-x.level)/Math.max(Math.abs(x.level),1))*100})).sort((a,b)=>a.distPct-b.distPct)[0]:undefined;
  const fib4Long=near(fourFibLong?[{level:fourFibLong.fib382,name:"0.382"},{level:fourFibLong.fib50,name:"0.500"},{level:fourFibLong.fib618,name:"0.618"}]:undefined);
  const fib4Short=near(fourFibShort?[{level:fourFibShort.fib382,name:"0.382"},{level:fourFibShort.fib50,name:"0.500"},{level:fourFibShort.fib618,name:"0.618"}]:undefined);
  const fib1Long=near(oneFibLong?[{level:oneFibLong.fib382,name:"0.382"},{level:oneFibLong.fib50,name:"0.500"},{level:oneFibLong.fib618,name:"0.618"}]:undefined);
  const fib1Short=near(oneFibShort?[{level:oneFibShort.fib382,name:"0.382"},{level:oneFibShort.fib50,name:"0.500"},{level:oneFibShort.fib618,name:"0.618"}]:undefined);

  // The Cycle Runner's job is to catch the TREND CHANGE, not a mature trend.
  // Weekly direction is context only. It must never veto a genuine 4H transition.
  // The core entry is deliberately simple:
  //   1) 4H has turned/confirmed in one direction
  //   2) price has retraced deeply into the 0.500/0.618 area of that 4H impulse
  //   3) 1H momentum turns back in the same direction
  // Nothing from the day-trading engine (trendlines, RSI exhaustion, Entry 1/2, ADDs)
  // is allowed to veto this cycle entry.
  const structuralTurnLong=structure.shiftTo==="LONG"||structure.structure==="LONG";
  const structuralTurnShort=structure.shiftTo==="SHORT"||structure.structure==="SHORT";
  const dailyTransitionLong=dailyTransition.stage==="EARLY_BULLISH"||dailyTransition.direction==="BULLISH";
  const dailyTransitionShort=dailyTransition.stage==="EARLY_BEARISH"||dailyTransition.direction==="BEARISH";
  const trendChangeLong=fourDir==="LONG"&&(structuralTurnLong||dailyTransitionLong);
  const trendChangeShort=fourDir==="SHORT"&&(structuralTurnShort||dailyTransitionShort);

  const selectedLong=trendChangeLong&&!!fib4Long&&fib4Long.distPct<=2.0;
  const selectedShort=trendChangeShort&&!!fib4Short&&fib4Short.distPct<=2.0;
  const selectedDirection=selectedLong?"LONG":selectedShort?"SHORT":fourDir||weeklyDirection;
  const selectedFib4=selectedDirection==="LONG"?fib4Long:fib4Short;
  const selectedFib1=selectedDirection==="LONG"?fib1Long:fib1Short;
  const selectedLevels=selectedDirection==="LONG"?fourFibLong:fourFibShort;
  const depth=selectedFib4?.name==="0.618"?3:selectedFib4?.name==="0.500"?2:selectedFib4?.name==="0.382"?1:0;
  const oneTurn=selectedDirection==="LONG"?oneTurnLong:oneTurnShort;
  const trendChangeConfirmed=selectedDirection==="LONG"?trendChangeLong:trendChangeShort;
  const precision=!!selectedFib4&&selectedFib4.distPct<=1.0&&oneTurn&&fourDir===selectedDirection&&trendChangeConfirmed;
  const deepRetest=!!selectedFib4&&selectedFib4.distPct<=1.0&&(selectedFib4.name==="0.500"||selectedFib4.name==="0.618");
  // A deep 4H retracement plus a 1H turn is not enough for the one-shot
  // cycle position if both daily and weekly Stoch RSI are still pinned at the
  // top. This specifically prevents a local 4H pullback inside an extended
  // higher-timeframe trend from being labelled a cycle entry.
  const ready=pair==="BTC"||pair==="ETH"?deepRetest&&oneTurn&&trendChangeConfirmed&&higherTimeframeReset:false;
  const direction=selectedDirection;

  return{
    enabled:pair==="BTC"||pair==="ETH",
    status:ready?"ENTRY READY":!higherTimeframeReset?"HTF MOMENTUM TOO HOT":deepRetest&&!oneTurn?"DEEP RETEST · WAIT 1H TURN":selectedLong||selectedShort?"MAJOR RETEST · WAIT":"WAITING FOR TREND CHANGE / MAJOR RETEST",
    direction,weeklyDirection,fourHDirection:fourDir||"NEUTRAL",weeklyFast:round(wf),weeklySlow:round(ws),
    trendChangeConfirmed,structureShift:structure.shiftTo,dailyTransition:dailyTransition.stage,
    fourHFib:{direction:direction==="LONG"?"LONG":"SHORT",swingLow:selectedLevels?.swingLow??null,swingHigh:selectedLevels?.swingHigh??null,fib382:selectedLevels?.fib382??null,fib50:selectedLevels?.fib50??null,fib618:selectedLevels?.fib618??null,nearest:selectedFib4?{level:selectedFib4.level,distPct:selectedFib4.distPct,name:selectedFib4.name}:null},
    oneHFib:{direction:direction==="LONG"?"LONG":"SHORT",swingLow:(selectedDirection==="LONG"?oneFibLong:oneFibShort)?.swingLow??null,swingHigh:(selectedDirection==="LONG"?oneFibLong:oneFibShort)?.swingHigh??null,fib382:(selectedDirection==="LONG"?oneFibLong:oneFibShort)?.fib382??null,fib50:(selectedDirection==="LONG"?oneFibLong:oneFibShort)?.fib50??null,fib618:(selectedDirection==="LONG"?oneFibLong:oneFibShort)?.fib618??null,nearest:selectedFib1?{level:selectedFib1.level,distPct:selectedFib1.distPct,name:selectedFib1.name}:null},
    oneHStoch:{k:oneSt.k,d:oneSt.d,turnLong:oneTurnLong,turnShort:oneTurnShort},
    higherTimeframeStoch:{
      daily:{k:dailySt.k,d:dailySt.d,prevK:dailyStPrev.k,prevD:dailyStPrev.d,overheated:dailyOverheated},
      weekly:{k:weeklySt.k,d:weeklySt.d,prevK:weeklyStPrev.k,prevD:weeklyStPrev.d,overheated:weeklyOverheated},
      reset:higherTimeframeReset
    },
    majorRetest:!!selectedFib4&&selectedFib4.distPct<=2.0,
    deepRetest,precisionConfirmed:precision,ready,
    entryQuality:{
      depth,
      preferredLevel:depth>=2,
      trendChangeConfirmed,
      fourHDirection:fourDir||"NEUTRAL",
      structureShift:structure.shiftTo,
      dailyTransition:dailyTransition.stage,
      weeklyContext:weeklyDirection,
      oneHTurn:oneTurn,
      withinEntryZone:!!selectedFib4&&selectedFib4.distPct<=1.0,
      dailyStoch:{k:dailySt.k,d:dailySt.d,overheated:dailyOverheated},
      weeklyStoch:{k:weeklySt.k,d:weeklySt.d,overheated:weeklyOverheated},
      higherTimeframeReset
    },
    positionPlan:{margin:5000,leverage:10,notional:50000}
  };
}
export function getMarketSnapshot(pair:string,candles1h:Candle[],candles4h:Candle[],candles15m:Candle[],dailyLive?:DailyLiveContext){
  const d=bias(candles4h),price=candles4h.at(-1)?.close||0;if(!d)return{pair,price,timestamp:Date.now(),trend:"FLAT",location:"NONE",trigger:"NO_BIAS",adx:0,rsi:0,stochK:0,stochD:0,trendlinePrice:0,distToTrendline:null,momentumState:"NEUTRAL",dailyLive:dailyLive||null};
  const structure=detectStructureShift(pair,candles4h.slice(0,-1)),sd=structure.state==="HEALTHY"&&(structure.structure==="LONG"||structure.structure==="SHORT")?structure.structure as Direction:null,effective=sd||d,primary=buildTrendline(candles4h.slice(0,-1),effective,60),tl=primary.stale?buildTrendline(candles4h.slice(0,-1),effective,FRESH_LOOKBACK):primary;return snapshot(pair,candles4h,effective,tl,price,dailyLive);
}
export interface ValidityCheck{valid:boolean;reason:string;exited:boolean;state?:"VALID"|"STALE"|"INVALID";}
export function isSignalStillValid(s:Signal,p:number,now=Date.now()):ValidityCheck{if(now-s.timestamp>(s.type==="ADD"?4:24)*60*60*1000)return{valid:false,reason:"expired_ttl",exited:true,state:"STALE"};if(s.direction==="LONG"&&p<=s.stop)return{valid:false,reason:"sl_hit",exited:true,state:"INVALID"};if(s.direction==="SHORT"&&p>=s.stop)return{valid:false,reason:"sl_hit",exited:true,state:"INVALID"};return{valid:true,reason:"active",exited:false,state:"VALID"};}
export type ManagementState="STAY"|"EXIT";
export interface HoldResult{shouldHold:boolean;reason:string;managementState:ManagementState;recommendation:string;newStop?:number;scaleOut?:{level:number;size:number;label:string};}
function waveMomentum(c:Candle[],d:Direction){
  const closed=c.length>1?c.slice(0,-1):c;
  if(closed.length<26)return{state:"STAY IN TRADE" as const,confirmedReversal:false};
  const closes=closed.map(x=>x.close),e8=ema(closes,TF_FAST),e21=ema(closes,TF_SLOW),m=macd4h(closed),n=closed.length;
  const c0=closes[n-1],c1=closes[n-2],e80=e8[n-1]!,e81=e8[n-2]!,e210=e21[n-1]!,e211=e21[n-2]!;
  const longReversal=d==="LONG"&&c0<e80&&c1<e81&&e80<e210&&e81<=e211&&m.bearishShift;
  const shortReversal=d==="SHORT"&&c0>e80&&c1>e81&&e80>e210&&e81>=e211&&m.bullishShift;
  const confirmedReversal=longReversal||shortReversal;
  return{state:confirmedReversal?"EXIT TRADE":"STAY IN TRADE" as const,confirmedReversal};
}
export function shouldHold(s:Signal,c:Candle[],p:number):HoldResult{
  const momentum=waveMomentum(c,s.direction);
  const closed=c.length>1?c.slice(0,-1):c;
  const structure=closed.length>=20?detectStructureShift(s.pair,closed):null;
  const oppositeStructure=!!structure&&((s.direction==="LONG"&&(structure.structure==="SHORT"||structure.shiftTo==="SHORT"))||(s.direction==="SHORT"&&(structure.structure==="LONG"||structure.shiftTo==="LONG")));
  const closes=closed.map(x=>x.close),e8=ema(closes,TF_FAST).at(-1)??p,e21=ema(closes,TF_SLOW).at(-1)??p;
  const emaOpposite=s.direction==="LONG"?e8<e21:e8>e21,priceAgainstE8=s.direction==="LONG"?p<e8:p>e8;
  const structureBroken=oppositeStructure&&emaOpposite&&priceAgainstE8;
  if(s.direction==="LONG"&&p<=s.stop)return{shouldHold:false,reason:"sl_hit",managementState:"EXIT",recommendation:"EXIT TRADE"};
  if(s.direction==="SHORT"&&p>=s.stop)return{shouldHold:false,reason:"sl_hit",managementState:"EXIT",recommendation:"EXIT TRADE"};
  if(s.tp2!==undefined&&((s.direction==="LONG"&&p>=s.tp2)||(s.direction==="SHORT"&&p<=s.tp2)))return{shouldHold:false,reason:"tp2_hit",managementState:"EXIT",recommendation:"EXIT TRADE",scaleOut:{level:s.tp2,size:1,label:"TP2_FINAL"}};
  if(s.tp1!==undefined&&((s.direction==="LONG"&&p>=s.tp1)||(s.direction==="SHORT"&&p<=s.tp1)))return{shouldHold:true,reason:"tp1_hit",managementState:"STAY",recommendation:"STAY IN TRADE",newStop:s.entry,scaleOut:{level:s.tp1,size:.5,label:"TP1_50"}};
  // Management is deliberately binary:
  // STAY = the original trade thesis remains intact.
  // EXIT = confirmed 4H reversal or confirmed structural breakdown.
  // Normal momentum cooling, Fib retracements, and price moving below/above
  // the fast EMA do NOT create an intermediate management state.
  if(momentum.confirmedReversal||structureBroken)return{shouldHold:false,reason:momentum.confirmedReversal?"momentum_confirmed_4h_reversal":"structure_break_confirmed",managementState:"EXIT",recommendation:"EXIT TRADE"};
  return{shouldHold:true,reason:"thesis_intact",managementState:"STAY",recommendation:"STAY IN TRADE"};
}
export function shouldHoldCompat(s:Signal,c4:Candle[],c1:Candle[],p:number){return shouldHold(s,c4,p);}
export function filterExpiredSignals(signals:Signal[],prices:Record<string,number>,now?:number){const active:Signal[]=[],exited:{signal:Signal;reason:string}[]=[];for(const s of signals){const p=prices[s.pair];if(p===undefined){active.push(s);continue;}const v=isSignalStillValid(s,p,now);v.valid?active.push(s):exited.push({signal:s,reason:v.reason});}return{active,exited};}
export type TradeStatus="ACTIVE"|"TP_HIT"|"SL_HIT"|"EXPIRED";
export function checkTradeStatus(s:Signal,p:number,now=Date.now()):TradeStatus{const v=isSignalStillValid(s,p,now);if(v.reason==="expired_ttl")return"EXPIRED";if(s.direction==="LONG"&&p<=s.stop)return"SL_HIT";if(s.direction==="SHORT"&&p>=s.stop)return"SL_HIT";return"ACTIVE";}
export function rebuildStateFromTrades(_:Record<string,any>):void{return;}