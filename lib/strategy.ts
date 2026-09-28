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
export const CURRENT_SIGNAL_VERSION=16;

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
  breakoutSeen:boolean
){
  if(!tl.valid||tl.stale||tl.invalidated||c15.length<4)return{breakSeen:false,retest:false,linePrice:null,reason:"NO_VALID_4H_TRENDLINE"};
  const av15=atr(c15);
  const current=c15.at(-1)!;
  const currentLine=lineAtTimestamp(tl,c4,current.timestamp);
  if(currentLine===null)return{breakSeen:false,retest:false,linePrice:null,reason:"NO_LINE_PRICE"};

  const retestBuffer=Math.max(av15*TL_RETEST_ATR,Math.abs(currentLine)*TL_RETEST_PCT);
  const breakBuffer=Math.max(av15*TL_BREAK_ATR,Math.abs(currentLine)*BREAKOUT_PCT);

  // The 4H layer owns the breakout. 15M is not allowed to manufacture one
  // from an old crossing because that can produce an ENTRY_2 after price has
  // already been beyond the line for hours.
  const seen=breakoutSeen;
  if(!seen)return{breakSeen:false,retest:false,linePrice:currentLine,reason:"WAITING_FOR_4H_BREAK"};

  const touched=d==="LONG"
    ? current.low<=currentLine+retestBuffer
    : current.high>=currentLine-retestBuffer;
  const reclaimed=d==="LONG"
    ? current.close>currentLine
    : current.close<currentLine;

  return{
    breakSeen:true,
    retest:touched&&reclaimed,
    linePrice:currentLine,
    reason:touched&&reclaimed?"15M_DIP_RETEST_CONFIRMED":touched?"15M_RETEST_IN_PROGRESS":"WAITING_FOR_15M_DIP"
  };
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
function dailyDirection(live?:DailyLiveContext,local?:Direction|null):"BULL"|"BEAR"|"NEUTRAL"{
  // A weakening established regime still carries directional context.
  // A genuine HTF transition does not: do not let a stale prior 1D trend
  // authorize a new trade while the daily engine is changing sides.
  if(live){
    const state=live.state||"";
    const candidate=live.candidateState||state;
    if(candidate==="TRANSITION")return"NEUTRAL";
    if(state.startsWith("BULL") && candidate.startsWith("BEAR"))return"NEUTRAL";
    if(state.startsWith("BEAR") && candidate.startsWith("BULL"))return"NEUTRAL";
    if(state==="BULL_ESTABLISHED"||state==="BULL_WEAKENING")return"BULL";
    if(state==="BEAR_ESTABLISHED"||state==="BEAR_WEAKENING")return"BEAR";
    if(state==="BEAR_DEVELOPING")return"NEUTRAL";
    if(state==="TRANSITION")return"NEUTRAL";
    return"NEUTRAL";
  }
  return local||"NEUTRAL";
}
function opposite(pair:string,d:Direction,trades?:any[]){return!!trades?.some(t=>(t.pair===pair||t.symbol===pair)&&t.direction!==d);}
function same(pair:string,d:Direction,trades?:any[]){return!!trades?.some(t=>(t.pair===pair||t.symbol===pair)&&t.direction===d);}
function liq(entry:number,d:Direction){return d==="LONG"?entry*(1-1/LEVERAGE+MMR):entry*(1+1/LEVERAGE-MMR);}
export function liquidationSafeStop(entry:number,d:Direction){const l=liq(entry,d),safe=d==="LONG"?l*(1+LIQ_BUFFER):l*(1-LIQ_BUFFER);return round(safe);}

function snapshot(pair:string,c:Candle[],d:Direction,tl:Trendline,price:number,dailyLive?:DailyLiveContext){
  const closed=c.length>1?c.slice(0,-1):c,closes=closed.map(x=>x.close),st=stochRsi(closes),r=Math.round(rsi(closes)*10)/10,a=adx(closed),e8=ema(closes,TF_FAST).at(-1)??price,e21=ema(closes,TF_SLOW).at(-1)??price,m=macd4h(closed),d1=getDaily513Diagnostic(c),dist=tl.valid?(price-tl.price)/tl.price:null;
  const longTL=buildTrendline(closed,"LONG"),shortTL=buildTrendline(closed,"SHORT");
  return{pair,price:round(price),timestamp:Date.now(),trend:`${d} ${strength(daily(c),d)}`,location:dist===null?"NO_TL":Math.abs(dist)<=RETEST_PCT?"NEAR_TL":d==="LONG"?price>tl.price?"BEYOND_TL":"FAR_FROM_TL":price<tl.price?"BEYOND_TL":"FAR_FROM_TL",trigger:"WAITING",adx:a,rsi:r,stochK:st.k,stochD:st.d,trendlinePrice:tl.valid?round(tl.price):0,distToTrendline:dist===null?null:Math.round(Math.abs(dist)*10000)/100,ema8_4h:round(e8),ema21_4h:round(e21),fourH513:get4HEmaDiagnostic(c),macd4h:m,daily513:d1,dailyLive:dailyLive||null,momentumState:waveMomentum(c,d).state,trendlineStatus:tl.stale?"STALE_REBUILD":tl.valid?"ACTIVE":"REBUILDING",trendlineReason:tl.reason,trendlinePivots:tl.pivots.length,trendlineAgeCandles:tl.ageCandles,trendlineSlope:round(tl.slope),trendlineStaleByAge:tl.staleByAge,trendlineStaleByDistance:tl.staleByDistance,entry1Closed4hTimestamp:closed.at(-1)?.timestamp??0,entry1ClosedStochK:st.k,entry1ClosedStochD:st.d,entry1NearTL:tl.valid&&dist!==null&&Math.abs(dist)<=RETEST_PCT,entry1LongNearTL:longTL.valid&&Math.abs((price-longTL.price)/longTL.price)<=RETEST_PCT,entry1ShortNearTL:shortTL.valid&&Math.abs((price-shortTL.price)/shortTL.price)<=RETEST_PCT,entry1ShortMacdTurn:m.bearishShift,entry1ShortStochTurn:st.k<st.d,entry1LongStochTurn:st.k>st.d,entry1ShortTurn:st.k<st.d,entry1LongTrendlinePrice:longTL.valid?round(longTL.price):0,entry1ShortTrendlinePrice:shortTL.valid?round(shortTL.price):0};
}
export function getDaily513Diagnostic(c:Candle[]){
  const d=daily(c);if(d.length<21)return{stage:"NEUTRAL",label:"1D NEUTRAL",direction:"NEUTRAL" as const,ema5:0,ema13:0,spread:0,spreadPct:0,spreadContracting:false,spreadChangePct:0,ema5Slope:0,ema13Slope:0};
  const x=d.slice(0,-1).map(z=>z.close),f=ema(x,5),s=ema(x,13),ema5=f.at(-1)!,ema13=s.at(-1)!,p5=f.at(-2)!,p13=s.at(-2)!,spread=ema5-ema13,prev=p5-p13,contract=Math.abs(spread)<Math.abs(prev);let stage=spread>0?"BULLISH":"BEARISH",label=spread>0?"1D BULLISH":"1D BEARISH",direction:"BULLISH"|"BEARISH"=spread>0?"BULLISH":"BEARISH";if(spread<0&&ema5>p5&&contract){stage="EARLY_BULLISH";label="1D EARLY BULLISH";}if(spread>0&&ema5<p5&&contract){stage="EARLY_BEARISH";label="1D EARLY BEARISH";}return{stage,label,direction,ema5,ema13,spread,spreadPct:ema13?spread/ema13*100:0,spreadContracting:contract,spreadChangePct:prev?((Math.abs(spread)-Math.abs(prev))/Math.abs(prev))*100:0,ema5Slope:ema5-p5,ema13Slope:ema13-p13};
}
function logFib(debug:string[],pair:string,d:Direction,f:FibLevels|null,price:number){if(!f){debug.push(`[FIB] ${pair} ${d} | unavailable`);return;}const levels=[["0.382",f.fib382],["0.500",f.fib50],["0.618",f.fib618]] as const,near=levels.reduce((a,b)=>Math.abs(price-b[1])<Math.abs(price-a[1])?b:a);debug.push(`[FIB] ${pair} ${d} | swingLow=${f.swingLow.toFixed(2)} swingHigh=${f.swingHigh.toFixed(2)} | 0.382=${f.fib382.toFixed(2)} 0.500=${f.fib50.toFixed(2)} 0.618=${f.fib618.toFixed(2)} | price=${price.toFixed(2)} nearest=${near[0]} @ ${near[1].toFixed(2)} dist=${(Math.abs(price-near[1])/Math.max(Math.abs(near[1]),1)*100).toFixed(2)}%`);}

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

export function generateSignal(pair:string,candles1h:Candle[],candles4h:Candle[],candles15m:Candle[],activeTrades:any[]=[],currentPrice?:number,lastBreakout?:BreakoutRecord,dailyLive?:DailyLiveContext,candlesWeekly:Candle[]=[]):SignalResult{
  const debug:string[]=[];const now=Date.now();if(candles4h.length<35){debug.push("Insufficient 4H data");return{debug};}
  const price=currentPrice??candles4h.at(-1)!.close,closed=candles4h.slice(0,-1),localDaily=bias(candles4h),dDir=dailyDirection(dailyLive,localDaily),weekly=weeklyDirection(candlesWeekly,price);
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
  // ENTRY_1 momentum is deliberately permissive: ANY ONE of the three
  // closed-4H momentum signals is enough. This is an early entry, not a
  // confirmation entry. Direction/location/exhaustion remain separate gates.
  const stochLong=st.k>st.d&&st.k>prevSt.k,stochShort=st.k<st.d&&st.k<prevSt.k;
  const macdLong=macd.bullishShift,macdShort=macd.bearishShift;
  const emaLong=fourH.direction==="BULLISH"||fourH.turning&&fourH.direction==="BULLISH";
  const emaShort=fourH.direction==="BEARISH"||fourH.turning&&fourH.direction==="BEARISH";
  const longMomentum=stochLong||macdLong||emaLong;
  const shortMomentum=stochShort||macdShort||emaShort;
  const longMomentumCount=[stochLong,macdLong,emaLong].filter(Boolean).length;
  const shortMomentumCount=[stochShort,macdShort,emaShort].filter(Boolean).length;
  const longExhaustion=checkEntry1Exhaustion("LONG",r,st,longDist,a),shortExhaustion=checkEntry1Exhaustion("SHORT",r,st,shortDist,a);
  const longExhausted=longExhaustion.blocked,shortExhausted=shortExhaustion.blocked;
  // Fib decides WHERE through the path; StochRSI + 4H structure decide WHEN.
  // There is still only one ENTRY_1. Shallow/deep are internal path states only.
  const longLocation=longPathLocation||longNearFib,shortLocation=shortPathLocation||shortNearFib;

  // ENTRY_1 is deliberately early, but it must have ONE piece of real 4H
  // directional evidence in addition to location + StochRSI timing.
  // This restores the useful V28 behaviour without stacking five separate gates.
  // 1D remains context/risk sizing only — it never creates the trade direction.
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

  // ENTRY_1 stays early, but MACD improvement is supporting evidence — not
  // permission by itself. If 4H 5/13 is still on the opposite side, require
  // an actual structural transition/reclaim/break. This prevents the recent
  // SOL/HYPE-style "MACD improving = long" entries without over-gating normal
  // bullish 4H turns.
  const longStructuralConfirmation=
    structure.shiftTo==="LONG" ||
    (higherLow&&(reclaim8Long||priorHighBreak));
  const shortStructuralConfirmation=
    structure.shiftTo==="SHORT" ||
    (lowerHigh&&(reclaim8Short||priorLowBreak));
  const long4HConfirmation=
    fourH.direction==="BULLISH" ||
    (fourH.turning&&fourH.direction==="BULLISH") ||
    longStructuralConfirmation;
  const short4HConfirmation=
    fourH.direction==="BEARISH" ||
    (fourH.turning&&fourH.direction==="BEARISH") ||
    shortStructuralConfirmation;

  const weeklyLong=weekly.direction==="LONG";
  const weeklyShort=weekly.direction==="SHORT";
  // NEW-ENTRY HTF permission:
  // - Stable/weakening 1D regimes still provide directional context.
  //   4H only needs to point the same way; early/turning 4H states count.
  // - A genuine 1D transition is a no-trade zone.
  // - With no usable 1D context, weekly + 4H can still provide an early setup.
  const dailyTransitionBlocked=!!dailyLive && dDir==="NEUTRAL";
  const long4HDirectional=fourH.direction==="BULLISH" || (fourH.turning&&fourH.direction==="BULLISH");
  const short4HDirectional=fourH.direction==="BEARISH" || (fourH.turning&&fourH.direction==="BEARISH");
  const longHtfAligned=dailyTransitionBlocked
    ? false
    : dDir==="BULL"
      ? long4HDirectional
      : dDir==="BEAR"
        ? false
        : weeklyLong&&long4HDirectional;
  const shortHtfAligned=dailyTransitionBlocked
    ? false
    : dDir==="BEAR"
      ? short4HDirectional
      : dDir==="BULL"
        ? false
        : weeklyShort&&short4HDirectional;
  const longEntry1=weeklyLong&&longHtfAligned&&longLocation&&long4HConfirmation&&!longExhausted;
  const shortEntry1=weeklyShort&&shortHtfAligned&&shortLocation&&short4HConfirmation&&!shortExhausted;

  debug.push(`[1W] ${pair} | ${weekly.direction||"NEUTRAL"} | direction=${weekly.direction||"NEUTRAL"} | ${weekly.reason} | 5/13=${weekly.ema5.toFixed(2)}/${weekly.ema13.toFixed(2)} | ADX=${weekly.adx}`);
  debug.push(`[1D] ${pair} | ${dailyLive?.state||"LOCAL"}/${dailyLive?.candidateState||"—"} | ${dDir} | ${((weeklyLong&&dDir==="BULL")||(weeklyShort&&dDir==="BEAR"))?"SUPPORTIVE":"COUNTER/NEUTRAL"}`);
  debug.push(`[4H] ${pair} | 5/13=${fourH.label} | MACD=${macd.bullishShift?"BULL_IMPROVING":macd.bearishShift?"BEAR_IMPROVING":"NEUTRAL"} | Stoch=${st.k}/${st.d} prev=${prevSt.k}/${prevSt.d}`);
  debug.push(`[TL] ${pair} | LONG=${longTL.valid?longTL.price.toFixed(2):"—"} dist=${isFinite(longDist)?(longDist*100).toFixed(2)+"%":"—"} | SHORT=${shortTL.valid?shortTL.price.toFixed(2):"—"} dist=${isFinite(shortDist)?(shortDist*100).toFixed(2)+"%":"—"}`);
  debug.push(`[ENTRY_1 EXHAUSTION] ${pair} | RSI=${r} | LONG=${longExhausted?"BLOCK":"CLEAR"}${longExhaustion.reason?` (${longExhaustion.reason})`:""} | SHORT=${shortExhausted?"BLOCK":"CLEAR"}${shortExhaustion.reason?` (${shortExhaustion.reason})`:""}`);
  debug.push(`[FIB PATH] ${pair} | LONG=${longFibPath.state}/${longFibPath.trigger} age=${Number.isFinite(longFibPath.triggerAge)?longFibPath.triggerAge:"—"} fresh=${longFibPath.fresh?"YES":"NO"} | SHORT=${shortFibPath.state}/${shortFibPath.trigger} age=${Number.isFinite(shortFibPath.triggerAge)?shortFibPath.triggerAge:"—"} fresh=${shortFibPath.fresh?"YES":"NO"}`);
  debug.push(`[ENTRY_1 DECISION] ${pair} | 1D=${dDir} | 4H=${fourH.direction} | HTF=${dailyTransitionBlocked?"TRANSITION_BLOCK":longHtfAligned?"LONG_ALIGNED":shortHtfAligned?"SHORT_ALIGNED":"NO_TRADE"} | MomentumLong=${longMomentumCount}/3 | MomentumShort=${shortMomentumCount}/3 | Stoch=${stochLong?"LONG":stochShort?"SHORT":"NONE"} | FibPath=${longLocation?"LONG":shortLocation?"SHORT":"NONE"} | finalDecision=${longEntry1?"LONG_ENTRY_1":shortEntry1?"SHORT_ENTRY_1":"NONE"}`);

  const fallbackDir:Direction=weekly.direction||(dDir==="BEAR"?"SHORT":"LONG");
  const baseMarket=()=>snapshot(pair,candles4h,structureDir||fallbackDir,structureDir==="LONG"?longTL:structureDir==="SHORT"?shortTL:longTL,price,dailyLive);
  const market=(m:any)=>Object.assign(m||baseMarket(),{
    weeklyDirection:weekly.direction,weeklyDirectionReason:weekly.reason,weeklySupportive:(weeklyLong&&dDir==="BULL")||(weeklyShort&&dDir==="BEAR"),entry1Direction:longEntry1?"LONG":shortEntry1?"SHORT":"NEUTRAL",entry1Decision:longEntry1?"LONG_ENTRY_1":shortEntry1?"SHORT_ENTRY_1":"NONE",
    entry1TriggersLong:longMomentumCount,entry1TriggersShort:shortMomentumCount,entry1StructuralLocation:longLocation?"LONG":shortLocation?"SHORT":"NONE",
    entry1FibPathLong:longFibPath,entry1FibPathShort:shortFibPath,
    entry1NearTL:longNearFib&&!shortNearFib?"LONG":shortNearFib&&!longNearFib?"SHORT":"NONE",entry1LiveNearTL:longNearFib&&!shortNearFib?"LONG":shortNearFib&&!longNearFib?"SHORT":"NONE",
    entry1LiveDistPct:longEntry1?longDist*100:shortEntry1?shortDist*100:null,entry1PreBreak:longPreBreak||shortPreBreak,
    entry1ExecutionAllowed:longEntry1||shortEntry1,weeklyGateLong:weeklyLong,weeklyGateShort:weeklyShort,volatilityPct:price>0?round((av/price)*100):0,entry1MaxEntry:longNearFib&&longFibNearest?round(longFibNearest[1]*(1+ENTRY1_FIB_ZONE_PCT)):shortNearFib&&shortFibNearest?round(shortFibNearest[1]*(1-ENTRY1_FIB_ZONE_PCT)):null,
    entry1Chase:false,entry1Exhaustion:longExhausted?"LONG":shortExhausted?"SHORT":"NONE",entry1DailyConflict:"NONE",entry1ClosedRsi:r,
    entry1Grade:longEntry1||shortEntry1?"A":null,entry1TriggerThreshold:0,entry1MomentumRequired:false,entry1ExhaustionThreshold:dDir==="BULL"?ENTRY1_LONG_EXHAUSTION_RSI:ENTRY1_SHORT_EXHAUSTION_RSI
  });

  const closedIndex=closed.length-1;

  // ENTRY_2 is deliberately NOT a closed-4H signal anymore.
  // The current 4H candle may break the confirmed structural line in real time,
  // but merely being beyond the line is NOT a breakout. We require a fresh
  // cross from the correct side during the current developing 4H candle.
  const developing4HIndex=candles4h.length-1;
  const developing4H=candles4h.at(-1)!;
  const previous4H=closed.at(-1)!;
  const developingLongLine=longTL.valid?lineAt(longTL,developing4HIndex):null;
  const developingShortLine=shortTL.valid?lineAt(shortTL,developing4HIndex):null;
  const previousLongLine=longTL.valid?lineAt(longTL,closed.length-1):null;
  const previousShortLine=shortTL.valid?lineAt(shortTL,closed.length-1):null;
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
  const longExec=detect15mTrendlineRetest(candles15m,candles4h,longTL,"LONG",persistedLongBreak||current4HBreakLong);
  const shortExec=detect15mTrendlineRetest(candles15m,candles4h,shortTL,"SHORT",persistedShortBreak||current4HBreakShort);

  const breakoutLong=current4HBreakLong||persistedLongBreak;
  const breakoutShort=current4HBreakShort||persistedShortBreak;
  const detectedBreakout:BreakoutRecord|undefined=current4HBreakLong
    ? {direction:"LONG",price:round(developingLongLine??price),timestamp:now,candleIndex:developing4HIndex}
    : current4HBreakShort
      ? {direction:"SHORT",price:round(developingShortLine??price),timestamp:now,candleIndex:developing4HIndex}
      : undefined;
  const retestLong=longExec.retest;
  const retestShort=shortExec.retest;

  let dir:Direction|null=null,type:"ENTRY_1"|"ENTRY_2"|null=null,reason="";
  if(longEntry1&&!shortEntry1){dir="LONG";type="ENTRY_1";reason="probability-based early setup";}
  else if(shortEntry1&&!longEntry1){dir="SHORT";type="ENTRY_1";reason="probability-based early setup";}
  else if(weeklyLong&&retestLong&&!retestShort&&!same(pair,"LONG",activeTrades)){dir="LONG";type="ENTRY_2";reason="4H trendline break + 15M dip/retest";}
  else if(weeklyShort&&retestShort&&!retestLong&&!same(pair,"SHORT",activeTrades)){dir="SHORT";type="ENTRY_2";reason="4H trendline break + 15M dip/retest";}
  debug.push(`[4H BREAK] ${pair} | LONG prevClose=${previous4H.close.toFixed(2)} prevLine=${previousLongLine?.toFixed(2)||"—"} currentHigh=${developing4H.high.toFixed(2)} currentLine=${developingLongLine?.toFixed(2)||"—"} crossed=${current4HBreakLong?"YES":"NO"} | SHORT prevClose=${previous4H.close.toFixed(2)} prevLine=${previousShortLine?.toFixed(2)||"—"} currentLow=${developing4H.low.toFixed(2)} currentLine=${developingShortLine?.toFixed(2)||"—"} crossed=${current4HBreakShort?"YES":"NO"}`);
  debug.push(`[ENTRY_2] ${pair} | LONG 1W=${weeklyLong?"PASS":"BLOCK"} break=${breakoutLong?"YES":"NO"} retest=${retestLong?"YES":"NO"} line=${longExec.linePrice?.toFixed(2)||"—"} reason=${longExec.reason} | SHORT 1W=${weeklyShort?"PASS":"BLOCK"} break=${breakoutShort?"YES":"NO"} retest=${retestShort?"YES":"NO"} line=${shortExec.linePrice?.toFixed(2)||"—"} reason=${shortExec.reason}`);

  if(!dir||!type){debug.push(`[ENTRY_1 WAIT] ${pair} | ${longExhausted&&longLocation?`LONG exhaustion veto: ${longExhaustion.reason}`:shortExhausted&&shortLocation?`SHORT exhaustion veto: ${shortExhaustion.reason}`:!weekly.direction?"waiting for clear 1W direction":weeklyLong&&dDir!=="BULL"?"1W bullish opportunity with 1D counter-context":weeklyShort&&dDir!=="BEAR"?"1W bearish opportunity with 1D counter-context":weeklyLong&&!long4HConfirmation?"waiting for bullish 4H setup":weeklyShort&&!short4HConfirmation?"waiting for bearish 4H setup":dDir==="BULL"&&!longLocation?"waiting for price to approach bullish structural area":dDir==="BEAR"&&!shortLocation?"waiting for price to approach bearish structural area":"waiting for next valid setup"}`);return{market:market(baseMarket()),debug};}
  if(opposite(pair,dir,activeTrades)){debug.push(`[SIGNAL BLOCK] ${pair} ${dir} | opposite position active`);return{market:market(baseMarket()),debug};}
  const tl=dir==="LONG"?longTL:shortTL;
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
  const recentResistance=Math.max(...closed.slice(-12).map(x=>x.high));
  const recentSupport=Math.min(...closed.slice(-12).map(x=>x.low));
  const structuralFallback=dir==="LONG"?recentResistance:recentSupport;
  const forwardLevels=[...new Set(rawForwardLevels)].sort((x,y)=>dir==="LONG"?x-y:y-x);
  // TP1 must be a meaningful move, not simply the nearest Fib level.
  // Reject levels that are too close to entry and step forward to the next
  // structural/Fib level. The floor is volatility-aware so this works across
  // BTC/ETH and higher-beta alts without imposing one fixed percentage.
  const minTp1Distance=Math.max(entry*0.0035,av*0.5);
  const meaningfulForwardLevels=forwardLevels.filter(x=>Math.abs(x-entry)>=minTp1Distance);
  const tp1=meaningfulForwardLevels[0]??(dir==="LONG"
    ? entry+minTp1Distance
    : entry-minTp1Distance);
  const riskTarget15=dir==="LONG"?entry+risk*1.5:entry-risk*1.5;
  const secondStructural=meaningfulForwardLevels.find(x=>dir==="LONG"?x>tp1:x<tp1);
  const tp2=secondStructural!==undefined
    ? (dir==="LONG"?Math.max(secondStructural,riskTarget15):Math.min(secondStructural,riskTarget15))
    : riskTarget15;
  const target=tp2;
  const tp1Move=Math.abs(tp1-entry)/Math.max(entry,1),tp2Move=Math.abs(tp2-entry)/Math.max(entry,1);
  const dailyAligned=(dDir==="BULL"&&dir==="LONG")||(dDir==="BEAR"&&dir==="SHORT");
  const volatilityPct=entry>0?(av/entry)*100:0;
  const volatilityMultiplier=volatilitySizeMultiplier(entry,av);
  const riskMultiplier=(dailyAligned?1:0.5)*volatilityMultiplier;
  const trendAlignment=dailyAligned?"WITH_1D":"AGAINST_1D";
  const breakoutRecord:BreakoutRecord|undefined=type==="ENTRY_2"?(dir==="LONG"?{direction:"LONG",price:round(longExec.linePrice??price),timestamp:now,candleIndex:developing4HIndex}:{direction:"SHORT",price:round(shortExec.linePrice??price),timestamp:now,candleIndex:developing4HIndex}):undefined;
  const location=type==="ENTRY_1"?"EARLY_STRUCTURAL":"15M_TRENDLINE_RETEST";
  const entry1Trigger=dir==="LONG"
    ? [stochLong&&"4H_STOCHRSI_TURN",macdLong&&"4H_MACD_IMPROVING",emaLong&&"4H_5_13_TURN"].filter(Boolean).join("+")
    : [stochShort&&"4H_STOCHRSI_TURN",macdShort&&"4H_MACD_IMPROVING",emaShort&&"4H_5_13_TURN"].filter(Boolean).join("+");
  const trigger=type==="ENTRY_1"?(entry1Trigger||"4H_STRUCTURE_REACTION"):"4H_BREAKOUT→15M_DIP";
  const signal:Signal={id:`${pair}_${type}_${now}`,pair,direction:dir,type,scale:type,entry:round(entry),stop:round(stop),target:round(target),tp1:round(tp1),tp2:round(tp2),confidence:type==="ENTRY_1"?70:type==="ENTRY_2"?80:85,rr:1.5,adx:a,rsi:r,stochK:st.k,stochD:st.d,expectedMove:Math.round(tp2Move*1000)/10,reason:`${dir} ${type} | ${reason} | ${trendAlignment}`,timestamp:now,version:CURRENT_SIGNAL_VERSION,trend:`${dir} | 1W ${weekly.direction||"NEUTRAL"} | 1D ${dDir} | 4H ${strength(daily(candles4h),dir)}`,location,trigger,context:{
    marketPhase:type==="ENTRY_1"?`${dir} PROBABILITY EARLY SETUP`:`${dir} CONFIRMED ENTRY_2`,
    structure:structureDir?`4H ${structureDir}`:"4H STRUCTURE TRANSITION",momentum:`RSI ${r} | Stoch ${st.k}/${st.d} | MACD hist ${round(macd.histogram)}`,
    pullback:type==="ENTRY_2"?"15M_DIP_TO_4H_TRENDLINE":dir==="LONG"?longFibPath.trigger:shortFibPath.trigger,
    fourH513:fourH,daily513:getDaily513Diagnostic(candles4h),dailyLive:dailyLive||null,weeklyDirection:weekly.direction,weeklyContext:weekly,macd4h:macd,trendAlignment,sizeMultiplier:riskMultiplier,
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