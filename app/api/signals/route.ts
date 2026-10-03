// app/api/signals/route.ts — canonical dashboard state + alert validity
import { NextResponse } from "next/server";
import { getActiveSignals, getSignalHistory, getLatestAlerts, getMarketData, getLastCronRun } from "@/lib/state";
import { CXSWITCH_VERSION, ENTRY_ARCHITECTURE, DAILY_BIAS, EXECUTION_MODE } from "@/lib/version";

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
  const ttl=h.type==="ADD"?4*60*60*1000:24*60*60*1000;
  if(!isActivePosition&&now-h.timestamp>ttl)return{state:"STALE" as AlertState,reason:"Alert expired by age"};
  if(h.direction==="LONG"&&price<=h.stop)return{state:"INVALID" as AlertState,reason:"Price is at/below alert SL"};
  if(h.direction==="SHORT"&&price>=h.stop)return{state:"INVALID" as AlertState,reason:"Price is at/above alert SL"};
  const finalTarget=h.tp2??h.target;
  if(finalTarget!==undefined&&h.direction==="LONG"&&price>=finalTarget)return{state:"STALE" as AlertState,reason:"Final target reached — original alert has completed"};
  if(finalTarget!==undefined&&h.direction==="SHORT"&&price<=finalTarget)return{state:"STALE" as AlertState,reason:"Final target reached — original alert has completed"};
  const drift=Math.abs((price-h.entry)/h.entry),limit=h.type==="ADD"?0.04:0.06;
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
  if(!h||h.status!=="ACTIVE"||!m||h.type==="ENTRY_0")return null;
  const price=Number(m.price);
  const tp2Hit=!!h.tp2HitAt||(h.tp2!==undefined&&(h.direction==="LONG"?price>=h.tp2:price<=h.tp2));
  if(tp2Hit)return{managementState:"EXIT",status:"failed",recommendation:"🔴 EXIT TRADE",reason:"R1.5/final target reached. Close the trade."};
  return{managementState:"STAY",status:"healthy",recommendation:"🟢 STAY IN TRADE",reason:"No confirmed 4H reversal or structural breakdown. Normal momentum cooling does not create an intermediate state."};
}

export async function GET(){
  const activeSignals=await getActiveSignals(),signalHistory=await getSignalHistory(),persistedLatest=await getLatestAlerts(),marketData=await getMarketData(),lastCronRun=await getLastCronRun(),now=Date.now();
  const activeByPair=Object.fromEntries(activeSignals.map((s:any)=>[s.pair,s]));
  const v28LatestAlerts=Object.fromEntries(Object.entries(persistedLatest).map(([pair,h]:any)=>{const m=Array.isArray(marketData)?marketData.find((x:any)=>x?.pair===pair):undefined;const active=activeByPair[pair];const price=m?.price??h.entry;const v=alertValidity(h,price,now,!!active);const management=active?managementAdvice(active,m):null;const validity=management&&v.state==="VALID"?{...v,reason:`${management.recommendation} — ${management.reason}`}:v;return[pair,{...h,target:h.tp2??h.target,managementAdvice:management,momentumState:momentumState(active,m,management),momentumStatus:momentumStatus(active,m,management),currentPrice:price,ageMinutes:Math.round((now-h.timestamp)/60000),validity}];}));
  const latestAlerts=v28LatestAlerts;
  const liveMarketData=(Array.isArray(marketData)?marketData:[]).map((m:any)=>{const a:any=activeByPair[m.pair];if(!a||a.status!=="ACTIVE")return m;return{...m,price:a.currentPrice??m.price,location:a.context?.marketPhase||m.location,trigger:a.trigger||m.trigger,alertState:a.validity?.state||"VALID",alertType:a.type,alertDirection:a.direction,alertEntry:a.entry,alertTimestamp:a.timestamp};});
  const enrichedActive=activeSignals.map((s:any)=>{const m=Array.isArray(marketData)?marketData.find((x:any)=>x?.pair===s.pair):undefined;const price=m?.price??s.entry;const management=managementAdvice(s,m);return{...s,scale:s.type,target:s.tp2??s.target,expectedMove:s.entry&&s.tp2?Math.round(Math.abs(s.tp2-s.entry)/s.entry*1000)/10:0,currentPrice:price,ageMinutes:Math.round((now-s.timestamp)/60000),validity:alertValidity(s,price,now,true),managementAdvice:management,momentumState:momentumState(s,m,management),momentumStatus:momentumStatus(s,m,management),meta:{status:s.status,ageMinutes:Math.round((now-s.timestamp)/60000),actionable:s.status==="ACTIVE",state:"POSITION_ACTIVE"}};});
  const enrichedHistory=signalHistory.map((h:any)=>({...h,scale:h.type,target:h.tp2??h.target,meta:{ageMinutes:Math.round((now-h.timestamp)/60000),status:h.status}}));
  const historyLogs=signalHistory.slice().sort((a,b)=>b.timestamp-a.timestamp).slice(0,8).map((h:any)=>`[ALERT] ${h.pair} — ${h.direction} ${h.type} @ ${h.entry} | SL ${h.stop} | R1 ${h.tp1??"—"} | R1.5 ${h.tp2??h.target} | ${h.status}`);
  const validityLogs=Object.entries(latestAlerts).map(([pair,a]:any)=>`[VALIDITY] ${pair} — ${a.validity.state} | ${a.validity.reason}`);
  const marketLogs=liveMarketData.map((m:any)=>`[PAIR] ${m.pair} — ${m.trend||"NO TREND"} | Price ${m.price} | ${m.location||"—"} | ${m.trigger||"WAITING"} | ADX ${m.adx??"—"} | RSI ${m.rsi??"—"} | Stoch ${m.stochK??"—"}/${m.stochD??"—"} | Momentum ${m.momentumState||"—"}`);
  const managementLogs=Object.entries(latestAlerts).filter(([,a]:any)=>a.managementAdvice).map(([pair,a]:any)=>`[MANAGEMENT] ${pair} — ${a.direction} | ${a.momentumStatus?.icon||""} ${a.momentumStatus?.label||""} | ${a.managementAdvice.recommendation}`);
  const logs=[`[SYSTEM] CXSwitch v${CXSWITCH_VERSION} | ${ENTRY_ARCHITECTURE} | ${DAILY_BIAS} | ${EXECUTION_MODE}`,`[CRON] Last run ${lastCronRun?new Date(lastCronRun).toISOString():"not recorded"}`,...managementLogs,...validityLogs,...marketLogs,...historyLogs,`[CRON] State: active=${enrichedActive.length} marketData=${liveMarketData.length} history=${signalHistory.length} latest=${Object.keys(latestAlerts).length}`].slice(0,40);
  const response=NextResponse.json({version:CXSWITCH_VERSION,architecture:ENTRY_ARCHITECTURE,dailyBias:DAILY_BIAS,executionMode:EXECUTION_MODE,activeSignals:enrichedActive,signalHistory:enrichedHistory,marketData:liveMarketData,latestAlerts,logs,system:{version:CXSWITCH_VERSION,lastCronRun,lastCronAgeMs:lastCronRun?now-lastCronRun:null,activePositions:enrichedActive.length,latestAlerts:Object.keys(latestAlerts).length,historyEntries:signalHistory.length},updatedAt:new Date(now).toISOString()});
  response.headers.set("Cache-Control","no-store, no-cache, must-revalidate, proxy-revalidate");response.headers.set("Pragma","no-cache");response.headers.set("Expires","0");return response;
}