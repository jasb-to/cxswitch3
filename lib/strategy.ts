// lib/strategy.ts — V28 early-breakout core
// ============================================================
// V28 combines the live 1D regime with 4H reversal timing.
// ENTRY_1 = earliest validated 4H reversal OR first confirmed trendline breakout.
// ENTRY_2 = independent breakout retest when no position was captured.
// ADD     = breakout retest/continuation after ENTRY_1 or ENTRY_2 is active.
// Early ENTRY_1 is intentionally allowed to be choppy, but it must occur during
// the actual 4H transition — not after MACD/5-13/8-21 are already extended.

import { get4HEmaDiagnostic } from "./ema-diagnostic";
import { detectStructureShift } from "./structure-shift";

export interface Candle { timestamp:number; open:number; high:number; low:number; close:number; volume:number; }
export interface BreakoutRecord { direction:"LONG"|"SHORT"; price:number; timestamp:number; candleIndex:number; }
export interface Signal { id:string; pair:string; direction:"LONG"|"SHORT"; type:"ENTRY_1"|"ENTRY_2"|"ADD"; scale:"ENTRY_1"|"ENTRY_2"|"ADD"|null; entry:number; stop:number; target:number; tp1?:number; tp2?:number; tp3?:number; confidence:number; rr:number; adx:number; rsi:number; stochK:number; stochD:number; expectedMove:number; reason:string; timestamp:number; version:number; trend?:string; location?:string; trigger?:string; context?:any; }
export interface SignalResult { signals?:Signal[]; signal?:Signal; market?:any; debug:string[]; }
export const CURRENT_SIGNAL_VERSION=3;

type DailyLiveContext={state?:string;candidateState?:string;candidateStreak?:number;direction?:"BULL"|"BEAR"|"NEUTRAL";structure?:any;ema?:any;fast513?:any;adx?:number;momentum?:any;protectedLevel?:number|null};

const DAILY_FAST=5, DAILY_SLOW=13, TF_FAST=8, TF_SLOW=21;
const BREAKOUT_PCT=0.005, RETEST_PCT=0.012, ENTRY_ATR=2, ADD_ATR=1.5, MIN_RR=1.25;
const STALE_TL_PCT=0.04, STALE_TL_CANDLES=12, FRESH_LOOKBACK=30, BREAKOUT_EXPIRY_CANDLES=12;
const LEVERAGE=20, MMR=0.01, LIQ_BUFFER=0.005;
const EARLY_NEAR_PCT=0.025;
const EARLY_LOOKBACK=12;

 type Pivot={index:number;price:number;timestamp:number};
type TL={valid:boolean;slope:number;intercept:number;price:number;pivots:Pivot[];ageCandles:number;reason:string;invalidated:boolean;stale:boolean;staleByAge:boolean;staleByDistance:boolean;};
const avg=(a:number[])=>a.length?a.reduce((x,y)=>x+y,0)/a.length:0;
function ema(a:number[],p:number){if(!a.length)return[];const k=2/(p+1),r=[a[0]];for(let i=1;i<a.length;i++)r.push(a[i]*k+r[i-1]*(1-k));return r;}
function atr(c:Candle[],p=14){const r:number[]=[];for(let i=Math.max(1,c.length-p);i<c.length;i++){const x=c[i],q=c[i-1];r.push(Math.max(x.high-x.low,Math.abs(x.high-q.close),Math.abs(x.low-q.close)));}return avg(r);}
function rsi(a:number[],p=14){if(a.length<2)return 50;let g=0,l=0,n=0;for(let i=Math.max(1,a.length-p);i<a.length;i++){const d=a[i]-a[i-1];if(d>0)g+=d;else l+=Math.abs(d);n++;}if(!n)return 50;const ag=g/n,al=l/n;if(al===0)return 100;return 100-100/(1+ag/al);}
function rsiSeries(a:number[],p=14){const r:number[]=[];for(let i=p;i<a.length;i++)r.push(rsi(a.slice(i-p,i+1),p));return r;}
function stochRsi(a:number[],rp=14,sp=14,ks=3,ds=3){const rv=rsiSeries(a,rp);if(rv.length<sp+ks-1)return{k:50,d:50};const raw:number[]=[];for(let i=sp-1;i<rv.length;i++){const w=rv.slice(i-sp+1,i+1),lo=Math.min(...w),hi=Math.max(...w);raw.push(hi===lo?50:(rv[i]-lo)/(hi-lo)*100);}const kv:number[]=[];for(let i=ks-1;i<raw.length;i++)kv.push(avg(raw.slice(i-ks+1,i+1)));if(kv.length<ds)return{k:50,d:50};return{k:Math.round(kv.at(-1)!*10)/10,d:Math.round(avg(kv.slice(-ds))*10)/10};}
function wilder(a:number[],p:number){if(!a.length)return[];const r=[avg(a.slice(0,p))];for(let i=p;i<a.length;i++)r.push((r.at(-1)!*(p-1)+a[i])/p);return r;}
function adx(c:Candle[],p=14){if(c.length<p+1)return 0;const tr:number[]=[],plus:number[]=[],minus:number[]=[];for(let i=1;i<c.length;i++){const x=c[i],q=c[i-1];tr.push(Math.max(x.high-x.low,Math.abs(x.high-q.close),Math.abs(x.low-q.close)));plus.push(x.high-q.high>q.low-x.low?Math.max(x.high-q.high,0):0);minus.push(q.low-x.low>x.high-q.high?Math.max(q.low-x.low,0):0);}const t=wilder(tr,p),pd=wilder(plus,p),md=wilder(minus,p),dx:number[]=[];for(let i=0;i<t.length;i++){const a=pd[i]/t[i]*100,b=md[i]/t[i]*100;dx.push(a+b===0?0:Math.abs(a-b)/(a+b)*100);}return Math.round((wilder(dx,p).at(-1)||0)*10)/10;}
function daily(c:Candle[]){const m=new Map<string,Candle[]>();for(const x of [...c].sort((a,b)=>a.timestamp-b.timestamp)){const d=new Date(x.timestamp),k=`${d.getUTCFullYear()}-${d.getUTCMonth()}-${d.getUTCDate()}`;(m.get(k)||m.set(k,[]).get(k)!).push(x);}return[...m.values()].map(b=>({timestamp:b[0].timestamp,open:b[0].open,high:Math.max(...b.map(x=>x.high)),low:Math.min(...b.map(x=>x.low)),close:b.at(-1)!.close,volume:b.reduce((s,x)=>s+x.volume,0)}));}
function bias(c:Candle[]):"LONG"|"SHORT"|null{if(c.length<20)return null;const a=c.map(x=>x.close),f=ema(a,DAILY_FAST).at(-1)!,s=ema(a,DAILY_SLOW).at(-1)!;return f>s?"LONG":f<s?"SHORT":null;}
function strength(c:Candle[],d:"LONG"|"SHORT"){const h=c.slice(-20).map(x=>x.high),l=c.slice(-20).map(x=>x.low);return d==="LONG"&&h.at(-1)!>Math.max(...h.slice(0,-1))||d==="SHORT"&&l.at(-1)!<Math.min(...l.slice(0,-1))?"STRONG":"MEDIUM";}
function pivots(c:Candle[],kind:"HIGH"|"LOW",w=2){const r:Pivot[]=[];for(let i=w;i<c.length-w;i++){const v=kind==="LOW"?c[i].low:c[i].high;let ok=true;for(let j=1;j<=w;j++){if(kind==="LOW"?(v>=c[i-j].low||v>=c[i+j].low):(v<=c[i-j].high||v<=c[i+j].high)){ok=false;break;}}if(ok)r.push({index:i,price:v,timestamp:c[i].timestamp});}return r;}
function buildTrendline(c:Candle[],d:"LONG"|"SHORT",lookback=60):TL{const kind=d==="LONG"?"LOW":"HIGH";const p=pivots(c,kind).filter(x=>x.index>=Math.max(0,c.length-lookback)).slice(-5);if(p.length<2)return{valid:false,slope:0,intercept:0,price:0,pivots:p,ageCandles:p.length?c.length-1-p[0].index:0,reason:`No ${d} breakout trendline — ${p.length}/2 confirmed pivots`,invalidated:false,stale:false,staleByAge:false,staleByDistance:false};const a=p.at(-2)!,b=p.at(-1)!,dx=b.index-a.index;if(dx<=0)return{valid:false,slope:0,intercept:0,price:0,pivots:p,ageCandles:0,reason:"Trendline degenerate",invalidated:false,stale:false,staleByAge:false,staleByDistance:false};const slope=(b.price-a.price)/dx,intercept=a.price-slope*a.index,price=slope*(c.length-1)+intercept,buffer=Math.max(Math.abs(price)*BREAKOUT_PCT,atr(c)*.35);let invalidated=false;for(let j=b.index+1;j<c.length-1;j++){const line=slope*j+intercept;if(d==="LONG"&&c[j].close>line+buffer){invalidated=true;break;}if(d==="SHORT"&&c[j].close<line-buffer){invalidated=true;break;}}const distance=Math.abs((c.at(-1)!.close-price)/Math.max(Math.abs(price),1)),ageCandles=c.length-1-b.index,staleByAge=ageCandles>STALE_TL_CANDLES,staleByDistance=distance>=STALE_TL_PCT,stale=!invalidated&&(staleByAge||staleByDistance);return{valid:true,slope,intercept,price,pivots:p,ageCandles,reason:stale?`${d} breakout trendline stale — ${staleByAge?"age":""}${staleByAge&&staleByDistance?"+":""}${staleByDistance?"distance":""}; rebuilding`:invalidated?`${d} breakout trendline already broken — preserving breakout context`:`${d} breakout trendline active`,invalidated,stale,staleByAge,staleByDistance};}
function lineAt(tl:TL,i:number){return tl.slope*i+tl.intercept;}
function opposite(pair:string,d:"LONG"|"SHORT",trades:any[]|undefined){return !!trades?.some(t=>(t.pair===pair||t.symbol===pair)&&t.direction===(d==="LONG"?"SHORT":"LONG"));}
function same(pair:string,d:"LONG"|"SHORT",trades:any[]|undefined){return !!trades?.some(t=>(t.pair===pair||t.symbol===pair)&&t.direction===d);}
function liq(entry:number,d:"LONG"|"SHORT"){return d==="LONG"?entry*(1-1/LEVERAGE+MMR):entry*(1+1/LEVERAGE-MMR);}
function round(n:number){return Math.round(n*100000)/100000;}

function macd4h(c:Candle[]){
 const closes=c.map(x=>x.close),fast=ema(closes,12),slow=ema(closes,26),macd=fast.map((v,j)=>v-(slow[j]??v)),signal=ema(macd,9),hist=macd.map((v,j)=>v-(signal[j]??0));
 const i=hist.length-1,p=i-1,pp=i-2,h=hist[i]??0,prev=hist[p]??0,prev2=hist[pp]??prev;
 const rising=h>prev,falling=h<prev,bullishColour=rising&&h<0,bearishColour=falling&&h>0,bullishCross=h>=0&&prev<0,bearishCross=h<=0&&prev>0;
 return{macd:macd[i]??0,signal:signal[i]??0,histogram:h,prevHistogram:prev,prev2Histogram:prev2,rising,falling,bullishColour,bearishColour,bullishShift:(h>prev)||(h>=0&&prev<0),bearishShift:(h<prev)||(h<=0&&prev>0),bullishCross,bearishCross,histogramPct:Math.abs(h)>0?((h-prev)/Math.abs(h))*100:0};
}

function snapshot(pair:string,c:Candle[],d:"LONG"|"SHORT",tl:TL,price:number,dailyLive?:DailyLiveContext){const closes=c.map(x=>x.close),st=stochRsi(closes),r=rsi(closes),a=adx(c),e8=ema(closes,TF_FAST).at(-1)!,e21=ema(closes,TF_SLOW).at(-1)!,d1=getDaily513Diagnostic(c),m=macd4h(c);const dist=tl.valid?(price-tl.price)/tl.price:null;return{pair,price:round(price),timestamp:Date.now(),trend:`${d} ${strength(daily(c),d)}`,location:dist===null?"NO_TL":Math.abs(dist)<RETEST_PCT?"NEAR_TL":(d==="LONG"?price>tl.price:price<tl.price)?"BEYOND_TL":"FAR_FROM_TL",trigger:"WAITING",adx:a,rsi:Math.round(r*10)/10,stochK:st.k,stochD:st.d,trendlinePrice:tl.valid?round(tl.price):0,distToTrendline:dist===null?null:Math.round(Math.abs(dist)*10000)/100,ema8_4h:round(e8),ema21_4h:round(e21),fourH513:get4HEmaDiagnostic(c),macd4h:m,daily513:d1,dailyLive:dailyLive||null,momentumState:d==="LONG"?(r>=80?"OVEREXTENDED":r>=70?"HOT":st.k<20?"PULLBACK":"NEUTRAL"):(r<=20?"OVEREXTENDED":r<=30?"HOT":st.k>80?"PULLBACK":"NEUTRAL"),trendlineStatus:tl.stale?"STALE_REBUILD":tl.valid?"ACTIVE":"REBUILDING",trendlineReason:tl.reason,trendlinePivots:tl.pivots.length,trendlineAgeCandles:tl.ageCandles,trendlineSlope:round(tl.slope),trendlineStaleByAge:tl.staleByAge,trendlineStaleByDistance:tl.staleByDistance,entry1Closed4hTimestamp:c.length>1?(c.at(-2)?.timestamp??0):(c.at(-1)?.timestamp??0),entry1ClosedStochK:c.length>1?stochRsi(c.slice(0,-1).map(x=>x.close)).k:st.k,entry1ClosedStochD:c.length>1?stochRsi(c.slice(0,-1).map(x=>x.close)).d:st.d,entry1NearTL:tl.valid&&dist!==null&&Math.abs(dist)<=RETEST_PCT,entry1LongNearTL:tl.valid&&d==="LONG"&&dist!==null&&Math.abs(dist)<=RETEST_PCT,entry1ShortNearTL:tl.valid&&d==="SHORT"&&dist!==null&&Math.abs(dist)<=RETEST_PCT,entry1LongStochTurn:c.length>1?stochRsi(c.slice(0,-1).map(x=>x.close)).k>stochRsi(c.slice(0,-1).map(x=>x.close)).d:false,entry1ShortTurn:c.length>1?stochRsi(c.slice(0,-1).map(x=>x.close)).k<stochRsi(c.slice(0,-1).map(x=>x.close)).d:false,entry1ShortStochTurn:c.length>1?stochRsi(c.slice(0,-1).map(x=>x.close)).k<stochRsi(c.slice(0,-1).map(x=>x.close)).d:false,entry1LongTrendlinePrice:(buildTrendline(c.length>1?c.slice(0,-1):c,"LONG",60)).valid?round(buildTrendline(c.length>1?c.slice(0,-1):c,"LONG",60).price):0,entry1ShortTrendlinePrice:(buildTrendline(c.length>1?c.slice(0,-1):c,"SHORT",60)).valid?round(buildTrendline(c.length>1?c.slice(0,-1):c,"SHORT",60).price):0};}

export function getDaily513Diagnostic(c:Candle[]){const d=daily(c);if(d.length<21)return{stage:"NEUTRAL",label:"1D NEUTRAL",direction:"NEUTRAL" as const,ema5:0,ema13:0,spread:0,spreadPct:0,spreadContracting:false,spreadChangePct:0,ema5Slope:0,ema13Slope:0};const x=d.slice(0,-1).map(z=>z.close),f=ema(x,5),s=ema(x,13),ema5=f.at(-1)!,ema13=s.at(-1)!,p5=f.at(-2)!,p13=s.at(-2)!,spread=ema5-ema13,prev=p5-p13,contract=Math.abs(spread)<Math.abs(prev),earlyBullish=spread<0&&ema5>p5&&contract,earlyBearish=spread>0&&ema5<p5&&contract;let stage=spread>0?"BULLISH":"BEARISH",label=spread>0?"1D BULLISH":"1D BEARISH",direction:"BULLISH"|"BEARISH"="BULLISH";if(spread<0){direction="BEARISH";if(earlyBullish){stage="EARLY_BULLISH";label="1D EARLY BULLISH";}}else if(earlyBearish){stage="EARLY_BEARISH";label="1D EARLY BEARISH";}return{stage,label,direction,ema5,ema13,spread,spreadPct:ema13?spread/ema13*100:0,spreadContracting:contract,spreadChangePct:prev?((Math.abs(spread)-Math.abs(prev))/Math.abs(prev))*100:0,ema5Slope:ema5-p5,ema13Slope:ema13-p13};}

export function generateSignal(pair:string,candles1h:Candle[],candles4h:Candle[],candles15m:Candle[],activeTrades?:any[],currentPrice?:number,lastBreakout?:BreakoutRecord,dailyLive?:DailyLiveContext):SignalResult{
 const debug:string[]=[];const now=Date.now();if(candles4h.length<30){debug.push("Insufficient 4H data");return{debug};}
 const d=daily(candles4h),contextDir=bias(d),price=currentPrice??candles4h.at(-1)!.close;
 const i=candles4h.length-1,prev=candles4h.at(-2)!,last=candles4h.at(-1)!;
 // ENTRY_1 timing is evaluated only from the last CLOSED 4H candle. The live price
 // may still be used for the eventual execution price, but it cannot create an
 // intrabar ENTRY_1 condition.
 const closed4h=candles4h.length>1?candles4h.slice(0,-1):candles4h;
 const entryLast=closed4h.at(-1)!;
 const entryPrev=closed4h.at(-2)??entryLast;
 const entryCloses=closed4h.map(x=>x.close);
 const entrySt=stochRsi(entryCloses);
 const structure=detectStructureShift(pair,candles4h),structureDir=structure.state==="HEALTHY"&&(structure.structure==="LONG"||structure.structure==="SHORT")?structure.structure:null;
 const fourH513=get4HEmaDiagnostic(candles4h),macd=macd4h(candles4h),closes=candles4h.map(x=>x.close),e5=ema(closes,5),e13=ema(closes,13),e8=ema(closes,8),e21=ema(closes,21),r=Math.round(rsi(closes)*10)/10,st=stochRsi(closes),a=adx(candles4h),av=atr(candles4h);
 const dailyState=dailyLive?.state||"",dailyCandidate=dailyLive?.candidateState||"",dailyDirection=dailyLive?.direction||(dailyState.startsWith("BULL")||dailyCandidate.startsWith("BULL")?"BULL":dailyState.startsWith("BEAR")||dailyCandidate.startsWith("BEAR")?"BEAR":"NEUTRAL");
 const dailyBull=dailyDirection==="BULL"||dailyState.startsWith("BULL")||dailyCandidate.startsWith("BULL");
 const dailyBear=dailyDirection==="BEAR"||dailyState.startsWith("BEAR")||dailyCandidate.startsWith("BEAR");
 const dailyTurnBull=(dailyState==="TRANSITION"&&dailyCandidate.startsWith("BULL"))||dailyCandidate==="BULL_WEAKENING"||dailyState==="BULL_WEAKENING";
 const dailyTurnBear=(dailyState==="TRANSITION"&&dailyCandidate.startsWith("BEAR"))||dailyCandidate==="BEAR_DEVELOPING"||dailyState==="BEAR_DEVELOPING";
 const ema8Up=e8.at(-1)!>e8.at(-2)!,ema8Down=e8.at(-1)!<e8.at(-2)!;
 const bull5of13=fourH513.direction==="BULLISH"||fourH513.stage.includes("BULLISH"),bear5of13=fourH513.direction==="BEARISH"||fourH513.stage.includes("BEARISH");
 const recentLow=Math.min(...candles4h.slice(-EARLY_LOOKBACK).map(x=>x.low)),recentHigh=Math.max(...candles4h.slice(-EARLY_LOOKBACK).map(x=>x.high));
 const nearLow=price<=recentLow*(1+EARLY_NEAR_PCT),nearHigh=price>=recentHigh*(1-EARLY_NEAR_PCT);
 const early5Bull=fourH513.stage==="EARLY_BULLISH_L1"||fourH513.stage==="EARLY_BULLISH_L2"||(fourH513.turning&&fourH513.direction==="BULLISH")||(fourH513.crossNow&&fourH513.direction==="BULLISH");
 const early5Bear=fourH513.stage==="EARLY_BEARISH_L1"||fourH513.stage==="EARLY_BEARISH_L2"||(fourH513.turning&&fourH513.direction==="BEARISH")||(fourH513.crossNow&&fourH513.direction==="BEARISH");
 // EARLY ENTRY 1: true transition entry, not a stacked confirmation model.
 // 1D supplies context; 4H supplies the trigger; risk/chase filters veto.
 // A-grade: aligned 1D context + any 2 of 5 early 4H triggers.
 // B-grade: mixed/transitioning 1D context + any 2 of 5 clean 4H triggers,
 // entered at half risk until the 4H trendline breaks/retests.
 const dailyMomentumBull=String(dailyLive?.momentum?.direction||"").startsWith("BULL");
 const dailyMomentumBear=String(dailyLive?.momentum?.direction||"").startsWith("BEAR");
 const dailyBullishOrTurning=dailyBull||dailyTurnBull||dailyMomentumBull;
 const dailyBearishOrTurning=dailyBear||dailyTurnBear||dailyMomentumBear;

 // ENTRY_1 follows the original V28 philosophy: location + StochRSI timing.
 // 1D/4H diagnostics remain available on the symbol cards, but are not stacked gates.
 const reclaim8Long=price>=(e8.at(-1)??price)&&prev.close<(e8.at(-2)??prev.close);
 const reclaim8Short=price<=(e8.at(-1)??price)&&prev.close>(e8.at(-2)??prev.close);
 const higherLow=last.low>Math.min(...candles4h.slice(-EARLY_LOOKBACK,-1).map(x=>x.low));
 const lowerHigh=last.high<Math.max(...candles4h.slice(-EARLY_LOOKBACK,-1).map(x=>x.high));
 const priorHighBreak=last.close>Math.max(...candles4h.slice(-4,-1).map(x=>x.high));
 const priorLowBreak=last.close<Math.min(...candles4h.slice(-4,-1).map(x=>x.low));
 const macdImprovingLong=macd.bullishShift;
 const macdImprovingShort=macd.bearishShift;
 const longTriggers=(macd.bullishShift?1:0)+(early5Bull?1:0)+(reclaim8Long?1:0)+(higherLow?1:0)+(priorHighBreak?1:0);
 const shortTriggers=(macd.bearishShift?1:0)+(early5Bear?1:0)+(reclaim8Short?1:0)+(lowerHigh?1:0)+(priorLowBreak?1:0);
 let earlyLong=false,earlyShort=false;
 let earlyLongGrade:"A"|"B"|null=null,earlyShortGrade:"A"|"B"|null=null;

 debug.push(`[1D] ${pair} | ${dailyState||"LOCAL"}/${dailyCandidate||"—"} | ${dailyDirection}`);
 debug.push(`[4H] ${pair} | MACD ${macd.bullishShift?"BULL_IMPROVING":macd.bearishShift?"BEAR_IMPROVING":"NEUTRAL"} | 5/13=${fourH513.label} | 8/21=${price >= (e21.at(-1) ?? price) ? "ABOVE" : "BELOW"} | triggers=${longTriggers}/${shortTriggers} | early=WAIT_TL_STOCH`); const prepare=(dir:"LONG"|"SHORT")=>{const primary=buildTrendline(candles4h,dir,60),wasStale=primary.stale,alreadyBeyond=primary.valid&&(dir==="LONG"?price>primary.price*1.02:price<primary.price*0.98);let tl=primary;if(wasStale){const fresh=buildTrendline(candles4h,dir,FRESH_LOOKBACK);if(fresh.valid)tl={...fresh,reason:`${fresh.reason}; fresh ${FRESH_LOOKBACK}-candle structure`};}const buf=tl.valid?Math.max(Math.abs(tl.price)*BREAKOUT_PCT,atr(candles4h)*.35):0,freshBeyond=wasStale&&alreadyBeyond&&tl.valid&&(dir==="LONG"?price>tl.price+buf:price<tl.price-buf);return{tl,wasStale,alreadyBeyond,freshBeyond};};
 const LP=prepare("LONG"),SP=prepare("SHORT");let longTL=LP.tl,shortTL=SP.tl;
 if(structureDir==="LONG"&&shortTL.valid){debug.push(`[V28 SYNC] ${pair} — LONG HEALTHY invalidates opposing SHORT TL @ ${shortTL.price.toFixed(2)}; rebuilding LONG TL from confirmed LOW pivots`);longTL=buildTrendline(candles4h,"LONG",FRESH_LOOKBACK);}else if(structureDir==="SHORT"&&longTL.valid){debug.push(`[V28 SYNC] ${pair} — SHORT HEALTHY invalidates opposing LONG TL @ ${longTL.price.toFixed(2)}; rebuilding SHORT TL from confirmed HIGH pivots`);shortTL=buildTrendline(candles4h,"SHORT",FRESH_LOOKBACK);}
 const logTlDiag=(dir:"LONG"|"SHORT",tl:TL)=>{if(!tl.valid){debug.push(`[TL] ${pair} ${dir} invalid pivots=${tl.pivots.length}/2`);return;}const p1=tl.pivots.at(-2)!,p2=tl.pivots.at(-1)!,dist=Math.abs((price-tl.price)/Math.max(Math.abs(tl.price),1))*100;debug.push(`[TL] ${pair} ${dir} ${tl.price.toFixed(2)} dist=${dist.toFixed(2)}% age=${i-p2.index}c stale=${tl.stale?"YES":"NO"}`);};
 logTlDiag("LONG",longTL);logTlDiag("SHORT",shortTL);
 const test=(dir:"LONG"|"SHORT",tl:TL)=>{if(!tl.valid)return{breakout:false,retest:false,line:0,buf:0,dist:0,freshBeyond:false,alreadyBeyondBuffer:false};const line=lineAt(tl,i),prevLine=lineAt(tl,i-1),buf=Math.max(Math.abs(line)*BREAKOUT_PCT,atr(candles4h)*.35),priceDistance=Math.abs((price-line)/Math.max(Math.abs(line),1)),broke=dir==="LONG"?last.close>line+buf&&prev.close<=prevLine+buf:last.close<line-buf&&prev.close>=prevLine-buf,alreadyBeyondBuffer=dir==="LONG"?last.close>line+buf:last.close<line-buf,retest=dir==="LONG"?last.low<=line*(1+RETEST_PCT)&&last.close>line&&last.close>=prev.close:last.high>=line*(1-RETEST_PCT)&&last.close<line&&last.close<=prev.close;return{breakout:broke,retest,line,buf,dist:(price-line)/Math.max(Math.abs(line),1),freshBeyond:false,alreadyBeyondBuffer};};
 const L=test("LONG",longTL),S=test("SHORT",shortTL);
 const NEAR_TL_BUFFER=0.0025;
 const nearTLThreshold=Math.max(0,RETEST_PCT-NEAR_TL_BUFFER);
 const entryLongTL=buildTrendline(closed4h,"LONG",60);
 const entryShortTL=buildTrendline(closed4h,"SHORT",60);
 const longNearTL=entryLongTL.valid&&Math.abs((entryLast.close-entryLongTL.price)/Math.max(Math.abs(entryLongTL.price),1))<=nearTLThreshold;
 const shortNearTL=entryShortTL.valid&&Math.abs((entryLast.close-entryShortTL.price)/Math.max(Math.abs(entryShortTL.price),1))<=nearTLThreshold;
 const longStochExtreme=entrySt.k<20;
 const longStochTurn=entrySt.k>entrySt.d&&entrySt.k<40;
 // SHORT requires an actual bearish StochRSI turn. Being overbought by itself is not enough.
 const shortStochTurn=entrySt.k<entrySt.d&&entrySt.k>60;
 const longRejection=entryLast.close>entryLast.open&&entryLast.close>entryPrev.close;
 const shortRejection=entryLast.close<entryLast.open&&entryLast.close<entryPrev.close;

 // ENTRY_1 = original V28 location/timing model, evaluated only on closed 4H candles.
 // LONG = near LOW trendline + oversold/turning StochRSI.
 // SHORT = near HIGH trendline + bearish StochRSI turn/rejection.
 // 1D context only determines A/B risk; it does not veto the reversal.
 earlyLong=longNearTL&&(longStochExtreme||(longStochTurn&&longRejection));
 earlyShort=shortNearTL&&shortStochTurn&&shortRejection;
 earlyLongGrade=earlyLong?(dailyBullishOrTurning?"A":"B"):null;
 earlyShortGrade=earlyShort?(dailyBearishOrTurning?"A":"B"):null;
 const longTrendlineExtreme=longTL.valid&&price>longTL.price&&(price-longTL.price)>av*2;
 const shortTrendlineExtreme=shortTL.valid&&price<shortTL.price&&(shortTL.price-price)>av*2;
 debug.push(`[ENTRY_1] ${pair} | CLOSED_4H ${new Date(entryLast.timestamp).toISOString()} | LONG nearTL=${longNearTL?"YES":"NO"} stoch=${entrySt.k.toFixed(1)}/${entrySt.d.toFixed(1)} | SHORT nearTL=${shortNearTL?"YES":"NO"} stoch=${entrySt.k.toFixed(1)}/${entrySt.d.toFixed(1)} | early=${earlyLong?"LONG_"+earlyLongGrade:earlyShort?"SHORT_"+earlyShortGrade:"NO"}`);
 if(!earlyLong&&!earlyShort)debug.push(`[ENTRY_1 WAIT] ${pair} | waiting for trendline + StochRSI timing/rejection`);
 // Continuation retest: a controlled pullback into the fast 4H trend structure.
 // This is deliberately stricter than "first red/green candle": price must remain
 // on the correct side of 8/21, 5/13 must still agree, and MACD must not have
 // confirmed a full momentum reversal. It can therefore support ADD or ENTRY_2.
 const pullbackLong=last.close<last.open&&last.low<=e8.at(-1)!*(1+RETEST_PCT)&&last.close>=e21.at(-1)!&&last.close>=(prev.close*0.985);
 const pullbackShort=last.close>last.open&&last.high>=e8.at(-1)!*(1-RETEST_PCT)&&last.close<=e21.at(-1)!&&last.close<=(prev.close*1.015);
 const continuationLong=pullbackLong&&bull5of13&&e8.at(-1)!>e21.at(-1)!&&!macd.bearishCross&&macd.rising&&st.k<90;
 const continuationShort=pullbackShort&&bear5of13&&e8.at(-1)!<e21.at(-1)!&&!macd.bullishCross&&macd.falling&&st.k>10;
 let dir:"LONG"|"SHORT"|null=null,tl:TL|null=null,breakout=false,retest=false,continuation=false,early=false;
 if(earlyLong&&!earlyShort){dir="LONG";tl=longTL;early=true;}
 else if(earlyShort&&!earlyLong){dir="SHORT";tl=shortTL;early=true;}
 else if(structureDir==="LONG"){dir="LONG";tl=longTL;breakout=L.breakout;retest=L.retest;}
 else if(structureDir==="SHORT"){dir="SHORT";tl=shortTL;breakout=S.breakout;retest=S.retest;}
 else if(L.breakout&&!S.breakout){dir="LONG";tl=longTL;breakout=true;}
 else if(S.breakout&&!L.breakout){dir="SHORT";tl=shortTL;breakout=true;}
 else if(L.retest&&!S.retest){dir="LONG";tl=longTL;retest=true;}
 else if(S.retest&&!L.retest){dir="SHORT";tl=shortTL;retest=true;}
 else if(continuationLong&&!continuationShort){dir="LONG";tl=longTL;continuation=true;}
 else if(continuationShort&&!continuationLong){dir="SHORT";tl=shortTL;continuation=true;}
 else if(contextDir){dir=contextDir;tl=dir==="LONG"?longTL:shortTL;}
 if(!dir||!tl){debug.push("No 4H structural direction");return{debug};}
 if(opposite(pair,dir,activeTrades)){debug.push("Opposite direction active");return{debug};}
 const has=same(pair,dir,activeTrades);
 if(!tl.valid&&!early){debug.push(`State: ${tl.reason}`);return{market:snapshot(pair,candles4h,dir,tl,price,dailyLive),debug};}
 let type:"ENTRY_1"|"ENTRY_2"|"ADD"|null=null;
 if(early){type="ENTRY_1";debug.push(`[V28 EARLY] ${pair} ${dir} | daily turn + 4H transition`);}
 else if(breakout){type="ENTRY_1";}
 else if(retest){if(has){type="ADD";}else{const hasRecentBreakout=!!lastBreakout&&lastBreakout.direction===dir&&(i-lastBreakout.candleIndex)>=0&&(i-lastBreakout.candleIndex)<=BREAKOUT_EXPIRY_CANDLES;if(!hasRecentBreakout)return{market:snapshot(pair,candles4h,dir,tl,price,dailyLive),debug};const retestDistance=Math.abs(price-lastBreakout!.price)/Math.max(Math.abs(lastBreakout!.price),1);if(retestDistance>=0.01)return{market:snapshot(pair,candles4h,dir,tl,price,dailyLive),debug};type="ENTRY_2";}}
 else if(continuation){
   if(has){type="ADD";debug.push(`[V28 CONTINUATION] ${pair} ${dir} | controlled 4H pullback into 8/21`);}
   else{
     const hasRecentBreakout=!!lastBreakout&&lastBreakout.direction===dir&&(i-lastBreakout.candleIndex)>=0&&(i-lastBreakout.candleIndex)<=BREAKOUT_EXPIRY_CANDLES;
     if(!hasRecentBreakout)return{market:snapshot(pair,candles4h,dir,tl,price,dailyLive),debug};
     const retestDistance=Math.abs(price-lastBreakout!.price)/Math.max(Math.abs(lastBreakout!.price),1);
     const nearBreakout=retestDistance<=RETEST_PCT;
     if(!nearBreakout)return{market:snapshot(pair,candles4h,dir,tl,price,dailyLive),debug};
     type="ENTRY_2";debug.push(`[V28 CONTINUATION] ${pair} ${dir} | ENTRY_2 after controlled 4H pullback`);
   }
 }
 if(!type){debug.push(`State: ${has?"POST_BREAKOUT_WAIT":"WAITING"}`);return{market:snapshot(pair,candles4h,dir,tl,price,dailyLive),debug};}
 const structural=dir==="LONG"?Math.min(...candles4h.slice(-10).map(x=>x.low),entryPriceFor(dir,price,av,type)):Math.max(...candles4h.slice(-10).map(x=>x.high),entryPriceFor(dir,price,av,type));
 const entry=price,stop=structural,risk=Math.abs(entry-stop);if(!risk)return{debug};
 const tp1=dir==="LONG"?entry+risk:entry-risk,tp2=dir==="LONG"?entry+risk*1.5:entry-risk*1.5,tp3=dir==="LONG"?entry+risk*2:entry-risk*2,target=tp2,rr=1.5;if(rr<MIN_RR)return{market:snapshot(pair,candles4h,dir,tl,price,dailyLive),debug:[...debug,"R:R below minimum"]};
 const l=liq(entry,dir),safe=dir==="LONG"?l*(1+LIQ_BUFFER):l*(1-LIQ_BUFFER),daily513=getDaily513Diagnostic(candles4h),agreesWith1D=dailyLive?(dir==="LONG"&&dailyBull)||(dir==="SHORT"&&dailyBear):((dir==="LONG"&&daily513.direction==="BULLISH")||(dir==="SHORT"&&daily513.direction==="BEARISH")),earlyGrade=dir==="LONG"?earlyLongGrade:earlyShortGrade,riskMultiplier=early?(earlyGrade==="A"&&agreesWith1D?1:0.5):(agreesWith1D?1:0.5),baseRisk=risk,positionSize=baseRisk*riskMultiplier,trendAlignment=agreesWith1D?"WITH_1D":"AGAINST_1D";
 const breakoutRecord:BreakoutRecord=type==="ENTRY_1"&&!early?{direction:dir,price:round(tl.price),timestamp:now,candleIndex:i}:lastBreakout!;
 const location=early?"EARLY_REVERSAL":breakout?"BREAKOUT":continuation?"MOMENTUM_PULLBACK":"RETEST",trigger=early?"1D_REGIME_4H_TRANSITION":breakout?"4H_TRENDLINE_BREAKOUT":continuation?"4H_MOMENTUM_PULLBACK":"4H_BREAKOUT_RETEST";
 const s:Signal={id:`${pair}_${type}_${now}`,pair,direction:dir,type,scale:type,entry:round(entry),stop:round(stop),target:round(target),tp1:round(tp1),tp2:round(tp2),tp3:round(tp3),confidence:early?70:type==="ENTRY_1"?80:type==="ENTRY_2"?70:85,rr,adx:a,rsi:r,stochK:st.k,stochD:st.d,expectedMove:Math.round(Math.abs(tp3-entry)/entry*1000)/10,reason:early?`${dir} ENTRY_1 EARLY ${earlyGrade} | 1D ${dailyState||dailyCandidate||"REGIME"} | 4H triggers ${dir==="LONG"?longTriggers:shortTriggers}/5 | MACD ${dir==="LONG"?(macdImprovingLong?"improving":"—"):(macdImprovingShort?"improving":"—")} | 5/13 ${fourH513.label}`: `${dir} ${type} | 4H trendline breakout/retest | 1D ${contextDir?strength(d,contextDir):"NEUTRAL"} | Stoch ${st.k}/${st.d}`,timestamp:now,version:CURRENT_SIGNAL_VERSION,trend:`${dir} ${strength(d,dir)}`,location,trigger,context:{marketPhase:early?`${dir} EARLY REVERSAL ${earlyGrade}`:`${dir} ${strength(d,dir)}`,structure:early?`4H ${structure.structure||"TRANSITION"} + trigger count ${dir==="LONG"?longTriggers:shortTriggers}/5`:(breakout?"4H TRENDLINE BREAKOUT":"4H BREAKOUT RETEST"),momentum:`RSI ${r} | Stoch ${st.k}/${st.d} | MACD hist ${round(macd.histogram)}`,pullback:continuation?"controlled_4h_momentum_pullback":retest?"confirmed_retest":early?"early_transition":"breakout",fourH513,daily513,dailyLive:dailyLive||null,macd4h:macd,trendAlignment,sizeMultiplier:riskMultiplier,earlyGrade:early?earlyGrade:undefined,risk:{baseRisk:round(baseRisk),positionSize:round(positionSize),trendAlignment,sizeMultiplier:riskMultiplier,riskMultiplier,estimatedLiquidation:round(l),safeBoundary:round(safe),leverage:LEVERAGE},breakoutRecord:breakoutRecord?{direction:breakoutRecord.direction,price:round(breakoutRecord.price),timestamp:breakoutRecord.timestamp,candleIndex:breakoutRecord.candleIndex}:undefined,stages:{tp1:round(tp1),tp2:round(tp2),tp3:round(tp3),tp1R:1,tp2R:1.5,tp3R:2}}};
 debug.push(`SIGNAL: ${type} ${dir} @ ${s.entry} | SL ${s.stop} | TP1 ${s.tp1} | TP2 ${s.tp2} | TP3 ${s.tp3} | ${trendAlignment} | ${early?`EARLY_${earlyGrade}`:"CONFIRMED"} | size x${riskMultiplier}`);return{signal:s,signals:[s],market:snapshot(pair,candles4h,dir,tl,price,dailyLive),debug};
}

function entryPriceFor(_dir:"LONG"|"SHORT",entry:number,av:number,_type:string){return _dir==="LONG"?entry-av*(_type==="ADD"?ADD_ATR:ENTRY_ATR):entry+av*(_type==="ADD"?ADD_ATR:ENTRY_ATR);}

export function getMarketSnapshot(pair:string,candles1h:Candle[],candles4h:Candle[],candles15m:Candle[]){const d=daily(candles4h),dir=bias(d),price=candles4h.at(-1)?.close||0;if(!dir)return{pair,price,timestamp:Date.now(),trend:"FLAT",location:"NONE",trigger:"NO_BIAS",adx:0,rsi:0,stochK:0,stochD:0,trendlinePrice:0,distToTrendline:null,momentumState:"NEUTRAL"};const structure=detectStructureShift(pair,candles4h),syncDir=structure.state==="HEALTHY"&&(structure.structure==="LONG"||structure.structure==="SHORT")?structure.structure:null,effectiveDir=syncDir||dir,primary=buildTrendline(candles4h,effectiveDir,60),tl=primary.stale?buildTrendline(candles4h,effectiveDir,FRESH_LOOKBACK):primary;return snapshot(pair,candles4h,effectiveDir,tl.valid?tl:primary,price);}
export interface ValidityCheck{valid:boolean;reason:string;exited:boolean;state?:"VALID"|"STALE"|"INVALID";}
export function isSignalStillValid(s:Signal,p:number,now=Date.now()):ValidityCheck{if(now-s.timestamp>(s.type==="ADD"?4:24)*60*60*1000)return{valid:false,reason:"expired_ttl",exited:true,state:"STALE"};if(s.direction==="LONG"&&p<=s.stop)return{valid:false,reason:"sl_hit",exited:true,state:"INVALID"};if(s.direction==="SHORT"&&p>=s.stop)return{valid:false,reason:"sl_hit",exited:true,state:"INVALID"};return{valid:true,reason:"active",exited:false,state:"VALID"};}
export interface HoldResult{shouldHold:boolean;reason:string;newStop?:number;scaleOut?:{level:number;size:number;label:string};}
export function shouldHold(s:Signal,c:Candle[],p:number):HoldResult{const risk=Math.abs(s.entry-s.stop);if(risk){const rr=s.direction==="LONG"?(p-s.entry)/risk:(s.entry-p)/risk;if(rr>=2){const a=atr(c),e21=ema(c.map(x=>x.close),TF_SLOW).at(-1)!,trail=s.direction==="LONG"?e21-a*1.5:e21+a*1.5,locked=s.direction==="LONG"?s.entry+risk:s.entry-risk,newStop=s.direction==="LONG"?Math.max(locked,trail):Math.min(locked,trail);return{shouldHold:true,reason:"tp3_runner_trailing",newStop,scaleOut:{level:s.tp3??s.entry,size:.2,label:"TP3_RUNNER_20"}};}if(rr>=1.5)return{shouldHold:true,reason:"tp2_hit_lock_1r_runner",newStop:s.direction==="LONG"?s.entry+risk:s.entry-risk,scaleOut:{level:s.tp2??s.entry,size:.4,label:"TP2"}};if(rr>=1)return{shouldHold:true,reason:"tp1_hit_scale_out_40",newStop:s.entry,scaleOut:{level:s.tp1??s.entry,size:.4,label:"TP1"}};}return isSignalStillValid(s,p);}
export function shouldHoldCompat(s:Signal,c4:Candle[],c1:Candle[],p:number){return shouldHold(s,c4,p);}
export function filterExpiredSignals(signals:Signal[],prices:Record<string,number>,now?:number){const active:Signal[]=[],exited:{signal:Signal;reason:string}[]=[];for(const s of signals){const p=prices[s.pair];if(p===undefined){active.push(s);continue;}const v=isSignalStillValid(s,p,now);v.valid?active.push(s):exited.push({signal:s,reason:v.reason});}return{active,exited};}
export type TradeStatus="ACTIVE"|"TP_HIT"|"SL_HIT"|"EXPIRED";
export function checkTradeStatus(s:Signal,p:number,now=Date.now()):TradeStatus{const v=isSignalStillValid(s,p,now);if(v.reason==="expired_ttl")return"EXPIRED";if(s.direction==="LONG"&&p<=s.stop)return"SL_HIT";if(s.direction==="SHORT"&&p>=s.stop)return"SL_HIT";return"ACTIVE";}
export function rebuildStateFromTrades(_:Record<string,any>):void{return;}
