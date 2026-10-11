export interface Candle { timestamp:number; open:number; high:number; low:number; close:number; volume:number }
export interface Signal {
  id:string; pair:string; direction:"LONG"|"SHORT"; type:"ENTRY_1"|"ENTRY_2"|"REVERSAL_SHORT"|"REVERSAL_LONG"; signalClass:"TREND"|"REVERSAL"; sizeMultiplier:1|0.5;
  entry:number; stop:number; tp1:number; tp2:number; rr:number;
  adx:number; rsi:number; stochK:number; stochD:number; expectedMove:number;
  reason:string; timestamp:number; version:number; context?:any;
}
export interface BreakoutRecord { direction:Direction; price:number; timestamp:number; candleIndex:number }
export interface SignalResult { signal?:Signal; market?:any; debug:string[]; breakoutRecord?:BreakoutRecord }
export const CURRENT_SIGNAL_VERSION=29;
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
function stoch(a:number[]){const rv=rsiSeries(a),raw:number[]=[],k:number[]=[],d:number[]=[];for(let i=13;i<rv.length;i++){const w=rv.slice(i-13,i+1),lo=Math.min(...w),hi=Math.max(...w);raw.push(hi===lo?50:(rv[i]-lo)/(hi-lo)*100)}for(let i=2;i<raw.length;i++)k.push(raw.slice(i-2,i+1).reduce((x,y)=>x+y,0)/3);for(let i=2;i<k.length;i++)d.push(k.slice(i-2,i+1).reduce((x,y)=>x+y,0)/3);return{k:r(k.at(-1)??50,1),d:r(d.at(-1)??50,1),pk:r(k.at(-2)??50,1),pd:r(d.at(-2)??50,1)}}
function atr(c:Candle[],p=14){if(c.length<2)return 0;const v:number[]=[];for(let i=Math.max(1,c.length-p);i<c.length;i++){const x=c[i],q=c[i-1];v.push(Math.max(x.high-x.low,Math.abs(x.high-q.close),Math.abs(x.low-q.close)))}return v.reduce((a,b)=>a+b,0)/v.length}
function adx(c:Candle[],p=14){if(c.length<p+2)return 0;const tr:number[]=[],pl:number[]=[],mi:number[]=[];for(let i=1;i<c.length;i++){const x=c[i],q=c[i-1];tr.push(Math.max(x.high-x.low,Math.abs(x.high-q.close),Math.abs(x.low-q.close)));const u=x.high-q.high,d=q.low-x.low;pl.push(u>d?Math.max(u,0):0);mi.push(d>u?Math.max(d,0):0)}const sm=(a:number[])=>{if(a.length<p)return[];const o=[a.slice(0,p).reduce((x,y)=>x+y,0)/p];for(let i=p;i<a.length;i++)o.push((o.at(-1)!*(p-1)+a[i])/p);return o};const t=sm(tr),pp=sm(pl),mm=sm(mi),dx:number[]=[];for(let i=0;i<t.length;i++){const a=pp[i]/Math.max(t[i],EPS)*100,b=mm[i]/Math.max(t[i],EPS)*100;dx.push(a+b?Math.abs(a-b)/(a+b)*100:0)}if(dx.length<p)return 0;let x=dx.slice(0,p).reduce((a,b)=>a+b,0)/p;for(let i=p;i<dx.length;i++)x=(x*(p-1)+dx[i])/p;return r(x,1)}
function daily(c:Candle[]){const m=new Map<string,Candle[]>();for(const x of [...c].sort((a,b)=>a.timestamp-b.timestamp)){const z=new Date(x.timestamp),k=z.toISOString().slice(0,10),b=m.get(k)??[];b.push(x);m.set(k,b)}return[...m.values()].map(b=>({timestamp:b[0].timestamp,open:b[0].open,high:Math.max(...b.map(x=>x.high)),low:Math.min(...b.map(x=>x.low)),close:b.at(-1)!.close,volume:b.reduce((s,x)=>s+x.volume,0)}))}
export interface TrendAlignment { daily:Direction|null; fourH:Direction|null; aligned:Direction|null; dailyE5:number; dailyE13:number; fourHE5:number; fourHE13:number }
export function trendAlignment(c:Candle[]):TrendAlignment{
  const d=daily(c).slice(0,-1),dCloses=d.map(x=>x.close),dE5=ema(dCloses,5).at(-1)??0,dE13=ema(dCloses,13).at(-1)??0;
  const dailyDirection:Direction|null=dE5>dE13?"LONG":dE5<dE13?"SHORT":null;
  const closed4h=c.slice(0,-1),hCloses=closed4h.map(x=>x.close),hE5=ema(hCloses,5).at(-1)??0,hE13=ema(hCloses,13).at(-1)??0;
  const fourH:Direction|null=hE5>hE13?"LONG":hE5<hE13?"SHORT":null;
  const aligned=dailyDirection&&fourH&&dailyDirection===fourH?dailyDirection:null;
  return{daily:dailyDirection,fourH,aligned,dailyE5:dE5,dailyE13:dE13,fourHE5:hE5,fourHE13:hE13};
}
export interface Entry1State { pair:string; direction:Direction; entry:number; timestamp:number; context?:any }
type StochSnapshot={k:number;d:number;pk:number;pd:number};
export function evaluateEntry1(aligned:Direction|null,st:StochSnapshot){
  const entry1Long=aligned==="LONG"&&st.pk<=st.pd&&st.k>st.d&&st.k<40;
  const entry1Short=aligned==="SHORT"&&st.pk>=st.pd&&st.k<st.d&&st.k>60;
  return{entry1Long,entry1Short,entry1:entry1Long||entry1Short,direction:entry1Long?"LONG" as const:entry1Short?"SHORT" as const:null};
}
export function entry2RetestConditions(direction:Direction,entry:number,price:number,firstWavePrice:number,ema8:number,st:StochSnapshot,adverseCross:boolean,alreadyFired=false){
  const waveMoved=direction==="LONG"?firstWavePrice>=entry*1.015:firstWavePrice<=entry*0.985;
  const pulledBack=Math.abs(price-entry)/Math.max(entry,EPS)<=0.01;
  const correctEmaSide=direction==="LONG"?price>ema8:price<ema8;
  const freshCross=direction==="LONG"?st.pk<=st.pd&&st.k>st.d&&st.k<60:st.pk>=st.pd&&st.k<st.d&&st.k>40;
  return !alreadyFired&&waveMoved&&pulledBack&&correctEmaSide&&freshCross&&!adverseCross;
}
function hasAdverseEmaCrossSince(c:Candle[],state:Entry1State):boolean{
  const closed=c.slice(0,-1),closes=closed.map(x=>x.close),e8=ema(closes,8),e21=ema(closes,21);
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
function entry2Ready(pair:string,direction:Direction,state:Entry1State|undefined,c:Candle[],price:number,st:StochSnapshot,alreadyFired:boolean){
  if(!state||state.pair!==pair||state.direction!==direction)return false;
  const closed=c.slice(0,-1),marker=Number(state.context?.closed4hTimestamp);
  if(!Number.isFinite(marker)||!closed.some(x=>x.timestamp===marker)||closed.at(-1)!.timestamp<=marker)return false;
  const after=closed.filter(x=>x.timestamp>marker);
  if(!after.length)return false;
  const firstWavePrice=direction==="LONG"?Math.max(...after.map(x=>x.high)):Math.min(...after.map(x=>x.low));
  const ema8=ema(closed.map(x=>x.close),8).at(-1)??0;
  return entry2RetestConditions(direction,state.entry,price,firstWavePrice,ema8,st,hasAdverseEmaCrossSince(c,state),alreadyFired);
}
export interface GateEvaluation {
  direction:Direction|null;
  alignment:TrendAlignment;
  trigger:{entry1:boolean;entry2:boolean;signalType:"ENTRY_1"|"ENTRY_2"|null};
  exhaustion:string|null;
  stopCalc:StopCalc|null;
  missing:string[];
  allPassed:boolean;
  dailyTransition:boolean;
  breakoutRecord?:BreakoutRecord;
}
export interface StopCalc { structuralAnchor:number; atrMultiplier:number; riskPct:number; liquidationBufferPct:number; liquidationPrice:number; marginUsagePct:number }
export function calculateLiquidationBufferPct(direction:Direction,entry:number,stop:number,leverage=MAX_LEVERAGE):number{
  const liquidationPrice=direction==="LONG"?entry*(1-1/leverage+MAINTENANCE_MARGIN_RATE):entry*(1+1/leverage-MAINTENANCE_MARGIN_RATE);
  return direction==="LONG"?(stop-liquidationPrice)/Math.max(liquidationPrice,EPS)*100:(liquidationPrice-stop)/Math.max(liquidationPrice,EPS)*100;
}
export function calculateStop(direction:Direction,entry:number,atrValue:number,candles:Candle[]):{stop:number;calc:StopCalc;valid:boolean;invalidReason?:string}{
  if(!Number.isFinite(entry)||entry<=0||!Number.isFinite(atrValue)||atrValue<=0)
    return{stop:0,calc:{structuralAnchor:0,atrMultiplier:0,riskPct:Infinity,liquidationBufferPct:-Infinity,liquidationPrice:0,marginUsagePct:Infinity},valid:false,invalidReason:"stop_inputs"};
  const closed=[...candles].sort((a,b)=>a.timestamp-b.timestamp).slice(0,-1),recentWindow=closed.slice(-5);
  if(!recentWindow.length)return{stop:0,calc:{structuralAnchor:0,atrMultiplier:0,riskPct:Infinity,liquidationBufferPct:-Infinity,liquidationPrice:0,marginUsagePct:Infinity},valid:false,invalidReason:"stop_no_closed_candles"};
  const recentSwing=direction==="LONG"?Math.min(...recentWindow.map(x=>x.low)):Math.max(...recentWindow.map(x=>x.high));
  const atrFloor=direction==="LONG"?entry-1.5*atrValue:entry+1.5*atrValue;
  const stop=direction==="LONG"?Math.min(recentSwing,atrFloor):Math.max(recentSwing,atrFloor);
  const riskPct=Math.abs(entry-stop)/Math.max(entry,EPS)*100,atrMultiplier=Math.abs(entry-stop)/Math.max(atrValue,EPS);
  const liquidationPrice=direction==="LONG"?entry*(1-1/MAX_LEVERAGE+MAINTENANCE_MARGIN_RATE):entry*(1+1/MAX_LEVERAGE-MAINTENANCE_MARGIN_RATE);
  const liquidationBufferPct=calculateLiquidationBufferPct(direction,entry,stop,MAX_LEVERAGE);
  const calc={structuralAnchor:priceRound(recentSwing),atrMultiplier:r(atrMultiplier,2),riskPct:r(riskPct,2),liquidationBufferPct:r(liquidationBufferPct,2),liquidationPrice:priceRound(liquidationPrice),marginUsagePct:r(riskPct*MAX_LEVERAGE,1)};
  return{stop,calc,valid:true};
}
function exhaustion(direction:Direction,rv:number):string|null{
  if(direction==="LONG"&&rv>78)return"4H RSI overbought";
  if(direction==="SHORT"&&rv<22)return"4H RSI oversold";
  return null;
}
export function evaluateGates(pair:string,candles4h:Candle[],currentPrice:number,entry1State?:Entry1State,entry2AlreadyFired=false):GateEvaluation{
  const c=[...candles4h].sort((a,b)=>a.timestamp-b.timestamp),p=currentPrice??c.at(-1)?.close??0,alignment=trendAlignment(c),direction=alignment.aligned;
  const closed4h=c.slice(0,-1),closes=closed4h.map(x=>x.close),st=stoch(closes),rv=rsi(closes),a=atr(closed4h);
  const e1=evaluateEntry1(direction,st);
  const entry1=!!e1.entry1;
  const entry2=!!direction&&entry2Ready(pair,direction,entry1State,c,p,st,entry2AlreadyFired);
  const signalType: "ENTRY_1"|"ENTRY_2"|null=entry2?"ENTRY_2":entry1?"ENTRY_1":null;
  const exhausted=direction?exhaustion(direction,rv):null;
  const missing:string[]=[];
  if(!direction)missing.push("alignment");
  else if(!signalType)missing.push("entry_trigger");
  if(exhausted)missing.push("exhaustion");
  let stopCalc:StopCalc|null=null;
  if(direction&&signalType&&a>0)stopCalc=calculateStop(direction,p,a,c).calc;
  const deduped=[...new Set(missing)];
  return{direction,alignment,trigger:{entry1,entry2,signalType},exhaustion:exhausted,stopCalc,missing:deduped,allPassed:!!direction&&!!signalType&&!exhausted,dailyTransition:!alignment.daily,breakoutRecord:undefined};
}
export function generateSignal(pair:string,candles1h:Candle[],candles4h:Candle[],candles15m:Candle[],currentPrice?:number,nowOverride?:number,lastBreakout?:BreakoutRecord,entry1State?:Entry1State,entry2AlreadyFired=false){
  void candles1h;void candles15m;void lastBreakout;
  const debug:string[]=[],c=[...candles4h].sort((a,b)=>a.timestamp-b.timestamp),p=currentPrice??c.at(-1)?.close??0,now=nowOverride??Date.now();
  const closed=c.slice(0,-1),closedCloses=closed.map(x=>x.close),a=atr(closed),av=adx(closed),rv=rsi(closedCloses),st=stoch(closedCloses);
  const evaluation=evaluateGates(pair,c,p,entry1State,entry2AlreadyFired),alignment=evaluation.alignment;
  debug.push("[ALIGNMENT] 1D EMA5="+r(alignment.dailyE5)+" EMA13="+r(alignment.dailyE13)+" "+(alignment.daily??"NEUTRAL")+" | 4H EMA5="+r(alignment.fourHE5)+" EMA13="+r(alignment.fourHE13)+" "+(alignment.fourH??"NEUTRAL")+" | aligned="+(alignment.aligned??"NO"));
  debug.push("[GATES] "+JSON.stringify(evaluation));
  debug.push("[TRIGGER] ENTRY_1="+evaluation.trigger.entry1+" | ENTRY_2="+evaluation.trigger.entry2+" | Stoch K="+st.k+" D="+st.d);
  debug.push("[EXHAUST] "+(evaluation.exhaustion??"clear"));
  if(!evaluation.allPassed){
    debug.push(!alignment.aligned?"[WAIT] alignment — 1D and 4H EMA5/13 must agree":"[WAIT] "+evaluation.missing.join(", "));
    debug.push("[SIGNAL] none");
    debug.push("[JARVIS] observation only — no trade");
    debug.push("[ALERT] none");
    return{market:getMarketSnapshot(pair,candles1h,candles4h,candles15m),debug,breakoutRecord:undefined};
  }
  const direction=evaluation.direction!,signalType=evaluation.trigger.signalType!,entry=p,stopResult=calculateStop(direction,entry,a,c);
  if(!stopResult.valid){
    debug.push("[SIGNAL BLOCKED] "+pair+" | "+(stopResult.invalidReason??"invalid stop inputs"));
    return{market:getMarketSnapshot(pair,candles1h,candles4h,candles15m),debug,breakoutRecord:undefined};
  }
  const tp1=direction==="LONG"?entry*1.03:entry*0.97,tp2=direction==="LONG"?entry*1.06:entry*0.94;
  const risk=Math.abs(entry-stopResult.stop),actualRr=Math.abs(tp2-entry)/Math.max(risk,EPS);
  const closed4hTimestamp=closed.at(-1)?.timestamp??0,ema8_4h=ema(closedCloses,8).at(-1)??0,ema21_4h=ema(closedCloses,21).at(-1)??0;
  const sizeMultiplier:1|0.5=1;
  const s:Signal={
    id:pair+"_"+signalType+"_"+now,pair,direction,type:signalType,entry:priceRound(entry),signalClass:"TREND",sizeMultiplier,
    stop:priceRound(stopResult.stop),tp1:priceRound(tp1),tp2:priceRound(tp2),rr:r(actualRr,2),expectedMove:6,adx:r(av,1),rsi:r(rv,1),stochK:st.k,stochD:st.d,
    reason:direction+" "+signalType+" | 1D and 4H EMA5/13 aligned | "+(signalType==="ENTRY_1"?"fresh 4H Stoch RSI crossover within early-entry range":"ENTRY_1 retest: first wave, pullback, EMA8 side and second 4H Stoch RSI crossover"),
    timestamp:now,version:CURRENT_SIGNAL_VERSION,
    context:{entryAnchor:"current price",signalClass:"TREND",sizeMultiplier,structuralAnchor:stopResult.calc.structuralAnchor,liquidationPrice:stopResult.calc.liquidationPrice,stopToLiquidationBufferPct:stopResult.calc.liquidationBufferPct,stopCalc:stopResult.calc,ema5_1d:alignment.dailyE5,ema13_1d:alignment.dailyE13,ema5_4h:alignment.fourHE5,ema13_4h:alignment.fourHE13,ema8_4h:ema8_4h,ema21_4h:ema21_4h,closed4hTimestamp,stochK_4h:st.k,stochD_4h:st.d}
  };
  debug.push("[STOP] "+direction+" | SL "+s.stop+" | "+stopResult.calc.riskPct+"% risk | 1.5 ATR floor");
  debug.push("[TARGETS] TP1 "+s.tp1+" (3%) | TP2 "+s.tp2+" (6%) | RR "+s.rr);
  debug.push("[SIGNAL] "+s.direction+" "+s.type+" | entry "+s.entry+" | SL "+s.stop+" | TP1 "+s.tp1+" | TP2 "+s.tp2);
  debug.push("[JARVIS] trade conditions passed — execution remains separate from opportunity guidance");
  debug.push("[ALERT] SURFACE");
  return{signal:s,market:getMarketSnapshot(pair,candles1h,candles4h,candles15m),debug,breakoutRecord:undefined};
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
export function getMarketSnapshot(pair:string,candles1h:Candle[],candles4h:Candle[],candles15m:Candle[]){
  void candles1h;void candles15m;
  const c=[...candles4h].sort((a,b)=>a.timestamp-b.timestamp),closed=c.slice(0,-1),q=closed.map(x=>x.close),dailyCandles=daily(c).slice(0,-1),dailyCloses=dailyCandles.map(x=>x.close),alignment=trendAlignment(c);
  const e5d=alignment.dailyE5,e13d=alignment.dailyE13,e8d=ema(dailyCloses,8).at(-1)??0,e21d=ema(dailyCloses,21).at(-1)??0;
  const st=stoch(q),st1d=stoch(dailyCloses),e8=ema(q,8).at(-1)??0,e21=ema(q,21).at(-1)??0;
  const fourHDirection=e8>e21?"BULL":e8<e21?"BEAR":"NEUTRAL";
  const fourHTacticalDirection=alignment.fourH==="LONG"?"BULL":alignment.fourH==="SHORT"?"BEAR":"NEUTRAL";
  const fourHTacticalLabel="EMA5 "+r(alignment.fourHE5)+" "+(alignment.fourH==="LONG"?">":alignment.fourH==="SHORT"?"<":"=")+" EMA13 "+r(alignment.fourHE13);
  return{pair,price:c.at(-1)?.close??0,trend:alignment.daily??"NEUTRAL",adx:adx(closed),rsi:rsi(q),stochK:st.k,stochD:st.d,stochK4h:st.k,stochD4h:st.d,stochK4hPrev:st.pk,stochD4hPrev:st.pd,ema8_4h:e8,ema21_4h:e21,ema8_1d:e8d,ema21_1d:e21d,ema5_1d:e5d,ema13_1d:e13d,dailyDirection:alignment.daily==="LONG"?"BULL":alignment.daily==="SHORT"?"BEAR":"NEUTRAL",dailyStrength:"NEUTRAL",fourHDirection,fourHTacticalDirection,fourHTacticalLabel,stochK1d:st1d.k,stochD1d:st1d.d,stochK1dPrev:st1d.pk,stochD1dPrev:st1d.pd,ema5_4h:alignment.fourHE5,ema13_4h:alignment.fourHE13,alignedDirection:alignment.aligned};
}
