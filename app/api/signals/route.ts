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
  if(h.direction==="LONG"&&price>=tp3)return{state:"STALE" as AlertState,reason:"TP3 reached — original alert has completed"};
  if(h.direction==="SHORT"&&price<=tp3)return{state:"STALE" as AlertState,reason:"TP3 reached — original alert has completed"};
  const drift=Math.abs((price-h.entry)/h.entry);
  const limit=h.type==="ADD"?0.04:0.06;
  if(drift>limit)return{state:"STALE" as AlertState,reason:`Price is ${((drift)*100).toFixed(1)}% from alert entry`};
  return{state:"VALID" as AlertState,reason:"Alert remains actionable"};
}

export async function GET(){
  const activeSignals=await getActiveSignals();
  const signalHistory=await getSignalHistory();
  const persistedLatest=await getLatestAlerts();
  const marketData=await getMarketData();
  const lastCronRun=await getLastCronRun();
  const now=Date.now();

  // Three deliberately separate concepts:
  // activeSignals = currently tracked manual positions
  // latestAlerts = latest alert sent for each market, regardless of position status
  // signalHistory = complete alert audit trail
  const latestAlerts=Object.fromEntries(Object.entries(persistedLatest).map(([pair,h]:any)=>{
    const m=Array.isArray(marketData)?marketData.find((x:any)=>x?.pair===pair):undefined;
    const price=m?.price??h.entry;
    const v=alertValidity(h,price,now);
    return [pair,{...h,target:h.tp2??h.target,validity:v,currentPrice:price,ageMinutes:Math.round((now-h.timestamp)/60000)}];
  }));

  const enrichedActive=activeSignals.map((s:any)=>({
    ...s,scale:s.type,target:s.tp2??s.target,
    expectedMove:s.entry&&s.tp3?Math.round(Math.abs(s.tp3-s.entry)/s.entry*1000)/10:0,
    meta:{status:s.status,ageMinutes:Math.round((now-s.timestamp)/60000),actionable:s.status==="ACTIVE",state:"POSITION_ACTIVE"}
  }));
  const enrichedHistory=signalHistory.map((h:any)=>({...h,scale:h.type,target:h.tp2??h.target,meta:{ageMinutes:Math.round((now-h.timestamp)/60000),status:h.status}}));

  const historyLogs=signalHistory.slice().sort((a,b)=>b.timestamp-a.timestamp).slice(0,16).map((h:any)=>
    `[ALERT] ${h.pair} — ${h.direction} ${h.type} @ ${h.entry} | SL ${h.stop} | TP1 ${h.tp1??"—"} | TP2 ${h.tp2??h.target} | TP3 ${h.tp3??"—"} | ${h.status}${h.exitReason?` | ${h.exitReason}`:""}`
  );
  const validityLogs=Object.entries(latestAlerts).map(([pair,a]:any)=>`[VALIDITY] ${pair} — ${a.validity.state} | ${a.validity.reason} | latest ${a.type} @ ${a.entry} | SL ${a.stop} | TP1 ${a.tp1??"—"} | TP2 ${a.tp2??a.target} | TP3 ${a.tp3??"—"} | current ${a.currentPrice}`);
  const marketLogs=(Array.isArray(marketData)?marketData:[]).map((m:any)=>
    `[PAIR] ${m.pair} — ${m.trend||"NO TREND"} | TL ${m.trendlinePrice||"—"} | Price ${m.price} | Dist ${m.distToTrendline??"—"}% | ${m.location||"—"} | ${m.trigger||"WAITING"} | ADX ${m.adx??"—"} | RSI ${m.rsi??"—"} | Stoch ${m.stochK??"—"}/${m.stochD??"—"} | Momentum ${m.momentumState||"—"}`
  );
  const logs=[
    `[SYSTEM] CXSwitch v${CXSWITCH_VERSION} | ${ENTRY_ARCHITECTURE} entry architecture | ${DAILY_BIAS} daily bias | ${EXECUTION_MODE} execution`,
    `[CRON] Last run ${lastCronRun?new Date(lastCronRun).toISOString():"not recorded"}`,
    ...validityLogs,...marketLogs,...historyLogs,
    `[CRON] State: active=${enrichedActive.length} marketData=${Array.isArray(marketData)?marketData.length:0} history=${signalHistory.length} latest=${Object.keys(latestAlerts).length}`
  ].slice(0,40);

  const response=NextResponse.json({
    version:CXSWITCH_VERSION,architecture:ENTRY_ARCHITECTURE,dailyBias:DAILY_BIAS,executionMode:EXECUTION_MODE,
    activeSignals:enrichedActive,signalHistory:enrichedHistory,marketData:Array.isArray(marketData)?marketData:[],latestAlerts,logs,
    system:{version:CXSWITCH_VERSION,lastCronRun,lastCronAgeMs:lastCronRun?now-lastCronRun:null,activePositions:enrichedActive.length,latestAlerts:Object.keys(latestAlerts).length,historyEntries:signalHistory.length},
    updatedAt:new Date(now).toISOString()
  });
  response.headers.set("Cache-Control","no-store, no-cache, must-revalidate, proxy-revalidate");response.headers.set("Pragma","no-cache");response.headers.set("Expires","0");
  return response;
}
