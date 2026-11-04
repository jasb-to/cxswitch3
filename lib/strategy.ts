export interface Candle { timestamp:number; open:number; high:number; low:number; close:number; volume:number }
export interface Signal {
  id:string; pair:string; direction:"LONG"|"SHORT"; type:"ENTRY_1"|"ENTRY_2"|"ADD"|"REVERSAL_SHORT"|"REVERSAL_LONG"; signalClass:"TREND"|"REVERSAL"; sizeMultiplier:0.125|0.25|0.5|1;
  entry:number; stop:number; tp1:number; tp2:number; rr:number;
  adx:number; rsi:number; stochK:number; stochD:number; expectedMove:number;
  reason:string; timestamp:number; version:number; context?:any;
}
export interface BreakoutRecord { direction:Direction; price:number; timestamp:number; candleIndex:number }
export interface SignalResult { signal?:Signal; market?:any; debug:string[]; breakoutRecord?:BreakoutRecord }
export const CURRENT_SIGNAL_VERSION=32;
type Direction="LONG"|"SHORT";
const VERBOSE_CRON_LOGS=process.env.CRON_VERBOSE_LOGS==="true";
const TTL=24*60*60*1000, EPS=1e-12;
const MAX_LEVERAGE=15;
const MAINTENANCE_MARGIN_RATE=0.01;
const r=(n:number,d=2)=>{const m=10**d;return Math.round(n*m)/m};
const priceRound=(n:number)=>{if(!Number.isFinite(n))return n;const d=Math.abs(n)>=1000?0:Math.abs(n)>=1?2:Math.abs(n)>=0.1?3:5;return r(n,d)};
function ema(a:number[],p:number){if(!a.length)return[];const k=2/(p+1),o=[a[0]];for(let i=1;i<a.length;i++)o.push(a[i]*k+o[i-1]*(1-k));return o}
function rsiSeries(a:number[],p=14){if(a.length<=p)return[];let g=0,l=0;for(let i=1;i<=p;i++){const x=a[i]-a[i-1];if(x>=0)g+=x;else l-=x}let ag=g/p,al=l/p,o=[al===0?100:100-100/(1+ag/al)];for(let i=p+1;i<a.length;i++){const x=a[i]-a[i-1];ag=(ag*(p-1)+Math.max(x,0))/p;al=(al*(p-1)+Math.max(-x,0))/p;o.push(al===0?100:100-100/(1+ag/al))}return o}
function rsi(a:number[]){const x=rsiSeries(a);return x.at(-1)??50}
type StochPoint={k:number;d:number};
function getStochSeries(a:number[]):StochPoint[]{const rv=rsiSeries(a),raw:number[]=[],k:number[]=[],d:number[]=[];for(let i=13;i<rv.length;i++){const w=rv.slice(i-13,i+1),lo=Math.min(...w),hi=Math.max(...w);raw.push(hi===lo?50:(rv[i]-lo)/(hi-lo)*100)}for(let i=2;i<raw.length;i++)k.push(raw.slice(i-2,i+1).reduce((x,y)=>x+y,0)/3);for(let i=2;i<k.length;i++)d.push(k.slice(i-2,i+1).reduce((x,y)=>x+y,0)/3);return d.map((value,i)=>({k:r(k[i+2],1),d:r(value,1)}))}
export function getStochHistoryPointCount(closes:number[]):number{return getStochSeries(closes).length}
function stoch(a:number[]){const series=getStochSeries(a),last=series.at(-1)??{k:50,d:50},prev=series.at(-2)??{k:50,d:50};return{k:last.k,d:last.d,pk:prev.k,pd:prev.d}}
function atr(c:Candle[],p=14){if(c.length<2)return 0;const v:number[]=[];for(let i=Math.max(1,c.length-p);i<c.length;i++){const x=c[i],q=c[i-1];v.push(Math.max(x.high-x.low,Math.abs(x.high-q.close),Math.abs(x.low-q.close)))}return v.reduce((a,b)=>a+b,0)/v.length}
function adx(c:Candle[],p=14){if(c.length<p+2)return 0;const tr:number[]=[],pl:number[]=[],mi:number[]=[];for(let i=1;i<c.length;i++){const x=c[i],q=c[i-1];tr.push(Math.max(x.high-x.low,Math.abs(x.high-q.close),Math.abs(x.low-q.close)));const u=x.high-q.high,d=q.low-x.low;pl.push(u>d?Math.max(u,0):0);mi.push(d>u?Math.max(d,0):0)}const sm=(a:number[])=>{if(a.length<p)return[];const o=[a.slice(0,p).reduce((x,y)=>x+y,0)/p];for(let i=p;i<a.length;i++)o.push((o.at(-1)!*(p-1)+a[i])/p);return o};const t=sm(tr),pp=sm(pl),mm=sm(mi),dx:number[]=[];for(let i=0;i<t.length;i++){const a=pp[i]/Math.max(t[i],EPS)*100,b=mm[i]/Math.max(t[i],EPS)*100;dx.push(a+b?Math.abs(a-b)/(a+b)*100:0)}if(dx.length<p)return 0;let x=dx.slice(0,p).reduce((a,b)=>a+b,0)/p;for(let i=p;i<dx.length;i++)x=(x*(p-1)+dx[i])/p;return r(x,1)}
function daily(c:Candle[]){const m=new Map<string,Candle[]>();for(const x of [...c].sort((a,b)=>a.timestamp-b.timestamp)){const z=new Date(x.timestamp),k=z.toISOString().slice(0,10),b=m.get(k)??[];b.push(x);m.set(k,b)}return[...m.values()].map(b=>({timestamp:b[0].timestamp,open:b[0].open,high:Math.max(...b.map(x=>x.high)),low:Math.min(...b.map(x=>x.low)),close:b.at(-1)!.close,volume:b.reduce((s,x)=>s+x.volume,0)}))}
export type RegimeStrength="HIGH"|"MED"|"LOW";
export type RegimeState="BULL_HIGH"|"BULL_MED"|"BULL_LOW"|"CHOP"|"BEAR_LOW"|"BEAR_MED"|"BEAR_HIGH";
export function regimeAllowsTrading(_state:RegimeState):boolean{return true;}
export interface ComputedRegime {
  state:RegimeState; direction:Direction|null; sizeMultiplier:0|0.5|1;
  price:number; e21:number; e5:number; e13:number; spread:number; spread3:number; spreadDelta:number;
  strength:RegimeStrength|"NEUTRAL";
}
export function computeRegime(c:Candle[]):ComputedRegime {
  const d=daily(c).slice(0,-1),closes=d.map(x=>x.close);
  const neutral:ComputedRegime={state:"CHOP",direction:null,sizeMultiplier:0,price:closes.at(-1)??0,e21:0,e5:0,e13:0,spread:0,spread3:0,spreadDelta:0,strength:"NEUTRAL"};
  if(closes.length<22)return neutral;
  const e5s=ema(closes,5),e13s=ema(closes,13),e21s=ema(closes,21);
  const price=closes.at(-1)!,e5=e5s.at(-1)!,e13=e13s.at(-1)!,e21=e21s.at(-1)!;
  const aboveE21=price>e21,emaStack=e5>e13?"BULL":"BEAR";
  const spread=(e5-e13)/price*100;
  const spread3=closes.length>=25?(e5s.at(-4)!-e13s.at(-4)!)/closes.at(-4)!*100:spread;
  const spreadDelta=spread-spread3;
  let strength:RegimeStrength;
  if(Math.abs(spreadDelta)<0.05)strength="MED";
  else if((emaStack==="BULL"&&spreadDelta>0)||(emaStack==="BEAR"&&spreadDelta<0))strength="HIGH";
  else strength="LOW";
  let state:RegimeState;
  if(emaStack==="BULL"&&aboveE21)state=("BULL_"+strength) as RegimeState;
  else if(emaStack==="BEAR"&&!aboveE21)state=("BEAR_"+strength) as RegimeState;
  else state="CHOP";
  const direction:Direction|null=state.startsWith("BULL")?"LONG":state.startsWith("BEAR")?"SHORT":null;
  const sizeMultiplier:0|0.5|1=strength==="LOW"||state==="CHOP"?0.5:1;
  return{state,direction,sizeMultiplier,price,e21,e5,e13,spread,spread3,spreadDelta,strength:direction?strength:"NEUTRAL"};
}
export interface TrendlineResult { valid:boolean; slope:number; intercept:number; priceAtCurrent:number; pivots:{index:number;price:number;timestamp:number}[]; r2:number; touchCount:number; reason:string }
export function calculateTrendlineR2(points:{index:number;price:number}[]):number{if(points.length<2)return 0;const mean=points.reduce((sum,p)=>sum+p.price,0)/points.length,total=points.reduce((sum,p)=>sum+(p.price-mean)**2,0);if(total===0)return 0;const n=points.length,sx=points.reduce((sum,p)=>sum+p.index,0),sy=points.reduce((sum,p)=>sum+p.price,0),sxy=points.reduce((sum,p)=>sum+p.index*p.price,0),sx2=points.reduce((sum,p)=>sum+p.index*p.index,0),denom=n*sx2-sx*sx;if(!denom)return 0;const slope=(n*sxy-sx*sy)/denom,intercept=(sy-slope*sx)/n,residual=points.reduce((sum,p)=>sum+(p.price-(slope*p.index+intercept))**2,0);return 1-residual/total;}
export function evaluateTrendlineProximity(price:number,trendlinePrice:number){if(!Number.isFinite(price)||!Number.isFinite(trendlinePrice)||trendlinePrice<=0)return{valid:false,distancePct:Infinity,reason:"invalid_trendline_price"};const distancePct=Math.abs(price-trendlinePrice)/trendlinePrice*100;return{valid:distancePct<=1.2,distancePct,reason:distancePct>1.2?"price_too_far_from_trendline":"valid"};}
export function hasBreakoutVolumeConfirmation(candles:Candle[]):boolean{const current=candles.at(-1),previous=candles.slice(-6,-1);return !!current&&previous.length===5&&current.volume>previous.reduce((sum,x)=>sum+x.volume,0)/5*1.2;}
export function get4HTrendline(candles:Candle[],direction:Direction,price:number):TrendlineResult {
  void price;
  const closed=candles.slice(0,-1).slice(-60),invalid=(reason:string,pivots:{index:number;price:number;timestamp:number}[]=[],slope=0,intercept=0,r2=0):TrendlineResult=>({valid:false,slope,intercept,priceAtCurrent:0,pivots,r2,touchCount:pivots.length,reason});
  if(closed.length<20)return invalid("insufficient_history");
  const highs=direction==="SHORT",pivots:{index:number;price:number;timestamp:number}[]=[];
  for(let i=3;i<closed.length-3;i++){const x=closed[i],pivot=highs?x.high>closed[i-1].high&&x.high>closed[i-2].high&&x.high>closed[i+1].high&&x.high>closed[i+2].high:x.low<closed[i-1].low&&x.low<closed[i-2].low&&x.low<closed[i+1].low&&x.low<closed[i+2].low;if(pivot)pivots.push({index:i,price:highs?x.high:x.low,timestamp:x.timestamp});}
  if(pivots.length<3)return invalid("fewer_than_3_pivots",pivots);
  const recent=pivots.slice(-5),n=recent.length,sumX=recent.reduce((v,x)=>v+x.index,0),sumY=recent.reduce((v,x)=>v+x.price,0),sumXY=recent.reduce((v,x)=>v+x.index*x.price,0),sumX2=recent.reduce((v,x)=>v+x.index*x.index,0),denom=n*sumX2-sumX*sumX;
  if(!denom)return invalid("degenerate_pivots",recent);
  const slope=(n*sumXY-sumX*sumY)/denom,intercept=(sumY-slope*sumX)/n,r2=calculateTrendlineR2(recent);
  const currentIndex=closed.length-1,priceAtCurrent=slope*currentIndex+intercept;
  if(!Number.isFinite(priceAtCurrent)||priceAtCurrent<=0)return invalid("invalid_trendline_price",recent,slope,intercept,r2);
  return{valid:true,slope,intercept,priceAtCurrent,pivots:recent,r2,touchCount:n,reason:"valid"};
}
export interface TrendAlignment {
  regime:RegimeState; daily:Direction|null; fourH:Direction|null; aligned:Direction|null;
  dailyClose:number; dailyE21:number; dailyE5:number; dailyE13:number; dailyE8:number;
  dailyStrength:RegimeStrength|"NEUTRAL"; dailySpreadPct:number; dailySpread3dPct:number; dailySpreadDelta:number; dailySlope:number;
  sizeMultiplier:0|0.5|1; fourHE5:number; fourHE13:number;
}
export function trendAlignment(c:Candle[]):TrendAlignment{
  const regime=computeRegime(c),closed4h=[...c].sort((a,b)=>a.timestamp-b.timestamp).slice(0,-1),hCloses=closed4h.map(x=>x.close);
  const hE5=ema(hCloses,5).at(-1)??0,hE13=ema(hCloses,13).at(-1)??0;
  const fourH:Direction|null=hE5>hE13?"LONG":hE5<hE13?"SHORT":null;
  const d=daily(c).slice(0,-1).map(x=>x.close),dE8=ema(d,8).at(-1)??0,dE21=ema(d,21).at(-1)??0;
  const dE5=ema(d,5).at(-1)??0,dE13=ema(d,13).at(-1)??0,slopeSeries=ema(d,8);
  const slope=slopeSeries.length>1?slopeSeries.at(-1)!-slopeSeries.at(-2)!:0;
  const dailyDirection:Direction|null=d.length<22?null:dE8>dE21?"LONG":dE8<dE21?"SHORT":null;
  return{regime:regime.state,daily:dailyDirection,fourH,aligned:dailyDirection,dailyClose:d.at(-1)??0,dailyE21:dE21,dailyE5:dE5,dailyE13:dE13,dailyE8:dE8,dailyStrength:regime.strength,dailySpreadPct:regime.spread,dailySpread3dPct:regime.spread3,dailySpreadDelta:regime.spreadDelta,dailySlope:slope,sizeMultiplier:regime.sizeMultiplier,fourHE5:hE5,fourHE13:hE13};
}
export interface Entry1State { pair:string; direction:Direction; entry:number; timestamp:number; context?:any }
type StochSnapshot={k:number;d:number;pk:number;pd:number};
type Entry1Evaluation={entry1Long:boolean;entry1Short:boolean;entry1:boolean;direction:Direction|null;crossDetected:"bullish"|"bearish"|null;crossAge:"last candle"|"previous candle"|null;crossAgeInCandles:number|null;case:"fresh"|"recent"|null;sizeMultiplier:1|0.5;thresholdPassed:boolean;reason:string;crossPrice:number|null;priceMovePct:number|null;kInRange:boolean;notExtended:boolean};
export function evaluateEntry1(aligned:Direction|null,input:StochPoint[]|StochSnapshot,closed4h:Candle[]=[],price?:number,liveStoch?:StochPoint):Entry1Evaluation {
  const series=Array.isArray(input)?input:[{k:input.pk,d:input.pd},{k:input.k,d:input.d}],last=series.at(-1);
  const empty=(reason:string):Entry1Evaluation=>({entry1Long:false,entry1Short:false,entry1:false,direction:null,crossDetected:null,crossAge:null,crossAgeInCandles:null,case:null,sizeMultiplier:1,thresholdPassed:false,reason,crossPrice:null,priceMovePct:null,kInRange:false,notExtended:false});
  if(!aligned)return empty("daily_ema_8_21_direction_unavailable");
  if(!last)return empty("insufficient_stoch_history");
  const thresholdPassed=aligned==="LONG"?last.k<20:last.k>80;
  return{entry1Long:thresholdPassed&&aligned==="LONG",entry1Short:thresholdPassed&&aligned==="SHORT",entry1:thresholdPassed,direction:thresholdPassed?aligned:null,crossDetected:null,crossAge:null,crossAgeInCandles:null,case:thresholdPassed?"fresh":null,sizeMultiplier:1,thresholdPassed,reason:thresholdPassed?"4H Stoch RSI extreme at V28 trendline":"4H Stoch RSI not at V28 extreme",crossPrice:null,priceMovePct:null,kInRange:thresholdPassed,notExtended:true};
}
export function entry2RetestConditions(direction:Direction,entry:number,price:number,firstWavePrice:number,ema8:number,st:StochSnapshot,adverseCross:boolean,alreadyFired=false){
  const waveMoved=direction==="LONG"?firstWavePrice>=entry*1.015:firstWavePrice<=entry*0.985;
  const pulledBack=Math.abs(price-entry)/Math.max(entry,EPS)<=0.01;
  const correctEmaSide=direction==="LONG"?price>ema8:price<ema8;
  const freshCross=direction==="LONG"?st.pk<=st.pd&&st.k>st.d&&st.k<60:st.pk>=st.pd&&st.k<st.d&&st.k>40;
  return !alreadyFired&&waveMoved&&pulledBack&&correctEmaSide&&freshCross&&!adverseCross;
}
export function hasAdverseEmaCrossSince(c:Candle[],state:Entry1State):boolean{
  const closed=c,closes=closed.map(x=>x.close),e8=ema(closes,8),e21=ema(closes,21);
  const marker=Number(state.context?.closed4hTimestamp);
  let start=Number.isFinite(marker)?closed.findIndex(x=>x.timestamp===marker):-1;
  if(start<0)start=closed.findIndex(x=>x.timestamp>state.timestamp);
  if(start<0)return false;
  for(let i=start+1;i<closed.length;i++){
    if(state.direction==="LONG"&&e8[i-1]>=e21[i-1]&&e8[i]<e21[i])return true;
    if(state.direction==="SHORT"&&e8[i-1]<=e21[i-1]&&e8[i]>e21[i])return true;
  }
  return false;
}
function entry2Ready(pair:string,direction:Direction,state:Entry1State|undefined,c:Candle[],price:number,st:StochSnapshot,alreadyFired:boolean):{ready:boolean;reason:string}{
  if(!state)return{ready:false,reason:"no_active_entry1_state"};
  if(state.pair!==pair)return{ready:false,reason:"entry1_state_pair_mismatch"};
  if(state.direction!==direction)return{ready:false,reason:"entry1_state_direction_mismatch"};
  const closed=c,marker=Number(state.context?.closed4hTimestamp);
  if(!Number.isFinite(marker))return{ready:false,reason:"entry1_candle_timestamp_missing"};
  if(!closed.some(x=>x.timestamp===marker))return{ready:false,reason:"entry1_candle_not_in_history"};
  if(closed.at(-1)!.timestamp<=marker)return{ready:false,reason:"no_closed_candle_after_entry1"};
  const after=closed.filter(x=>x.timestamp>marker);
  if(!after.length)return{ready:false,reason:"no_closed_candle_after_entry1"};
  const firstWavePrice=direction==="LONG"?Math.max(...after.map(x=>x.high)):Math.min(...after.map(x=>x.low));
  const ema8=ema(closed.map(x=>x.close),8).at(-1)??0;
  const waveMoved=direction==="LONG"?firstWavePrice>=state.entry*1.015:firstWavePrice<=state.entry*0.985;
  const pulledBack=Math.abs(price-state.entry)/Math.max(state.entry,EPS)<=0.01;
  const correctEmaSide=direction==="LONG"?price>ema8:price<ema8;
  const freshCross=direction==="LONG"?st.pk<=st.pd&&st.k>st.d&&st.k<60:st.pk>=st.pd&&st.k<st.d&&st.k>40;
  const adverseCross=hasAdverseEmaCrossSince(c,state);
  const checks=[["first_wave_not_reached",waveMoved],["pullback_not_within_1pct",pulledBack],["price_on_wrong_ema8_side",correctEmaSide],["no_fresh_stoch_cross",freshCross],["adverse_ema8_21_cross",!adverseCross],["entry2_already_fired",!alreadyFired]];
  const failed=checks.filter(([,passed])=>!passed).map(([reason])=>reason as string);
  const ready=entry2RetestConditions(direction,state.entry,price,firstWavePrice,ema8,st,adverseCross,alreadyFired);
  return{ready,reason:ready?"trigger_met":failed.join("+")||"retest_conditions_not_met"};
}
function entry1WaitReason(aligned:Direction|null,entry:Entry1Evaluation):string{
  return entry.reason;
}
export interface GateEvaluation {
  direction:Direction|null;
  zone:{valid:boolean;type:string;price:number;distancePct:number}|null;
  trendlineSlope:number;
  trendline:{price:number;distancePct:number;r2:number;reason:string}|null;
  alignment:TrendAlignment;
  trigger:{entry1:boolean;entry2:boolean;signalType:"ENTRY_1"|"ENTRY_2"|"ADD"|null;entry1Reason:string;entry2Reason:string;entry1SizeMultiplier:1|0.5;entry1CrossAgeInCandles:number|null;entry1Case:"fresh"|"recent"|null};
  exhaustion:string|null;
  stopCalc:StopCalc|null;
  missing:string[];
  allPassed:boolean;
  dailyTransition:boolean;
  breakoutRecord?:BreakoutRecord;
}
export interface StopCalc { structuralAnchor:number; atrMultiplier:number; riskPct:number; liquidationBufferPct:number; liquidationPrice:number; marginUsagePct:number }
export function calculateRiskSizeMultiplier(riskPct:number):0.5|1|null{
  if(!Number.isFinite(riskPct)||riskPct<0)return null;
  if(riskPct<=3.5)return 1;
  if(riskPct<=5.0)return 0.5;
  return null;
}
export function calculateLiquidationBufferPct(direction:Direction,entry:number,stop:number,leverage=MAX_LEVERAGE):number{
  const liquidationPrice=direction==="LONG"?entry*(1-1/leverage+MAINTENANCE_MARGIN_RATE):entry*(1+1/leverage-MAINTENANCE_MARGIN_RATE);
  return direction==="LONG"?(stop-liquidationPrice)/Math.max(liquidationPrice,EPS)*100:(liquidationPrice-stop)/Math.max(liquidationPrice,EPS)*100;
}
export function calculateStop(direction:Direction,entry:number,atrValue:number,candles:Candle[]):{stop:number;calc:StopCalc;valid:boolean;invalidReason?:string}{
  if(!Number.isFinite(entry)||entry<=0||!Number.isFinite(atrValue)||atrValue<=0)
    return{stop:0,calc:{structuralAnchor:0,atrMultiplier:0,riskPct:Infinity,liquidationBufferPct:-Infinity,liquidationPrice:0,marginUsagePct:Infinity},valid:false,invalidReason:"stop_inputs"};
  const closed=[...candles].sort((a,b)=>a.timestamp-b.timestamp),recentWindow=closed.slice(-20);
  if(!recentWindow.length)return{stop:0,calc:{structuralAnchor:0,atrMultiplier:0,riskPct:Infinity,liquidationBufferPct:-Infinity,liquidationPrice:0,marginUsagePct:Infinity},valid:false,invalidReason:"stop_no_closed_candles"};
  const recentSwing=direction==="LONG"?Math.min(...recentWindow.map(x=>x.low)):Math.max(...recentWindow.map(x=>x.high));
  const atrFloor=direction==="LONG"?entry-2*atrValue:entry+2*atrValue;
  const stop=direction==="LONG"?Math.min(recentSwing,atrFloor):Math.max(recentSwing,atrFloor);
  const riskPct=Math.abs(entry-stop)/Math.max(entry,EPS)*100,atrMultiplier=Math.abs(entry-stop)/Math.max(atrValue,EPS);
  const liquidationPrice=direction==="LONG"?entry*(1-1/MAX_LEVERAGE+MAINTENANCE_MARGIN_RATE):entry*(1+1/MAX_LEVERAGE-MAINTENANCE_MARGIN_RATE);
  const liquidationBufferPct=calculateLiquidationBufferPct(direction,entry,stop,MAX_LEVERAGE);
  const calc={structuralAnchor:priceRound(recentSwing),atrMultiplier:r(atrMultiplier,2),riskPct:r(riskPct,2),liquidationBufferPct:r(liquidationBufferPct,2),liquidationPrice:priceRound(liquidationPrice),marginUsagePct:r(riskPct*MAX_LEVERAGE,1)};
  return{stop,calc,valid:true};
}
function exhaustion(direction:Direction,rv:number,adxValue:number,st:StochSnapshot):{blocked:string|null;warning:string|null}{
  if(direction==="LONG"&&rv>78)return{blocked:"4H RSI overbought",warning:null};
  if(direction==="SHORT"&&rv<22)return{blocked:"4H RSI oversold",warning:null};
  const turningAgainst=direction==="LONG"?st.k<st.d&&st.pk>=st.pd:st.k>st.d&&st.pk<=st.pd;
  if(adxValue>50&&turningAgainst)return{blocked:"ADX over 50 with Stoch RSI turning against position",warning:null};
  if(adxValue>50)return{blocked:null,warning:"ADX over 50 but Stoch remains aligned — continuation allowed"};
  return{blocked:null,warning:null};
}
export function evaluateGates(pair:string,candles4h:Candle[],currentPrice:number,entry1State?:Entry1State,entry2AlreadyFired=false,activeSignals:Array<{pair:string;direction:Direction}>=[]):GateEvaluation{
  const c=[...candles4h].sort((a,b)=>a.timestamp-b.timestamp),p=currentPrice??c.at(-1)?.close??0,alignment=trendAlignment(c),direction=alignment.aligned;
  const closed4h=c.slice(0,-1),closedCloses=closed4h.map(x=>x.close),st=stoch(closedCloses),rv=rsi(closedCloses),a=atr(closed4h);
  const tl=direction?get4HTrendline(c,direction,p):null;
  const proximity=tl?.valid?evaluateTrendlineProximity(p,tl.priceAtCurrent):{valid:false,distancePct:Infinity,reason:tl?.reason??"daily_direction_unavailable"};
  const trendlineGate={valid:!!tl?.valid&&proximity.valid,price:tl?.priceAtCurrent??0,distancePct:proximity.distancePct,r2:tl?.r2??0,reason:proximity.reason};
  const lastClosed=closed4h.at(-1),priorTen=closed4h.slice(-11,-1),volumeAverage=priorTen.length===10?priorTen.reduce((sum,x)=>sum+x.volume,0)/10:Infinity;
  const lineNow=tl?.valid?tl.priceAtCurrent:0,breakoutDistance=lineNow>0?(p-lineNow)/lineNow*100:0;
  const confirming=!!lastClosed&&(direction==="LONG"?lastClosed.close>lastClosed.open:lastClosed.close<lastClosed.open);
  const volumeAligned=!!lastClosed&&lastClosed.volume>1.3*volumeAverage;
  const adxValue=adx(closed4h),stochMomentum=direction==="LONG"?st.k>st.d:direction==="SHORT"?st.k<st.d:false;
  const beyondTrendline=direction==="LONG"?breakoutDistance>0.8:direction==="SHORT"?breakoutDistance< -0.8:false;
  const hE5=ema(closedCloses,5).at(-1)??0,hE13=ema(closedCloses,13).at(-1)??0;
  const momentumAligned=direction==="LONG"?hE5>hE13:direction==="SHORT"?hE5<hE13:false;
  const exhaustionReason=direction==="LONG"?(rv>78?"4H RSI overbought":st.k>95?"4H Stoch K overbought":null):direction==="SHORT"?(rv<22?"4H RSI oversold":st.k<5?"4H Stoch K oversold":null):null;
  const filtersPass=!!direction&&momentumAligned&&!exhaustionReason;
  const activeMatch=!!direction&&activeSignals.some(x=>x.pair===pair&&x.direction===direction);
  const e1=evaluateEntry1(direction,st,closed4h,p,st);
  const entry1=!!direction&&trendlineGate.valid&&e1.entry1&&filtersPass&&!activeMatch;
  const entry2Check=direction?entry2Ready(pair,direction,entry1State,c,p,st,entry2AlreadyFired):{ready:false,reason:"daily_ema_8_21_direction_unavailable"};
  const entry2=!!activeMatch&&entry2Check.ready&&filtersPass;
  const addReady=!!activeMatch&&!!tl?.valid&&beyondTrendline&&confirming&&(volumeAligned||stochMomentum||adxValue>20)&&filtersPass;
  const signalType:"ENTRY_1"|"ENTRY_2"|"ADD"|null=addReady?"ADD":entry2?"ENTRY_2":entry1?"ENTRY_1":null;
  const missing:string[]=[];
  if(!direction)missing.push("daily_ema_8_21_direction_unavailable");
  if(direction&&!tl?.valid)missing.push("trendline_"+(tl?.reason??"unavailable"));
  if(direction&&tl?.valid&&!trendlineGate.valid&&!beyondTrendline)missing.push("price_too_far_from_trendline");
  if(direction&&!momentumAligned)missing.push("4h_ema5_13_momentum_misaligned");
  if(exhaustionReason)missing.push("exhaustion_veto: "+exhaustionReason);
  if(!entry1&&!entry2&&!addReady)missing.push(e1.reason);
  if(activeMatch&&!addReady&&!entry2)missing.push("active_position_waiting_for_add_breakout");
  const stopCalc=direction&&signalType&&a>0?calculateStop(direction,p,a,closed4h).calc:null;
  return{direction,zone:null,trendlineSlope:tl?.slope??0,trendline:tl?{price:tl.priceAtCurrent,distancePct:proximity.distancePct,r2:tl.r2,reason:proximity.reason}:null,alignment,trigger:{entry1,entry2,signalType,entry1Reason:entry1?e1.reason:exhaustionReason??(!momentumAligned?"4h_ema5_13_momentum_misaligned":e1.reason),entry2Reason:entry2?"trigger_met":entry2Check.reason,entry1SizeMultiplier:1,entry1CrossAgeInCandles:null,entry1Case:entry1?"fresh":null},exhaustion:exhaustionReason,stopCalc,missing:[...new Set(missing)],allPassed:!!direction&&!!signalType&&filtersPass&&!!tl?.valid&&(entry1?trendlineGate.valid:true),dailyTransition:false,breakoutRecord:undefined};
}
export function generateSignal(
  pair:string,candles1h:Candle[],candles4h:Candle[],candles15m:Candle[],currentPrice?:number,nowOverride?:number,lastBreakout?:BreakoutRecord,entry1State?:Entry1State,entry2AlreadyFired=false,activeSignals:Array<{pair:string;direction:Direction}>=[]
):SignalResult{
  void lastBreakout;
  const debug:string[]=[],c=[...candles4h].sort((a,b)=>a.timestamp-b.timestamp),p=currentPrice??c.at(-1)?.close??0,now=nowOverride??Date.now();
  if(c.length<35){debug.push("[WAIT] insufficient 4H history");return{market:getMarketSnapshot(pair,candles1h,candles4h,candles15m),debug};}
  const closed=c.slice(0,-1),closedCloses=closed.map(x=>x.close),a=atr(closed),av=adx(closed),rv=rsi(closedCloses),st=stoch(closedCloses);
  const evaluation=evaluateGates(pair,c,p,entry1State,entry2AlreadyFired,activeSignals),alignment=evaluation.alignment;
  debug.push("[REGIME] "+alignment.regime+" (reference only) | 1D EMA8/21 direction="+(alignment.daily??"NONE")+" | size="+Math.round(alignment.sizeMultiplier*100)+"%");
  debug.push("[4H MOMENTUM] EMA5="+r(alignment.fourHE5)+" EMA13="+r(alignment.fourHE13)+" | "+(alignment.fourH??"NEUTRAL"));
  debug.push("[GATES] "+JSON.stringify(evaluation));
  debug.push("[DIAGNOSTIC] "+pair+" | 1D EMA8="+r(alignment.dailyE8)+" EMA21="+r(alignment.dailyE21)+" | 4H K="+st.k+" D="+st.d+" RSI="+r(rv,1));
  debug.push("[EXHAUSTION] "+(evaluation.exhaustion??"clear")+" | Momentum="+(alignment.daily==="LONG"?alignment.fourHE5>alignment.fourHE13:alignment.daily==="SHORT"?alignment.fourHE5<alignment.fourHE13:false));
  if(!evaluation.allPassed){debug.push("[WAIT] "+evaluation.missing.join(", "));debug.push("[SIGNAL] none");debug.push("[ALERT] none");return{market:getMarketSnapshot(pair,candles1h,candles4h,candles15m),debug,breakoutRecord:undefined};}
  const direction=evaluation.direction!,signalType=evaluation.trigger.signalType!,entry=p,stopResult=calculateStop(direction,entry,a,closed);
  if(!stopResult.valid){debug.push("[SIGNAL BLOCKED] "+(stopResult.invalidReason??"invalid stop"));return{market:getMarketSnapshot(pair,candles1h,candles4h,candles15m),debug};}
  const target=direction==="LONG"?entry+5*a:entry-5*a,risk=Math.abs(entry-stopResult.stop),reward=Math.abs(target-entry),actualRr=reward/Math.max(risk,EPS);
  const sizeMultiplier=(alignment.sizeMultiplier===0.5?0.5:1) as 0.5|1,closed4hTimestamp=closed.at(-1)?.timestamp??0;
  const s:Signal={
    id:pair+"_"+signalType+"_"+now,pair,direction,type:signalType,signalClass:"TREND",sizeMultiplier,
    entry:priceRound(entry),stop:priceRound(stopResult.stop),tp1:priceRound(target),tp2:priceRound(target),rr:r(actualRr,2),expectedMove:r(reward/Math.max(entry,EPS)*100,2),
    adx:r(av,1),rsi:r(rv,1),stochK:st.k,stochD:st.d,
    reason:direction+" "+signalType+" | 1D EMA8/21 | 4H trendline "+(signalType==="ADD"?"breakout ADD":"extreme Stoch RSI entry")+" | 5 ATR target | "+Math.round(sizeMultiplier*100)+"% regime size",
    timestamp:now,version:CURRENT_SIGNAL_VERSION,
    context:{targetCount:1,targetAtrMultiple:5,regime:alignment.regime,regimeReferenceOnly:true,regimeSizeMultiplier:sizeMultiplier,stopCalc:stopResult.calc,structuralAnchor:stopResult.calc.structuralAnchor,ema8_1d:alignment.dailyE8,ema21_1d:alignment.dailyE21,ema5_4h:alignment.fourHE5,ema13_4h:alignment.fourHE13,closed4hTimestamp,stochK_4h:st.k,stochD_4h:st.d}
  };
  debug.push("[STOP] "+direction+" | "+s.stop+" | 20-bar swing / 2 ATR");
  debug.push("[TARGET] single target "+s.tp1+" | 5 ATR (legacy TP2 field mirrors TP1 for storage compatibility)");
  debug.push("[SIGNAL] "+s.direction+" "+s.type+" | entry "+s.entry+" | SL "+s.stop+" | TP "+s.tp1);
  debug.push("[ALERT] "+(signalType==="ENTRY_2"?"SILENT":"SURFACE"));
  return{signal:s,market:getMarketSnapshot(pair,candles1h,candles4h,candles15m),debug,breakoutRecord:undefined};
}

export function shouldHold(s:Signal,c:Candle[],p:number,now=Date.now(),lastExitAlertAt?:number){
  void now;void lastExitAlertAt;
  const ordered=[...c].sort((a,b)=>a.timestamp-b.timestamp),closed4h=ordered.slice(0,-1);
  if(closed4h.length<22)return{shouldHold:true,reason:"insufficient_closed_4h_history",managementState:"STAY" as const,recommendation:"STAY IN TRADE" as const};
  if((s.direction==="LONG"&&p<=s.stop)||(s.direction==="SHORT"&&p>=s.stop))return{shouldHold:false,reason:"stop_hit",managementState:"EXIT" as const,recommendation:"EXIT TRADE" as const};
  const target=s.tp1??s.tp2;
  if((s.direction==="LONG"&&p>=target)||(s.direction==="SHORT"&&p<=target))return{shouldHold:false,reason:"target_hit",managementState:"EXIT" as const,recommendation:"EXIT TRADE" as const};
  const dailyDirection=trendAlignment(ordered).daily,reversed=(s.direction==="LONG"&&dailyDirection==="SHORT")||(s.direction==="SHORT"&&dailyDirection==="LONG"),profitable=s.direction==="LONG"?p>s.entry:p<s.entry;
  if(reversed&&!profitable)return{shouldHold:false,reason:"daily_trend_reversal_unprofitable",managementState:"EXIT" as const,recommendation:"EXIT TRADE" as const};
  const closes=closed4h.map(x=>x.close),st=stoch(closes),e21=ema(closes,21).at(-1)??0;
  const exit4h=s.direction==="LONG"?p<e21&&st.k<st.d:p>e21&&st.k>st.d;
  if(exit4h)return{shouldHold:false,reason:"4h_ema21_stoch_exit",managementState:"EXIT" as const,recommendation:"EXIT TRADE" as const};
  return{shouldHold:true,reason:"thesis_intact",managementState:"STAY" as const,recommendation:"STAY IN TRADE" as const};
}
export function isSignalStillValid(s:Signal,p:number,now=Date.now()){if(now-s.timestamp>TTL)return{valid:false,reason:"expired_ttl",exited:true,state:"STALE" as const};if((s.direction==="LONG"&&p<=s.stop)||(s.direction==="SHORT"&&p>=s.stop))return{valid:false,reason:"sl_hit",exited:true,state:"INVALID" as const};const target=s.tp1??s.tp2;if((s.direction==="LONG"&&p>=target)||(s.direction==="SHORT"&&p<=target))return{valid:false,reason:"target_hit",exited:true,state:"INVALID" as const};return{valid:true,reason:"active",exited:false,state:"VALID" as const}}
export function filterExpiredSignals(signals:Signal[],prices:Record<string,number>,now=Date.now()){const active:Signal[]=[],exited:{signal:Signal;reason:string}[]=[];for(const s of signals){const p=prices[s.pair];if(p===undefined){active.push(s);continue}const v=isSignalStillValid(s,p,now);v.valid?active.push(s):exited.push({signal:s,reason:v.reason})}return{active,exited}}
export type TradeStatus="ACTIVE"|"TP_HIT"|"SL_HIT"|"EXPIRED";
export function checkTradeStatus(s:Signal,p:number,now=Date.now()):TradeStatus{const v=isSignalStillValid(s,p,now);if(v.reason==="expired_ttl")return"EXPIRED";if((s.direction==="LONG"&&p<=s.stop)||(s.direction==="SHORT"&&p>=s.stop))return"SL_HIT";if((s.direction==="LONG"&&p>=s.tp1)||(s.direction==="SHORT"&&p<=s.tp1))return"TP_HIT";return"ACTIVE"}
export function getMarketSnapshot(pair:string,candles1h:Candle[],candles4h:Candle[],candles15m:Candle[]){
  void candles1h;void candles15m;
  const c=[...candles4h].sort((a,b)=>a.timestamp-b.timestamp),q=c.map(x=>x.close),dailyCandles=daily(c).slice(0,-1),dailyCloses=dailyCandles.map(x=>x.close),alignment=trendAlignment(c);
  
  const closed4h=c.slice(0,-1),closedCloses=closed4h.map(x=>x.close),st=stoch(closedCloses),st1d=stoch(dailyCloses),e8=ema(q,8).at(-1)??0,e21=ema(q,21).at(-1)??0;
  const fourHDirection=alignment.fourHE5>alignment.fourHE13?"BULL":alignment.fourHE5<alignment.fourHE13?"BEAR":"NEUTRAL";
  const fourHTacticalDirection=alignment.fourH==="LONG"?"BULL":alignment.fourH==="SHORT"?"BEAR":"NEUTRAL";
  const fourHTacticalLabel="EMA5 "+r(alignment.fourHE5)+" "+(alignment.fourH==="LONG"?">":alignment.fourH==="SHORT"?"<":"=")+" EMA13 "+r(alignment.fourHE13);
  const gates=evaluateGates(pair,c,c.at(-1)?.close??0),exhausted=gates.exhaustion;
  const entry1Reason=gates.trigger.entry1Reason;
  const strategyStatus=exhausted?"WAIT — "+exhausted:gates.trigger.signalType==="ENTRY_1"?"FIRED — ENTRY_1 "+gates.direction:gates.trigger.signalType==="ADD"?"FIRED — ADD "+gates.direction:gates.trigger.signalType==="ENTRY_2"?"READY — ENTRY_2 (silent)":gates.missing.includes("price_too_far_from_trendline")?"WAIT — price too far from trendline":!gates.trendline?.price?"WAIT — "+(gates.trendline?.reason??gates.missing[0]??"trendline_unavailable"):entry1Reason?"WAIT — "+entry1Reason:"READY — waiting for 4H Stoch RSI extreme at trendline";
  return{pair,price:c.at(-1)?.close??0,trend:alignment.regime,regime:alignment.regime,dailyClose:alignment.dailyClose,dailyE21:alignment.dailyE21,adx:adx(c),rsi:rsi(q),stochK:st.k,stochD:st.d,stochK4h:st.k,stochD4h:st.d,stochK4hPrev:st.pk,stochD4hPrev:st.pd,ema8_4h:e8,ema21_4h:e21,ema8_1d:alignment.dailyE8,ema21_1d:alignment.dailyE21,ema5_1d:alignment.dailyE5,ema13_1d:alignment.dailyE13,dailyDirection:alignment.daily==="LONG"?"BULL":alignment.daily==="SHORT"?"BEAR":"NEUTRAL",dailyStrength:alignment.dailyStrength,dailySpreadPct:alignment.dailySpreadPct,dailySpread3dPct:alignment.dailySpread3dPct,dailySpreadDelta:alignment.dailySpreadDelta,dailySlope:alignment.dailySlope,sizeMultiplier:alignment.sizeMultiplier,fourHDirection,fourHTacticalDirection,fourHTacticalLabel,stochK1d:st1d.k,stochD1d:st1d.d,stochK1dPrev:st1d.pk,stochD1dPrev:st1d.pd,ema5_4h:alignment.fourHE5,ema13_4h:alignment.fourHE13,trendlinePrice:gates.trendline?.price??0,distToTrendline:gates.trendline?.distancePct??0,alignedDirection:alignment.aligned,strategyStatus};
}
