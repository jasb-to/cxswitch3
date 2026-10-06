// app/api/cron/route.ts — canonical CXSwitch execution loop
import { NextResponse } from "next/server";
import { getCandles, krakenPairFormat, getFuturesPositions, isExchangeSyncConfigured, placeFuturesReduceOnlyMarketOrder, moveFuturesStopToBreakeven } from "@/lib/kraken";
import { generateSignal, getMarketSnapshot, shouldHold } from "@/lib/strategy";
import type { Signal } from "@/lib/strategy";
import { get4HEmaDiagnostic } from "@/lib/ema-diagnostic";
import { CXSWITCH_VERSION } from "@/lib/version";
import { getActiveSignals, setActiveSignals, addActiveSignal, getSignalHistory, appendSignalHistory, updateSignalHistoryStatus, updateActiveTradeMilestones, updateHistoryMilestones, updateHistoryStopMilestone, setMarketData, getLastCronRun, setLastCronRun, getCooldowns, getCardResets, claimTelegramAlert, releaseTelegramAlert, runPersistenceCleanup } from "@/lib/state";
import { sendAlert, sendManagementAlert, sendJarvisOpportunity } from "@/lib/telegram";
import { narratePairState, runJarvis, reviewFiredSignal } from "@/lib/jarvis";
import { getMarketHealth } from "@/lib/market-health";

export const dynamic="force-dynamic";
export const revalidate=0;
const PAIRS=["BTC","ETH","SOL","HYPE","DOGE","LINK","AVAX","ZEC"] as const;
const EXECUTION_MODE="MANUAL" as const;
// All Kraken-backed pairs are live. JARVIS observes and interprets; it never gates alerts.
const PAUSED_ALERT_PAIRS=new Set<string>();
const MIN_CRON_INTERVAL_MS=2*60*1000;
const SIGNAL_DEDUP_MS=45*60*1000;
const SIGNAL_DEDUP_ENTRY_PCT=0.004;
const VERBOSE_CRON_LOGS=process.env.CRON_VERBOSE_LOGS==="true";
const round=(n:number)=>n>=10000?Math.round(n):n>=1000?Math.round(n*10)/10:n>=100?Math.round(n*100)/100:Math.round(n*1000)/1000;
function sameRecentSignal(history:any[],s:Signal,now:number){return history.some(h=>h.pair===s.pair&&h.direction===s.direction&&h.type===s.type&&h.exitReason!=="manual_symbol_reset"&&now-h.timestamp<SIGNAL_DEDUP_MS&&Math.abs((h.entry-s.entry)/s.entry)<SIGNAL_DEDUP_ENTRY_PCT);}
function toSignalLike(t:any):Signal{return{...t,adx:t.adx??0,rsi:t.rsi??0,stochK:t.stochK??0,stochD:t.stochD??0,expectedMove:t.expectedMove??0,reason:t.reason||""} as Signal;}
function telegramAlertKey(signal:Signal,resetAt?:number):string{
  const resetSuffix=resetAt?`:reset:${resetAt}`:"";
  return `${signal.pair}:${signal.direction}:${signal.type}:${signal.id}${resetSuffix}`;
}

async function manageActivePositions(initialActive:any[], marketData:any[], managementByPair:Record<string,any>, alerts:any[]){
 let active=initialActive;
 for(const trade of [...active]){try{
  if(trade.recoveredFromExchange){
    console.log(`[MANAGE] ${trade.pair} ${trade.direction} — recovered exchange position; awaiting matching internal signal before strategy management`);
    continue;
  }
  const c=await getCandles(krakenPairFormat(trade.pair+"/USD"),240);const price=c.at(-1)?.close;if(price===undefined){console.log(`[MANAGE] ${trade.pair} — no price`);continue;}
  const tp1AlreadyHit=!!trade.tp1HitAt;
  // Evaluate management before persisting a newly-hit TP1 milestone so the first
  // touch can still produce the one-time 50% scale-out + breakeven instruction.
  let hold=shouldHold(toSignalLike(trade),c,price);
  await updateHistoryMilestones(trade.id,price);
  if(typeof hold.shouldHold!=="boolean"){
    console.error(`[MANAGE] ${trade.pair} — invalid hold result; preserving active position`);
    hold={shouldHold:true,reason:"hold_result_invalid"};
  }
  if(!hold.shouldHold&&hold.reason==="price_too_far_from_alert"){
    console.log(`[MANAGE] ${trade.pair} — alert stale; manual position remains tracked`);
    hold={shouldHold:true,reason:"active_alert_stale"};
  }
  if(hold.reason==="1d_ema_reversal"){
    const key=`management:${trade.id}:1d_reversal`;
    if(await claimTelegramAlert(key))await sendManagementAlert({pair:trade.pair,direction:trade.direction,kind:"1D_REVERSAL"});
  }else if(hold.reason==="4h_ema_reversal_confirmed"){
    const key=`management:${trade.id}:4h_reversal`;
    if(await claimTelegramAlert(key))await sendManagementAlert({pair:trade.pair,direction:trade.direction,kind:"4H_REVERSAL"});
  }else if(hold.reason==="chandelier_stop"&&hold.newStop!==undefined){
    const improves=trade.direction==="LONG"?hold.newStop>Number(trade.stop):hold.newStop<Number(trade.stop);
    if(improves){
      const key=`management:${trade.id}:trail:${round(Number(hold.newStop))}`;
      if(await claimTelegramAlert(key))await sendManagementAlert({pair:trade.pair,direction:trade.direction,kind:"TRAIL",stop:Number(hold.newStop)});
    }
  }
  console.log(`[MANAGE] ${trade.pair} ${trade.direction} | Entry ${trade.entry} | Price ${price} | SL ${trade.stop} | TP1 ${trade.tp1??"—"} | TP2 ${trade.tp2??"—"} | Management ${hold.managementState} | ${hold.recommendation} | ${hold.reason}`);
  if(!hold.shouldHold){
    try{
      const execution=await placeFuturesReduceOnlyMarketOrder(trade.pair,trade.direction,Number(trade.exchangeSize||0));
      console.log(`[EXIT] ${trade.pair} ${trade.direction} — Kraken Futures close confirmed ${execution.requestedSize} remaining=${execution.remainingSize} @ ${price}`);
    }catch(error){
      console.error(`[EXIT] ${trade.pair} ${trade.direction} — Kraken Futures close failed; keeping position active`,error);
      alerts.push({pair:trade.pair,status:"exit_failed",reason:hold.reason,price,error:String(error)});
      continue;
    }
    await updateSignalHistoryStatus(trade.id,hold.reason==="tp2_hit"?"TP_HIT":"FAILED",hold.reason,price);
    active=active.filter(x=>x.id!==trade.id);
    alerts.push({pair:trade.pair,status:"exit",reason:hold.reason,price});
    continue;
  }
  if(hold.scaleOut && !tp1AlreadyHit){
    try{
      const positions=await getFuturesPositions();
      const exchangePosition=positions.find(p=>pairFromFuturesSymbol(p.symbol)===trade.pair&&p.side===trade.direction);
      if(!exchangePosition) throw new Error(`No Kraken Futures ${trade.direction} position found for TP1 scale-out`);
      const halfSize=exchangePosition.size*0.5;
      const execution=await placeFuturesReduceOnlyMarketOrder(trade.pair,trade.direction,halfSize);
      trade.exchangeSize=execution.remainingSize;
      const milestoneTrade=await updateActiveTradeMilestones(trade.id,price);
      if(milestoneTrade)Object.assign(trade,milestoneTrade);
      console.log(`[MGT] ${trade.pair} — TP1 scale-out confirmed ${execution.requestedSize}; remaining=${execution.remainingSize}`);
    }catch(error){
      console.error(`[MGT] ${trade.pair} — TP1 scale-out failed; keeping position active`,error);
      alerts.push({pair:trade.pair,status:"scaleout_failed",reason:hold.reason,error:String(error)});
      continue;
    }
  }
  if(hold.newStop&&hold.newStop!==trade.stop&&trade.tp1HitAt){
    try{
      const remainingSize=Number(trade.exchangeSize||0);
      if(remainingSize<=0) throw new Error("Missing remaining Kraken Futures size for breakeven stop");
      const stopExecution=await moveFuturesStopToBreakeven(trade.pair,trade.direction,remainingSize,hold.newStop);
      trade.stop=hold.newStop;
      await updateHistoryStopMilestone(trade.id,trade.stop);
      console.log(`[MGT] ${trade.pair} — Kraken Futures stop moved to ${hold.reason==="chandelier_stop"?"chandelier trail":"breakeven"} ${hold.newStop} (${stopExecution.stopOrderId||"accepted"})`);
    }catch(error){
      console.error(`[MGT] ${trade.pair} — breakeven stop update failed; keeping position active`,error);
      alerts.push({pair:trade.pair,status:"breakeven_stop_failed",reason:hold.reason,error:String(error)});
      continue;
    }
  }
  // TP1 scale-out is a one-time lifecycle event. shouldHold() remains deliberately
  // permissive for management, but must not re-emit the same 50% instruction on
  // every cron run once the TP1 milestone has already been persisted.
  if(hold.scaleOut && tp1AlreadyHit) delete hold.scaleOut;
  if(hold.scaleOut)console.log(`[MGT] ${trade.pair} — scale-out ${hold.scaleOut.label} ${hold.scaleOut.size*100}% @ ${hold.scaleOut.level}`);
  const snapshot=getMarketSnapshot(trade.pair,c,c,c);snapshot.positionState="ACTIVE";snapshot.positionDirection=trade.direction;snapshot.positionEntry=trade.entry;snapshot.positionStop=trade.stop;snapshot.positionTarget=trade.tp2??trade.target;snapshot.positionTp1=trade.tp1;snapshot.positionTp2=trade.tp2;snapshot.positionTp1HitAt=trade.tp1HitAt;snapshot.positionTp2HitAt=trade.tp2HitAt;snapshot.positionManagementState=hold.managementState;snapshot.positionManagementRecommendation=hold.recommendation;snapshot.positionManagementReason=hold.reason;snapshot.positionThesis=hold.reason;managementByPair[trade.pair]={state:hold.managementState,recommendation:hold.recommendation,reason:hold.reason};marketData.push(snapshot);
 }catch(e){console.error(`[MANAGE] ${trade.pair} ERROR`,e);}}
 await setActiveSignals(active);
 return active;
}

async function observeManualManagement(active:any[],marketData:any[]){
  if(EXECUTION_MODE!=="MANUAL")return;
  for(const trade of active){
    const m=marketData.find((x:any)=>x?.pair===trade.pair);
    const candles=Array.isArray(m?.momentumCandles4h)?m.momentumCandles4h:[];
    const price=Number(m?.price);
    if(!candles.length||!Number.isFinite(price))continue;
    const hold=shouldHold(toSignalLike(trade),candles,price);
    if(hold.reason==="chandelier_stop"&&hold.newStop!==undefined){
      const improves=trade.direction==="LONG"?hold.newStop>Number(trade.stop):hold.newStop<Number(trade.stop);
      if(!improves)continue;
      const key=`management:${trade.id}:trail:${round(Number(hold.newStop))}`;
      if(await claimTelegramAlert(key)){
        await sendManagementAlert({pair:trade.pair,direction:trade.direction,kind:"TRAIL",stop:Number(hold.newStop)});
        console.log(`[ALERT] CX — ${trade.pair} ${trade.direction}. Trail stop raised to ${round(Number(hold.newStop))}.`);
      }
    }else if(hold.reason==="1d_ema_reversal"){
      const key=`management:${trade.id}:1d_reversal`;
      if(await claimTelegramAlert(key)){
        await sendManagementAlert({pair:trade.pair,direction:trade.direction,kind:"1D_REVERSAL"});
        console.log(`[ALERT] CX — ${trade.pair} ${trade.direction}. 1D trend reversed. Exit now.`);
      }
    }else if(hold.reason==="4h_ema_reversal_confirmed"){
      const key=`management:${trade.id}:4h_reversal`;
      if(await claimTelegramAlert(key)){
        await sendManagementAlert({pair:trade.pair,direction:trade.direction,kind:"4H_REVERSAL"});
        console.log(`[ALERT] CX — ${trade.pair} ${trade.direction}. 4H trend reversed. Exit now.`);
      }
    }
  }
}

function pairFromFuturesSymbol(symbol:string):string|undefined{
  const s=symbol.toUpperCase().replace(/^(PI|PF)_/,"").replace(/[^A-Z0-9]/g,"");
  const map:Record<string,string>={XBTUSD:"BTC",ETHUSD:"ETH",SOLUSD:"SOL",HYPEUSD:"HYPE",DOGEUSD:"DOGE",LINKUSD:"LINK",AVAXUSD:"AVAX",ZECUSD:"ZEC"};
  return map[s];
}

async function reconcileExchangePositions(activeInput:any[]):Promise<any[]>{
  if(!isExchangeSyncConfigured()){
    console.log("[SYNC] Kraken Futures credentials not configured; preserving internal state");
    return activeInput;
  }
  try{
    const exchange=await getFuturesPositions();
    const next=[...activeInput];
    const exchangeByKey=new Map(exchange.map(p=>[`${pairFromFuturesSymbol(p.symbol)}|${p.side}`,p]));
    for(const trade of [...next]){
      const ex=exchangeByKey.get(`${trade.pair}|${trade.direction}`);
      if(!ex){
        await updateSignalHistoryStatus(trade.id,"FAILED","exchange_position_gone",undefined);
        next.splice(next.indexOf(trade),1);
        console.log(`[SYNC] ${trade.pair} ${trade.direction} — position gone from exchange`);
        continue;
      }
      if(Math.abs(Number(trade.entry)-ex.entryPrice)>Math.max(0.01,Math.abs(ex.entryPrice)*0.0005)){
        console.warn(`[SYNC] ${trade.pair} ${trade.direction} — entry mismatch internal=${trade.entry} exchange=${ex.entryPrice}; trusting Kraken`);
        trade.entry=ex.entryPrice;
      }
      if(Number(trade.exchangeSize)!==ex.size){
        console.warn(`[SYNC] ${trade.pair} ${trade.direction} — size mismatch internal=${trade.exchangeSize??"unknown"} exchange=${ex.size}; trusting Kraken`);
        trade.exchangeSize=ex.size;
      }
      exchangeByKey.delete(`${trade.pair}|${trade.direction}`);
    }
    for(const [key,ex] of exchangeByKey){
      const [pair,direction]=key.split("|") as [string,"LONG"|"SHORT"];
      if(!pair) continue;
      const recovered:any={
        id:`EXCHANGE_RECOVERY_${pair}_${direction}_${Date.now()}`,
        pair,direction,type:"ENTRY",entry:ex.entryPrice,stop:0,tp1:0,tp2:0,rr:0,
        timestamp:Date.now(),status:"ACTIVE",version:29,context:{recoveredFromExchange:true},
        exchangeSize:ex.size,recoveredFromExchange:true
      };
      next.push(recovered);
      console.log(`[SYNC] recovered orphan position ${pair} ${direction} @ ${ex.entryPrice} size=${ex.size}`);
    }
    return next;
  }catch(error){
    console.error("[SYNC] Kraken Futures reconciliation failed; preserving internal state",error);
    return activeInput;
  }
}

export async function GET(request:Request){
 const started=Date.now(),url=new URL(request.url),secret=url.searchParams.get("secret"),auth=request.headers.get("authorization");
 if(secret!==process.env.CRON_SECRET&&auth!==`Bearer ${process.env.CRON_SECRET}`)return NextResponse.json({error:"Unauthorized"},{status:401});
 const last=await getLastCronRun();
 if(started-last<MIN_CRON_INTERVAL_MS){console.log(`[CRON v${CXSWITCH_VERSION}] Guard: run skipped; previous run ${Math.round((started-last)/1000)}s ago`);return NextResponse.json({success:true,skipped:true,reason:"concurrency_guard"});}
 await setLastCronRun(started);
 try{await runPersistenceCleanup();}catch(error){console.error("[STATE CLEANUP] persistence cleanup failed; continuing",error);}
 console.log("========================================");console.log(`[CRON v${CXSWITCH_VERSION}] Started at ${new Date(started).toISOString()}`);
 let active=await getActiveSignals();
 if(EXECUTION_MODE==="AUTO") active=await reconcileExchangePositions(active);
 // Reconcile the persistent position store against ACTIVE history before any
 // management runs. This recovers a live position if the active-state key was
 // lost/reset while its corresponding history entry remained ACTIVE.
 const historyAtStart=await getSignalHistory();
 const activeKeys=new Set(active.map((x:any)=>`${x.pair}|${x.direction}`));
 const recoverable=historyAtStart
   .filter((h:any)=>h.status==="ACTIVE"&&(h.type==="ENTRY_1"||h.type==="ENTRY_2"||h.type==="REVERSAL_SHORT"||h.type==="REVERSAL_LONG")&&Number.isFinite(Number(h.tp1))&&Number.isFinite(Number(h.tp2))&&!activeKeys.has(`${h.pair}|${h.direction}`))
   .reduce((map:any,h:any)=>{
     const key=`${h.pair}|${h.direction}`;
     if(!map.has(key)||h.timestamp>map.get(key).timestamp)map.set(key,h);
     return map;
   },new Map<string,any>());
 if(recoverable.size){
   for(const h of recoverable.values()){
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
 let marketData:any[]=[],alerts:any[]=[],newSignals:Signal[]=[],managementByPair:Record<string,any>={};


 // The 1D experiment is now live context for entry timing. It still does not
 // execute trades by itself; the strategy supplies the execution-grade entry/SL/TP model.
 let marketHealth:any=null;
 try{
   marketHealth=await getMarketHealth();
   console.log(`[MARKET HEALTH] BTC.D ${marketHealth.btcDominance??"—"} (rel ${marketHealth.btcDominanceRelative24h??"—"}%) | USDT.D ${marketHealth.usdtDominance??"—"} (rel ${marketHealth.usdtDominanceRelative24h??"—"}%) | TOTAL ${marketHealth.totalMarketCapChange24h??"—"}% | ALT ${marketHealth.altContext}`);
 }catch(error){console.error("[MARKET HEALTH] refresh failed",error);}


 for(const batch of [PAIRS.slice(0,4),PAIRS.slice(4)]){ await Promise.all(batch.map(async (pair)=>{let stateMarket:any=undefined;let stateCandles4h:any[]=[];let stateCandles15m:any[]=[];let stateSignal:Signal|undefined=undefined;try{
  const [c1,c4,c15]=await Promise.all([
    getCandles(krakenPairFormat(pair+"/USD"),60),
    getCandles(krakenPairFormat(pair+"/USD"),240),
    getCandles(krakenPairFormat(pair+"/USD"),15)
  ]);stateCandles4h=c4||[];stateCandles15m=c15||[];
  if(!c1?.length||!c4?.length||!c15?.length){console.log(`[PAIR] ${pair} — SKIP insufficient candles`);alerts.push({pair,status:"skip",reason:"insufficient_candles"});return;}
  const ema513=get4HEmaDiagnostic(c4);
  console.log(`[EMA 4H 5/13] ${pair} — ${ema513.label} | 5=${ema513.ema5.toFixed(4)} | 13=${ema513.ema13.toFixed(4)} | spread=${ema513.spread.toFixed(4)} (${ema513.spreadPct.toFixed(3)}%) | spreadATR=${ema513.spreadAtr.toFixed(3)} | contracting=${ema513.spreadContracting?"YES":"NO"} | Δspread=${ema513.spreadChangePct.toFixed(2)}% | 5slope=${ema513.ema5Slope.toFixed(4)} | 13slope=${ema513.ema13Slope.toFixed(4)} | cross=${ema513.crossNow?"YES":"NO"}`);
  const price=c1.at(-1)!.close;
  const existing=active.find(x=>x.pair===pair);
  const result=generateSignal(pair,c1,c4,c15,price);
  const snapshot:any=result.market||getMarketSnapshot(pair,c1,c4,c15);snapshot.currentPrice=price;snapshot.momentumCandles4h=c4.slice(-220);stateMarket=snapshot;
  // Preserve the strategy's canonical 4H EMA(8/21) values; do not overwrite them with
  // non-existent legacy snapshot keys before deriving the coarse 4H direction.
  snapshot.fourH513=ema513;
  const dailyPrice=Number(snapshot.price||price),dailyE8=Number(snapshot.ema8_1d),dailyE21=Number(snapshot.ema21_1d),dailySpread=Math.abs(dailyE8-dailyE21)/Math.max(dailyPrice,1e-12)*100;
  snapshot.dailyDirection=dailySpread<=0.5?"NEUTRAL":dailyE8>dailyE21?"BULL":"BEAR";
  snapshot.fourHDirection=snapshot.ema8_4h>snapshot.ema21_4h?"BULL":snapshot.ema8_4h<snapshot.ema21_4h?"BEAR":"NEUTRAL";
  snapshot.dailyLive={state:snapshot.dailyDirection,candidateState:snapshot.dailyDirection,direction:snapshot.dailyDirection==="BULL"?"LONG":snapshot.dailyDirection==="BEAR"?"SHORT":"NEUTRAL"};
  const dbg=result.debug||[];
  const gateDebug=dbg.find(x=>x.startsWith("[GATES]"));
  if(pair==="BTC"&&gateDebug)console.log(`[GATES] BTC — ${gateDebug.slice(8)}`);
  dbg.filter(x=>x.startsWith("[SWINGS]")||x.startsWith("[TL]")).forEach(x=>console.log(x));
  if(VERBOSE_CRON_LOGS)dbg.forEach(x=>console.log(`[PAIR] ${pair} — ${x}`));
  marketData.push(snapshot);
  const signal=result.signal;
  if(!signal){if(!existing)console.log(`[PAIR] ${pair} | 1D=${snapshot.dailyDirection||"—"} | 4H=${ema513.label} | WAIT`);return;}
  console.log(`[SIGNAL] ${pair} — ${signal.type} ${signal.direction} @ ${signal.entry} | SL ${signal.stop} | TP ${signal.tp2} | RR ${signal.rr}`);
  if(existing){console.log(`[PAIR] ${pair} — ${signal.type} suppressed because position is already active`);return;}
  const history=await getSignalHistory();
  if(PAUSED_ALERT_PAIRS.has(pair)){console.log(`[PAIR] ${pair} — ${signal.type} paused; signal suppressed`);alerts.push({pair,direction:signal.direction,type:signal.type,status:"paused"});return;}
  if(sameRecentSignal(history,signal,Date.now())){console.log(`[PAIR] ${pair} — ${signal.type} deduped: same entry condition was alerted recently`);return;}
  const cooldowns=await getCooldowns(),cd=cooldowns[`${pair}_${signal.direction}`];
  if(cd&&Date.now()<cd){console.log(`[PAIR] ${pair} — COOLDOWN until ${new Date(cd).toISOString()}`);return;}
  const cardResets=await getCardResets();
  const alertKey=telegramAlertKey(signal,cardResets[pair]);
  const claimed=await claimTelegramAlert(alertKey);
  if(!claimed){console.log(`[PAIR] ${pair} — ${signal.type} blocked: lifecycle alert already claimed (${alertKey})`);alerts.push({pair,direction:signal.direction,type:signal.type,status:"telegram_deduped_blocked"});return;}
  const jarvisReview=await reviewFiredSignal(signal,snapshot);
  if(jarvisReview?.verdict==="VETO"){
    await releaseTelegramAlert(alertKey);
    console.log(`[JARVIS] ${pair} — ${signal.type} ${signal.direction} vetoed: ${jarvisReview.reason}`);
    alerts.push({pair,direction:signal.direction,type:signal.type,status:"jarvis_veto",reason:jarvisReview.reason});
    return;
  }
  try{
    await sendAlert({symbol:signal.pair,state:"ENTRY",price:round(signal.entry),bias:signal.direction,stopLoss:round(signal.stop),takeProfit:round(signal.tp2),takeProfit1:signal.tp1,takeProfit2:signal.tp2,rr:signal.rr,expectedMove:signal.expectedMove,signalClass:signal.signalClass,sizeMultiplier:signal.sizeMultiplier,adx:signal.adx,rsi:signal.rsi,stochK:signal.stochK,stochD:signal.stochD,reason:signal.reason,updatedAt:new Date(signal.timestamp).toISOString(),signalType:signal.type,signalEmoji:"📊",context:signal.context,jarvis:jarvisReview});
  }catch(e){await releaseTelegramAlert(alertKey);throw e;}
  await appendSignalHistory(signal);
  stateSignal=signal;
  newSignals.push(signal);
  alerts.push({pair,direction:signal.direction,type:signal.type,status:"sent"});
  console.log(`[ALERT] ${pair} — ${signal.type} sent @ ${signal.entry} | SL ${signal.stop} | TP ${signal.tp2}`);
  if(EXECUTION_MODE==="AUTO"){
   await addActiveSignal(signal);
   active=await getActiveSignals();
  }
 } catch(e){
    console.error(`[PAIR] ${pair} — ERROR`,e);
    alerts.push({pair,status:"error",error:String(e)});
  } finally {
    const jarvisState=narratePairState(pair,stateMarket,stateCandles4h,stateSignal,stateCandles15m);
    if(stateMarket)stateMarket.jarvisState=jarvisState;
    console.log(jarvisState);
  }
 })); }
 await setMarketData(marketData);
 // Jarvis refresh completes before management.
 try{
   const jarvis=await runJarvis(marketData,await getActiveSignals());
   console.log(`[JARVIS] Portfolio ${jarvis.portfolioState} | ${jarvis.whatChanged}`);
   for(const [pair,state] of Object.entries(jarvis.pairs)){
     const opportunity=(state as any).opportunity;
     if(!opportunity)continue;
     const key=`jarvis:opportunity:${pair}:${opportunity.direction}:${opportunity.strength}:position:${opportunity.activePosition||"NONE"}:conflict:${opportunity.positionConflict?"YES":"NO"}`;
     if(await claimTelegramAlert(key)){
       try{
         await sendJarvisOpportunity({pair,direction:opportunity.direction,strength:opportunity.strength,reason:opportunity.reason,activePosition:opportunity.activePosition,positionConflict:opportunity.positionConflict});
         console.log(`[JARVIS] ${pair} — ${opportunity.direction} ${opportunity.strength} opportunity alert sent`);
       }catch(error){
         await releaseTelegramAlert(key);
         console.error(`[JARVIS] ${pair} — opportunity alert failed`,error);
       }
     }
   }
 }catch(error){
   console.error("[JARVIS] State refresh failed; existing strategy continues unchanged",error);
 }
 if(EXECUTION_MODE==="AUTO"){
  active=await manageActivePositions(active,marketData,managementByPair,alerts);
  await setActiveSignals(active);
 }else{
  await observeManualManagement(active,marketData);
 }
 const finalActive=await getActiveSignals();
 console.log(`[CRON v${CXSWITCH_VERSION}] Done active=${finalActive.length} marketData=${marketData.length} new=${newSignals.length} alerts=${alerts.length}`);
 console.log("========================================");
 return NextResponse.json({success:true,version:CXSWITCH_VERSION,activeSignals:finalActive.length,marketData:marketData.length,newSignals:newSignals.length,alerts});
}