export interface Candle { timestamp:number; open:number; high:number; low:number; close:number; volume:number }
export interface Signal {
  id:string; pair:string; direction:"LONG"|"SHORT"; type:"ENTRY_1"|"ENTRY_2"; entryType:"MARKET"|"LIMIT";
  entry:number; stop:number; tp1:number; tp2:number; rr:number;
  adx:number; rsi:number; stochK:number; stochD:number; expectedMove:number;
  reason:string; timestamp:number; version:number; context?:any;
}
export interface SignalResult { signal?:Signal; market?:any; debug:string[] }
export const CURRENT_SIGNAL_VERSION=31;
type Direction="LONG"|"SHORT";
const MIN_RR=1.5, DAILY_NEUTRAL_SPREAD_PCT=0.5, TTL=24*60*60*1000, EPS=1e-12;
const r=(n:number,d=2)=>{const m=10**d;return Math.round(n*m)/m};
function ema(a:number[],p:number){if(!a.length)return[];const k=2/(p+1),o=[a[0]];for(let i=1;i<a.length;i++)o.push(a[i]*k+o[i-1]*(1-k));return o}
function rsiSeries(a:number[],p=14){if(a.length<=p)return[];let g=0,l=0;for(let i=1;i<=p;i++){const x=a[i]-a[i-1];if(x>=0)g+=x;else l-=x}let ag=g/p,al=l/p,o=[al===0?100:100-100/(1+ag/al)];for(let i=p+1;i<a.length;i++){const x=a[i]-a[i-1];ag=(ag*(p-1)+Math.max(x,0))/p;al=(al*(p-1)+Math.max(-x,0))/p;o.push(al===0?100:100-100/(1+ag/al))}return o}
function rsi(a:number[]){const x=rsiSeries(a);return x.at(-1)??50}
function stoch(a:number[]){const rv=rsiSeries(a),raw:number[]=[],k:number[]=[],d:number[]=[];for(let i=13;i<rv.length;i++){const w=rv.slice(i-13,i+1),lo=Math.min(...w),hi=Math.max(...w);raw.push(hi===lo?50:(rv[i]-lo)/(hi-lo)*100)}for(let i=2;i<raw.length;i++)k.push(raw.slice(i-2,i+1).reduce((x,y)=>x+y,0)/3);for(let i=2;i<k.length;i++)d.push(k.slice(i-2,i+1).reduce((x,y)=>x+y,0)/3);return{k:r(k.at(-1)??50,1),d:r(d.at(-1)??50,1),pk:r(k.at(-2)??50,1),pd:r(d.at(-2)??50,1)}}
function atr(c:Candle[],p=14){if(c.length<2)return 0;const v:number[]=[];for(let i=Math.max(1,c.length-p);i<c.length;i++){const x=c[i],q=c[i-1];v.push(Math.max(x.high-x.low,Math.abs(x.high-q.close),Math.abs(x.low-q.close)))}return v.reduce((a,b)=>a+b,0)/v.length}
function adx(c:Candle[],p=14){if(c.length<p+2)return 0;const tr:number[]=[],pl:number[]=[],mi:number[]=[];for(let i=1;i<c.length;i++){const x=c[i],q=c[i-1];tr.push(Math.max(x.high-x.low,Math.abs(x.high-q.close),Math.abs(x.low-q.close)));const u=x.high-q.high,d=q.low-x.low;pl.push(u>d?Math.max(u,0):0);mi.push(d>u?Math.max(d,0):0)}const sm=(a:number[])=>{if(a.length<p)return[];const o=[a.slice(0,p).reduce((x,y)=>x+y,0)/p];for(let i=p;i<a.length;i++)o.push((o.at(-1)!*(p-1)+a[i])/p);return o};const t=sm(tr),pp=sm(pl),mm=sm(mi),dx:number[]=[];for(let i=0;i<t.length;i++){const a=pp[i]/Math.max(t[i],EPS)*100,b=mm[i]/Math.max(t[i],EPS)*100;dx.push(a+b?Math.abs(a-b)/(a+b)*100:0)}if(dx.length<p)return 0;let x=dx.slice(0,p).reduce((a,b)=>a+b,0)/p;for(let i=p;i<dx.length;i++)x=(x*(p-1)+dx[i])/p;return r(x,1)}
function daily(c:Candle[]){const m=new Map<string,Candle[]>();for(const x of [...c].sort((a,b)=>a.timestamp-b.timestamp)){const z=new Date(x.timestamp),k=z.toISOString().slice(0,10),b=m.get(k)??[];b.push(x);m.set(k,b)}return[...m.values()].map(b=>({timestamp:b[0].timestamp,open:b[0].open,high:Math.max(...b.map(x=>x.high)),low:Math.min(...b.map(x=>x.low)),close:b.at(-1)!.close,volume:b.reduce((s,x)=>s+x.volume,0)}))}
function dailyTrend(c:Candle[]){const d=daily(c);if(d.length<25)return{direction:null as Direction|null,e8:0,e21:0,spread:0};const a=d.map(x=>x.close),e8=ema(a,8).at(-1)!,e21=ema(a,21).at(-1)!,p=a.at(-1)!,spread=Math.abs(e8-e21)/Math.max(p,EPS)*100;return{direction:spread<=DAILY_NEUTRAL_SPREAD_PCT?null:e8>e21?"LONG":"SHORT",e8,e21,spread}}
interface Swing{index:number;price:number;timestamp:number}
function swings(c:Candle[],high:boolean){const o:Swing[]=[];for(let i=2;i<c.length-2;i++){const p=high?c[i].high:c[i].low;let ok=true;for(let j=1;j<=2;j++)if(high?(p<=c[i-j].high||p<=c[i+j].high):(p>=c[i-j].low||p>=c[i+j].low))ok=false;if(ok)o.push({index:i,price:p,timestamp:c[i].timestamp})}return o}
function line(p:Swing[]){if(p.length<2)return null;const n=p.length,sx=p.reduce((s,x)=>s+x.index,0),sy=p.reduce((s,x)=>s+x.price,0),sxy=p.reduce((s,x)=>s+x.index*x.price,0),sx2=p.reduce((s,x)=>s+x.index*x.index,0),den=n*sx2-sx*sx;if(!den)return null;const slope=(n*sxy-sx*sy)/den;return{slope,intercept:(sy-slope*sx)/n}}
export interface TrendlineState{slope:number;intercept:number;pivots:Swing[];lastUpdated:number;direction:Direction;r2:number}
const trendlineStore=new Map<string,TrendlineState>();
export function getTrendline(pair:string,candles:Candle[],direction:Direction):TrendlineState|null{
  const now=candles.at(-1)?.timestamp;
  if(now===undefined)return null;
  const existing=trendlineStore.get(pair);
  if(existing&&existing.direction===direction){
    const ageDays=(now-existing.lastUpdated)/(24*60*60*1000);
    const recentSwings=swings(candles,direction==="SHORT").slice(-5);
    const currentLinePrice=existing.slope*(candles.length-1)+existing.intercept;
    const lastSwing=recentSwings.at(-1);
    const deviation=lastSwing?Math.abs(lastSwing.price-currentLinePrice)/Math.max(currentLinePrice,EPS):0;
    if(ageDays<7&&deviation<0.02)return existing;
  }
  const tr=swings(candles,direction==="SHORT").slice(-5);
  const f=line(tr);
  if(!f)return null;
  const state:TrendlineState={slope:f.slope,intercept:f.intercept,pivots:tr,lastUpdated:now,direction,r2:0};
  trendlineStore.set(pair,state);
  return state;
}
function zone(c:Candle[],dir:Direction,p:number,a:number,e21:number,pair=""){if(!a)return null;const z:{type:string;price:number;distance:number}[]=[];const tr=pair?getTrendline(pair,c,dir):null;if(tr&&((dir==="LONG"&&tr.slope>0)||(dir==="SHORT"&&tr.slope<0))){const lp=tr.slope*(c.length-1)+tr.intercept;z.push({type:dir==="LONG"?"TRENDLINE_SUPPORT":"TRENDLINE_RESISTANCE",price:lp,distance:Math.abs(p-lp)})}z.push({type:"EMA21",price:e21,distance:Math.abs(p-e21)});const sw=swings(c,dir==="SHORT"),lastSwing=sw.at(-1);if(lastSwing)z.push({type:dir==="LONG"?"SWING_LOW":"SWING_HIGH",price:lastSwing.price,distance:Math.abs(p-lastSwing.price)});z.sort((x,y)=>x.distance-y.distance);const q=z[0];return q?{...q,distancePct:q.distance/Math.max(p,EPS)*100}:null}
function exhaust(dir:Direction,k:number,rv:number,p:number,e21:number,label="4H"){if(dir==="LONG"&&k>=95)return`LONG blocked: ${label} Stoch K ${r(k,1)} >= 95`;if(dir==="SHORT"&&k<=5)return`SHORT blocked: ${label} Stoch K ${r(k,1)} <= 5`;if(dir==="LONG"&&rv>=78)return`LONG blocked: 4H RSI ${r(rv,1)} >= 78`;if(dir==="SHORT"&&rv<=22)return`SHORT blocked: 4H RSI ${r(rv,1)} <= 22`;if(dir==="LONG"&&p>e21*1.03)return"LONG blocked: 4H close is more than 3% above 4H EMA(21)";if(dir==="SHORT"&&p<e21*.97)return"SHORT blocked: 4H close is more than 3% below 4H EMA(21)";return null}
function jarvis(s:Signal,d:ReturnType<typeof dailyTrend>,e8:number,e21:number){if(s.direction!==d.direction)return["VETO","signal direction disagrees with 1D trend"] as const;const four=e8>e21?"LONG":e8<e21?"SHORT":null;if(four&&four!==s.direction)return["WARN","signal agrees with 1D but disagrees with 4H trend"] as const;if(s.direction==="LONG"&&s.stochK>90)return["WARN","4H Stoch is already in the trade-direction exhaustion zone"] as const;if(s.direction==="SHORT"&&s.stochK<10)return["WARN","4H Stoch is already in the trade-direction exhaustion zone"] as const;return["GOOD","all deterministic Jarvis checks passed"] as const}

export interface GateEvaluation {
  direction: "LONG" | "SHORT" | null;
  zone: { valid: boolean; type: string; price: number; distancePct: number } | null;
  trendlineSlope: number;
  trigger: { entry1: boolean; entry2: boolean; signalType: "ENTRY_1" | "ENTRY_2" | null };
  exhaustion: string | null;
  rr: number | null;
  missing: string[];
  allPassed: boolean;
}

export function evaluateGates(pair:string,candles4h:Candle[],currentPrice:number):GateEvaluation{
  const c=[...candles4h].sort((a,b)=>a.timestamp-b.timestamp);
  const p=currentPrice??c.at(-1)?.close??0;
  const d=dailyTrend(c);
  const missing:string[]=[];

  if(!d.direction) missing.push("direction");

  const direction=d.direction;
  const trendlineState=direction?getTrendline(pair,c,direction):null;
  const trendlineSlope=trendlineState?.slope??0;
  const validTrendline=!!trendlineState&&!!direction&&(
    (direction==="LONG"&&trendlineSlope>0) ||
    (direction==="SHORT"&&trendlineSlope<0)
  );
  const trendlinePrice=trendlineState?trendlineState.slope*(c.length-1)+trendlineState.intercept:0;
  const distancePct=validTrendline?Math.abs(p-trendlinePrice)/Math.max(p,EPS)*100:Infinity;
  const zoneValue=validTrendline
    ? {valid:true,type:direction==="LONG"?"TRENDLINE_SUPPORT":"TRENDLINE_RESISTANCE",price:trendlinePrice,distancePct}
    : null;
  if(!zoneValue||distancePct>1.2) missing.push("zone");

  const st4=stoch(c.map(x=>x.close));
  const entry1=direction==="LONG"?st4.k<20:direction==="SHORT"?st4.k>80:false;
  const entry2=direction==="LONG"
    ? st4.k>st4.d&&st4.k>=20&&st4.k<=55
    : direction==="SHORT"
      ? st4.k<st4.d&&st4.k<=80&&st4.k>=45
      : false;
  const entry2Late=direction==="LONG"
    ? st4.k>st4.d&&st4.k>55
    : direction==="SHORT"
      ? st4.k<st4.d&&st4.k<45
      : false;
  const signalType=entry1?"ENTRY_1":entry2?"ENTRY_2":null;
  if(!signalType && direction) missing.push(entry2Late?"entry2_late":"stoch_cross");

  const rv=rsi(c.map(x=>x.close));
  const e21=ema(c.map(x=>x.close),21).at(-1)??0;
  const exhaustion=direction?exhaust(direction,st4.k,rv,p,e21,"4H"):null;
  if(exhaustion) missing.push("exhaustion");

  let rr:number|null=null;
  if(zoneValue){
    const a=atr(c);
    if(a>0){
      const entryBase=distancePct<=0.3?p:trendlinePrice;
      const stop=direction==="LONG"?trendlinePrice-.5*a:trendlinePrice+.5*a;
      const risk=direction==="LONG"?entryBase-stop:stop-entryBase;
      const tp1=direction==="LONG"?entryBase*1.05:entryBase*.95;
      rr=(direction==="LONG"?tp1-entryBase:entryBase-tp1)/Math.max(risk,EPS);
      if(rr<MIN_RR) missing.push("rr");
    }else{
      rr=0;
      missing.push("rr");
    }
  }

  const deduped=[...new Set(missing.filter(Boolean))];
  return {
    direction,
    zone:zoneValue,
    trendlineSlope,
    trigger:{entry1,entry2,signalType},
    exhaustion,
    rr,
    missing:deduped,
    allPassed:deduped.length===0
  };
}

export function getTrendlineDebug(pair:string,candles:Candle[],direction:"LONG"|"SHORT"){
  const c=[...candles].sort((a,b)=>a.timestamp-b.timestamp);
  const pivots=swings(c,direction==="SHORT").slice(-5);
  const state=getTrendline(pair,c,direction);
  const priceAtCurrent=state?state.slope*(c.length-1)+state.intercept:null;
  return {
    pair,
    direction,
    pivots:pivots.map(x=>({i:x.index,p:x.price,t:x.timestamp})),
    slope:state?.slope??null,
    intercept:state?.intercept??null,
    priceAtCurrent
  };
}

export function generateSignal(pair:string,candles1h:Candle[],candles4h:Candle[],candles15m:Candle[],currentPrice?:number,nowOverride?:number){
  void candles1h; void candles15m;
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

  const d=dailyTrend(c),cl=c.map(x=>x.close),e8=ema(cl,8).at(-1)!,e21=ema(cl,21).at(-1)!,rv=rsi(cl),st4=stoch(cl),a=atr(c),av=adx(c);
  const evaluation=evaluateGates(pair,c,p);
  debug.push(`[GATES] ${JSON.stringify(evaluation)}`);
  debug.push(`[1D] ${d.direction??"NEUTRAL"} | EMA8 ${r(d.e8)} | EMA21 ${r(d.e21)} | spread ${d.spread.toFixed(2)}%`);

  if(!evaluation.direction){
    debug.push("[1D] NEUTRAL | spread < 0.5%");
    debug.push("[ZONE] none in range"); debug.push("[TRIGGER] 4H Stoch/Trendline unavailable | fired=false");
    debug.push("[EXHAUST] clear"); debug.push("[SIGNAL] none"); debug.push("[JARVIS] not evaluated"); debug.push("[ALERT] none");
    return{market:getMarketSnapshot(pair,candles1h,candles4h,candles15m),debug};
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
  }
  debug.push(`[EXHAUST] ${evaluation.exhaustion??"clear"}`);

  if(!evaluation.allPassed){
    debug.push(`[SIGNAL] none — missing ${evaluation.missing.join(", ")}`);
    debug.push("[JARVIS] not evaluated"); debug.push("[ALERT] none");
    return{market:getMarketSnapshot(pair,candles1h,candles4h,candles15m),debug};
  }

  const signalType=evaluation.trigger.signalType!;
  const entryType=trendlineDistancePct<=0.3?"MARKET":"LIMIT";
  const entryBase=entryType==="MARKET"?p:trendlinePrice;
  debug.push(`[ENTRY] ${entryType} | anchor ${r(entryBase)} | trendline distance ${trendlineDistancePct.toFixed(2)}%`);
  const stop=evaluation.direction==="LONG"?trendlinePrice-.5*a:trendlinePrice+.5*a;
  const tp1=evaluation.direction==="LONG"?entryBase*1.05:entryBase*.95;
  const tp2=evaluation.direction==="LONG"?entryBase*1.10:entryBase*.90;

  const s:Signal={
    id:`${pair}_${signalType}_${now`,pair,direction:evaluation.direction,type:signalType,entry:r(entryBase),entryType,
    stop:r(stop),tp1:r(tp1),tp2:r(tp2),rr:r(evaluation.rr??0),adx:r(av,1),rsi:r(rv,1),stochK:st4.k,stochD:st4.d,
    reason:`${evaluation.direction} ${signalType} + ${trendlineType} location + 4H Stoch`,
    timestamp:now,version:CURRENT_SIGNAL_VERSION,
    context:{zone:trendlineType,zonePrice:r(trendlinePrice),zoneDistancePct:trendlineDistancePct,zoneDistanceAtr,entryType,entryAnchor:"4H trendline",structuralAnchor:r(trendlinePrice),ema8_1d:d.e8,ema21_1d:d.e21,ema8_4h:e8,ema21_4h:e21,stochK_4h:st4.k,stochD_4h:st4.d}
  };
  debug.push(`[SIGNAL] ${s.direction} ${s.type} ${s.entryType} | entry ${s.entry} | trendline ${r(trendlinePrice)} | SL ${s.stop} | TP1 ${s.tp1} | TP2 ${s.tp2} | RR ${s.rr}`);
  debug.push("[JARVIS] GOOD | shared gate evaluation passed");
  debug.push("[ALERT] SURFACE");
  return{signal:s,market:getMarketSnapshot(pair,candles1h,candles4h,candles15m),debug};
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
    const qd=d.map(z=>z.close),a8=ema(qd,8),a21=ema(qd,21);
    const dr=s.direction==="LONG"
      ? a8.at(-2)!>=a21.at(-2)!&&a8.at(-1)!<a21.at(-1)!
      : a8.at(-2)!<=a21.at(-2)!&&a8.at(-1)!>a21.at(-1)!;
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
export function getMarketSnapshot(pair:string,candles1h:Candle[],candles4h:Candle[],candles15m:Candle[]){void candles1h;const c=[...candles4h].sort((a,b)=>a.timestamp-b.timestamp),c15=[...candles15m].sort((a,b)=>a.timestamp-b.timestamp),q=c.map(x=>x.close),q15=c15.map(x=>x.close),d=dailyTrend(c),st=stoch(q),st15=stoch(q15),e8=ema(q,8).at(-1)??0,e21=ema(q,21).at(-1)??0;const fourHDirection=e8>e21?"BULL":"BEAR";return{pair,price:c.at(-1)?.close??0,trend:d.direction??"NEUTRAL",adx:adx(c),rsi:rsi(q),stochK:st.k,stochD:st.d,stochK4h:st.k,stochD4h:st.d,stochK4hPrev:st.pk,stochD4hPrev:st.pd,ema8_4h:e8,ema21_4h:e21,ema8_1d:d.e8,ema21_1d:d.e21,fourHDirection}}
export async function getMonitorState(_pair:string){return undefined}
export async function clearMonitorState(_pair:string){return}
export async function setMonitorState(_pair:string,_state:any){return}
export function setRedisClient(_client:any){return}
export function rebuildStateFromTrades(_trades:Record<string,any>){return}
export function isSignalStillValidBool(s:Signal,p:number){return isSignalStillValid(s,p).valid}
export async function generateSignalCompat(pair:string,candles1h:Candle[],candles4h:Candle[],candles15m:Candle[],_activeTrades:any[]=[],currentPrice?:number,_lastBreakout?:any,_dailyLive?:any,_candlesWeekly:Candle[]=[],_marketHealth?:any,nowOverride?:number){return generateSignal(pair,candles1h,candles4h,candles15m,currentPrice,nowOverride)}
export function shouldHoldCompat(s:Signal,c4:Candle[],_c1:Candle[],p:number){return shouldHold(s,c4,p)}
