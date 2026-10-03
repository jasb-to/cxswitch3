import { get4HEmaDiagnostic } from "./ema-diagnostic";

// lib/strategy.ts — CX Switch simplified v28
// 1D EMA 8/21 direction -> 4H transition -> 4H break-line -> 4H StochRSI timing -> ENTRY_1 / ENTRY_2.
// No Fib paths, daily pre-breaks, weekly gates, scores, or multi-stage state machines.
// ENTRY_1 = early accumulation; ENTRY_2 = confirmed trendline break; no ADD.

export interface Candle { timestamp:number; open:number; high:number; low:number; close:number; volume:number; }
export interface Signal {
  id:string; pair:string; direction:"LONG"|"SHORT"; type:"ENTRY_1"|"ENTRY_2";
  scale:"ENTRY_1"|"ENTRY_2"|null; entry:number; stop:number; target:number; tp1?:number; tp2?:number; tp3?:number;
  rr:number; adx:number; rsi:number; stochK:number; stochD:number;
  /** Backward-compatible shape only; clean engine never computes or populates confidence. */ confidence?:number;
  expectedMove:number; reason:string; timestamp:number; version:number;
  trend?:string; location?:string; trigger?:string; context?:any;
}
export type BreakoutRecord = { direction:"LONG"|"SHORT"; price:number; timestamp:number; candleIndex:number; };
export interface SignalResult { signal?:Signal; signals?:Signal[]; market?:any; debug:string[]; breakout?:{direction:"LONG"|"SHORT";price:number;timestamp:number;candleIndex:number}; }
export const CURRENT_SIGNAL_VERSION=28;
const LEVERAGE=20, MMR=0.01, LIQ_BUFFER=0.015;
const MIN_RR=1.5;
type Direction="LONG"|"SHORT";
interface Pivot { index:number; price:number; timestamp:number; }
interface TrendlineState { slope:number; intercept:number; pivots:Pivot[]; lastUpdated:number; direction:Direction; r2:number; startIndex:number; endIndex:number; }
interface HysteresisState { lastSignalType:"ENTRY_1"|"ENTRY_2"|null; lastSignalDirection:Direction|null; lastSignalPrice:number; lockUntil:number; }
const trendlineStore=new Map<string,TrendlineState>();
const hysteresisStore=new Map<string,HysteresisState>();
const exhaustionBlockedSince=new Map<string,number>();
const HYSTERESIS_BAND=0.005;
const TRENDLINE_MAX_AGE=7*24*60*60*1000;
const TRENDLINE_MAX_DEVIATION=0.02;
const ENTRY1_ATR_DISTANCE=0.75;
const ENTRY2_ATR_BUFFER=0.25;
const MIN_PIVOTS=3;
const MAX_PIVOTS=5;
const avg=(a:number[])=>a.length?a.reduce((x,y)=>x+y,0)/a.length:0;
const round=(n:number,d=2)=>{const m=10**d;return Math.round(n*m)/m;};
function ema(a:number[],p:number){if(!a.length)return[];const k=2/(p+1),r=[a[0]];for(let i=1;i<a.length;i++)r.push(a[i]*k+r[i-1]*(1-k));return r;}

// Wilder RSI, then TradingView-style StochRSI(14,14,3,3).
function rsiSeries(a:number[],p=14){
  if(a.length<=p)return[]; let g=0,l=0;
  for(let i=1;i<=p;i++){const d=a[i]-a[i-1];if(d>0)g+=d;else l-=d;}
  let ag=g/p,al=l/p; const out:number[]=[];
  out.push(al===0?100:100-100/(1+ag/al));
  for(let i=p+1;i<a.length;i++){const d=a[i]-a[i-1],up=Math.max(d,0),dn=Math.max(-d,0);ag=(ag*(p-1)+up)/p;al=(al*(p-1)+dn)/p;out.push(al===0?100:100-100/(1+ag/al));}
  return out;
}
function rsi(a:number[],p=14){const x=rsiSeries(a,p);return x.length?x[x.length-1]:50;}
function stochRsi(a:number[],rp=14,sp=14,ks=3,ds=3){
  const rv=rsiSeries(a,rp);if(rv.length<sp)return{k:50,d:50};const raw:number[]=[];
  for(let i=sp-1;i<rv.length;i++){const w=rv.slice(i-sp+1,i+1),lo=Math.min(...w),hi=Math.max(...w);raw.push(hi===lo?50:(rv[i]-lo)/(hi-lo)*100);}
  const kv:number[]=[];for(let i=ks-1;i<raw.length;i++)kv.push(avg(raw.slice(i-ks+1,i+1)));
  if(kv.length<ds)return{k:50,d:50};return{k:round(kv[kv.length-1],1),d:round(avg(kv.slice(-ds)),1)};
}
function atr(c:Candle[],p=14){if(c.length<2)return 0;const r:number[]=[];for(let i=Math.max(1,c.length-p);i<c.length;i++){const x=c[i],q=c[i-1];r.push(Math.max(x.high-x.low,Math.abs(x.high-q.close),Math.abs(x.low-q.close)));}return avg(r);}
function wilder(a:number[],p:number){if(!a.length)return[];if(a.length<p)return[avg(a)];const r=[avg(a.slice(0,p))];for(let i=p;i<a.length;i++)r.push((r[r.length-1]*(p-1)+a[i])/p);return r;}
function adx(c:Candle[],p=14){
  if(c.length<p+2)return 0;const tr:number[]=[],plus:number[]=[],minus:number[]=[];
  for(let i=1;i<c.length;i++){const x=c[i],q=c[i-1];tr.push(Math.max(x.high-x.low,Math.abs(x.high-q.close),Math.abs(x.low-q.close)));const up=x.high-q.high,dn=q.low-x.low;plus.push(up>dn?Math.max(up,0):0);minus.push(dn>up?Math.max(dn,0):0);}
  const t=wilder(tr,p),pu=wilder(plus,p),mi=wilder(minus,p),dx:number[]=[];
  for(let i=0;i<t.length;i++){const a=pu[i]/Math.max(t[i],1e-12)*100,b=mi[i]/Math.max(t[i],1e-12)*100;dx.push(a+b===0?0:Math.abs(a-b)/(a+b)*100);}
  const z=wilder(dx,p);return z.length?round(z[z.length-1],1):0;
}
function aggregateTo1D(c:Candle[]){
  const m=new Map<string,Candle[]>();
  for(const x of [...c].sort((a,b)=>a.timestamp-b.timestamp)){const d=new Date(x.timestamp),k=d.getUTCFullYear()+"-"+d.getUTCMonth()+"-"+d.getUTCDate();const b=m.get(k)||[];b.push(x);m.set(k,b);}
  return [...m.values()].map(b=>({timestamp:b[0].timestamp,open:b[0].open,high:Math.max(...b.map(x=>x.high)),low:Math.min(...b.map(x=>x.low)),close:b[b.length-1].close,volume:b.reduce((s,x)=>s+x.volume,0)}));
}
function trend1D(c:Candle[]){
  if(c.length<25)return{direction:null as Direction|null,strength:"WEAK",ema8:0,ema21:0,spreadPct:0};
  const a=c.map(x=>x.close),e8=ema(a,8).at(-1)!,e21=ema(a,21).at(-1)!,p=a.at(-1)!;const spread=p?Math.abs(e8-e21)/p:0;
  if(spread<=0.005)return{direction:null as Direction|null,strength:"NEUTRAL",ema8:e8,ema21:e21,spreadPct:spread};
  const direction:Direction=e8>e21?"LONG":"SHORT";const h=c.slice(-20).map(x=>x.high),l=c.slice(-20).map(x=>x.low);
  const strong=(direction==="LONG"&&h.at(-1)!>Math.max(...h.slice(0,-1)))||(direction==="SHORT"&&l.at(-1)!<Math.min(...l.slice(0,-1)));
  return{direction,strength:strong?"STRONG":"MEDIUM",ema8:e8,ema21:e21,spreadPct:spread};
}
function findPivots(c:Candle[],d:Direction,w=2){
  const r:Pivot[]=[],highs=d==="LONG";
  for(let i=w;i<c.length-w;i++){const v=highs?c[i].high:c[i].low;let ok=true;for(let j=1;j<=w;j++){if(highs?(v<=c[i-j].high||v<=c[i+j].high):(v>=c[i-j].low||v>=c[i+j].low)){ok=false;break;}}if(ok)r.push({index:i,price:v,timestamp:c[i].timestamp});}return r;
}
function fitLine(p:Pivot[]){
  if(p.length<2)return null;const n=p.length,sx=p.reduce((s,x)=>s+x.index,0),sy=p.reduce((s,x)=>s+x.price,0),sxy=p.reduce((s,x)=>s+x.index*x.price,0),sx2=p.reduce((s,x)=>s+x.index*x.index,0),den=n*sx2-sx*sx;if(!den)return null;
  const slope=(n*sxy-sx*sy)/den,inter=(sy-slope*sx)/n,mean=sy/n,total=p.reduce((s,x)=>s+(x.price-mean)**2,0),res=p.reduce((s,x)=>s+(x.price-(slope*x.index+inter))**2,0);
  return{slope,intercept:inter,r2:total?Math.max(0,1-res/total):0};
}
function buildTrendline(c:Candle[],d:Direction){
  if(c.length<25)return null;const all=findPivots(c,d),ps=all.slice(-MAX_PIVOTS);if(ps.length<MIN_PIVOTS)return null;let best:any=null;
  for(let s=0;s<=ps.length-MIN_PIVOTS;s++){const selected=ps.slice(s),fit=fitLine(selected);if(!fit)continue;if(d==="LONG"&&fit.slope>=0)continue;if(d==="SHORT"&&fit.slope<=0)continue;if(!best||fit.r2>best.fit.r2)best={fit,pivots:selected};}
  if(!best)return null;const last=best.pivots.at(-1)!;
  return{slope:best.fit.slope,intercept:best.fit.intercept,pivots:best.pivots,lastUpdated:c.at(-1)!.timestamp,direction:d,r2:best.fit.r2,startIndex:best.pivots[0].index,endIndex:last.index};
}
function getTrendline(pair:string,c:Candle[],d:Direction){
  const now=c.at(-1)?.timestamp??Date.now(),old=trendlineStore.get(pair);
  if(old&&old.direction===d){const age=now-old.lastUpdated,last=findPivots(c,d).at(-1);const projected=last?old.slope*last.index+old.intercept:0;const dev=last&&projected?Math.abs(last.price-projected)/Math.abs(projected):0;
    if(age<=TRENDLINE_MAX_AGE&&dev<=TRENDLINE_MAX_DEVIATION){const price=old.slope*(c.length-1)+old.intercept;return{state:old,price,age};}}
  const fresh=buildTrendline(c,d);if(!fresh)return null;trendlineStore.set(pair,fresh);return{state:fresh,price:fresh.slope*(c.length-1)+fresh.intercept,age:0};
}
function setHysteresis(pair:string,type:"ENTRY_1"|"ENTRY_2",direction:Direction,price:number,now:number){hysteresisStore.set(pair,{lastSignalType:type,lastSignalDirection:direction,lastSignalPrice:price,lockUntil:now+24*60*60*1000});}
function hystOK(pair:string,type:"ENTRY_1"|"ENTRY_2",direction:Direction,price:number,now:number,debug:string[]){const s=hysteresisStore.get(pair);if(!s||now>s.lockUntil||s.lastSignalType!==type||s.lastSignalDirection!==direction)return true;const move=Math.abs(price-s.lastSignalPrice)/Math.max(s.lastSignalPrice,1);if(move< HYSTERESIS_BAND){debug.push("[STATE] hysteresis lock | "+type+" | move "+(move*100).toFixed(2)+"% < 0.50%");return false;}return true;}
type TrendlineApproachClass="BREAK_ATTEMPT"|"REJECTION"|"NEUTRAL";

function classifyTrendlineApproach(c:Candle[],line:number,slope:number,k:number,prevK:number){
  const recent=c.slice(-3);
  const sd=k>prevK+1?"RISING":k<prevK-1?"FALLING":"FLAT";
  let rejectionCandles=0;
  for(let i=0;i<recent.length;i++){
    const x=recent[i],idx=c.length-recent.length+i,range=Math.max(x.high-x.low,1e-12);
    const upper=(x.high-Math.max(x.open,x.close))/range,lineAt=slope*idx+line;
    if(upper>0.40&&x.high>=lineAt) rejectionCandles++;
  }
  const last=recent.at(-1)!,lastIndex=c.length-1,lastLine=slope*lastIndex+line;
  const lastTouched=last.high>=lastLine,closeBackInside=lastTouched&&last.close<lastLine;
  const rejection=sd!=="RISING"&&(rejectionCandles>=2||closeBackInside);
  const strongCloses=recent.filter(x=>{
    const range=Math.max(x.high-x.low,1e-12),upper=(x.high-Math.max(x.open,x.close))/range;
    return upper<0.25;
  }).length;
  const breakAttempt=sd==="RISING"&&(last.close>lastLine||strongCloses>=2);
  return{classification:rejection?"REJECTION":breakAttempt?"BREAK_ATTEMPT":"NEUTRAL",stochDirection:sd,rejectionCandles,closeBackInside,lastTouched};
}

function exhaustion(d:Direction,k:number,r:number){
  if(d==="LONG"){
    if(k>=99)return"STOCH_PINNED_LONG K"+k;
    if(r>=80)return"RSI_EXTREME_LONG RSI"+r;
    if(k>95&&r>75)return"STOCH_RSI_COMBINED_LONG K"+k+" RSI"+r;
  }else{
    if(k<=1)return"STOCH_PINNED_SHORT K"+k;
    if(r<=20)return"RSI_EXTREME_SHORT RSI"+r;
    if(k<5&&r<25)return"STOCH_RSI_COMBINED_SHORT K"+k+" RSI"+r;
  }
  return null;
}
function market(pair:string,p:number,t:any,tl:number|null,k:number,d:number,r:number,a:number,e8:number,e21:number,ts:number){return{pair,price:round(p),timestamp:ts,trend:t.direction?t.direction+" "+t.strength:"NEUTRAL",dailyDirection:t.direction==="LONG"?"BULL":t.direction==="SHORT"?"BEAR":"NEUTRAL",dailyStrength:t.strength,dailyEma8:round(t.ema8),dailyEma21:round(t.ema21),dailyEmaSpreadPct:round(t.spreadPct*100,3),adx:round(a,1),rsi:round(r,1),stochK:round(k,1),stochD:round(d,1),trendlinePrice:tl===null?0:round(tl),distToTrendline:tl===null?null:round((p-tl)/tl*100,3),ema8:round(e8),ema21:round(e21)};}

export function generateSignal(pair:string,candles1h:Candle[],candles4h:Candle[],candles15m:Candle[],activeTrades:any[]=[],currentPrice?:number,lastBreakout?:any,dailyLive?:any,candlesWeekly:Candle[]=[],marketHealth?:any,nowOverride?:number):SignalResult{
  const debug:string[]=[];if(candles4h.length<40){debug.push("[STATE] insufficient 4H history");return{debug};}
  const sorted=[...candles4h].sort((a,b)=>a.timestamp-b.timestamp),closed=sorted.length>1?sorted.slice(0,-1):sorted;if(closed.length<40){debug.push("[STATE] insufficient CLOSED 4H history");return{debug};}
  const daily=aggregateTo1D(closed),t=trend1D(daily),price=currentPrice??sorted.at(-1)!.close,closes=closed.map(x=>x.close),st=stochRsi(closes),r=rsi(closes),a=adx(closed),av=atr(closed),e8=ema(closes,8).at(-1)??price,e21=ema(closes,21).at(-1)??price,now=nowOverride??Date.now();
  debug.push("[1D] "+(t.direction||"NEUTRAL")+" | EMA8 "+round(t.ema8)+" | EMA21 "+round(t.ema21)+" | spread "+(t.spreadPct*100).toFixed(2)+"% | "+t.strength);
  debug.push("[STOCH] K "+st.k+" | D "+st.d+" | RSI "+round(r,1));
  if(!t.direction){debug.push("[STATE] 1D EMA8/EMA21 within 0.5% — neutral/chop, no trade");debug.push("[SIGNAL] none");debug.push("[ALERT] none");return{market:market(pair,price,t,null,st.k,st.d,r,a,e8,e21,now),debug};}
  const tl=getTrendline(pair,closed,t.direction);if(!tl){debug.push("[TL] no valid 3-pivot directional trendline");debug.push("[SIGNAL] none");debug.push("[ALERT] none");return{market:market(pair,price,t,null,st.k,st.d,r,a,e8,e21,now),debug};}
  const tlPrice=tl.price,dist=(price-tlPrice)/Math.max(Math.abs(tlPrice),1),ageDays=tl.age/(24*60*60*1000);
  debug.push("[TL] "+round(tlPrice)+" | R² "+round(tl.state.r2,2)+" | distance "+(dist*100).toFixed(2)+"% | age "+ageDays.toFixed(2)+"d | "+(t.direction==="LONG"?"swing highs / descending":"swing lows / ascending"));
  const ema513=get4HEmaDiagnostic(closed);
  const prevEma513=closed.length>20?get4HEmaDiagnostic(closed.slice(0,-1)):ema513;
  const earlyTransition=t.direction==="LONG"
    ? ema513.spread<0 && Math.abs(ema513.spreadAtr)<=0.75 && ema513.spread>ema513.spreadPrev && ema513.ema5Slope>prevEma513.ema5Slope
    : ema513.spread>0 && Math.abs(ema513.spreadAtr)<=0.75 && ema513.spread<ema513.spreadPrev && ema513.ema5Slope<prevEma513.ema5Slope;
  const confirmedTransition=t.direction==="LONG"
    ? ema513.label==="BULLISH TREND TURNING"
    : ema513.label==="BEARISH TREND TURNING";
  debug.push("[TRANSITION] 4H "+ema513.label+" | early="+earlyTransition+" | confirmed="+confirmedTransition);
  const near=Math.abs(price-tlPrice)<=Math.max(ENTRY1_ATR_DISTANCE*av,price*0.0025),beyond=t.direction==="LONG"?price>tlPrice+ENTRY2_ATR_BUFFER*av:price<tlPrice-ENTRY2_ATR_BUFFER*av;
  const last=closed.at(-1)!,lastLine=tl.state.slope*(closed.length-1)+tl.state.intercept,closedBreak=t.direction==="LONG"?last.close>lastLine+ENTRY2_ATR_BUFFER*av:last.close<lastLine-ENTRY2_ATR_BUFFER*av;
  const prevStoch=stochRsi(closes.slice(0,-1)).k;
  const approach=classifyTrendlineApproach(closed,tl.state.intercept,tl.state.slope,st.k,prevStoch);
  const turning=t.direction==="LONG"?st.k>st.d:st.k<st.d,extreme=t.direction==="LONG"?st.k<25:st.k>75;
  const c15=candles15m.length>=2?[...candles15m].sort((x,y)=>x.timestamp-y.timestamp):[],x15=c15.at(-1),p15=c15.at(-2),trigger15=!x15||!p15||(t.direction==="LONG"?x15.close>=x15.open&&x15.close>=p15.close:x15.close<=x15.open&&x15.close<=p15.close);
  debug.push("[TL APPROACH] "+pair+" | "+(t.direction==="LONG"?"descending resistance":"ascending support")+" | "+approach.classification+" | stoch="+approach.stochDirection+" | rejectionCandles="+approach.rejectionCandles+" | closeBackInside="+approach.closeBackInside);
  const state=t.direction==="LONG"?(price>tlPrice?"beyond TL":near?"near TL":"below TL / far"):(price<tlPrice?"beyond TL":near?"near TL":"above TL / far");
  debug.push("[STATE] "+state+" | near="+near+" | beyond="+beyond+" | closedBreak="+closedBreak);
  let type:"ENTRY_1"|"ENTRY_2"|null=null;
  let signalDirection:Direction=t.direction;
  let tacticalRejection=false;
  if(closedBreak&&beyond&&turning&&trigger15&&confirmedTransition)type="ENTRY_2";
  else if(t.direction==="LONG"&&near&&extreme&&earlyTransition&&approach.classification==="BREAK_ATTEMPT")type="ENTRY_1";
  else if(t.direction==="LONG"&&near&&approach.classification==="REJECTION"){type="ENTRY_1";signalDirection="SHORT";tacticalRejection=true;}
  if(!type){debug.push("[SIGNAL] none");debug.push("[ALERT] none");return{market:market(pair,price,t,tlPrice,st.k,st.d,r,a,e8,e21,now),debug};}
  if(type==="ENTRY_1"||type==="ENTRY_2"){
    const blockKey=pair+"|"+type+"|"+signalDirection;
    const veto=exhaustion(signalDirection,st.k,r);
    if(veto){
      const blockedSince=exhaustionBlockedSince.get(blockKey)??now;
      if(!exhaustionBlockedSince.has(blockKey))exhaustionBlockedSince.set(blockKey,blockedSince);
      const cycles=Math.max(1,Math.floor((now-blockedSince)/(4*60*60*1000))+1);
      debug.push("[EXHAUST] "+veto+" | blocked_since "+new Date(blockedSince).toISOString()+" | cycles "+cycles);
      debug.push("[SIGNAL BLOCKED] "+pair+" | "+type+" "+signalDirection+" | exhaustion: "+veto+" | blocked_since "+new Date(blockedSince).toISOString());
      debug.push("[SIGNAL] none — "+type+" exhaustion veto");
      debug.push("[ALERT] none");
      return{market:market(pair,price,t,tlPrice,st.k,st.d,r,a,e8,e21,now),debug};
    }
    exhaustionBlockedSince.delete(blockKey);
    debug.push("[EXHAUST] "+type+" clear");
  }
  if(!hystOK(pair,type,signalDirection,price,now,debug)){debug.push("[SIGNAL] suppressed by hysteresis");debug.push("[ALERT] none");return{market:market(pair,price,t,tlPrice,st.k,st.d,r,a,e8,e21,now),debug};}
  const lows=closed.slice(-20).map(x=>x.low),highs=closed.slice(-20).map(x=>x.high);let stop:number,tp1:number,tp2:number;
  if(type==="ENTRY_1"&&tacticalRejection){
    const rejectionHigh=Math.max(...closed.slice(-6).map(x=>x.high));
    stop=Math.max(rejectionHigh,tlPrice+0.5*av);
  }else if(type==="ENTRY_1"){
    stop=signalDirection==="LONG"?Math.min(Math.min(...lows),price-2*av):Math.max(Math.max(...highs),price+2*av);
  }else{
    stop=t.direction==="LONG"?Math.min(tlPrice*0.995,price-1.5*av):Math.max(tlPrice*1.005,price+1.5*av);
  }
  const structuralTarget=signalDirection==="LONG"?Math.max(...highs):Math.min(...lows);
  const structuralValid=signalDirection==="LONG"
    ? structuralTarget>price+1.5*av
    : structuralTarget<price-1.5*av;
  if(structuralValid){
    tp2=structuralTarget;
    tp1=price+(tp2-price)*0.5;
  }else{
    tp1=signalDirection==="LONG"?price+1.5*av:price-1.5*av;
    tp2=signalDirection==="LONG"?price+3*av:price-3*av;
  }
  const target=tp2;
  const risk=signalDirection==="LONG"?price-stop:stop-price,reward=signalDirection==="LONG"?target-price:price-target,rr=risk>0?reward/risk:0;
  if(rr<MIN_RR){debug.push("[SIGNAL] "+type+" rejected — realized RR "+rr.toFixed(2)+" < "+MIN_RR);debug.push("[ALERT] none");return{market:market(pair,price,t,tlPrice,st.k,st.d,r,a,e8,e21,now),debug};}
  const signal:Signal={id:pair+"_"+type+"_"+now,pair,direction:signalDirection,type:type,scale:type,entry:round(price),stop:round(stop),target:round(tp2),tp1:round(tp1),tp2:round(tp2),rr:round(rr,2),adx:round(a,1),rsi:round(r,1),stochK:st.k,stochD:st.d,expectedMove:round(Math.abs(tp2-price)/Math.max(price,1)*100,1),reason:tacticalRejection?"SHORT ENTRY_1 tactical rejection at descending resistance | "+ema513.label+" | Stoch K "+st.k+"/"+st.d:(type==="ENTRY_1"?t.direction+" ENTRY_1 early 4H break attempt | "+ema513.label+" | Stoch K"+st.k:t.direction+" ENTRY_2 confirmed transition + 4H break | "+ema513.label+" | Stoch "+st.k+"/"+st.d),timestamp:now,version:CURRENT_SIGNAL_VERSION,trend:signalDirection+" | 1D "+t.strength,location:type==="ENTRY_1"?(tacticalRejection?"TRENDLINE_REJECTION":"NEAR_BREAK_LINE"):"BREAK_LINE_CONFIRMED",trigger:type==="ENTRY_1"?(tacticalRejection?"4H_TRENDLINE_REJECTION":"4H_EARLY_TRANSITION"):"4H_CLOSED_BREAK_CONFIRMED_TRANSITION",context:{ema8_1d:round(t.ema8),ema21_1d:round(t.ema21),trendlinePrice:round(tlPrice),ema5_4h:round(ema513.ema5,4),ema13_4h:round(ema513.ema13,4),emaStage4h:ema513.stage,emaLabel4h:ema513.label,trendlinePrice:round(tlPrice),trendlineSlope:tl.state.slope,trendlineIntercept:tl.state.intercept,trendlineApproach:{classification:approach.classification,stochDirection:approach.stochDirection,rejectionCandles:approach.rejectionCandles,closeBackInside:approach.closeBackInside,lastTouched:approach.lastTouched,tacticalRejection}}};
  setHysteresis(pair,type,signalDirection,price,now);debug.push("[SIGNAL] "+signal.type+" "+type+" "+signal.direction+" | entry "+signal.entry+" | SL "+signal.stop+" | TP "+signal.target+" | RR "+signal.rr);debug.push(tacticalRejection?"[ALERT] SURFACE — ENTRY_1 tactical rejection SHORT":"[ALERT] SURFACE — "+(type==="ENTRY_2"?"ENTRY_2 confirmed transition + breakout":"ENTRY_1 early transition"));
  return{signal,signals:[signal],market:market(pair,price,t,tlPrice,st.k,st.d,r,a,e8,e21,now),debug,breakout:type==="ENTRY_2"?{direction:t.direction,price:round(last.close),timestamp:last.timestamp,candleIndex:closed.length-1}:undefined};
}

export function getMarketSnapshot(pair:string,candles1h:Candle[],candles4h:Candle[],candles15m:Candle[],_dailyLive?:any):any{
  if(!candles4h.length)return{pair,price:0,timestamp:Date.now(),trend:"NEUTRAL",dailyDirection:"NEUTRAL"};
  const s=[...candles4h].sort((a,b)=>a.timestamp-b.timestamp),c=s.length>1?s.slice(0,-1):s,d=aggregateTo1D(c),t=trend1D(d),cl=c.map(x=>x.close),st=stochRsi(cl),r=rsi(cl),a=adx(c),e8=ema(cl,8).at(-1)??0,e21=ema(cl,21).at(-1)??0,p=candles4h.at(-1)!.close,tl=t.direction?getTrendline(pair,c,t.direction):null;
  return market(pair,p,t,tl?.price??null,st.k,st.d,r,a,e8,e21,Date.now());
}
export interface ValidityCheck{valid:boolean;reason:string;exited:boolean;state?:"VALID"|"STALE"|"INVALID";}
export function isSignalStillValid(s:Signal,p:number,now=Date.now()):ValidityCheck{const max=(s.type==="ENTRY_1"?24:4)*60*60*1000;if(now-s.timestamp>max)return{valid:false,reason:"expired_ttl",exited:true,state:"STALE"};if(s.direction==="LONG"&&p<=s.stop)return{valid:false,reason:"sl_hit",exited:true,state:"INVALID"};if(s.direction==="SHORT"&&p>=s.stop)return{valid:false,reason:"sl_hit",exited:true,state:"INVALID"};if(s.direction==="LONG"&&p>=s.target)return{valid:false,reason:"tp_hit",exited:true,state:"INVALID"};if(s.direction==="SHORT"&&p<=s.target)return{valid:false,reason:"tp_hit",exited:true,state:"INVALID"};return{valid:true,reason:"active",exited:false,state:"VALID"};}
export function filterExpiredSignals(signals:Signal[],prices:Record<string,number>,now?:number){const active:Signal[]=[],exited:{signal:Signal;reason:string}[]=[];for(const s of signals){const p=prices[s.pair];if(p===undefined){active.push(s);continue;}const v=isSignalStillValid(s,p,now);if(v.valid)active.push(s);else exited.push({signal:s,reason:v.reason});}return{active,exited};}
export type TradeStatus="ACTIVE"|"TP_HIT"|"SL_HIT"|"EXPIRED";
export function checkTradeStatus(s:Signal,p:number,now=Date.now()):TradeStatus{const v=isSignalStillValid(s,p,now);if(v.reason==="expired_ttl")return"EXPIRED";if(s.direction==="LONG"&&p<=s.stop)return"SL_HIT";if(s.direction==="SHORT"&&p>=s.stop)return"SL_HIT";if(s.direction==="LONG"&&p>=s.target)return"TP_HIT";if(s.direction==="SHORT"&&p<=s.target)return"TP_HIT";return"ACTIVE";}
export interface HoldResult{shouldHold:boolean;reason:string;managementState?:"STAY"|"EXIT";recommendation?:"STAY IN TRADE"|"EXIT TRADE";newStop?:number;scaleOut?:{level:number;size:number;label:string};}
export function shouldHold(s:Signal,c:Candle[],p:number,now?:number):HoldResult{
  const closed=c.length>1?c.slice(0,-1):c;
  const tacticalRejection=s.type==="ENTRY_1"&&s.context?.trendlineApproach?.tacticalRejection===true;
  if(tacticalRejection&&closed.length){
    const slope=Number(s.context?.trendlineSlope),intercept=Number(s.context?.trendlineIntercept);
    if(Number.isFinite(slope)&&Number.isFinite(intercept)){
      const lineAt=slope*(closed.length-1)+intercept,lastClose=closed.at(-1)!.close;
      const reclaimed=s.direction==="SHORT"?lastClose>lineAt:lastClose<lineAt;
      if(reclaimed)return{shouldHold:false,reason:"TACTICAL_REJECTION_TRENDLINE_RECLAIMED",managementState:"EXIT",recommendation:"EXIT TRADE"};
    }
  }
  const tp2=s.tp2??s.target;
  const tp1=s.tp1;
  if(tp2!==undefined){
    const tp2Hit=s.direction==="LONG"?p>=tp2:p<=tp2;
    if(tp2Hit)return{shouldHold:false,reason:"tp2_hit",managementState:"EXIT",recommendation:"EXIT TRADE"};
  }
  if(tp1!==undefined&&!s.tp1HitAt){
    const tp1Hit=s.direction==="LONG"?p>=tp1:p<=tp1;
    if(tp1Hit)return{shouldHold:true,reason:"tp1_hit_scale_out",managementState:"STAY",recommendation:"STAY IN TRADE",newStop:s.entry,scaleOut:{level:tp1,size:0.5,label:"TP1"}};
  }
  const d=aggregateTo1D(closed),t=trend1D(d);if(t.direction){const rev=(s.direction==="LONG"&&t.direction==="SHORT")||(s.direction==="SHORT"&&t.direction==="LONG"),profit=s.direction==="LONG"?p>s.entry:p<s.entry;if(rev&&!profit)return{shouldHold:false,reason:"trend_reversed_unprofitable",managementState:"EXIT",recommendation:"EXIT TRADE"};}
  const st=stochRsi(closed.map(x=>x.close));if(s.direction==="LONG"&&st.k<20)return{shouldHold:false,reason:"stoch_extreme_opposite_exit",managementState:"EXIT",recommendation:"EXIT TRADE"};if(s.direction==="SHORT"&&st.k>80)return{shouldHold:false,reason:"stoch_extreme_opposite_exit",managementState:"EXIT",recommendation:"EXIT TRADE"};
  return{shouldHold:true,reason:"1D trend intact; no tactical invalidation, TP exit, or opposite Stoch exit",managementState:"STAY",recommendation:"STAY IN TRADE"};
}

// Compatibility stubs: connections remain intact and no Redis dependency is introduced.
export async function getMonitorState(pair:string):Promise<any|undefined>{return undefined;}
export async function clearMonitorState(pair:string):Promise<void>{return;}
export async function setMonitorState(pair:string,state:any):Promise<void>{return;}
export function setRedisClient(_:any):void{return;}
export async function generateSignalCompat(pair:string,candles1h:Candle[],candles4h:Candle[],candles15m:Candle[],activeTrades:any[]=[],currentPrice?:number,lastBreakout?:any,dailyLive?:any,candlesWeekly:Candle[]=[],marketHealth?:any,nowOverride?:number):Promise<SignalResult>{return generateSignal(pair,candles1h,candles4h,candles15m,activeTrades,currentPrice,lastBreakout,dailyLive,candlesWeekly,marketHealth,nowOverride);}
export function isSignalStillValidBool(s:Signal,p:number){return isSignalStillValid(s,p).valid;}
export function shouldHoldCompat(s:Signal,c4:Candle[],c1:Candle[],p:number){return shouldHold(s,c4,p);}
export function rebuildStateFromTrades(_:Record<string,any>):void{return;}

// Compatibility exports used by the existing cron/cycle-runner UI. These do not
// participate in normal ENTRY_1/ENTRY_2 generation.
function liquidationPrice(entry:number,d:"LONG"|"SHORT"){return d==="LONG"?entry*(1-1/LEVERAGE+MMR):entry*(1+1/LEVERAGE-MMR);}
export function liquidationSafeStop(entry:number,d:"LONG"|"SHORT"){const l=liquidationPrice(entry,d);return round(d==="LONG"?l*(1+LIQ_BUFFER):l*(1-LIQ_BUFFER));}
export function getCycleRunnerSnapshot(pair:string,candles1h:Candle[],candles4h:Candle[],candlesWeekly:Candle[],currentPrice?:number){
  const price=currentPrice??candles4h.at(-1)?.close??candles1h.at(-1)?.close??0;
  const closed=candles4h.length>1?candles4h.slice(0,-1):candles4h;
  const daily=aggregateTo1D(closed),t=trend1D(daily),st=stochRsi(closed.map(x=>x.close));
  return {enabled:false,status:"DISABLED_BY_CORE_STRATEGY",direction:t.direction==="LONG"?"LONG":t.direction==="SHORT"?"SHORT":"NEUTRAL",weeklyDirection:"NEUTRAL",fourHDirection:t.direction==="LONG"?"LONG":t.direction==="SHORT"?"SHORT":"NEUTRAL",price,oneHStoch:{k:st.k,d:st.d},ready:false};
}