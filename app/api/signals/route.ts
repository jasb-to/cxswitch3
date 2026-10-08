// app/api/signals/route.ts — canonical dashboard state + alert validity
import { NextResponse } from "next/server";
import { getActiveSignals, getSignalHistory, getLatestAlerts, getMarketData, getLastCronRun } from "@/lib/state";
import { CXSWITCH_VERSION, ENTRY_ARCHITECTURE, DAILY_BIAS, EXECUTION_MODE } from "@/lib/version";
import { getJarvisSnapshot } from "@/lib/jarvis";
import { shouldHold } from "@/lib/strategy";

export const runtime="nodejs";
export const dynamic="force-dynamic";
export const revalidate=0;

type AlertState="VALID"|"STALE"|"INVALID";
function alertValidity(h:any,price:number,now:number,isActivePosition=false){
  if(!h)return{state:"STALE" as AlertState,reason:"No alert recorded"};
  if(h.status!=="ACTIVE")return{state:(h.status==="SL_HIT"||h.status==="FAILED")?"INVALID":"STALE" as AlertState,reason:h.exitReason||h.status};
  // An executed 4H position does not expire because its entry alert is old.
  // TTL only applies to an unexecuted/latest alert; active positions remain live
  // until SL, final target, or the confirmed management lifecycle closes them.
  const ttl=24*60*60*1000;
  if(!isActivePosition&&now-h.timestamp>ttl)return{state:"STALE" as AlertState,reason:"Alert expired by age"};
  if(h.direction==="LONG"&&price<=h.stop)return{state:"INVALID" as AlertState,reason:"Price is at/below alert SL"};
  if(h.direction==="SHORT"&&price>=h.stop)return{state:"INVALID" as AlertState,reason:"Price is at/above alert SL"};
  const finalTarget=h.tp2;
  if(finalTarget!==undefined&&h.direction==="LONG"&&price>=finalTarget)return{state:"STALE" as AlertState,reason:"Final target reached — original alert has completed"};
  if(finalTarget!==undefined&&h.direction==="SHORT"&&price<=finalTarget)return{state:"STALE" as AlertState,reason:"Final target reached — original alert has completed"};
  const drift=Math.abs((price-h.entry)/h.entry),limit=0.06;
  if(drift>limit)return{state:"STALE" as AlertState,reason:`Price is ${((drift)*100).toFixed(1)}% from alert entry`};
  return{state:"VALID" as AlertState,reason:"Alert remains actionable"};
}

function momentumState(h:any,m:any,management?:any):"IN TRADE"|"OUT OF TRADE"{
  if(!h||h.status!=="ACTIVE")return"OUT OF TRADE";
  if(management?.managementState==="EXIT")return"OUT OF TRADE";
  return"IN TRADE";
}
function momentumStatus(h:any,m:any,management?:any){
  const state=momentumState(h,m,management);
  return state==="IN TRADE"
    ? {icon:"🟢",label:"STAY IN TRADE",detail:"Active position; management has no confirmed exit condition."}
    : {icon:"🔴",label:"EXIT TRADE",detail:"No active position or a confirmed exit condition is present."};
}
function managementAdvice(h:any,m:any){
  if(!h||h.status!=="ACTIVE")return null;
  const price=Number(m?.price);
  const candles=Array.isArray(m?.momentumCandles4h)?m.momentumCandles4h:[];
  if(Number.isFinite(price)&&candles.length){
    const hold=shouldHold(h,candles,price);
    if(hold.reason==="tp1_hit_scale_out")
      return{managementState:"STAY",status:"healthy",recommendation:"🟢 STAY IN TRADE",reason:"TP1 reached; scale out 50% and move stop to breakeven.",newStop:hold.newStop??h.entry};
    if(hold.reason==="chandelier_trailing")
      return{managementState:"STAY",status:"healthy",recommendation:"🟢 STAY IN TRADE",reason:"Chandelier trail active; remaining position is being allowed to run.",newStop:hold.newStop};
    if(hold.reason==="1d_ema_reversal")
      return{managementState:"EXIT",status:"failed",recommendation:"🔴 EXIT TRADE",reason:"1D trend reversed. Exit now."};
    if(hold.reason==="4h_ema_reversal_confirmed")
      return{managementState:"EXIT",status:"failed",recommendation:"🔴 EXIT TRADE",reason:"4H trend reversed after failing to reclaim the fast EMA. Exit now."};
    if(hold.reason==="chandelier_trailing_stop")
      return{managementState:"EXIT",status:"failed",recommendation:"🔴 EXIT TRADE",reason:"Chandelier trailing stop hit. Exit now."};
    if(hold.reason==="stop_hit"||hold.reason==="tp2_hit")
      return{managementState:"EXIT",status:"failed",recommendation:"🔴 EXIT TRADE",reason:hold.reason==="tp2_hit"?"TP2 reached. Close the trade.":"Stop loss hit. Exit now."};
    return{managementState:"STAY",status:"healthy",recommendation:"🟢 STAY IN TRADE",reason:"Thesis intact. Normal 4H Stoch pullbacks do not close the trade."};
  }
  const priceFallback=Number(m?.price);
  const tp2=h.tp2;
  if(Number.isFinite(priceFallback)&&tp2!==undefined&&(h.direction==="LONG"?priceFallback>=tp2:priceFallback<=tp2))
    return{managementState:"EXIT",status:"failed",recommendation:"🔴 EXIT TRADE",reason:"TP2/final structural target reached. Close the trade."};
  return{managementState:"STAY",status:"healthy",recommendation:"🟢 STAY IN TRADE",reason:"Thesis intact. No confirmed higher-timeframe reversal."};
}
function latestAlertMomentum(pair:string,history:any[],market:any){
  const now=Date.now();
  const h=history.filter((x:any)=>x?.pair===pair&&x?.status==="ACTIVE"&&Number.isFinite(Number(x.timestamp))).sort((a:any,b:any)=>b.timestamp-a.timestamp)[0];
  if(!h||now-Number(h.timestamp)>24*60*60*1000)return null;
  const price=Number(market?.price);
  const candles=Array.isArray(market?.momentumCandles4h)?market.momentumCandles4h:[];
  if(!Number.isFinite(price)||!candles.length)return null;
  const hold=shouldHold(h,candles,price,now);
  const pnlPct=Math.round(((price-h.entry)/h.entry*(h.direction==="LONG"?1:-1))*10000)/100;
  return {signalId:String(h.id),direction:h.direction,entry:Number(h.entry),currentPrice:price,pnlPct,managementState:hold.managementState,reason:hold.reason,newStop:hold.newStop??null,recommendation:hold.recommendation};
}

export async function GET(){
  const activeSignals=await getActiveSignals(),signalHistory=await getSignalHistory(),persistedLatest=await getLatestAlerts(),marketData=await getMarketData(),lastCronRun=await getLastCronRun(),jarvisSnapshot=await getJarvisSnapshot(),now=Date.now();
  const activeByPair:Record<string,any>=Object.fromEntries(activeSignals.map((s:any)=>[s.pair,s]));
  const v28LatestAlerts=Object.fromEntries(Object.entries(persistedLatest).map(([pair,h]:any)=>{const m=Array.isArray(marketData)?marketData.find((x:any)=>x?.pair===pair):undefined;const active=activeByPair[pair];const price=m?.price??h.entry;const v=alertValidity(h,price,now,!!active);const management=active?managementAdvice(active,m):null;const validity=management&&v.state==="VALID"?{...v,reason:`${management.recommendation} — ${management.reason}`}:v;return[pair,{...h,target:h.tp2,tp1:h.tp1,tp2:h.tp2,managementAdvice:management,momentumState:momentumState(active,m,management),momentumStatus:momentumStatus(active,m,management),currentPrice:price,ageMinutes:Math.round((now-h.timestamp)/60000),validity}];}));
  const latestAlerts=v28LatestAlerts;
  const momentumByPair:Record<string,any>=Object.fromEntries((Array.isArray(marketData)?marketData:[]).map((m:any)=>[m.pair,latestAlertMomentum(m.pair,signalHistory,m)]));
  const liveMarketData=(Array.isArray(marketData)?marketData:[]).map((m:any)=>{const a:any=activeByPair[m.pair];const momentumState=momentumByPair[m.pair]??null;const clean={...m,momentumState};delete clean.momentumCandles4h;if(!a||a.status!=="ACTIVE")return clean;return{...clean,price:a.currentPrice??m.price,alertState:a.validity?.state||"VALID",alertType:a.type,alertDirection:a.direction,alertEntry:a.entry,alertTimestamp:a.timestamp};});
  const enrichedActive=activeSignals.map((s:any)=>{const m=Array.isArray(marketData)?marketData.find((x:any)=>x?.pair===s.pair):undefined;const price=m?.price??s.entry;const management=managementAdvice(s,m);const jarvis=jarvisSnapshot?.pairs?.[s.pair];return{...s,scale:s.type,tp1:s.tp1,tp2:s.tp2,expectedMove:s.entry&&s.tp2?Math.round(Math.abs(s.tp2-s.entry)/s.entry*1000)/10:0,currentPrice:price,unrealizedPnlPct:Math.round(((price-s.entry)/s.entry*(s.direction==="LONG"?1:-1))*10000)/100,ageMinutes:Math.round((now-s.timestamp)/60000),validity:alertValidity(s,price,now,true),managementAdvice:management,managementState:management?.managementState??"STAY",managementRecommendation:management?.recommendation??"🟢 STAY IN TRADE",jarvisVerdict:jarvis?.verdict??"GOOD",jarvisReason:jarvis?.reason??"No active Jarvis warning",momentumState:momentumState(s,m,management),momentumStatus:momentumStatus(s,m,management),meta:{status:s.status,ageMinutes:Math.round((now-s.timestamp)/60000),actionable:s.status==="ACTIVE",state:"POSITION_ACTIVE"}};});
  const enrichedHistory=signalHistory.map((h:any)=>({...h,scale:h.type,tp1:h.tp1,tp2:h.tp2,meta:{ageMinutes:Math.round((now-h.timestamp)/60000),status:h.status}}));
  const historyLogs=signalHistory.slice().sort((a,b)=>b.timestamp-a.timestamp).slice(0,8).map((h:any)=>`[ALERT] ${h.pair} — ${h.direction} ${h.type} @ ${h.entry} | SL ${h.stop} | TP1 ${h.tp1??"—"} | TP2 ${h.tp2} | ${h.status}`);
  const unifiedPairLogs=liveMarketData.map((m:any)=>{
    const pair=m.pair;
    const active=enrichedActive.find((x:any)=>x.pair===pair);
    const latest=latestAlerts[pair];
    const j=jarvisSnapshot?.pairs?.[pair];
    const signal=active?"none":latest?.validity?.state==="VALID"?`${latest.direction} ${latest.type}`:"none";
    const position=active?`${active.direction}@${active.entry} SL=${active.stop} TP1=${active.tp1??"—"} TP2=${active.tp2??"—"}`:"none";
    const management=active?.managementAdvice?.recommendation||"—";
    const jarvis=j?.verdict||"watch";
    return `[PAIR] ${pair} | 1D=${m.dailyDirection||"—"} | 4H=${m.fourH513?.label||m.trend||"—"} | SIGNAL=${signal} | POSITION=${position} | MANAGEMENT=${management} | JARVIS=${jarvis}`;
  });
  const logs=[`[SYSTEM] CXSwitch v${CXSWITCH_VERSION} | ${ENTRY_ARCHITECTURE} | ${DAILY_BIAS} | ${EXECUTION_MODE}`,`[CRON] Last run ${lastCronRun?new Date(lastCronRun).toISOString():"not recorded"}`,...unifiedPairLogs,...historyLogs,`[CRON] State: active=${enrichedActive.length} marketData=${liveMarketData.length} history=${signalHistory.length} latest=${Object.keys(latestAlerts).length}`].slice(0,40);
  const response=NextResponse.json({version:CXSWITCH_VERSION,architecture:ENTRY_ARCHITECTURE,dailyBias:DAILY_BIAS,executionMode:EXECUTION_MODE,activeSignals:enrichedActive,signalHistory:enrichedHistory,marketData:liveMarketData,latestAlerts,logs,system:{version:CXSWITCH_VERSION,lastCronRun,lastCronAgeMs:lastCronRun?now-lastCronRun:null,activePositions:enrichedActive.length,latestAlerts:Object.keys(latestAlerts).length,historyEntries:signalHistory.length},updatedAt:new Date(now).toISOString()});
  response.headers.set("Cache-Control","no-store, no-cache, must-revalidate, proxy-revalidate");response.headers.set("Pragma","no-cache");response.headers.set("Expires","0");return response;
}