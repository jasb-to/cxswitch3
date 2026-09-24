// lib/strategy.ts — clean CX Switch strategy engine
// 1D = directional context | 4H = timing + structure
// ENTRY_1 = probability-based early setup
// ENTRY_2 = confirmed breakout / retest
// ADD = next wave after pullback/retest with thesis intact
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
export interface SignalResult { signals?:Signal[]; signal?:Signal; market?:any; debug:string[]; }
export const CURRENT_SIGNAL_VERSION=7;

type DailyLiveContext={
  state?:string; candidateState?:string; candidateStreak?:number;
  direction?:"BULL"|"BEAR"|"NEUTRAL"; structure?:any; ema?:any; fast513?:any;
  adx?:number; momentum?:any; protectedLevel?:number|null;
};
type Direction="LONG"|"SHORT";
type Pivot={index:number;price:number;timestamp:number};
type Trendline={valid:boolean;slope:number;intercept:number;price:number;pivots:Pivot[];ageCandles:number;stale:boolean;staleByAge:boolean;staleByDistance:boolean;invalidated:boolean;reason:string};
type FibLevels={direction:Direction;swingLow:number;swingHigh:number;fib382:number;fib50:number;fib618:number;lowIndex:number;highIndex:number};
type FibPathState={state:"NONE"|"SHALLOW_REVERSAL"|"DEEP_TOUCHED"|"DEEP_RECLAIM"|"FAILED";touched618:boolean;reclaimed500:boolean;currentLevel:"ABOVE_382"|"BETWEEN_382_500"|"BETWEEN_500_618"|"BELOW_618";trigger:string;};

function getFibPathState(c:Candle[],f:FibLevels|null,d:Direction):FibPathState{
  const none:FibPathState={state:"NONE",touched618:false,reclaimed500:false,currentLevel:"ABOVE_382",trigger:"NONE"};
  if(!f||c.length<3)return none;
  const anchor=d==="LONG"?f.highIndex:f.lowIndex;
  const path=c.filter((_,i)=>i>=anchor);
  if(!path.length)return none;
  let touched618=false,reclaimed500=false,shallowReversal=false,failed=false;
  for(const x of path){
    if(d==="LONG"){
      if(x.low<=f.fib618)touched618=true;
      if(!touched618&&x.low<=f.fib382&&x.close>f.fib382)shallowReversal=true;
      if(touched618&&x.close>f.fib50)reclaimed500=true;
      if(touched618&&x.close<f.swingLow)failed=true;
    }else{
      if(x.high>=f.fib618)touched618=true;
      if(!touched618&&x.high>=f.fib382&&x.close<f.fib382)shallowReversal=true;
      if(touched618&&x.close<f.fib50)reclaimed500=true;
      if(touched618&&x.close>f.swingHigh)failed=true;
    }
  }
  const last=c.at(-1)!;
  let currentLevel:"ABOVE_382"|"BETWEEN_382_500"|"BETWEEN_500_618"|"BELOW_618";
  if(d==="LONG"){
    currentLevel=last.close>f.fib382?"ABOVE_382":last.close>f.fib50?"BETWEEN_382_500":last.close>f.fib618?"BETWEEN_500_618":"BELOW_618";
  }else{
    currentLevel=last.close<f.fib382?"ABOVE_382":last.close<f.fib50?"BETWEEN_382_500":last.close<f.fib618?"BETWEEN_500_618":"BELOW_618";
  }
  const state=failed?"FAILED":touched618&&reclaimed500?"DEEP_RECLAIM":touched618?"DEEP_TOUCHED":shallowReversal?"SHALLOW_REVERSAL":"NONE";
  const trigger=state==="DEEP_RECLAIM"?"0.618_TOUCH→0.5_RECLAIM":state==="SHALLOW_REVERSAL"?"0.382_REVERSAL":state==="DEEP_TOUCHED"?"0.618_TOUCHED":state==="FAILED"?"0.618_FAILED":"NONE";
  return{state,touched618,reclaimed500,currentLevel,trigger};
}

const DAILY_FAST=5, DAILY_SLOW=13, TF_FAST=8, TF_SLOW=21;
const BREAKOUT_PCT=0.005, RETEST_PCT=0.012, ENTRY1_FIB_ZONE_PCT=0.03;
const STALE_TL_PCT=0.04, STALE_TL_CANDLES=12, FRESH_LOOKBACK=30, BREAKOUT_EXPIRY_CANDLES=12;
const ENTRY1_LONG_EXHAUSTION_RSI=80, ENTRY1_SHORT_EXHAUSTION_RSI=20;
const LEVERAGE=20, MMR=0.01, LIQ_BUFFER=0.015, MIN_RR=1.25;

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
function pivots(c:Candle[],kind:"HIGH"|"LOW",w=2){const r:Pivot[]=[];for(let i=w;i<c.length-w;i++){const v=kind==="LOW"?c[i].low:c[i].high;let ok=true;for(let j=1;j<=w;j++){if(kind==="LOW"?(v>=c[i-j].low||v>=c[i+j].low):(v<=c[i-j].high||v<=c[i+j].high)){ok=false;break;}}if(ok)r.push({index:i,price:v,timestamp:c[i].timestamp});}return r;}
function buildTrendline(c:Candle[],d:Direction,lookback=60):Trendline{
  const kind=d==="LONG"?"LOW":"HIGH",ps=pivots(c,kind).filter(x=>x.index>=Math.max(0,c.length-lookback)).slice(-5);
  const empty=(reason:string):Trendline=>({valid:false,slope:0,intercept:0,price:0,pivots:ps,ageCandles:ps.length?c.length-1-ps[0].index:0,stale:false,staleByAge:false,staleByDistance:false,invalidated:false,reason});
  if(ps.length<2)return empty(`No ${d} structural trendline — ${ps.length}/2 confirmed pivots`);
  const a=ps.at(-2)!,b=ps.at(-1)!,dx=b.index-a.index;if(dx<=0)return empty("Trendline degenerate");
  const slope=(b.price-a.price)/dx,intercept=a.price-slope*a.index,price=slope*(c.length-1)+intercept,buffer=Math.max(Math.abs(price)*BREAKOUT_PCT,atr(c)*.35);
  let invalidated=false;for(let j=b.index+1;j<c.length-1;j++){const line=slope*j+intercept;if(d==="LONG"&&c[j].close>line+buffer){invalidated=true;break;}if(d==="SHORT"&&c[j].close<line-buffer){invalidated=true;break;}}
  const distance=Math.abs((c.at(-1)!.close-price)/Math.max(Math.abs(price),1)),age=c.length-1-b.index,staleByAge=age>STALE_TL_CANDLES,staleByDistance=distance>=STALE_TL_PCT,stale=!invalidated&&(staleByAge||staleByDistance);
  return{valid:true,slope,intercept,price,pivots:ps,ageCandles:age,stale,staleByAge,staleByDistance,invalidated,reason:invalidated?`${d} trendline already broken`:stale?`${d} trendline stale — rebuild recommended`:`${d} trendline active`};
}
function lineAt(t:Trendline,i:number){return t.slope*i+t.intercept;}
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
function dailyDirection(live?:DailyLiveContext,local?:Direction|null):"BULL"|"BEAR"|"NEUTRAL"{if(live?.state?.startsWith("BULL"))return"BULL";if(live?.state?.startsWith("BEAR"))return"BEAR";if(live?.direction)return live.direction;return local==="LONG"?"BULL":local==="SHORT"?"BEAR":"NEUTRAL";}
function opposite(pair:string,d:Direction,trades?:any[]){return!!trades?.some(t=>(t.pair===pair||t.symbol===pair)&&t.direction!==d);}
function same(pair:string,d:Direction,trades?:any[]){return!!trades?.some(t=>(t.pair===pair||t.symbol===pair)&&t.direction===d);}
function liq(entry:number,d:Direction){return d==="LONG"?entry*(1-1/LEVERAGE+MMR):entry*(1+1/LEVERAGE-MMR);}
export function liquidationSafeStop(entry:number,d:Direction){const l=liq(entry,d),safe=d==="LONG"?l*(1+LIQ_BUFFER):l*(1-LIQ_BUFFER);return round(safe);}

function snapshot(pair:string,c:Candle[],d:Direction,tl:Trendline,price:number,dailyLive?:DailyLiveContext){
  const closed=c.length>1?c.slice(0,-1):c,closes=closed.map(x=>x.close),st=stochRsi(closes),r=Math.round(rsi(closes)*10)/10,a=adx(closed),e8=ema(closes,TF_FAST).at(-1)??price,e21=ema(closes,TF_SLOW).at(-1)??price,m=macd4h(closed),d1=getDaily513Diagnostic(c),dist=tl.valid?(price-tl.price)/tl.price:null;
  const longTL=buildTrendline(closed,"LONG"),shortTL=buildTrendline(closed,"SHORT");
  return{pair,price:round(price),timestamp:Date.now(),trend:`${d} ${strength(daily(c),d)}`,location:dist===null?"NO_TL":Math.abs(dist)<=RETEST_PCT?"NEAR_TL":d==="LONG"?price>tl.price?"BEYOND_TL":"FAR_FROM_TL":price<tl.price?"BEYOND_TL":"FAR_FROM_TL",trigger:"WAITING",adx:a,rsi:r,stochK:st.k,stochD:st.d,trendlinePrice:tl.valid?round(tl.price):0,distToTrendline:dist===null?null:Math.round(Math.abs(dist)*10000)/100,ema8_4h:round(e8),ema21_4h:round(e21),fourH513:get4HEmaDiagnostic(c),macd4h:m,daily513:d1,dailyLive:dailyLive||null,momentumState:d==="LONG"?(r>=80?"OVEREXTENDED":r>=70?"HOT":st.k<20?"PULLBACK":"NEUTRAL"):(r<=20?"OVEREXTENDED":r<=30?"HOT":st.k>80?"PULLBACK":"NEUTRAL"),trendlineStatus:tl.stale?"STALE_REBUILD":tl.valid?"ACTIVE":"REBUILDING",trendlineReason:tl.reason,trendlinePivots:tl.pivots.length,trendlineAgeCandles:tl.ageCandles,trendlineSlope:round(tl.slope),trendlineStaleByAge:tl.staleByAge,trendlineStaleByDistance:tl.staleByDistance,entry1Closed4hTimestamp:closed.at(-1)?.timestamp??0,entry1ClosedStochK:st.k,entry1ClosedStochD:st.d,entry1NearTL:tl.valid&&dist!==null&&Math.abs(dist)<=RETEST_PCT,entry1LongNearTL:longTL.valid&&Math.abs((price-longTL.price)/longTL.price)<=RETEST_PCT,entry1ShortNearTL:shortTL.valid&&Math.abs((price-shortTL.price)/shortTL.price)<=RETEST_PCT,entry1ShortMacdTurn:m.bearishShift,entry1ShortStochTurn:st.k<st.d,entry1LongStochTurn:st.k>st.d,entry1ShortTurn:st.k<st.d,entry1LongTrendlinePrice:longTL.valid?round(longTL.price):0,entry1ShortTrendlinePrice:shortTL.valid?round(shortTL.price):0};
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

export function generateSignal(pair:string,candles1h:Candle[],candles4h:Candle[],candles15m:Candle[],activeTrades:any[]=[],currentPrice?:number,lastBreakout?:BreakoutRecord,dailyLive?:DailyLiveContext):SignalResult{
  const debug:string[]=[];const now=Date.now();if(candles4h.length<35){debug.push("Insufficient 4H data");return{debug};}
  const price=currentPrice??candles4h.at(-1)!.close,closed=candles4h.slice(0,-1),localDaily=bias(candles4h),dDir=dailyDirection(dailyLive,localDaily);
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
  const longPathLocation=!!longFib&&(
    (longFibPath.state==="SHALLOW_REVERSAL"&&price<=longFib.swingHigh&&price>=longFib.fib618*(1-ENTRY1_FIB_ZONE_PCT))||
    (longFibPath.state==="DEEP_RECLAIM"&&price<=longFib.swingHigh&&price>=longFib.fib50*(1-ENTRY1_FIB_ZONE_PCT))
  );
  const shortPathLocation=!!shortFib&&(
    (shortFibPath.state==="SHALLOW_REVERSAL"&&price>=shortFib.swingLow&&price<=shortFib.fib618*(1+ENTRY1_FIB_ZONE_PCT))||
    (shortFibPath.state==="DEEP_RECLAIM"&&price>=shortFib.swingLow&&price<=shortFib.fib50*(1+ENTRY1_FIB_ZONE_PCT))
  );
  const longPreBreak=longTL.valid&&price<=longTL.price+longBuffer,shortPreBreak=shortTL.valid&&price>=shortTL.price-shortBuffer;
  const longMomentum=st.k>st.d&&st.k>prevSt.k,shortMomentum=st.k<st.d&&st.k<prevSt.k;
  const longExhaustion=checkEntry1Exhaustion("LONG",r,st,longDist,a),shortExhaustion=checkEntry1Exhaustion("SHORT",r,st,shortDist,a);
  const longExhausted=longExhaustion.blocked,shortExhausted=shortExhaustion.blocked;
  // Fib decides WHERE through the path; StochRSI + 4H structure decide WHEN.
  // There is still only one ENTRY_1. Shallow/deep are internal path states only.
  const longLocation=longPathLocation,shortLocation=shortPathLocation;

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

  const longEntry1=longMomentum&&longLocation&&long4HConfirmation&&!longExhausted;
  const shortEntry1=shortMomentum&&shortLocation&&short4HConfirmation&&!shortExhausted;

  debug.push(`[1D] ${pair} | ${dailyLive?.state||"LOCAL"}/${dailyLive?.candidateState||"—"} | ${dDir}`);
  debug.push(`[4H] ${pair} | 5/13=${fourH.label} | MACD=${macd.bullishShift?"BULL_IMPROVING":macd.bearishShift?"BEAR_IMPROVING":"NEUTRAL"} | Stoch=${st.k}/${st.d} prev=${prevSt.k}/${prevSt.d}`);
  debug.push(`[TL] ${pair} | LONG=${longTL.valid?longTL.price.toFixed(2):"—"} dist=${isFinite(longDist)?(longDist*100).toFixed(2)+"%":"—"} | SHORT=${shortTL.valid?shortTL.price.toFixed(2):"—"} dist=${isFinite(shortDist)?(shortDist*100).toFixed(2)+"%":"—"}`);
  debug.push(`[ENTRY_1 EXHAUSTION] ${pair} | RSI=${r} | LONG=${longExhausted?"BLOCK":"CLEAR"}${longExhaustion.reason?` (${longExhaustion.reason})`:""} | SHORT=${shortExhausted?"BLOCK":"CLEAR"}${shortExhaustion.reason?` (${shortExhaustion.reason})`:""}`);
  debug.push(`[FIB PATH] ${pair} | LONG=${longFibPath.state}/${longFibPath.trigger} | SHORT=${shortFibPath.state}/${shortFibPath.trigger}`);\n  debug.push(`[ENTRY_1 DECISION] ${pair} | 1D=${dDir} | Stoch=${longMomentum?"LONG":shortMomentum?"SHORT":"NONE"} | FibPath=${longLocation?"LONG":shortLocation?"SHORT":"NONE"} | finalDecision=${longEntry1?"LONG_ENTRY_1":shortEntry1?"SHORT_ENTRY_1":"NONE"}`);

  const fallbackDir:Direction=dDir==="BEAR"?"SHORT":"LONG";
  const baseMarket=()=>snapshot(pair,candles4h,structureDir||fallbackDir,structureDir==="LONG"?longTL:structureDir==="SHORT"?shortTL:longTL,price,dailyLive);
  const market=(m:any)=>Object.assign(m||baseMarket(),{
    entry1Direction:longEntry1?"LONG":shortEntry1?"SHORT":"NEUTRAL",entry1Decision:longEntry1?"LONG_ENTRY_1":shortEntry1?"SHORT_ENTRY_1":"NONE",
    entry1TriggersLong:longMomentum?1:0,entry1TriggersShort:shortMomentum?1:0,entry1StructuralLocation:longLocation?"LONG":shortLocation?"SHORT":"NONE",
    entry1FibPathLong:longFibPath,entry1FibPathShort:shortFibPath,
    entry1NearTL:longNearFib&&!shortNearFib?"LONG":shortNearFib&&!longNearFib?"SHORT":"NONE",entry1LiveNearTL:longNearFib&&!shortNearFib?"LONG":shortNearFib&&!longNearFib?"SHORT":"NONE",
    entry1LiveDistPct:longEntry1?longDist*100:shortEntry1?shortDist*100:null,entry1PreBreak:longPreBreak||shortPreBreak,
    entry1ExecutionAllowed:longEntry1||shortEntry1,entry1MaxEntry:longNearFib&&longFibNearest?round(longFibNearest[1]*(1+ENTRY1_FIB_ZONE_PCT)):shortNearFib&&shortFibNearest?round(shortFibNearest[1]*(1-ENTRY1_FIB_ZONE_PCT)):null,
    entry1Chase:false,entry1Exhaustion:longExhausted?"LONG":shortExhausted?"SHORT":"NONE",entry1DailyConflict:"NONE",entry1ClosedRsi:r,
    entry1Grade:longEntry1||shortEntry1?"A":null,entry1TriggerThreshold:1,entry1ExhaustionThreshold:dDir==="BULL"?ENTRY1_LONG_EXHAUSTION_RSI:ENTRY1_SHORT_EXHAUSTION_RSI
  });

  const closedIndex=closed.length-1;
  const breakoutLong=longTL.valid&&!longTL.stale&&!longTL.invalidated&&closed.at(-1)!.close>lineAt(longTL,closedIndex)+longBuffer;
  const breakoutShort=shortTL.valid&&!shortTL.stale&&!shortTL.invalidated&&closed.at(-1)!.close<lineAt(shortTL,closedIndex)-shortBuffer;
  const age=(lastBreakout&&lastBreakout.candleIndex<=closedIndex)?closedIndex-lastBreakout.candleIndex:Infinity;
  const retestLong=!!lastBreakout&&lastBreakout.direction==="LONG"&&age<=BREAKOUT_EXPIRY_CANDLES&&Math.abs((price-lastBreakout.price)/Math.max(Math.abs(lastBreakout.price),1))<=RETEST_PCT;
  const retestShort=!!lastBreakout&&lastBreakout.direction==="SHORT"&&age<=BREAKOUT_EXPIRY_CANDLES&&Math.abs((price-lastBreakout.price)/Math.max(Math.abs(lastBreakout.price),1))<=RETEST_PCT;

  const e8=ema(closes,TF_FAST).at(-1)??price;
  // ADD is only the next wave after an actual pullback/retest. A fresh momentum turn
  // by itself is not enough: price must first be back into a meaningful retracement
  // area. This prevents ADDs from firing while an existing position is simply
  // continuing or cooling at/near the highs.
  const addFibLong=longFib?[longFib.fib382,longFib.fib50,longFib.fib618].some(level=>Math.abs((price-level)/Math.max(Math.abs(level),1))<=RETEST_PCT):false;
  const addFibShort=shortFib?[shortFib.fib382,shortFib.fib50,shortFib.fib618].some(level=>Math.abs((price-level)/Math.max(Math.abs(level),1))<=RETEST_PCT):false;
  const addRecentHigh=Math.max(...closed.slice(-8).map(x=>x.high)),addRecentLow=Math.min(...closed.slice(-8).map(x=>x.low));
  const pulledBackLong=price<=e8*(1+0.002)&&price<addRecentHigh*(1-0.003);
  const pulledBackShort=price>=e8*(1-0.002)&&price>addRecentLow*(1+0.003);
  // ADD requires BOTH sides of the setup:
  // 1) a real retracement/pullback has occurred, AND
  // 2) price is in a meaningful retracement area (Fib or the pullback/EMA area).
  // Fib proximity alone is never enough to trigger an ADD.
  const addLocationLong=pulledBackLong&&(addFibLong||pulledBackLong);
  const addLocationShort=pulledBackShort&&(addFibShort||pulledBackShort);
  const addLong=same(pair,"LONG",activeTrades)&&longMomentum&&fourH.direction==="BULLISH"&&addLocationLong&&!macd.bearishCross;
  const addShort=same(pair,"SHORT",activeTrades)&&shortMomentum&&fourH.direction==="BEARISH"&&addLocationShort&&!macd.bullishCross;
  debug.push(`[ADD LOCATION] ${pair} | LONG fib=${addFibLong?"YES":"NO"} pullback=${pulledBackLong?"YES":"NO"} | SHORT fib=${addFibShort?"YES":"NO"} pullback=${pulledBackShort?"YES":"NO"}`);

  let dir:Direction|null=null,type:"ENTRY_1"|"ENTRY_2"|"ADD"|null=null,reason="";
  if(longEntry1&&!shortEntry1){dir="LONG";type="ENTRY_1";reason="probability-based early setup";}
  else if(shortEntry1&&!longEntry1){dir="SHORT";type="ENTRY_1";reason="probability-based early setup";}
  else if(addLong&&!addShort){dir="LONG";type="ADD";reason="next wave — fresh 4H momentum turn with thesis intact";}
  else if(addShort&&!addLong){dir="SHORT";type="ADD";reason="next wave — fresh 4H momentum turn with thesis intact";}
  else if(breakoutLong&&!breakoutShort&&!same(pair,"LONG",activeTrades)){dir="LONG";type="ENTRY_2";reason="confirmed trendline breakout";}
  else if(breakoutShort&&!breakoutLong&&!same(pair,"SHORT",activeTrades)){dir="SHORT";type="ENTRY_2";reason="confirmed trendline breakout";}
  else if(retestLong&&!same(pair,"LONG",activeTrades)){dir="LONG";type="ENTRY_2";reason="breakout retest confirmation";}
  else if(retestShort&&!same(pair,"SHORT",activeTrades)){dir="SHORT";type="ENTRY_2";reason="breakout retest confirmation";}

  if(!dir||!type){debug.push(`[ENTRY_1 WAIT] ${pair} | ${longExhausted&&longMomentum&&longLocation?`LONG exhaustion veto: ${longExhaustion.reason}`:shortExhausted&&shortMomentum&&shortLocation?`SHORT exhaustion veto: ${shortExhaustion.reason}`:dDir==="BULL"&&!longMomentum?"waiting for bullish 4H StochRSI turn":dDir==="BEAR"&&!shortMomentum?"waiting for bearish 4H StochRSI turn":dDir==="BULL"&&!longLocation?"waiting for price to approach bullish structural area":dDir==="BEAR"&&!shortLocation?"waiting for price to approach bearish structural area":"waiting for next valid setup"}`);return{market:market(baseMarket()),debug};}
  if(opposite(pair,dir,activeTrades)){debug.push(`[SIGNAL BLOCK] ${pair} ${dir} | opposite position active`);return{market:market(baseMarket()),debug};}
  const tl=dir==="LONG"?longTL:shortTL;
  if(!tl.valid&&type==="ENTRY_2"){debug.push(`[SIGNAL BLOCK] ${pair} ${dir} | no valid structural trendline`);return{market:market(baseMarket()),debug};}
  const reference=tl.valid?tl.price:price,distance=Math.abs((price-reference)/Math.max(Math.abs(reference),1));
  // ENTRY_1 no longer has a trendline-distance execution veto. Fib proximity is the location test.

  const entry=price,structuralStop=dir==="LONG"?Math.min(...closed.slice(-10).map(x=>x.low),entry-av*2):Math.max(...closed.slice(-10).map(x=>x.high),entry+av*2);
  const liquidation=liq(entry,dir),safe=dir==="LONG"?liquidation*(1+LIQ_BUFFER):liquidation*(1-LIQ_BUFFER),stop=dir==="LONG"?Math.max(structuralStop,safe):Math.min(structuralStop,safe);
  const structuralRisk=Math.abs(entry-structuralStop);if(!structuralRisk)return{debug};const risk=Math.abs(entry-stop);if(!risk)return{debug};
  const fib=dir==="LONG"?longFib:shortFib;
  const forwardLevels=dir==="LONG"?[fib?.fib50,fib?.fib382,fib?.swingHigh].filter((x):x is number=>Number.isFinite(x)&&x>entry):[fib?.fib50,fib?.fib382,fib?.swingLow].filter((x):x is number=>Number.isFinite(x)&&x<entry).sort((x,y)=>dir==="LONG"?x-y:y-x);
  const recentResistance=Math.max(...closed.slice(-12).map(x=>x.high));
  const recentSupport=Math.min(...closed.slice(-12).map(x=>x.low));
  const tp1=forwardLevels[0]??(dir==="LONG"?recentResistance:recentSupport);
  const tp2=forwardLevels[1]??(dir==="LONG"?Math.max(recentResistance,tp1):Math.min(recentSupport,tp1));
  const target=tp2;
  const tp1Move=Math.abs(tp1-entry)/Math.max(entry,1),tp2Move=Math.abs(tp2-entry)/Math.max(entry,1);
  const dailyAligned=(dDir==="BULL"&&dir==="LONG")||(dDir==="BEAR"&&dir==="SHORT"),riskMultiplier=dailyAligned?1:0.5,trendAlignment=dailyAligned?"WITH_1D":"AGAINST_1D";
  const breakoutRecord:BreakoutRecord|undefined=type==="ENTRY_2"?(breakoutLong?{direction:"LONG",price:round(longTL.price),timestamp:now,candleIndex:closedIndex}:breakoutShort?{direction:"SHORT",price:round(shortTL.price),timestamp:now,candleIndex:closedIndex}:lastBreakout):lastBreakout;
  const location=type==="ENTRY_1"?"EARLY_STRUCTURAL":breakoutLong||breakoutShort?"BREAKOUT":type==="ADD"?"MOMENTUM_PULLBACK":"BREAKOUT_RETEST";
  const trigger=type==="ENTRY_1"?"4H_STOCHRSI_TURN":breakoutLong||breakoutShort?"4H_TRENDLINE_BREAKOUT":type==="ADD"?"4H_FRESH_MOMENTUM_TURN":"4H_BREAKOUT_RETEST";
  const signal:Signal={id:`${pair}_${type}_${now}`,pair,direction:dir,type,scale:type,entry:round(entry),stop:round(stop),target:round(target),tp1:round(tp1),tp2:round(tp2),confidence:type==="ENTRY_1"?70:type==="ENTRY_2"?80:85,rr:1.5,adx:a,rsi:r,stochK:st.k,stochD:st.d,expectedMove:Math.round(tp2Move*1000)/10,reason:`${dir} ${type} | ${reason} | ${trendAlignment}`,timestamp:now,version:CURRENT_SIGNAL_VERSION,trend:`${dir} ${strength(daily(candles4h),dir)}`,location,trigger,context:{
    marketPhase:type==="ENTRY_1"?`${dir} PROBABILITY EARLY SETUP`:type==="ENTRY_2"?`${dir} CONFIRMED ENTRY_2`:`${dir} ADD NEXT WAVE`,
    structure:structureDir?`4H ${structureDir}`:"4H STRUCTURE TRANSITION",momentum:`RSI ${r} | Stoch ${st.k}/${st.d} | MACD hist ${round(macd.histogram)}`,
    pullback:type==="ADD"?"fresh_4h_momentum_turn":type==="ENTRY_2"?"breakout_or_retest":dir==="LONG"?longFibPath.trigger:shortFibPath.trigger,
    fourH513:fourH,daily513:getDaily513Diagnostic(candles4h),dailyLive:dailyLive||null,macd4h:macd,trendAlignment,sizeMultiplier:riskMultiplier,
    risk:{baseRisk:round(risk),structuralRisk:round(structuralRisk),positionSize:round(risk*riskMultiplier),trendAlignment,sizeMultiplier:riskMultiplier,estimatedLiquidation:round(liquidation),safeBoundary:round(safe),leverage:LEVERAGE},
    entryGuard:{referenceFib:dir==="LONG"?longFibNearest:shortFibNearest,referenceTrendline:dir==="LONG"?(longTL.valid?round(longTL.price):null):(shortTL.valid?round(shortTL.price):null),trendlineDistancePct:round((dir==="LONG"?longDist:shortDist)*100),executionDistancePct:round((dir==="LONG"?longFibDist:shortFibDist)*100),maxEntry:dir==="LONG"?(longFibNearest?round(longFibNearest[1]):null):(shortFibNearest?round(shortFibNearest[1]):null),maxDistancePct:ENTRY1_FIB_ZONE_PCT*100},
    entry1CandleTimestamp:entryLast.timestamp,entry1ClosedCandleIndex:closed.length-1,
    fibPath:dir==="LONG"?longFibPath:shortFibPath,
    exhaustion:{closedRsi:r,longBlocked:longExhausted,shortBlocked:shortExhausted,longReason:longExhaustion.reason,shortReason:shortExhaustion.reason,longThreshold:ENTRY1_LONG_EXHAUSTION_RSI,shortThreshold:ENTRY1_SHORT_EXHAUSTION_RSI,stochK:st.k,stochD:st.d,adx:a,trendlineDistanceLongPct:round(longDist*100),trendlineDistanceShortPct:round(shortDist*100)},
    breakoutRecord:breakoutRecord?{direction:breakoutRecord.direction,price:round(breakoutRecord.price),timestamp:breakoutRecord.timestamp,candleIndex:breakoutRecord.candleIndex}:undefined,
    stages:{tp1:round(tp1),tp2:round(tp2),tp1MovePct:round(tp1Move*100),tp2MovePct:round(tp2Move*100)}
  }};
  debug.push(`[RISK] ${pair} ${dir} | structuralSL=${round(structuralStop)} | liquidation=${round(liquidation)} | safeBoundary=${round(safe)} | finalSL=${round(stop)}`);
  debug.push(`[SIGNAL] ${pair} — ${type} ${dir} @ ${signal.entry} | SL ${signal.stop} | TP1 ${signal.tp1} (${(tp1Move*100).toFixed(2)}%) | TP2 ${signal.tp2} (${(tp2Move*100).toFixed(2)}%) | ${trendAlignment} | size x${riskMultiplier}`);
  return{signal,signals:[signal],market:market(snapshot(pair,candles4h,dir,tl,price,dailyLive)),debug};
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
export type ManagementState="STAY"|"PROTECT"|"DEFEND"|"EXIT";
export interface HoldResult{shouldHold:boolean;reason:string;managementState:ManagementState;recommendation:string;newStop?:number;scaleOut?:{level:number;size:number;label:string};}
function waveMomentum(c:Candle[],d:Direction){
  const closed=c.length>1?c.slice(0,-1):c;
  if(closed.length<26)return{state:"NEUTRAL",confirmedReversal:false,aligned:false,weakening:false};
  const closes=closed.map(x=>x.close),e8=ema(closes,TF_FAST),e21=ema(closes,TF_SLOW),m=macd4h(closed),n=closed.length;
  const c0=closes[n-1],c1=closes[n-2],e80=e8[n-1]!,e81=e8[n-2]!,e210=e21[n-1]!,e211=e21[n-2]!,r=rsi(closes);
  const longReversal=d==="LONG"&&c0<e80&&c1<e81&&e80<e210&&e81<=e211&&m.bearishShift;
  const shortReversal=d==="SHORT"&&c0>e80&&c1>e81&&e80>e210&&e81>=e211&&m.bullishShift;
  const confirmedReversal=longReversal||shortReversal;
  const aligned=d==="LONG"?c0>e80&&e80>e210&&r>=50:c0<e80&&e80<e210&&r<=50;
  const weakening=d==="LONG"?m.falling||c0<e80:m.rising||c0>e80;
  return{state:confirmedReversal?"REVERSING":aligned?"WAVE":"WEAKENING",confirmedReversal,aligned,weakening};
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
  if(s.tp1!==undefined&&((s.direction==="LONG"&&p>=s.tp1)||(s.direction==="SHORT"&&p<=s.tp1)))return{shouldHold:true,reason:momentum.state==="WAVE"?"tp1_hit_protect_momentum":"tp1_hit_protect",managementState:"PROTECT",recommendation:"PROTECT TRADE",newStop:s.entry,scaleOut:{level:s.tp1,size:.5,label:"TP1_50"}};
  if(momentum.confirmedReversal||structureBroken)return{shouldHold:false,reason:momentum.confirmedReversal?"momentum_confirmed_4h_reversal":"structure_break_confirmed",managementState:"EXIT",recommendation:"EXIT TRADE"};
  if(momentum.aligned)return{shouldHold:true,reason:"wave_active",managementState:"STAY",recommendation:"STAY IN TRADE"};
  if(oppositeStructure&&(!emaOpposite||!priceAgainstE8))return{shouldHold:true,reason:"structure_under_pressure",managementState:"DEFEND",recommendation:"DEFEND TRADE"};
  if(momentum.weakening||priceAgainstE8)return{shouldHold:true,reason:"healthy_4h_pullback",managementState:"PROTECT",recommendation:"PROTECT TRADE"};
  return{shouldHold:true,reason:"wave_cooling",managementState:"PROTECT",recommendation:"PROTECT TRADE"};
}
export function shouldHoldCompat(s:Signal,c4:Candle[],c1:Candle[],p:number){return shouldHold(s,c4,p);}
export function filterExpiredSignals(signals:Signal[],prices:Record<string,number>,now?:number){const active:Signal[]=[],exited:{signal:Signal;reason:string}[]=[];for(const s of signals){const p=prices[s.pair];if(p===undefined){active.push(s);continue;}const v=isSignalStillValid(s,p,now);v.valid?active.push(s):exited.push({signal:s,reason:v.reason});}return{active,exited};}
export type TradeStatus="ACTIVE"|"TP_HIT"|"SL_HIT"|"EXPIRED";
export function checkTradeStatus(s:Signal,p:number,now=Date.now()):TradeStatus{const v=isSignalStillValid(s,p,now);if(v.reason==="expired_ttl")return"EXPIRED";if(s.direction==="LONG"&&p<=s.stop)return"SL_HIT";if(s.direction==="SHORT"&&p>=s.stop)return"SL_HIT";return"ACTIVE";}
export function rebuildStateFromTrades(_:Record<string,any>):void{return;}