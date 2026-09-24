// app/api/cron/route.ts — canonical CXSwitch execution loop
import { NextResponse } from "next/server";
import { getCandles, krakenPairFormat } from "@/lib/kraken";
import { generateSignal, getMarketSnapshot, getCycleRunnerSnapshot, shouldHold, liquidationSafeStop, Signal } from "@/lib/strategy";
import { get4HEmaDiagnostic } from "@/lib/ema-diagnostic";
import { detectStructureShift, recordStructureShiftSnapshot } from "@/lib/structure-shift";
import { CXSWITCH_VERSION } from "@/lib/version";
import { getActiveSignals, setActiveSignals, addActiveSignal, getSignalHistory, appendSignalHistory, updateSignalHistoryStatus, updateActiveTradeMilestones, updateHistoryMilestones, updateHistoryStopMilestone, setMarketData, getLastCronRun, setLastCronRun, getCooldowns, claimTelegramAlert, releaseTelegramAlert, getCycleRunnerState, setCycleRunnerState } from "@/lib/state";
import { getLastBreakout, setLastBreakout } from "@/lib/v28-breakout-state";
import { sendAlert } from "@/lib/telegram";
import { run1DTrendExperiment } from "@/lib/1d-trend-runner";
import { get1DTrendState } from "@/lib/1d-trend-state";

export const dynamic="force-dynamic";
export const revalidate=0;
const PAIRS=["BTC","ETH","SOL","HYPE"] as const;
const MIN_CRON_INTERVAL_MS=2*60*1000;
const ADD_DEDUP_MS=45*60*1000;
const ADD_DEDUP_ENTRY_PCT=0.004;
const API_DELAY_MS=450;
const sleep=(ms:number)=>new Promise(r=>setTimeout(r,ms));
const round=(n:number)=>n>=10000?Math.round(n):n>=1000?Math.round(n*10)/10:n>=100?Math.round(n*100)/100:Math.round(n*1000)/1000;
function sameRecentSignal(history:any[],s:Signal,now:number){return history.some(h=>h.pair===s.pair&&h.direction===s.direction&&h.type===s.type&&h.exitReason!=="manual_symbol_reset"&&now-h.timestamp<ADD_DEDUP_MS&&Math.abs((h.entry-s.entry)/s.entry)<ADD_DEDUP_ENTRY_PCT);}
function toSignalLike(t:any):Signal{return{...t,scale:t.type,adx:t.adx??0,rsi:t.rsi??0,stochK:t.stochK??0,stochD:t.stochD??0,expectedMove:t.expectedMove??0,reason:t.reason||"",trend:t.trend||t.direction,location:t.location||"",trigger:t.trigger||""} as Signal;}
function telegramAlertKey(signal:Signal):string{
  const record=signal.context?.breakoutRecord;
  if(signal.type==="ENTRY_1"||signal.type==="ENTRY_2"){
    if(record) return `${signal.pair}:${signal.direction}:${signal.type}:candle:${record.candleIndex}:${record.price}`;
    const candleTs=signal.context?.entry1CandleTimestamp;
    if(candleTs) return `${signal.pair}:${signal.direction}:${signal.type}:candleTs:${candleTs}`;
    return `${signal.pair}:${signal.direction}:${signal.type}:entry:${signal.entry}`;
  }
  return `${signal.pair}:${signal.direction}:${signal.type}:${signal.id}`;
}

export async function GET(request:Request){
 const started=Date.now(),url=new URL(request.url),secret=url.searchParams.get("secret"),auth=request.headers.get("authorization");
 if(secret!==process.env.CRON_SECRET&&auth!==`Bearer ${process.env.CRON_SECRET}`)return NextResponse.json({error:"Unauthorized"},{status:401});
 const last=await getLastCronRun();
 if(started-last<MIN_CRON_INTERVAL_MS){console.log(`[CRON v${CXSWITCH_VERSION}] Guard: run skipped; previous run ${Math.round((started-last)/1000)}s ago`);return NextResponse.json({success:true,skipped:true,reason:"concurrency_guard"});}
 await setLastCronRun(started);
 console.log("========================================");console.log(`[CRON v${CXSWITCH_VERSION}] Started at ${new Date(started).toISOString()}`);
 let active=await getActiveSignals();console.log(`[STATE] Active signals on entry: ${active.map(a=>`${a.pair}_${a.direction}_${a.type}`).join(", ")||"none"}`);
 let marketData:any[]=[],alerts:any[]=[],newSignals:Signal[]=[],managementByPair:Record<string,any>={};
 for(const trade of [...active]){try{
  const c=await getCandles(krakenPairFormat(trade.pair+"/USD"),240);await sleep(API_DELAY_MS);const price=c.at(-1)?.close;if(price===undefined){console.log(`[MANAGE] ${trade.pair} — no price`);continue;}
  // Existing positions may pre-date the 20x liquidation-safe SL fix. Bring them
  // up to the same protection before evaluating the rest of the hold logic.
  const safeStop=liquidationSafeStop(trade.entry,trade.direction);
  const unsafe=(trade.direction==="LONG"&&trade.stop<safeStop)||(trade.direction==="SHORT"&&trade.stop>safeStop);
  if(unsafe&&((trade.direction==="LONG"&&price>safeStop)||(trade.direction==="SHORT"&&price<safeStop))){
    console.log(`[RISK] ${trade.pair} ${trade.direction} — legacy SL ${trade.stop} -> liquidation-safe ${safeStop}`);
    trade.stop=safeStop;
    await updateHistoryStopMilestone(trade.id,trade.stop);
  }
  const milestoneTrade=await updateActiveTradeMilestones(trade.id,price);if(milestoneTrade)Object.assign(trade,milestoneTrade);
  // Re-apply liquidation-safe protection after milestone hydration. Older milestone
  // records can contain the legacy stop and must never overwrite the safety boundary.
  if((trade.direction==="LONG"&&trade.stop<safeStop)||(trade.direction==="SHORT"&&trade.stop>safeStop)){
    if((trade.direction==="LONG"&&price>safeStop)||(trade.direction==="SHORT"&&price<safeStop)){
      console.log("[RISK] "+trade.pair+" "+trade.direction+" — enforcing liquidation-safe SL "+safeStop);
      trade.stop=safeStop;
      await updateHistoryStopMilestone(trade.id,trade.stop);
    }
  }
  await updateHistoryMilestones(trade.id,price);
  let hold=shouldHold(toSignalLike(trade),c,price);if(typeof hold.shouldHold!=="boolean"){console.error(`[MANAGE] ${trade.pair} — invalid hold result; preserving active position`);hold={shouldHold:true,reason:"hold_result_invalid"};}if(!hold.shouldHold&&hold.reason==="price_too_far_from_alert"){console.log(`[MANAGE] ${trade.pair} — alert stale; manual position remains tracked`);hold={shouldHold:true,reason:"active_alert_stale"};}
  console.log(`[MANAGE] ${trade.pair} ${trade.direction} | Entry ${trade.entry} | Price ${price} | SL ${trade.stop} | TP1 ${trade.tp1??"—"} | TP2 ${trade.tp2??"—"} | Management ${hold.managementState} | ${hold.recommendation} | ${hold.reason}`);
  if(!hold.shouldHold){await updateSignalHistoryStatus(trade.id,hold.reason==="tp2_hit"?"TP_HIT":"FAILED",hold.reason,price);active=active.filter(x=>x.id!==trade.id);alerts.push({pair:trade.pair,status:"exit",reason:hold.reason,price});console.log(`[EXIT] ${trade.pair} ${trade.direction} — ${hold.reason} @ ${price}`);continue;}
  if(hold.newStop&&hold.newStop!==trade.stop){console.log(`[MGT] ${trade.pair} — stop ${trade.stop} -> ${hold.newStop} (${hold.reason})`);trade.stop=hold.newStop;await updateHistoryStopMilestone(trade.id,trade.stop);}
  if(hold.scaleOut)console.log(`[MGT] ${trade.pair} — scale-out ${hold.scaleOut.label} ${hold.scaleOut.size*100}% @ ${hold.scaleOut.level}`);
  const snapshot=getMarketSnapshot(trade.pair,c,c,c);snapshot.positionState="ACTIVE";snapshot.positionDirection=trade.direction;snapshot.positionEntry=trade.entry;snapshot.positionStop=trade.stop;snapshot.positionTarget=trade.tp2??trade.target;snapshot.positionTp1=trade.tp1;snapshot.positionTp2=trade.tp2;snapshot.positionTp1HitAt=trade.tp1HitAt;snapshot.positionTp2HitAt=trade.tp2HitAt;snapshot.positionManagementState=hold.managementState;snapshot.positionManagementRecommendation=hold.recommendation;snapshot.positionManagementReason=hold.reason;snapshot.positionThesis=hold.reason;managementByPair[trade.pair]={state:hold.managementState,recommendation:hold.recommendation,reason:hold.reason};marketData.push(snapshot);
 }catch(e){console.error(`[MANAGE] ${trade.pair} ERROR`,e);}}
 await setActiveSignals(active);

 // The 1D experiment is now live context for entry timing. It still does not
 // execute trades by itself; the strategy supplies the execution-grade entry/SL/TP model.
 let dailyState:any={};
 try{
   await run1DTrendExperiment(active);
   dailyState=await get1DTrendState();
   console.log(`[1D LIVE] Regime context loaded for V28: ${PAIRS.map(p=>`${p}=${dailyState[p]?.state||"—"}/${dailyState[p]?.candidateState||"—"}`).join(" | ")}`);
 }catch(error){
   console.error(`[1D LIVE] Daily regime refresh failed; the strategy will use local 4H context only`,error);
   try{dailyState=await get1DTrendState();}catch{dailyState={};}
 }

 for(const pair of PAIRS){try{
  const c1=await getCandles(krakenPairFormat(pair+"/USD"),60);await sleep(API_DELAY_MS);const c4=await getCandles(krakenPairFormat(pair+"/USD"),240);await sleep(API_DELAY_MS);const c15=await getCandles(krakenPairFormat(pair+"/USD"),15);await sleep(API_DELAY_MS);const cW=(pair==="BTC"||pair==="ETH")?await getCandles(krakenPairFormat(pair+"/USD"),10080,Math.floor((Date.now()-365*24*60*60*1000)/1000)):[];if(pair==="BTC"||pair==="ETH")await sleep(API_DELAY_MS);
  if(!c1?.length||!c4?.length||!c15?.length){console.log(`[PAIR] ${pair} — SKIP insufficient candles`);alerts.push({pair,status:"skip",reason:"insufficient_candles"});continue;}
  const ema513=get4HEmaDiagnostic(c4);
  console.log(`[EMA 4H 5/13] ${pair} — ${ema513.label} | 5=${ema513.ema5.toFixed(4)} | 13=${ema513.ema13.toFixed(4)} | spread=${ema513.spread.toFixed(4)} (${ema513.spreadPct.toFixed(3)}%) | spreadATR=${ema513.spreadAtr.toFixed(3)} | contracting=${ema513.spreadContracting?"YES":"NO"} | Δspread=${ema513.spreadChangePct.toFixed(2)}% | 5slope=${ema513.ema5Slope.toFixed(4)} | 13slope=${ema513.ema13Slope.toFixed(4)} | cross=${ema513.crossNow?"YES":"NO"}`);
  const structureShift=detectStructureShift(pair,c4);
  const structureRecorded=await recordStructureShiftSnapshot(structureShift);
  console.log(`[STRUCTURE SHIFT] ${pair} — ${structureShift.structure} ${structureShift.state} | protected=${structureShift.protectedLevel?.toFixed(4)??"—"} | break=${structureShift.breakDistanceAtr?.toFixed(2)??"—"} ATR | recorded=${structureRecorded?"YES":"NO"} | ${structureShift.reason}`);
  const price=c1.at(-1)!.close,existing=active.find(x=>x.pair===pair),lastBreakout=await getLastBreakout(pair);console.log(`[BREAKOUT STATE] ${pair} — ${lastBreakout?`${lastBreakout.direction}@${lastBreakout.price} candle=${lastBreakout.candleIndex} age=${c4.length-1-lastBreakout.candleIndex}`:"NONE"}`);const live1D=dailyState[pair]||undefined;const result=generateSignal(pair,c1,c4,c15,active,price,lastBreakout,live1D);const snapshot=result.market||getMarketSnapshot(pair,c1,c4,c15);if(pair==="BTC"||pair==="ETH")snapshot.cycleRunner=getCycleRunnerSnapshot(pair,c1,c4,cW,price);snapshot.fourH513=ema513;snapshot.structureShift=structureShift;snapshot.lastBreakout=lastBreakout||null;snapshot.dailyLive=live1D||null;
  const dbg=result.debug||[];dbg.forEach(x=>console.log(`[PAIR] ${pair} — ${x}`));
  if(existing){snapshot.positionState="ACTIVE";snapshot.positionDirection=existing.direction;snapshot.positionEntry=existing.entry;snapshot.positionStop=existing.stop;snapshot.positionTarget=existing.tp2??existing.target;snapshot.positionTp1=existing.tp1;snapshot.positionTp2=existing.tp2;const mg=managementByPair[pair];if(mg){snapshot.positionManagementState=mg.state;snapshot.positionManagementRecommendation=mg.recommendation;snapshot.positionManagementReason=mg.reason;}snapshot.positionTp1HitAt=existing.tp1HitAt;snapshot.positionTp2HitAt=existing.tp2HitAt;console.log(`[PAIR] ${pair} — POSITION ACTIVE (${existing.direction}) — entry engine paused`);}
  marketData.push(snapshot);const signal=result.signal;if(!signal){if(!existing)console.log(`[PAIR] ${pair} — NO SIGNAL`);continue;}
  console.log(`[SIGNAL] ${pair} — ${signal.type} ${signal.direction} @ ${signal.entry} | SL ${signal.stop} | TP1 ${signal.tp1??"—"} | TP2 ${signal.tp2??"—"} | RR ${signal.rr}`);
  const hasSameDirection=active.some(x=>x.pair===pair&&x.direction===signal.direction);if(signal.type==="ENTRY_1"&&hasSameDirection){console.log(`[PAIR] ${pair} — ENTRY_1 blocked: active same-direction position already exists`);continue;}if(signal.type==="ADD"&&!hasSameDirection){console.log(`[PAIR] ${pair} — ADD blocked: no active same-direction position`);continue;}if(existing&&signal.type!=="ADD"){console.log(`[PAIR] ${pair} — signal suppressed because position is already active`);continue;}
  const history=await getSignalHistory();
  if((signal.type==="ENTRY_1"||signal.type==="ENTRY_2")&&sameRecentSignal(history,signal,Date.now())){console.log(`[PAIR] ${pair} — ${signal.type} deduped: same entry condition was alerted recently; no duplicate history/position/alert`);continue;}
  if(signal.type==="ADD"&&sameRecentSignal(history,signal,Date.now())){console.log(`[PAIR] ${pair} — ADD deduped: same entry condition was alerted recently; waiting for a new retest/price`);continue;}
  const cooldowns=await getCooldowns(),cd=cooldowns[`${pair}_${signal.direction}`];if(cd&&Date.now()<cd){console.log(`[PAIR] ${pair} — COOLDOWN until ${new Date(cd).toISOString()}`);continue;}
  const alertKey=telegramAlertKey(signal);const claimed=await claimTelegramAlert(alertKey);
  // A live position is never created unless its alert was successfully claimed.
  // This prevents state from showing a trade the user was never told about.
  if(!claimed){
    console.log(`[PAIR] ${pair} — ${signal.type} blocked: lifecycle alert already claimed (${alertKey}); no history/position created`);
    alerts.push({pair,direction:signal.direction,type:signal.type,status:"telegram_deduped_blocked"});
    continue;
  }
  const emoji=signal.type==="ENTRY_1"?"🟢":signal.type==="ENTRY_2"?"🟠":"🔵";
  try{
    if(claimed) await sendAlert({symbol:signal.pair,state:signal.type==="ADD"?"ADD":"ENTRY",price:round(signal.entry),bias:signal.direction,stopLoss:round(signal.stop),takeProfit:round(signal.tp2??signal.target),takeProfit1:signal.tp1,takeProfit2:signal.tp2,rr:signal.rr,expectedMove:signal.expectedMove,adx:signal.adx,rsi:signal.rsi,stochK:signal.stochK,stochD:signal.stochD,reason:signal.reason,trend:signal.trend,location:signal.location,trigger:signal.trigger,updatedAt:new Date(signal.timestamp).toISOString(),signalType:signal.type,signalEmoji:emoji,context:signal.context,marketPhase:signal.context?.marketPhase,structure:signal.context?.structure,momentum:signal.context?.momentum,pullback:signal.context?.pullback,fourH513Label:ema513.label});
  }catch(e){await releaseTelegramAlert(alertKey);throw e;}
  if(signal.type==="ENTRY_1"&&signal.context?.breakoutRecord){await setLastBreakout(pair,signal.context.breakoutRecord);console.log(`[BREAKOUT STATE] ${pair} — recorded ${signal.context.breakoutRecord.direction}@${signal.context.breakoutRecord.price} candle=${signal.context.breakoutRecord.candleIndex}`);}
  await appendSignalHistory(signal);newSignals.push(signal);alerts.push({pair,direction:signal.direction,type:signal.type,status:"sent"});console.log(`[ALERT] ${pair} — ${signal.type} sent @ ${signal.entry} | SL ${signal.stop} | TP1 ${signal.tp1} | TP2 ${signal.tp2}`);
  if(signal.type!=="ADD"&&!existing){await addActiveSignal(signal);active=await getActiveSignals();console.log(`[STATE] ${pair} — active position created`);}
 }catch(e){console.error(`[PAIR] ${pair} — ERROR`,e);alerts.push({pair,status:"error",error:String(e)});}}
 // Dedicated BTC/ETH cycle-runner entry alert. It does not create a normal CX trade.
 const cycleState=await getCycleRunnerState();
 for(const pair of ["BTC","ETH"] as const){
   const cm=marketData.find((m:any)=>m?.pair===pair)?.cycleRunner;
   if(!cm?.ready) continue;
   const existing=cycleState[pair];
   if(existing?.status==="IN_POSITION") continue;
   const key=`CYCLE_RUNNER:${pair}:${cm.direction}:${cm.fourHFib?.nearest?.level||"zone"}`;
   const claimed=await claimTelegramAlert(key);
   if(claimed){
     try{
       await sendAlert({symbol:pair,state:"CYCLE RUNNER ENTRY",price:round(marketData.find((m:any)=>m?.pair===pair)?.price||0),bias:cm.direction,stopLoss:0,takeProfit:0,rr:0,expectedMove:0,adx:0,rsi:0,stochK:cm.oneHStoch?.k||0,stochD:cm.oneHStoch?.d||0,reason:"Weekly direction + 4H major Fib retest + 1H momentum confirmation",trend:`WEEKLY ${cm.weeklyDirection} · 4H ${cm.fourHDirection}`,location:"4H_FIB_RETEST",trigger:"1H_PRECISION_CONFIRM",updatedAt:new Date().toISOString(),signalType:"CYCLE_RUNNER",signalEmoji:"🟣",context:{cycleRunner:cm}});
     }catch(e){await releaseTelegramAlert(key);console.error("[CYCLE RUNNER] Telegram alert failed",e);}
   }
 }
 await setMarketData(marketData);
 const finalActive=await getActiveSignals();
 console.log(`[CRON v${CXSWITCH_VERSION}] Done active=${finalActive.length} marketData=${marketData.length} new=${newSignals.length} alerts=${alerts.length}`);
 console.log("========================================");
 return NextResponse.json({success:true,version:CXSWITCH_VERSION,activeSignals:finalActive.length,marketData:marketData.length,newSignals:newSignals.length,alerts});
}