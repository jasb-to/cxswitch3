// app/api/cron/route.ts — canonical CXSwitch execution loop
import { NextResponse } from "next/server";
import { getCandles, krakenPairFormat } from "@/lib/kraken";
import { generateSignal, getMarketSnapshot, shouldHold } from "@/lib/strategy";
import type { Signal } from "@/lib/strategy";
import { get4HEmaDiagnostic } from "@/lib/ema-diagnostic";
import { CXSWITCH_VERSION } from "@/lib/version";
import { getActiveSignals, setActiveSignals, addActiveSignal, getSignalHistory, appendSignalHistory, updateSignalHistoryStatus, updateHistoryMilestones, setMarketData, getLastCronRun, setLastCronRun, getCooldowns, getExitAlertCooldowns, setExitAlertCooldowns, getCardResets, claimTelegramAlert, releaseTelegramAlert, runPersistenceCleanup, getLastBreakout, setLastBreakout, clearLastBreakout } from "@/lib/state";
import { sendAlert, sendManagementAlert } from "@/lib/telegram";
import { narratePairState, runJarvis, reviewFiredSignal } from "@/lib/jarvis";
import { createSerialQueue } from "@/lib/serial-queue";

export const dynamic="force-dynamic";
export const revalidate=0;
// Give transient market-data/API latency room without relying on the platform default.
// Kraken OHLC can require a retry across two bounded batches; allow transient upstream latency.
export const maxDuration=60;
const PAIRS=["BTC","ETH","SOL","HYPE","DOGE","LINK","VIRTUAL","ZEC"] as const;
// All Kraken-backed pairs are live. JARVIS observes and interprets; it never gates alerts.
const PAUSED_ALERT_PAIRS=new Set<string>();
const MIN_CRON_INTERVAL_MS=2*60*1000;
// Serialize active-list read/modify/write operations within this runtime instance.
const serializeActiveStateWrite=createSerialQueue();
const SIGNAL_DEDUP_MS=45*60*1000;
const SIGNAL_DEDUP_ENTRY_PCT=0.004;
const VERBOSE_CRON_LOGS=process.env.CRON_VERBOSE_LOGS==="true";
const round=(n:number)=>n>=10000?Math.round(n):n>=1000?Math.round(n*10)/10:n>=100?Math.round(n*100)/100:Math.round(n*1000)/1000;

// Compact 4H market-structure context for every asset in each cron run.
// Pivots use the same confirmed two-candle swing shape as the strategy; Fib
// retracements use the high/low of the last 50 closed 4H candles.
function marketStructureLog(pair:string,candles:any[],price:number):string {
  const c=candles.slice(0,-1).filter(x=>Number.isFinite(x.high)&&Number.isFinite(x.low));
  if(c.length<10||!Number.isFinite(price)||price<=0)return `[STRUCTURE] ${pair} | insufficient 4H candles`;
  const swings:{price:number;index:number;kind:"H"|"L"}[]=[];
  for(let i=2;i<c.length-2;i++){
    if(c[i].high>c[i-1].high&&c[i].high>c[i-2].high&&c[i].high>c[i+1].high&&c[i].high>c[i+2].high)swings.push({price:c[i].high,index:i,kind:"H"});
    if(c[i].low<c[i-1].low&&c[i].low<c[i-2].low&&c[i].low<c[i+1].low&&c[i].low<c[i+2].low)swings.push({price:c[i].low,index:i,kind:"L"});
  }
  const supports=swings.filter(x=>x.kind==="L"&&x.price<price).sort((a,b)=>b.price-a.price);
  const resistances=swings.filter(x=>x.kind==="H"&&x.price>price).sort((a,b)=>a.price-b.price);
  const fmt=(level:number|undefined)=>level===undefined?"—":`${round(level)} (${round(Math.abs(price-level)/price*100)}%)`;
  const window=c.slice(-50);
  const hi=Math.max(...window.map(x=>x.high)),lo=Math.min(...window.map(x=>x.low)),range=hi-lo;
  if(!Number.isFinite(range)||range<=0)return `[STRUCTURE] ${pair} @ ${round(price)} | Pivot S ${fmt(supports[0]?.price)} / R ${fmt(resistances[0]?.price)} | Fib unavailable`;
  const fibs=[{label:"38.2",price:hi-range*0.382},{label:"50",price:hi-range*0.5},{label:"61.8",price:hi-range*0.618}]
    .map(x=>({...x,distance:Math.abs(price-x.price)/price*100}))
    .sort((a,b)=>a.distance-b.distance);
  const nearestFib=fibs.slice(0,2).map(x=>`${x.label}%=${round(x.price)} (${round(x.distance)}%)`).join(", ");
  return `[STRUCTURE] ${pair} @ ${round(price)} | Pivot S ${fmt(supports[0]?.price)} / R ${fmt(resistances[0]?.price)} | Fib50-bar range ${round(lo)}–${round(hi)} nearest ${nearestFib}`;
}
function sameRecentSignal(history:any[],s:Signal,now:number){return history.some(h=>h.pair===s.pair&&h.direction===s.direction&&h.type===s.type&&h.exitReason!=="manual_symbol_reset"&&now-h.timestamp<SIGNAL_DEDUP_MS&&Math.abs((h.entry-s.entry)/s.entry)<SIGNAL_DEDUP_ENTRY_PCT);}
function telegramAlertKey(signal:Signal,resetAt?:number):string{
  const resetSuffix=resetAt?`:reset:${resetAt}`:"";
  return `${signal.pair}:${signal.direction}:${signal.type}:${signal.id}${resetSuffix}`;
}

const INDICATOR_EXIT_REASONS=new Set(["4h_ema_reversal_confirmed","1d_ema_reversal_confirmed","4h_rsi_extreme_opposite","chandelier_trailing_stop"]);
async function persistExitCooldown(pair:string,reason:string){if(!INDICATOR_EXIT_REASONS.has(reason))return;const cooldowns=await getExitAlertCooldowns();cooldowns[pair]=Date.now();await setExitAlertCooldowns(cooldowns);}
function toSignalLike(t:any):Signal{return{...t,adx:t.adx??0,rsi:t.rsi??0,stochK:t.stochK??0,stochD:t.stochD??0,expectedMove:t.expectedMove??0,reason:t.reason||""} as Signal;}

async function observeAlertManagement(active:any[],marketData:any[]){
  for(const alert of active){
    try {
    const market=marketData.find((item:any)=>item?.pair===alert.pair);
    const candles=Array.isArray(market?.momentumCandles4h)?market.momentumCandles4h:[];
    const price=Number(market?.currentPrice??market?.price);
    if(!candles.length||!Number.isFinite(price)||price<=0)continue;
    await updateHistoryMilestones(alert.id,price);
    const cooldowns=await getExitAlertCooldowns();
    const hold=shouldHold(toSignalLike(alert),candles,price,Date.now(),cooldowns[alert.pair]);
    if(!hold.shouldHold)await persistExitCooldown(alert.pair,hold.reason);
    if(hold.reason==="chandelier_stop"&&hold.newStop!==undefined){
      const improves=alert.direction==="LONG"?hold.newStop>Number(alert.stop):hold.newStop<Number(alert.stop);
      if(!improves)continue;
      const key=`management:${alert.id}:trail:${round(Number(hold.newStop))}`;
      if(await claimTelegramAlert(key)){
        await sendManagementAlert({pair:alert.pair,direction:alert.direction,kind:"TRAIL",stop:Number(hold.newStop)});
        console.log(`[MANAGEMENT ALERT] CX — ${alert.pair} ${alert.direction}. Trail stop raised to ${round(Number(hold.newStop))}.`);
      }
    }else if(!hold.shouldHold&&INDICATOR_EXIT_REASONS.has(hold.reason)){
      const kind=hold.reason==="1d_ema_reversal_confirmed"?"1D_REVERSAL":hold.reason==="4h_rsi_extreme_opposite"?"RSI_EXTREME":hold.reason==="chandelier_trailing_stop"?"TRAIL_EXIT":"4H_REVERSAL";
      const key=`management:${alert.id}:exit:${hold.reason}`;
      if(await claimTelegramAlert(key)){
        await sendManagementAlert({pair:alert.pair,direction:alert.direction,kind});
        console.log(`[MANAGEMENT ALERT] CX — ${alert.pair} ${alert.direction}. ${hold.reason} confirmed. EXIT TRADE.`);
      }
    }
    } catch(error) {
      console.error(`[MANAGEMENT] ${alert.pair} ${alert.direction} failed; continuing other positions`,error);
    }
  }
}

async function reconcileAlertOutcomes(initialActive:any[], marketData:any[], alerts:any[]){
  let active=[...initialActive];
  for(const alert of [...active]){
    try {
    const market=marketData.find((item:any)=>item?.pair===alert.pair);
    const price=Number(market?.currentPrice??market?.price);
    if(!Number.isFinite(price)||price<=0)continue;
    await updateHistoryMilestones(alert.id,price);
    const stop=Number(alert.stop);
    const target=Number(alert.tp2??alert.target);
    const stopHit=Number.isFinite(stop)&&stop>0&&(alert.direction==="LONG"?price<=stop:price>=stop);
    const targetHit=Number.isFinite(target)&&target>0&&(alert.direction==="LONG"?price>=target:price<=target);
    if(stopHit){
      await updateSignalHistoryStatus(alert.id,"SL_HIT","stop_hit",price);
      active=active.filter((item:any)=>item.id!==alert.id);
      alerts.push({pair:alert.pair,status:"sl_hit",price,level:stop});
      console.log(`[ALERT STATE] ${alert.pair} ${alert.direction} — SL_HIT @ ${price} (SL ${stop})`);
    }else if(targetHit){
      await updateSignalHistoryStatus(alert.id,"TP_HIT","tp2_hit",price);
      active=active.filter((item:any)=>item.id!==alert.id);
      alerts.push({pair:alert.pair,status:"tp_hit",price,level:target});
      console.log(`[ALERT STATE] ${alert.pair} ${alert.direction} — TP_HIT @ ${price} (TP2 ${target})`);
    }
    } catch(error) {
      console.error(`[RECONCILE] ${alert.pair} ${alert.direction} failed; retaining position for next run`,error);
      alerts.push({pair:alert.pair,status:"reconcile_failed",reason:String(error)});
    }
  }
  await setActiveSignals(active);
  return active;
}

export async function GET(request:Request){
 const started=Date.now(),url=new URL(request.url),secret=url.searchParams.get("secret"),auth=request.headers.get("authorization");
 if(secret!==process.env.CRON_SECRET&&auth!==`Bearer ${process.env.CRON_SECRET}`)return NextResponse.json({error:"Unauthorized"},{status:401});
 console.log(`[CRON v${CXSWITCH_VERSION}] Request accepted at ${new Date(started).toISOString()}`);
 const guardStarted=Date.now();
 console.log("[PERF] startup getLastCronRun started");
 const last=await getLastCronRun();
 console.log(`[PERF] startup getLastCronRun completed in ${Date.now()-guardStarted}ms`);
 if(started-last<MIN_CRON_INTERVAL_MS){console.log(`[CRON v${CXSWITCH_VERSION}] Guard: run skipped; previous run ${Math.round((started-last)/1000)}s ago`);return NextResponse.json({success:true,skipped:true,reason:"concurrency_guard"});}
 const lockStarted=Date.now();
 console.log("[PERF] startup setLastCronRun started");
 await setLastCronRun(started);
 console.log(`[PERF] startup setLastCronRun completed in ${Date.now()-lockStarted}ms`);
 // Retention cleanup is intentionally excluded from the trading path. It is
 // non-critical housekeeping and must never delay signal/position management.
 console.log("========================================");console.log(`[CRON v${CXSWITCH_VERSION}] Started at ${new Date(started).toISOString()}`);
 const activeReadStarted=Date.now();
 console.log("[PERF] startup getActiveSignals started");
 let active=await getActiveSignals();
 console.log(`[PERF] startup getActiveSignals completed in ${Date.now()-activeReadStarted}ms`);
 // Reconcile the persistent position store against ACTIVE history before any
 // management runs. This recovers a live position if the active-state key was
 // lost/reset while its corresponding history entry remained ACTIVE.
 const historyReadStarted=Date.now();
 console.log("[PERF] startup getSignalHistory started");
 const historyAtStart=await getSignalHistory();
 console.log(`[PERF] startup getSignalHistory completed in ${Date.now()-historyReadStarted}ms`);
 const activeKeys=new Set(active.map((x:any)=>`${x.pair}|${x.direction}`));
 const recoverable=historyAtStart
   .filter((h:any)=>h.status==="ACTIVE"&&(h.type==="ENTRY_1"||h.type==="ENTRY_2")&&Number.isFinite(Number(h.tp1))&&Number.isFinite(Number(h.tp2))&&!activeKeys.has(`${h.pair}|${h.direction}`))
   .reduce((map:any,h:any)=>{
     const key=`${h.pair}|${h.direction}`;
     if(!map.has(key)||h.timestamp>map.get(key).timestamp)map.set(key,h);
     return map;
   },new Map<string,any>());
 if(recoverable.size){   for(const h of recoverable.values()){
     active.push({...h,status:"ACTIVE",scale:h.type,});
     console.log(`[STATE] Recovered ACTIVE position from history: ${h.pair}_${h.direction}_${h.type}`);
   }
   await setActiveSignals(active);
 }
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
 let marketData:any[]=[],alerts:any[]=[],newSignals:Signal[]=[];


 await Promise.all(PAIRS.map(async (pair)=>{const pairStarted=Date.now();let stateMarket:any=undefined;let stateCandles4h:any[]=[];let stateCandles15m:any[]=[];let stateSignal:Signal|undefined=undefined;let dispatchPairSignal:Signal|undefined=undefined;let dispatchStage="signal_evaluation";let stateAddAttempted=false;try{
  const [c1,c4,c15]=await Promise.all([
    getCandles(krakenPairFormat(pair+"/USD"),60),
    getCandles(krakenPairFormat(pair+"/USD"),240),
    getCandles(krakenPairFormat(pair+"/USD"),15)
  ]);stateCandles4h=c4||[];stateCandles15m=c15||[];
  if(!c1?.length||!c4?.length||!c15?.length){console.log(`[PAIR] ${pair} — SKIP insufficient candles`);alerts.push({pair,status:"skip",reason:"insufficient_candles"});return;}
  const ema513=get4HEmaDiagnostic(c4);

  const price=c1.at(-1)!.close;
  console.log(marketStructureLog(pair,c4,price));
  const existing=active.find(x=>x.pair===pair);
  const historyForEntry=historyAtStart;
  const entry1State=historyForEntry.filter((h:any)=>h.pair===pair&&h.type==="ENTRY_1"&&h.status==="ACTIVE").sort((a:any,b:any)=>b.timestamp-a.timestamp)[0];
  const entry2AlreadyFired=!!entry1State&&historyForEntry.some((h:any)=>h.pair===pair&&h.direction===entry1State.direction&&h.type==="ENTRY_2"&&h.timestamp>entry1State.timestamp);
  const result=generateSignal(pair,c1,c4,c15,price,undefined,undefined,entry1State,entry2AlreadyFired,active.map((x:any)=>({pair:x.pair,direction:x.direction})));
  const snapshot:any=result.market||getMarketSnapshot(pair,c1,c4,c15);snapshot.currentPrice=price;snapshot.momentumCandles4h=c4.slice(-220);stateMarket=snapshot;
  // Preserve the strategy's canonical 4H EMA(8/21) values; do not overwrite them with
  // non-existent legacy snapshot keys before deriving the coarse 4H direction.
  snapshot.fourH513=ema513;
  const canonicalDailyDirection=String(snapshot.dailyDirection||"NEUTRAL");
  // Keep dashboard and Jarvis daily bias identical to the canonical regime calculated by strategy.ts.  snapshot.dailyDirection=canonicalDailyDirection;
  snapshot.fourHDirection=snapshot.ema8_4h>snapshot.ema21_4h?"BULL":snapshot.ema8_4h<snapshot.ema21_4h?"BEAR":"NEUTRAL";
  snapshot.dailyLive={state:canonicalDailyDirection,candidateState:canonicalDailyDirection,direction:canonicalDailyDirection==="BULL"?"LONG":canonicalDailyDirection==="BEAR"?"SHORT":"NEUTRAL"};
  const dbg=result.debug||[];
  const activeSuppression=dbg.find((x:string)=>x.startsWith("[SUPPRESSED]")&&x.includes("active_position_exists"));
  if(activeSuppression)console.log(`[PAIR] ${pair} ${activeSuppression}`);
  const regimeDebug=dbg.find(x=>x.startsWith("[REGIME]"));
  if(regimeDebug)console.log(`[PAIR] ${pair} — ${regimeDebug}`);
  const triggerDebug=dbg.find(x=>x.startsWith("[TRIGGER]"));
  if(triggerDebug)console.log(`[PAIR] ${pair} — ${triggerDebug}`);
  const gateDebug=dbg.find(x=>x.startsWith("[GATES]"));
  if(gateDebug)console.log(`[GATES] ${pair} — ${gateDebug.slice(8)}`);
  if(VERBOSE_CRON_LOGS)dbg.filter(x=>x.startsWith("[SWINGS]")||x.startsWith("[TL]")||x.startsWith("[TL POINTS]")).forEach(x=>console.log(x));
  if(VERBOSE_CRON_LOGS)dbg.forEach(x=>console.log(`[PAIR] ${pair} — ${x}`));
  marketData.push(snapshot);
  const signal=result.signal;
  dispatchPairSignal=signal;
  if(signal){snapshot.strategyStatus=`FIRED — ${signal.type} ${signal.direction}`;console.log(`[SIGNAL DECISION] ${pair} status=fired type=${signal.type} direction=${signal.direction} id=${signal.id}`);}
  else {const blocked=dbg.find((x:string)=>x.startsWith("[SIGNAL BLOCKED]"))||dbg.find((x:string)=>x.startsWith("[WAIT]"))||gateDebug;snapshot.strategyStatus=blocked?`WAIT — ${blocked.replace(/^\[[^\]]+\]\s*/, "")}`:"WAIT — no Signal object returned";console.log(`[SIGNAL DECISION] ${pair} status=not_fired reason=${snapshot.strategyStatus}`);console.log(`[ALERT DISPATCH] pair=${pair} direction=${snapshot.alignedDirection||"NONE"} status=suppressed reason=no_signal_object`);console.log(`[STATE ADD] pair=${pair} status=skipped reason=no_signal_object`);}
  if(!signal){
    if(!existing){
      const normalizeSide=(value:any):"LONG"|"SHORT"|null=>{const side=String(value??"").toUpperCase();return side==="BULL"||side==="BULLISH"||side==="LONG"?"LONG":side==="BEAR"||side==="BEARISH"||side==="SHORT"?"SHORT":null;};
      const dailySide=normalizeSide(snapshot.dailyDirection);
      // Direction is regime-only; 4H EMA5/13 is diagnostic context, not an entry gate.
      const conflict=snapshot.regime==="CHOP"||!dailySide;
      let waitReason=snapshot.regime==="CHOP"?"regime CHOP":conflict?"daily regime unavailable":"setup incomplete";
      if(!conflict&&gateDebug){
        try{
          const gateState=JSON.parse(gateDebug.slice(8));
          const missing=Array.isArray(gateState.missing)?gateState.missing.filter((x:string)=>x!=="direction"):[];
          if(missing.length)waitReason=`need ${missing.join(", ")}`;
        }catch{}
      }
      console.log(`[PAIR] ${pair} | REGIME=${snapshot.regime||"—"} 1D close=${round(Number(snapshot.dailyClose)||0)} EMA21=${round(Number(snapshot.dailyE21)||0)} EMA5/13=${round(Number(snapshot.ema5_1d)||0)}/${round(Number(snapshot.ema13_1d)||0)} | 4H EMA5/13=${round(Number(snapshot.ema5_4h)||0)}/${round(Number(snapshot.ema13_4h)||0)} ${snapshot.fourHTacticalDirection||"—"} | aligned=${snapshot.alignedDirection||"NO"} | ${snapshot.strategyStatus||"WAIT — "+waitReason}`);
    }
    return;
  }
  console.log(`[SIGNAL] ${pair} — ${signal.type} ${signal.direction} @ ${signal.entry} | SL ${signal.stop} | TP ${signal.tp2} | RR ${signal.rr}`);
  const entry2Continuation=!!existing&&existing.type==="ENTRY_1"&&signal.type==="ENTRY_2"&&existing.direction===signal.direction;
  if(existing&&!entry2Continuation){console.log(`[PAIR] ${pair} — ${signal.type} suppressed because position is already active`);console.log(`[ALERT DISPATCH] pair=${pair} direction=${signal.direction} status=suppressed reason=active_position_exists`);console.log(`[STATE ADD] pair=${pair} status=skipped reason=active_position_exists`);return;}
  const history=historyAtStart;
  if(PAUSED_ALERT_PAIRS.has(pair)){console.log(`[PAIR] ${pair} — ${signal.type} paused; signal suppressed`);console.log(`[ALERT DISPATCH] pair=${pair} direction=${signal.direction} status=suppressed reason=pair_paused`);console.log(`[STATE ADD] pair=${pair} status=skipped reason=pair_paused`);alerts.push({pair,direction:signal.direction,type:signal.type,status:"paused"});return;}
  if(sameRecentSignal(history,signal,Date.now())){console.log(`[PAIR] ${pair} — ${signal.type} deduped: same entry condition was alerted recently`);console.log(`[ALERT DISPATCH] pair=${pair} direction=${signal.direction} status=suppressed reason=recent_signal_dedupe`);console.log(`[STATE ADD] pair=${pair} status=skipped reason=recent_signal_dedupe`);return;}
  dispatchStage="cooldown_check";
  const cooldowns=await getCooldowns(),cd=cooldowns[`${pair}_${signal.direction}`];
  if(cd&&Date.now()<cd){console.log(`[PAIR] ${pair} — COOLDOWN until ${new Date(cd).toISOString()}`);console.log(`[ALERT DISPATCH] pair=${pair} direction=${signal.direction} status=suppressed reason=cooldown_until_${cd}`);console.log(`[STATE ADD] pair=${pair} status=skipped reason=cooldown`);return;}
  const cardResets=await getCardResets();
  const alertKey=telegramAlertKey(signal,cardResets[pair]);
  dispatchStage="claim_telegram_alert";
  const claimed=await claimTelegramAlert(alertKey);
  if(!claimed){console.log(`[PAIR] ${pair} — ${signal.type} blocked: lifecycle alert already claimed (${alertKey})`);console.log(`[ALERT DISPATCH] pair=${pair} direction=${signal.direction} status=suppressed reason=lifecycle_alert_already_claimed key=${alertKey}`);console.log(`[STATE ADD] pair=${pair} status=skipped reason=lifecycle_alert_already_claimed`);alerts.push({pair,direction:signal.direction,type:signal.type,status:"telegram_deduped_blocked"});return;}
  dispatchStage="jarvis_review";
  const jarvisReview=await reviewFiredSignal(signal,snapshot);
  if(jarvisReview?.verdict==="VETO"){
    await releaseTelegramAlert(alertKey);
    console.log(`[ALERT DISPATCH] pair=${pair} direction=${signal.direction} status=suppressed reason=jarvis_veto`);
    console.log(`[STATE ADD] pair=${pair} status=skipped reason=jarvis_veto`);
    console.log(`[JARVIS] ${pair} — ${signal.type} ${signal.direction} vetoed: ${jarvisReview.reason}`);
    alerts.push({pair,direction:signal.direction,type:signal.type,status:"jarvis_veto",reason:jarvisReview.reason});
    return;
  }
  dispatchStage="telegram_send";
  try{
    await sendAlert({symbol:signal.pair,state:"ENTRY",price:signal.entry,bias:signal.direction,stopLoss:signal.stop,takeProfit:signal.tp2,takeProfit1:signal.tp1,takeProfit2:signal.tp2,rr:signal.rr,expectedMove:signal.expectedMove,signalClass:signal.signalClass,sizeMultiplier:signal.sizeMultiplier,context:signal.context,adx:signal.adx,rsi:signal.rsi,stochK:signal.stochK,stochD:signal.stochD,reason:signal.reason,updatedAt:new Date(signal.timestamp).toISOString(),signalType:signal.type,signalEmoji:"📊",jarvis:jarvisReview});
    alerts.push({pair,direction:signal.direction,type:signal.type,status:"sent"});
    newSignals.push(signal);
    console.log(`[ALERT] ${pair} — ${signal.type} sent @ ${signal.entry} | SL ${signal.stop} | TP ${signal.tp2}`);
    console.log(`[ALERT DISPATCH] pair=${pair} direction=${signal.direction} status=sent reason=telegram_api_accepted`);
  }catch(e){await releaseTelegramAlert(alertKey);console.error(`[ALERT DISPATCH] pair=${pair} direction=${signal.direction} status=failed reason=${String(e)}`);alerts.push({pair,direction:signal.direction,type:signal.type,status:"alert_failed",reason:String(e)});throw e;}
  stateSignal=signal;
  dispatchStage="signal_history_append";
  try{await appendSignalHistory(signal);console.log(`[STATE ADD] pair=${pair} status=history_appended id=${signal.id}`);}catch(e){console.error(`[STATE ADD] pair=${pair} status=failed reason=history_append_error error=${String(e)}`);alerts.push({pair,direction:signal.direction,type:signal.type,status:"history_append_failed",reason:String(e)});}
  dispatchStage="active_state_add";stateAddAttempted=true;
  try{await serializeActiveStateWrite(async()=>{await addActiveSignal(signal);active=await getActiveSignals();console.log(`[STATE ADD] pair=${pair} status=added id=${signal.id} activeCount=${active.length}`);});}catch(e){console.error(`[STATE ADD] pair=${pair} status=failed reason=active_state_write_error error=${String(e)}`);alerts.push({pair,direction:signal.direction,type:signal.type,status:"active_state_add_failed",reason:String(e)});}
  dispatchStage="complete";
 } catch(e){
    console.error(`[PAIR] ${pair} — ERROR at stage=${dispatchStage}`,e);
    if(dispatchPairSignal){if(dispatchStage!=="telegram_send"&&dispatchStage!=="signal_history_append"&&dispatchStage!=="active_state_add"&&dispatchStage!=="complete")console.error(`[ALERT DISPATCH] pair=${pair} direction=${dispatchPairSignal.direction} status=failed reason=exception_at_${dispatchStage}: ${String(e)}`);if(!stateAddAttempted)console.error(`[STATE ADD] pair=${pair} status=skipped reason=exception_before_state_add stage=${dispatchStage}`);}
    alerts.push({pair,status:"error",stage:dispatchStage,error:String(e)});
  } finally {
    const jarvisState=narratePairState(pair,stateMarket,stateCandles4h,stateSignal,stateCandles15m);
    if(stateMarket)stateMarket.jarvisState=jarvisState;
    if(VERBOSE_CRON_LOGS)console.log(jarvisState);
    console.log(`[PERF] ${pair} processed in ${Date.now()-pairStarted}ms`);
  }
 }));
 const managementStarted=Date.now();
 console.log(`[PERF] Stage observeAlertManagement started active=${active.length}`);
 try {
   await observeAlertManagement(active,marketData);
   console.log(`[PERF] Stage observeAlertManagement completed in ${Date.now()-managementStarted}ms`);
 } catch(error) {
   console.error(`[PERF] Stage observeAlertManagement failed after ${Date.now()-managementStarted}ms`,error);
   alerts.push({status:"management_stage_failed",reason:String(error)});
 }
 const reconcileStarted=Date.now();
 console.log(`[PERF] Stage reconcileAlertOutcomes started`);
 try {
   active=await reconcileAlertOutcomes(active,marketData,alerts);
   console.log(`[PERF] Stage reconcileAlertOutcomes completed in ${Date.now()-reconcileStarted}ms`);
 } catch(error) {
   console.error(`[PERF] Stage reconcileAlertOutcomes failed after ${Date.now()-reconcileStarted}ms`,error);
   alerts.push({status:"reconcile_stage_failed",reason:String(error)});
 }
 const marketPersistStarted=Date.now();
 console.log(`[PERF] Stage setMarketData started rows=${marketData.length}`);
 try {
   await setMarketData(marketData);
   console.log(`[PERF] Stage setMarketData completed in ${Date.now()-marketPersistStarted}ms`);
 } catch(error) {
   console.error(`[PERF] Stage setMarketData failed after ${Date.now()-marketPersistStarted}ms; continuing with in-memory market data (dashboard snapshot may be stale)`,error);
   alerts.push({status:"market_data_persist_failed",reason:"dashboard_snapshot_write_failed"});
 }
 // Jarvis is advisory only; run it after position management and market persistence.
 const jarvisStarted=Date.now();
 console.log(`[PERF] Stage JARVIS started`);
 try {
   const jarvis=await runJarvis(marketData,await getActiveSignals());
   console.log(`[JARVIS] Portfolio ${jarvis.portfolioState} | ${jarvis.whatChanged}`);
   console.log(`[PERF] Stage JARVIS completed in ${Date.now()-jarvisStarted}ms`);
 } catch(error) {
   console.error(`[JARVIS] State refresh failed after ${Date.now()-jarvisStarted}ms; existing strategy continues unchanged`,error);
 }
 const finalActive=await getActiveSignals();
 const entryAlertsSent=alerts.filter((x:any)=>x.status==="sent").length;
 console.log(`[CRON v${CXSWITCH_VERSION}] Done active=${finalActive.length} marketData=${marketData.length} new=${newSignals.length} alerts=${entryAlertsSent} alertOutcomes=${alerts.length}`);
 console.log(`[PERF] Total cron duration ${Date.now()-started}ms`);
 console.log("========================================");
 return NextResponse.json({success:true,version:CXSWITCH_VERSION,activeSignals:finalActive.length,marketData:marketData.length,newSignals:newSignals.length,alerts});}