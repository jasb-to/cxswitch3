// app/api/signals/route.ts — canonical dashboard state + alert validity
import { NextResponse } from "next/server";
import { getActiveSignals, getSignalHistory, getLatestAlerts, getMarketData, getLastCronRun } from "@/lib/state";
import { CXSWITCH_VERSION, ENTRY_ARCHITECTURE, DAILY_BIAS, EXECUTION_MODE } from "@/lib/version";

export const runtime="nodejs";
export const dynamic="force-dynamic";
export const revalidate=0;

type AlertState="VALID"|"STALE"|"INVALID";
function alertValidity(h:any,price:number,now:number){
  if(!h)return{state:"STALE" as AlertState,reason:"No alert recorded"};
  if(h.status!=="ACTIVE")return{state:h.status==="SL_HIT"?"INVALID":"STALE" as AlertState,reason:h.exitReason||h.status};
  const ttl=h.type==="ADD"?4*60*60*1000:24*60*60*1000;
  if(now-h.timestamp>ttl)return{state:"STALE" as AlertState,reason:"Alert expired by age"};
  if(h.direction==="LONG"&&price<=h.stop)return{state:"INVALID" as AlertState,reason:"Price is at/below alert SL"};
  if(h.direction==="SHORT"&&price>=h.stop)return{state:"INVALID" as AlertState,reason:"Price is at/above alert SL"};
  const tp3=h.tp3??h.target;
  if(h.direction==="LONG"&&price>=tp3)return{state:"STALE" as AlertState,reason:"Final target reached — original alert has completed"};
  if(h.direction==="SHORT"&&price<=tp3)return{state:"STALE" as AlertState,reason:"Final target reached — original alert has completed"};
  const drift=Math.abs((price-h.entry)/h.entry);
  const limit=h.type==="ADD"?0.04:0.06;
  if(drift>limit)return{state:"STALE" as AlertState,reason:`Price is ${((drift)*100).toFixed(1)}% from alert entry`};
  return{state:"VALID" as AlertState,reason:"Alert remains actionable"};
}

function managementAdvice(h:any,m:any){
  if(!h||h.status!=="ACTIVE"||!m||h.type==="ENTRY_0")return null;
  const price=Number(m.price);
  const tp1Hit=!!h.tp1HitAt || (h.tp1!==undefined&&(h.direction==="LONG"?price>=h.tp1:price<=h.tp1));
  const tp2Hit=!!h.tp2HitAt || (h.tp2!==undefined&&(h.direction==="LONG"?price>=h.tp2:price<=h.tp2));
  const e=m.fourH513;
  if(!e)return{status:"healthy",recommendation:"HOLD — SL UNCHANGED",reason:"Trade remains active. Do not raise the stop before R1; the next management point is R1, then move SL to breakeven."};
  const long=h.direction==="LONG";
  const same513=e.direction===(long?"BULLISH":"BEARISH");
  const contracting=!!e.spreadContracting;
  const momentum=m.momentumState||"NEUTRAL";
  const ema8=Number(m.ema8_4h),ema21=Number(m.ema21_4h);
  const same821=Number.isFinite(ema8)&&Number.isFinite(ema21)&&(long?ema8>=ema21:ema8<=ema21);
  const exhausted=long?(m.stochK>=80&&m.stochK<m.stochD):(m.stochK<=20&&m.stochK>m.stochD);
  const weakMomentum=momentum==="PULLBACK"||momentum==="HOT"||momentum==="OVEREXTENDED";

  if(tp2Hit){
    if(same513&&same821&&!contracting&&!exhausted&&momentum!=="OVEREXTENDED")return{status:"healthy",recommendation:"R2 RUNNER POSSIBLE",reason:"R1.5 reached. 4H 5/13 remains aligned and 8/21 confirms the move — keep the R2 runner unless momentum deteriorates."};
    return{status:"warning",recommendation:"R1.5 IS THE LIKELY FINAL TARGET",reason:"R1.5 reached. The remaining position should be protected; do not assume R2."};
  }
  if(tp1Hit){
    if(!same513)return{status:"failed",recommendation:"PROTECT PROFIT",reason:"R1 reached and 4H 5/13 has turned against the position. Move SL to breakeven if not already done and protect the remaining profit."};
    if(contracting||exhausted||weakMomentum||!same821)return{status:"warning",recommendation:"SL TO BREAKEVEN · R1.5 LIKELY FINAL",reason:`R1 reached. Move SL to breakeven. Momentum is weakening${contracting?" (5/13 spread contracting)":""}${weakMomentum?` (${momentum})`:""}${exhausted?" (Stoch exhaustion)":""}${!same821?" (8/21 not aligned)":""}. Do not assume R2.`};
    return{status:"healthy",recommendation:"SL TO BREAKEVEN · HOLD FOR R1.5",reason:"R1 reached. Move SL to breakeven. 4H 5/13 and 8/21 remain aligned, so R1.5 remains the next management target."};
  }
  if(!same513)return{status:"failed",recommendation:"TRADE VALIDITY WARNING · PROTECT",reason:"4H 5/13 has turned against the position. The alert may still be above/below its original SL, but the move is deteriorating. Do not widen the SL; reassess manually."};
  if(contracting||exhausted||weakMomentum||!same821)return{status:"warning",recommendation:"HOLD — SL UNCHANGED · WATCH R1",reason:`Trade is still active, but momentum is weakening${contracting?" (5/13 spread contracting)":""}${weakMomentum?` (${momentum})`:""}${exhausted?" (Stoch exhaustion)":""}${!same821?" (8/21 not aligned)":""}. Next management point: R1 → SL to breakeven.`};
  return{status:"healthy",recommendation:"HOLD — SL UNCHANGED · TARGET R1",reason:"Trade remains valid and conditions are healthy. Keep the original SL. At R1, move SL to breakeven; R1.5 is next, then R2 runner if conditions stay healthy."};
}

export async function GET(){
  const activeSignals=await getActiveSignals();
  const signalHistory=await getSignalHistory();
  const persistedLatest=await getLatestAlerts();
  const marketData=await getMarketData();
  const lastCronRun=await getLastCronRun();
  const now=Date.now();

  const v28LatestAlerts=Object.fromEntries(Object.entries(persistedLatest).map(([pair,h]:any)=>{
    const m=Array.isArray(marketData)?marketData.find((x:any)=>x?.pair===pair):undefined;
    const active=activeSignals.find((x:any)=>x.pair===pair&&x.direction===h.direction&&x.id===h.id) || activeSignals.find((x:any)=>x.pair===pair&&x.direction===h.direction);
    const price=m?.price??h.entry;
    const v=alertValidity(h,price,now);
    const management=managementAdvice(active||h,m);
    const validity=management&&v.state==="VALID"?{...v,reason:`${management.recommendation} — ${management.reason}`} : v;
    return [pair,{...h,target:h.tp2??h.target,managementAdvice:management,currentPrice:price,ageMinutes:Math.round((now-h.timestamp)/60000),validity}];
  }));

  const latestAlerts=v28LatestAlerts;
  const enrichedActive=activeSignals.map((s:any)=>({...s,scale:s.type,target:s.tp2??s.target,expectedMove:s.entry&&s.tp3?Math.round(Math.abs(s.tp3-s.entry)/s.entry*1000)/10:0,meta:{status:s.status,ageMinutes:Math.round((now-s.timestamp)/60000),actionable:s.status==="ACTIVE",state:"POSITION_ACTIVE"}}));
  const enrichedHistory=signalHistory.map((h:any)=>({...h,scale:h.type,target:h.tp2??h.target,meta:{ageMinutes:Math.round((now-h.timestamp)/60000),status:h.status}}));

  const historyLogs=signalHistory.slice().sort((a,b)=>b.timestamp-a.timestamp).slice(0,16).map((h:any)=>`[ALERT] ${h.pair} — ${h.direction} ${h.type} @ ${h.entry} | SL ${h.stop} | R1 ${h.tp1??"—"} | R1.5 ${h.tp2??h.target} | R2 ${h.tp3??"—"} | ${h.status}${h.exitReason?` | ${h.exitReason}`:""}`);
  const validityLogs=Object.entries(latestAlerts).map(([pair,a]:any)=>`[VALIDITY] ${pair} — ${a.validity.state} | ${a.validity.reason} | latest ${a.type} @ ${a.entry} | SL ${a.stop} | R1 ${a.tp1??"—"} | R1.5 ${a.tp2??a.target} | R2 ${a.tp3??"—"} | current ${a.currentPrice}`);
  const marketLogs=(Array.isArray(marketData)?marketData:[]).map((m:any)=>`[PAIR] ${m.pair} — ${m.trend||"NO TREND"} | TL ${m.trendlinePrice||"—"} | Price ${m.price} | Dist ${m.distToTrendline??"—"}% | ${m.location||"—"} | ${m.trigger||"WAITING"} | ADX ${m.adx??"—"} | RSI ${m.rsi??"—"} | Stoch ${m.stochK??"—"}/${m.stochD??"—"} | Momentum ${m.momentumState||"—"}`);
  const managementLogs=Object.entries(latestAlerts).filter(([,a]:any)=>a.managementAdvice).map(([pair,a]:any)=>`[MANAGEMENT] ${pair} — ${a.direction} | ${a.managementAdvice.recommendation} | ${a.managementAdvice.reason}`);
  const logs=[
    `[SYSTEM] CXSwitch v${CXSWITCH_VERSION} | ${ENTRY_ARCHITECTURE} entry architecture | ${DAILY_BIAS} daily bias | ${EXECUTION_MODE} execution`,
    `[CRON] Last run ${lastCronRun?new Date(lastCronRun).toISOString():"not recorded"}`,
    ...managementLogs,...validityLogs,...marketLogs,...historyLogs,
    `[CRON] State: active=${enrichedActive.length} marketData=${Array.isArray(marketData)?marketData.length:0} history=${signalHistory.length} latest=${Object.keys(latestAlerts).length}`
  ].slice(0,40);

  const response=NextResponse.json({version:CXSWITCH_VERSION,architecture:ENTRY_ARCHITECTURE,dailyBias:DAILY_BIAS,executionMode:EXECUTION_MODE,activeSignals:enrichedActive,signalHistory:enrichedHistory,marketData:Array.isArray(marketData)?marketData:[],latestAlerts,logs,system:{version:CXSWITCH_VERSION,lastCronRun,lastCronAgeMs:lastCronRun?now-lastCronRun:null,activePositions:enrichedActive.length,latestAlerts:Object.keys(latestAlerts).length,historyEntries:signalHistory.length},updatedAt:new Date(now).toISOString()});
  response.headers.set("Cache-Control","no-store, no-cache, must-revalidate, proxy-revalidate");response.headers.set("Pragma","no-cache");response.headers.set("Expires","0");
  return response;
}
