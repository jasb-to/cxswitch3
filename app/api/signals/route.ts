// app/api/signals/route.ts — v59 dashboard state + alert validity
import { NextResponse } from "next/server";
import { getActiveSignals, getSignalHistory, getMarketData, getLastCronRun } from "@/lib/state";

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
  const tp3=h.context?.stages?.tp3??h.target;
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
  const marketData=await getMarketData();
  const lastCronRun=await getLastCronRun();
  const now=Date.now();
  const latestByPair:Record<string,any>={};
  for(const h of signalHistory){if(!latestByPair[h.pair]||h.timestamp>latestByPair[h.pair].timestamp)latestByPair[h.pair]=h;}

  const enrichedActive=activeSignals.map((s:any)=>({
    ...s,scale:s.type,
    expectedMove:s.entry&&s.target?Math.round(Math.abs(s.target-s.entry)/s.entry*1000)/10:0,
    meta:{status:s.status,ageMinutes:Math.round((now-s.timestamp)/60000),actionable:s.status==="ACTIVE",state:"POSITION_ACTIVE"}
  }));
  const enrichedHistory=signalHistory.map((h:any)=>({...h,scale:h.type,meta:{ageMinutes:Math.round((now-h.timestamp)/60000),status:h.status}}));

  const latestAlerts=Object.fromEntries(Object.entries(latestByPair).map(([pair,h]:any)=>{
    const m=Array.isArray(marketData)?marketData.find((x:any)=>x?.pair===pair):undefined;
    const price=m?.price??h.entry;
    const v=alertValidity(h,price,now);
    return[pair,{...h,validity:v,currentPrice:price,ageMinutes:Math.round((now-h.timestamp)/60000)}];
  }));

  const historyLogs=signalHistory.slice().sort((a,b)=>b.timestamp-a.timestamp).slice(0,16).map((h:any)=>
    `[ALERT] ${h.pair} — ${h.direction} ${h.type} @ ${h.entry} | SL ${h.stop} | TP ${h.target} | ${h.status}${h.exitReason?` | ${h.exitReason}`:""}`
  );
  const marketLogs=(Array.isArray(marketData)?marketData:[]).map((m:any)=>
    `[PAIR] ${m.pair} — ${m.trend||"NO TREND"} | TL ${m.trendlinePrice||"—"} | Price ${m.price} | Dist ${m.distToTrendline??"—"}% | ${m.location||"—"} | ${m.trigger||"WAITING"} | ADX ${m.adx??"—"} | RSI ${m.rsi??"—"} | Stoch ${m.stochK??"—"}/${m.stochD??"—"}`
  );
  const validityLogs=Object.entries(latestAlerts).map(([pair,a]:any)=>`[VALIDITY] ${pair} — ${a.validity.state} | ${a.validity.reason} | alert ${a.type} @ ${a.entry} | current ${a.currentPrice}`);
  const logs=[
    `[CRON] Last run ${lastCronRun?new Date(lastCronRun).toISOString():"not recorded"}`,
    ...validityLogs,...marketLogs,...historyLogs,
    `[CRON] State: active=${enrichedActive.length} marketData=${Array.isArray(marketData)?marketData.length:0} history=${signalHistory.length}`
  ].slice(0,40);

  const response=NextResponse.json({activeSignals:enrichedActive,signalHistory:enrichedHistory,marketData:Array.isArray(marketData)?marketData:[],latestAlerts,logs,system:{lastCronRun,lastCronAgeMs:lastCronRun?now-lastCronRun:null,activePositions:enrichedActive.length},updatedAt:new Date(now).toISOString()});
  response.headers.set("Cache-Control","no-store, no-cache, must-revalidate, proxy-revalidate");response.headers.set("Pragma","no-cache");response.headers.set("Expires","0");
  return response;
}
