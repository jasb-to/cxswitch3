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
  if(h.status!=="ACTIVE")return{state:h.status==="SL_HIT"?"INVALID":"STALE" as AlertState,reason:h.exitReason||h.status};
  // An executed 4H position does not expire because its entry alert is old.
  // TTL only applies to an unexecuted/latest alert; active positions remain live
  // until SL, final target, or the confirmed management lifecycle closes them.
  const ttl=h.type==="ADD"?4*60*60*1000:24*60*60*1000;
  if(!isActivePosition&&now-h.timestamp>ttl)return{state:"STALE" as AlertState,reason:"Alert expired by age"};
  if(h.direction==="LONG"&&price<=h.stop)return{state:"INVALID" as AlertState,reason:"Price is at/below alert SL"};
  if(h.direction==="SHORT"&&price>=h.stop)return{state:"INVALID" as AlertState,reason:"Price is at/above alert SL"};
  const tp3=h.tp3??h.target;
  if(h.direction==="LONG"&&price>=tp3)return{state:"STALE" as AlertState,reason:"Final target reached — original alert has completed"};
  if(h.direction==="SHORT"&&price<=tp3)return{state:"STALE" as AlertState,reason:"Final target reached — original alert has completed"};
  const drift=Math.abs((price-h.entry)/h.entry),limit=h.type==="ADD"?0.04:0.06;
  if(drift>limit)return{state:"STALE" as AlertState,reason:`Price is ${((drift)*100).toFixed(1)}% from alert entry`};
  return{state:"VALID" as AlertState,reason:"Alert remains actionable"};
}

function momentumStatus(h:any,m:any){
  if(!h||!m)return null;
  const long=h.direction==="LONG";
  const e=m.fourH513;
  const aligned513=e?.direction===(long?"BULLISH":"BEARISH");
  const against513=e?.direction===(long?"BEARISH":"BULLISH");
  const ema8=Number(m.ema8_4h),ema21=Number(m.ema21_4h);
  const same821=Number.isFinite(ema8)&&Number.isFinite(ema21)&&(long?ema8>=ema21:ema8<=ema21);
  const contracting=!!e?.spreadContracting;
  const macd=m.macd4h||{};
  const macdAgainst=long?!!macd.bearishCross:!!macd.bullishCross;
  const histWeakening=long?!!macd.falling:!!macd.rising;
  const stochExtreme=long?Number(m.stochK)>=80:Number(m.stochK)<=20;
  const stochCooling=long?Number(m.stochK)<Number(m.stochD):Number(m.stochK)>Number(m.stochD);
  // ENTRY_1 shorts are deliberately captured before the 4H bearish cross.
  // While 5/13 and 8/21 are still bullish/above, a contracting spread plus
  // bearish MACD deterioration is the intended V28 transition — not a break.
  if(!long&&h.type==="ENTRY_1"&&against513&&!same821&&contracting&&!macdAgainst&&!!macd.bearishShift){
    return{icon:"🟢",label:"WAVE ACTIVE",detail:"Early short setup remains active; no confirmed reversal."};
  }
  // BROKEN requires multiple independent failures, not a single Stoch turn.
  if(against513&&!same821)return{icon:"🔴",label:"WAVE REVERSAL",detail:"4H 5/13 and 8/21 have both turned against the position."};
  if((against513||!same821)&&(macdAgainst||contracting))return{icon:"🟠",label:"WAVE UNDER PRESSURE",detail:"Momentum is under pressure, but this is not a confirmed reversal."};
  if(aligned513&&same821&&(contracting||macdAgainst||((stochExtreme||stochCooling)&&histWeakening)))return{icon:"🟡",label:"WAVE COOLING",detail:"Momentum is easing, but the bullish/bearish wave remains intact."};
  return{icon:"🟢",label:"WAVE ACTIVE",detail:"The move remains valid with no confirmed reversal."};
}

function managementAdvice(h:any,m:any){
  if(!h||h.status!=="ACTIVE"||!m||h.type==="ENTRY_0")return null;
  const price=Number(m.price),tp1Hit=!!h.tp1HitAt||(h.tp1!==undefined&&(h.direction==="LONG"?price>=h.tp1:price<=h.tp1)),tp2Hit=!!h.tp2HitAt||(h.tp2!==undefined&&(h.direction==="LONG"?price>=h.tp2:price<=h.tp2));
  const e=m.fourH513;if(!e)return{status:"healthy",recommendation:"HOLD — SL UNCHANGED",reason:"Trade remains active. Do not raise the stop before R1; the next management point is R1, then move SL to breakeven."};
  const long=h.direction==="LONG",same513=e.direction===(long?"BULLISH":"BEARISH"),against513=e.direction===(long?"BEARISH":"BULLISH"),entry513Direction=h.context?.fourH513?.direction||h.fourH513Direction||h.fourH513?.direction,fourHWasAlreadyAgainstAtEntry=entry513Direction!==undefined&&entry513Direction!==(long?"BULLISH":"BEARISH"),contracting=!!e.spreadContracting,momentum=m.momentumState||"NEUTRAL",ema8=Number(m.ema8_4h),ema21=Number(m.ema21_4h),same821=Number.isFinite(ema8)&&Number.isFinite(ema21)&&(long?ema8>=ema21:ema8<=ema21),exhausted=long?(m.stochK>=80&&m.stochK<m.stochD):(m.stochK<=20&&m.stochK>m.stochD),weakMomentum=momentum==="PULLBACK"||momentum==="HOT"||momentum==="OVEREXTENDED";
  if(tp2Hit){if(same513&&same821&&!contracting&&!exhausted&&momentum!=="OVEREXTENDED")return{status:"healthy",recommendation:"R2 RUNNER POSSIBLE",reason:"R1.5 reached. 4H 5/13 remains aligned and 8/21 confirms the move — keep the R2 runner unless momentum deteriorates."};return{status:"warning",recommendation:"R1.5 IS THE LIKELY FINAL TARGET",reason:"R1.5 reached. The remaining position should be protected; do not assume R2."};}
  if(tp1Hit){if(against513&&!fourHWasAlreadyAgainstAtEntry)return{status:"failed",recommendation:"PROTECT PROFIT",reason:"R1 reached and 4H 5/13 has turned against the position. Move SL to breakeven if not already done and protect the remaining profit."};if(contracting||exhausted||weakMomentum||!same821)return{status:"warning",recommendation:"SL TO BREAKEVEN · R1.5 LIKELY FINAL",reason:`R1 reached. Move SL to breakeven. Momentum is weakening${contracting?" (5/13 spread contracting)":""}${weakMomentum?` (${momentum})`:""}${exhausted?" (Stoch exhaustion)":""}${!same821?" (8/21 not aligned)":""}. Do not assume R2.`};return{status:"healthy",recommendation:"SL TO BREAKEVEN · HOLD FOR R1.5",reason:"R1 reached. Move SL to breakeven. 4H 5/13 and 8/21 remain aligned, so R1.5 remains the next management target."};}
  if(against513&&!fourHWasAlreadyAgainstAtEntry)return{status:"failed",recommendation:"TRADE VALIDITY WARNING · PROTECT",reason:"4H 5/13 has turned against the position after entry. The alert may still be above/below its original SL, but the move is deteriorating. Do not widen the SL; reassess manually."};
  if(against513&&fourHWasAlreadyAgainstAtEntry)return{status:"warning",recommendation:"HOLD — 4H RECOVERY NEEDED",reason:`4H 5/13 is still ${long?"bearish":"bullish"}, as it was at entry. This is an early V28 position; do not widen the SL. Watch for ${long?"bullish":"bearish"} 4H recovery.`};
  if(contracting||exhausted||weakMomentum||!same821)return{status:"warning",recommendation:"HOLD — SL UNCHANGED · WATCH R1", reason:`Trade remains active. ${contracting?"Wave cooling":weakMomentum?"Normal pullback":exhausted?"Move is extended":!same821?"8/21 is no longer fully aligned":"Wave is active"} — no confirmed reversal. Next management point: R1 → SL to breakeven.`};
  return{status:"healthy",recommendation:"HOLD — SL UNCHANGED · TARGET R1",reason:"Wave is active and the trade remains valid. Keep the original SL. At R1, move SL to breakeven; R1.5 is next, then R2 runner if the wave remains active."};
}

export async function GET(){
  const activeSignals=await getActiveSignals(),signalHistory=await getSignalHistory(),persistedLatest=await getLatestAlerts(),marketData=await getMarketData(),lastCronRun=await getLastCronRun(),now=Date.now();
  const activeByPair=Object.fromEntries(activeSignals.map((s:any)=>[s.pair,s]));
  const v28LatestAlerts=Object.fromEntries(Object.entries(persistedLatest).map(([pair,h]:any)=>{const m=Array.isArray(marketData)?marketData.find((x:any)=>x?.pair===pair):undefined;const active=activeByPair[pair];const price=m?.price??h.entry;const v=alertValidity(h,price,now,!!active);const management=active?managementAdvice(active,m):null;const validity=management&&v.state==="VALID"?{...v,reason:`${management.recommendation} — ${management.reason}`}:v;return[pair,{...h,target:h.tp2??h.target,managementAdvice:management,momentumStatus:active?momentumStatus(active,m):null,currentPrice:price,ageMinutes:Math.round((now-h.timestamp)/60000),validity}];}));
  const latestAlerts=v28LatestAlerts;
  const liveMarketData=(Array.isArray(marketData)?marketData:[]).map((m:any)=>{const a:any=activeByPair[m.pair];if(!a||a.status!=="ACTIVE")return m;return{...m,price:a.currentPrice??m.price,location:a.context?.marketPhase||m.location,trigger:a.trigger||m.trigger,alertState:a.validity?.state||"VALID",alertType:a.type,alertDirection:a.direction,alertEntry:a.entry,alertTimestamp:a.timestamp};});
  const enrichedActive=activeSignals.map((s:any)=>{const m=Array.isArray(marketData)?marketData.find((x:any)=>x?.pair===s.pair):undefined;const price=m?.price??s.entry;return{...s,scale:s.type,target:s.tp2??s.target,expectedMove:s.entry&&s.tp3?Math.round(Math.abs(s.tp3-s.entry)/s.entry*1000)/10:0,currentPrice:price,ageMinutes:Math.round((now-s.timestamp)/60000),validity:alertValidity(s,price,now,true),managementAdvice:managementAdvice(s,m),momentumStatus:momentumStatus(s,m),meta:{status:s.status,ageMinutes:Math.round((now-s.timestamp)/60000),actionable:s.status==="ACTIVE",state:"POSITION_ACTIVE"}};});
  const enrichedHistory=signalHistory.map((h:any)=>({...h,scale:h.type,target:h.tp2??h.target,meta:{ageMinutes:Math.round((now-h.timestamp)/60000),status:h.status}}));
  const historyLogs=signalHistory.slice().sort((a,b)=>b.timestamp-a.timestamp).slice(0,8).map((h:any)=>`[ALERT] ${h.pair} — ${h.direction} ${h.type} @ ${h.entry} | SL ${h.stop} | R1 ${h.tp1??"—"} | R1.5 ${h.tp2??h.target} | R2 ${h.tp3??"—"} | ${h.status}`);
  const validityLogs=Object.entries(latestAlerts).map(([pair,a]:any)=>`[VALIDITY] ${pair} — ${a.validity.state} | ${a.validity.reason}`);
  const marketLogs=liveMarketData.map((m:any)=>`[PAIR] ${m.pair} — ${m.trend||"NO TREND"} | Price ${m.price} | ${m.location||"—"} | ${m.trigger||"WAITING"} | ADX ${m.adx??"—"} | RSI ${m.rsi??"—"} | Stoch ${m.stochK??"—"}/${m.stochD??"—"} | Momentum ${m.momentumState||"—"}`);
  const managementLogs=Object.entries(latestAlerts).filter(([,a]:any)=>a.managementAdvice).map(([pair,a]:any)=>`[MANAGEMENT] ${pair} — ${a.direction} | ${a.momentumStatus?.icon||""} ${a.momentumStatus?.label||""} | ${a.managementAdvice.recommendation}`);
  const logs=[`[SYSTEM] CXSwitch v${CXSWITCH_VERSION} | ${ENTRY_ARCHITECTURE} | ${DAILY_BIAS} | ${EXECUTION_MODE}`,`[CRON] Last run ${lastCronRun?new Date(lastCronRun).toISOString():"not recorded"}`,...managementLogs,...validityLogs,...marketLogs,...historyLogs,`[CRON] State: active=${enrichedActive.length} marketData=${liveMarketData.length} history=${signalHistory.length} latest=${Object.keys(latestAlerts).length}`].slice(0,40);
  const response=NextResponse.json({version:CXSWITCH_VERSION,architecture:ENTRY_ARCHITECTURE,dailyBias:DAILY_BIAS,executionMode:EXECUTION_MODE,activeSignals:enrichedActive,signalHistory:enrichedHistory,marketData:liveMarketData,latestAlerts,logs,system:{version:CXSWITCH_VERSION,lastCronRun,lastCronAgeMs:lastCronRun?now-lastCronRun:null,activePositions:enrichedActive.length,latestAlerts:Object.keys(latestAlerts).length,historyEntries:signalHistory.length},updatedAt:new Date(now).toISOString()});
  response.headers.set("Cache-Control","no-store, no-cache, must-revalidate, proxy-revalidate");response.headers.set("Pragma","no-cache");response.headers.set("Expires","0");return response;
}