// app/api/cron/route.ts — canonical CXSwitch execution loop
import { NextResponse } from "next/server";
import { getCandles, krakenPairFormat } from "@/lib/kraken";
import { generateSignal, getMarketSnapshot, getCycleRunnerSnapshot, shouldHold, liquidationSafeStop } from "@/lib/strategy";
import type { Signal } from "@/lib/strategy";
import { get4HEmaDiagnostic } from "@/lib/ema-diagnostic";
import { CXSWITCH_VERSION } from "@/lib/version";
import { getActiveSignals, setActiveSignals, addActiveSignal, getSignalHistory, appendSignalHistory, updateSignalHistoryStatus, updateActiveTradeMilestones, updateHistoryMilestones, updateHistoryStopMilestone, setMarketData, getLastCronRun, setLastCronRun, getCooldowns, getCardResets, claimTelegramAlert, releaseTelegramAlert, getCycleRunnerState, setCycleRunnerState } from "@/lib/state";
import { getLastBreakout, setLastBreakout } from "@/lib/v28-breakout-state";
import { sendAlert } from "@/lib/telegram";
import { runJarvis, reviewFiredSignal } from "@/lib/jarvis";
import { getMarketHealth } from "@/lib/market-health";

export const dynamic="force-dynamic";
export const revalidate=0;
const PAIRS=["BTC","ETH","SOL","HYPE","DOGE","LINK","AVAX","ZEC"] as const;
// All Kraken-backed pairs are live. JARVIS observes and interprets; it never gates alerts.
const PAUSED_ALERT_PAIRS=new Set<string>();
const MIN_CRON_INTERVAL_MS=2*60*1000;
const SIGNAL_DEDUP_MS=45*60*1000;
const SIGNAL_DEDUP_ENTRY_PCT=0.004;
const VERBOSE_CRON_LOGS=process.env.CRON_VERBOSE_LOGS==="true";
const round=(n:number)=>n>=10000?Math.round(n):n>=1000?Math.round(n*10)/10:n>=100?Math.round(n*100)/100:Math.round(n*1000)/1000;
function sameRecentSignal(history:any[],s:Signal,now:number){return history.some(h=>h.pair===s.pair&&h.direction===s.direction&&h.type===s.type&&h.exitReason!=="manual_symbol_reset"&&now-h.timestamp<SIGNAL_DEDUP_MS&&Math.abs((h.entry-s.entry)/s.entry)<SIGNAL_DEDUP_ENTRY_PCT);}
function toSignalLike(t:any):Signal{return{...t,scale:t.type,adx:t.adx??0,rsi:t.rsi??0,stochK:t.stochK??0,stochD:t.stochD??0,expectedMove:t.expectedMove??0,reason:t.reason||"",trend:t.trend||t.direction,location:t.location||"",trigger:t.trigger||""} as Signal;}
function telegramAlertKey(signal:Signal,resetAt?:number):string{
  const record=signal.context?.breakoutRecord;
  if(signal.type==="ENTRY_1"||signal.type==="ENTRY_2"){
    const resetSuffix=resetAt?`:reset:${resetAt}`:"";
    if(record) return `${signal.pair}:${signal.direction}:${signal.type}:candle:${record.candleIndex}:${record.price}${resetSuffix}`;
    const candleTs=signal.context?.entry1CandleTimestamp;
    if(candleTs) return `${signal.pair}:${signal.direction}:${signal.type}:candleTs:${candleTs}${resetSuffix}`;
    return `${signal.pair}:${signal.direction}:${signal.type}:entry:${signal.entry}${resetSuffix}`;
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
 let active=await getActiveSignals();
 // PAID has been retired. Remove any legacy active PAID state so the cron can
 // never try to manage the deleted GeckoTerminal market after the migration.
 const retiredPaid=active.filter(x=>x.pair==="PAID");
 if(retiredPaid.length){
   for(const trade of retiredPaid){
     await updateSignalHistoryStatus(trade.id,"EXPIRED","manual_symbol_reset",undefined);
   }
   active=active.filter(x=>x.pair!=="PAID");
   await setActiveSignals(active);
   console.log(`[STATE] Retired PAID legacy positions=${retiredPaid.length}`);
 }
 console.log(`[STATE] Active signals on entry: ${active.map(a=>`${a.pair}_${a.direction}_${a.type}`).join(", ")||"none"}`);
 let marketData:any[]=[],alerts:any[]=[],newSignals:Signal[]=[],managementByPair:Record<string,any>={};
 for(const trade of [...active]){try{
  const c=await getCandles(krakenPairFormat(trade.pair+"/USD"),240);const price=c.at(-1)?.close;if(price===undefined){console.log(`[MANAGE] ${trade.pair} — no price`);continue;}
  // Existing positions may pre-date the 20x liquidation-safe SL fix. Bring them
  // up to the same protection before evaluating the rest of the hold logic.
  const safeStop=liquidationSafeStop(trade.entry,trade.direction);
  const unsafe=(trade.direction==="LONG"&&trade.stop<safeStop)||(trade.direction==="SHORT"&&trade.stop>safeStop);
  if(unsafe&&((trade.direction==="LONG"&&price>safeStop)||(trade.direction==="SHORT"&&price<safeStop))){
    console.log(`[RISK] ${trade.pair} ${trade.direction} — legacy SL ${trade.stop} -> liquidation-safe ${safeStop}`);
    trade.stop=safeStop;
    await updateHistoryStopMilestone(trade.id,trade.stop);
  }
  const tp1AlreadyHit=!!trade.tp1HitAt;
  // Evaluate management before persisting a newly-hit TP1 milestone so the first
  // touch can still produce the one-time 50% scale-out + breakeven instruction.
  let hold=shouldHold(toSignalLike(trade),c,price);
  const milestoneTrade=await updateActiveTradeMilestones(trade.id,price);
  if(milestoneTrade)Object.assign(trade,milestoneTrade);
  // Re-apply liquidation-safe protection after milestone hydration.
  if((trade.direction==="LONG"&&trade.stop<safeStop)||(trade.direction==="SHORT"&&trade.stop>safeStop)){
    if((trade.direction==="LONG"&&price>safeStop)||(trade.direction==="SHORT"&&price<safeStop)){
      console.log("[RISK] "+trade.pair+" "+trade.direction+" — enforcing liquidation-safe SL "+safeStop);
      trade.stop=safeStop;
      await updateHistoryStopMilestone(trade.id,trade.stop);
    }
  }
  await updateHistoryMilestones(trade.id,price);
  if(typeof hold.shouldHold!=="boolean"){
    console.error(`[MANAGE] ${trade.pair} — invalid hold result; preserving active position`);
    hold={shouldHold:true,reason:"hold_result_invalid"};
  }
  if(!hold.shouldHold&&hold.reason==="price_too_far_from_alert"){
    console.log(`[MANAGE] ${trade.pair} — alert stale; manual position remains tracked`);
    hold={shouldHold:true,reason:"active_alert_stale"};
  }
  console.log(`[MANAGE] ${trade.pair} ${trade.direction} | Entry ${trade.entry} | Price ${price} | SL ${trade.stop} | TP1 ${trade.tp1??"—"} | TP2 ${trade.tp2??"—"} | Management ${hold.managementState} | ${hold.recommendation} | ${hold.reason}`);
  if(!hold.shouldHold){await updateSignalHistoryStatus(trade.id,hold.reason==="tp2_hit"?"TP_HIT":"FAILED",hold.reason,price);active=active.filter(x=>x.id!==trade.id);alerts.push({pair:trade.pair,status:"exit",reason:hold.reason,price});console.log(`[EXIT] ${trade.pair} ${trade.direction} — ${hold.reason} @ ${price}`);continue;}
  if(hold.newStop&&hold.newStop!==trade.stop){console.log(`[MGT] ${trade.pair} — stop ${trade.stop} -> ${hold.newStop} (${hold.reason})`);trade.stop=hold.newStop;await updateHistoryStopMilestone(trade.id,trade.stop);}
  // TP1 scale-out is a one-time lifecycle event. shouldHold() remains deliberately
  // permissive for management, but must not re-emit the same 50% instruction on
  // every cron run once the TP1 milestone has already been persisted.
  if(hold.scaleOut && tp1AlreadyHit) delete hold.scaleOut;
  if(hold.scaleOut)console.log(`[MGT] ${trade.pair} — scale-out ${hold.scaleOut.label} ${hold.scaleOut.size*100}% @ ${hold.scaleOut.level}`);
  const snapshot=getMarketSnapshot(trade.pair,c,c,c);snapshot.positionState="ACTIVE";snapshot.positionDirection=trade.direction;snapshot.positionEntry=trade.entry;snapshot.positionStop=trade.stop;snapshot.positionTarget=trade.tp2??trade.target;snapshot.positionTp1=trade.tp1;snapshot.positionTp2=trade.tp2;snapshot.positionTp1HitAt=trade.tp1HitAt;snapshot.positionTp2HitAt=trade.tp2HitAt;snapshot.positionManagementState=hold.managementState;snapshot.positionManagementRecommendation=hold.recommendation;snapshot.positionManagementReason=hold.reason;snapshot.positionThesis=hold.reason;managementByPair[trade.pair]={state:hold.managementState,recommendation:hold.recommendation,reason:hold.reason};marketData.push(snapshot);
 }catch(e){console.error(`[MANAGE] ${trade.pair} ERROR`,e);}}
 await setActiveSignals(active);

 // The 1D experiment is now live context for entry timing. It still does not
 // execute trades by itself; the strategy supplies the execution-grade entry/SL/TP model.
 let marketHealth:any=null;
 try{
   marketHealth=await getMarketHealth();
   console.log(`[MARKET HEALTH] BTC.D ${marketHealth.btcDominance??"—"} (rel ${marketHealth.btcDominanceRelative24h??"—"}%) | USDT.D ${marketHealth.usdtDominance??"—"} (rel ${marketHealth.usdtDominanceRelative24h??"—"}%) | TOTAL ${marketHealth.totalMarketCapChange24h??"—"}% | ALT ${marketHealth.altContext}`);
 }catch(error){console.error("[MARKET HEALTH] refresh failed",error);}


 for(const pair of PAIRS){try{
  const c1=await getCandles(krakenPairFormat(pair+"/USD"),60);
  const c4=await getCandles(krakenPairFormat(pair+"/USD"),240);
  const c15=await getCandles(krakenPairFormat(pair+"/USD"),15);
  const cW=await getCandles(krakenPairFormat(pair+"/USD"),10080,Math.floor((Date.now()-2*365*24*60*60*1000)/1000));
  if(!c1?.length||!c4?.length||!c15?.length){console.log(`[PAIR] ${pair} — SKIP insufficient candles`);alerts.push({pair,status:"skip",reason:"insufficient_candles"});continue;}
  const ema513=get4HEmaDiagnostic(c4);
  console.log(`[EMA 4H 5/13] ${pair} — ${ema513.label} | 5=${ema513.ema5.toFixed(4)} | 13=${ema513.ema13.toFixed(4)} | spread=${ema513.spread.toFixed(4)} (${ema513.spreadPct.toFixed(3)}%) | spreadATR=${ema513.spreadAtr.toFixed(3)} | contracting=${ema513.spreadContracting?"YES":"NO"} | Δspread=${ema513.spreadChangePct.toFixed(2)}% | 5slope=${ema513.ema5Slope.toFixed(4)} | 13slope=${ema513.ema13Slope.toFixed(4)} | cross=${ema513.crossNow?"YES":"NO"}`);
  const price=c1.at(-1)!.close;
  const existing=active.find(x=>x.pair===pair);
  const result=generateSignal(pair,c1,c4,c15,[],price);
  const snapshot:any=result.market||getMarketSnapshot(pair,c1,c4,c15);
  // Persist the canonical 4H diagnostics alongside the market snapshot so the dashboard
  // copy card reads the same live values the cron just calculated.
  snapshot.ema8_4h=snapshot.ema8;
  snapshot.ema21_4h=snapshot.ema21;
  snapshot.fourH513=ema513;
  snapshot.dailyLive={state:snapshot.trend,candidateState:snapshot.trend,direction:snapshot.dailyDirection==="BULL"?"LONG":snapshot.dailyDirection==="BEAR"?"SHORT":"NEUTRAL"};
  if(pair==="BTC"||pair==="ETH")snapshot.cycleRunner=getCycleRunnerSnapshot(pair,c1,c4,cW,price);
  const dbg=result.debug||[];
  if(VERBOSE_CRON_LOGS)dbg.forEach(x=>console.log(`[PAIR] ${pair} — ${x}`));
  if(result.breakout){await setLastBreakout(pair,result.breakout);if(VERBOSE_CRON_LOGS)console.log(`[BREAKOUT STATE] ${pair} — recorded ${result.breakout.direction}@${result.breakout.price} candle=${result.breakout.candleIndex}`);}
  if(existing){
    snapshot.positionState="ACTIVE";
    snapshot.positionDirection=existing.direction;
    snapshot.positionEntry=existing.entry;
    snapshot.positionStop=existing.stop;
    snapshot.positionTarget=existing.tp2??existing.target;
    snapshot.positionTp1=existing.tp1;
    snapshot.positionTp2=existing.tp2;
    const mg=managementByPair[pair];
    if(mg){snapshot.positionManagementState=mg.state;snapshot.positionManagementRecommendation=mg.recommendation;snapshot.positionManagementReason=mg.reason;}
    snapshot.positionTp1HitAt=existing.tp1HitAt;
    snapshot.positionTp2HitAt=existing.tp2HitAt;
    console.log(`[PAIR] ${pair} | ACTIVE ${existing.direction} | entry engine paused`);
  }
  marketData.push(snapshot);
  const signal=result.signal;
  if(!signal){if(!existing)console.log(`[PAIR] ${pair} | 1D=${snapshot.dailyDirection||"—"} | 4H=${ema513.label} | WAIT`);continue;}
  console.log(`[SIGNAL] ${pair} — ${signal.type} ${signal.direction} @ ${signal.entry} | SL ${signal.stop} | TP ${signal.target} | RR ${signal.rr}`);
  if(signal.type!=="ENTRY_1"&&signal.type!=="ENTRY_2"){console.log(`[PAIR] ${pair} — unsupported signal type ${signal.type}; ignored`);continue;}
  if(existing){console.log(`[PAIR] ${pair} — ${signal.type} suppressed because position is already active`);continue;}
  const history=await getSignalHistory();
  if(PAUSED_ALERT_PAIRS.has(pair)){console.log(`[PAIR] ${pair} — ${signal.type} paused; signal suppressed`);alerts.push({pair,direction:signal.direction,type:signal.type,status:"paused"});continue;}
  if(sameRecentSignal(history,signal,Date.now())){console.log(`[PAIR] ${pair} — ${signal.type} deduped: same entry condition was alerted recently`);continue;}
  const cooldowns=await getCooldowns(),cd=cooldowns[`${pair}_${signal.direction}`];
  if(cd&&Date.now()<cd){console.log(`[PAIR] ${pair} — COOLDOWN until ${new Date(cd).toISOString()}`);continue;}
  const cardResets=await getCardResets();
  const alertKey=telegramAlertKey(signal,cardResets[pair]);
  const claimed=await claimTelegramAlert(alertKey);
  if(!claimed){console.log(`[PAIR] ${pair} — ${signal.type} blocked: lifecycle alert already claimed (${alertKey})`);alerts.push({pair,direction:signal.direction,type:signal.type,status:"telegram_deduped_blocked"});continue;}
  const jarvisReview=await reviewFiredSignal(signal,snapshot);
  if(jarvisReview?.verdict==="BAD"){
    await releaseTelegramAlert(alertKey);
    console.log(`[JARVIS] ${pair} — ${signal.type} ${signal.direction} vetoed: ${jarvisReview.summary}`);
    alerts.push({pair,direction:signal.direction,type:signal.type,status:"jarvis_veto",reason:jarvisReview.summary});
    continue;
  }
  try{
    await sendAlert({symbol:signal.pair,state:"ENTRY",price:round(signal.entry),bias:signal.direction,stopLoss:round(signal.stop),takeProfit:round(signal.target),takeProfit1:signal.tp1,takeProfit2:signal.tp2,rr:signal.rr,expectedMove:signal.expectedMove,adx:signal.adx,rsi:signal.rsi,stochK:signal.stochK,stochD:signal.stochD,reason:signal.reason,trend:signal.trend,location:signal.location,trigger:signal.trigger,updatedAt:new Date(signal.timestamp).toISOString(),signalType:signal.type,signalEmoji:signal.type==="ENTRY_1"?"🟢":"🟠",context:signal.context,jarvis:jarvisReview});
  }catch(e){await releaseTelegramAlert(alertKey);throw e;}
  await appendSignalHistory(signal);
  newSignals.push(signal);
  alerts.push({pair,direction:signal.direction,type:signal.type,status:"sent"});
  console.log(`[ALERT] ${pair} — ${signal.type} sent @ ${signal.entry} | SL ${signal.stop} | TP ${signal.target}`);
  await addActiveSignal(signal);
  active=await getActiveSignals();
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
 try{
   const jarvis=await runJarvis(marketData,await getActiveSignals());
   console.log(`[JARVIS] Portfolio ${jarvis.portfolioState} | ${jarvis.whatChanged}`);
 }catch(error){
   console.error("[JARVIS] State refresh failed; existing strategy continues unchanged",error);
 }
 const finalActive=await getActiveSignals();
 console.log(`[CRON v${CXSWITCH_VERSION}] Done active=${finalActive.length} marketData=${marketData.length} new=${newSignals.length} alerts=${alerts.length}`);
 console.log("========================================");
 return NextResponse.json({success:true,version:CXSWITCH_VERSION,activeSignals:finalActive.length,marketData:marketData.length,newSignals:newSignals.length,alerts});
}