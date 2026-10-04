// app/api/cron/route.ts — canonical CXSwitch execution loop
import { NextResponse } from "next/server";
import { getCandles, krakenPairFormat, getFuturesPositions, isExchangeSyncConfigured } from "@/lib/kraken";
import { generateSignal, getMarketSnapshot, shouldHold } from "@/lib/strategy";
import type { Signal } from "@/lib/strategy";
import { get4HEmaDiagnostic } from "@/lib/ema-diagnostic";
import { CXSWITCH_VERSION } from "@/lib/version";
import { getActiveSignals, setActiveSignals, addActiveSignal, getSignalHistory, appendSignalHistory, updateSignalHistoryStatus, updateActiveTradeMilestones, updateHistoryMilestones, updateHistoryStopMilestone, setMarketData, getLastCronRun, setLastCronRun, getCooldowns, getCardResets, claimTelegramAlert, releaseTelegramAlert } from "@/lib/state";
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
function toSignalLike(t:any):Signal{return{...t,adx:t.adx??0,rsi:t.rsi??0,stochK:t.stochK??0,stochD:t.stochD??0,expectedMove:t.expectedMove??0,reason:t.reason||""} as Signal;}
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

async function manageActivePositions(initialActive:any[], marketData:any[], managementByPair:Record<string,any>, alerts:any[]){
 let active=initialActive;
 for(const trade of [...active]){try{
  const c=await getCandles(krakenPairFormat(trade.pair+"/USD"),240);const price=c.at(-1)?.close;if(price===undefined){console.log(`[MANAGE] ${trade.pair} — no price`);continue;}
  const tp1AlreadyHit=!!trade.tp1HitAt;
  // Evaluate management before persisting a newly-hit TP1 milestone so the first
  // touch can still produce the one-time 50% scale-out + breakeven instruction.
  let hold=shouldHold(toSignalLike(trade),c,price);
  const milestoneTrade=await updateActiveTradeMilestones(trade.id,price);
  if(milestoneTrade)Object.assign(trade,milestoneTrade);
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
 return active;
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
\nexport async function GET(request:Request){
 const started=Date.now(),url=new URL(request.url),secret=url.searchParams.get("secret"),auth=request.headers.get("authorization");
 if(secret!==process.env.CRON_SECRET&&auth!==`Bearer ${process.env.CRON_SECRET}`)return NextResponse.json({error:"Unauthorized"},{status:401});
 const last=await getLastCronRun();
 if(started-last<MIN_CRON_INTERVAL_MS){console.log(`[CRON v${CXSWITCH_VERSION}] Guard: run skipped; previous run ${Math.round((started-last)/1000)}s ago`);return NextResponse.json({success:true,skipped:true,reason:"concurrency_guard"});}
 await setLastCronRun(started);
 console.log("========================================");console.log(`[CRON v${CXSWITCH_VERSION}] Started at ${new Date(started).toISOString()}`);
 let active=await getActiveSignals();
 active=await reconcileExchangePositions(active);
 // Reconcile the persistent position store against ACTIVE history before any
 // management runs. This recovers a live position if the active-state key was
 // lost/reset while its corresponding history entry remained ACTIVE.
 const historyAtStart=await getSignalHistory();
 // Recover tactical rejection positions that were incorrectly closed by the
 // pre-fix 1D reversal rule. Only restore the latest matching position per pair
 // and only while current price remains between its SL and TP2.
 const legacyTactical=historyAtStart
   .filter((h:any)=>h.status==="FAILED"&&h.exitReason==="trend_reversed_unprofitable"&&h.type==="ENTRY_1"&&h.context?.trendlineApproach?.tacticalRejection===true)
   .reduce((map:any,h:any)=>{if(!map.has(h.pair)||h.timestamp>map.get(h.pair).timestamp)map.set(h.pair,h);return map;},new Map<string,any>());
 for(const h of legacyTactical.values()){
   try{
     const rc=await getCandles(krakenPairFormat(h.pair+"/USD"),240);
     const rp=rc.at(-1)?.close;
     const tp2=h.tp2??h.target;
     const inRange=rp!==undefined&&(h.direction==="SHORT"?rp<h.stop&&rp>tp2:rp>h.stop&&rp<tp2);
     if(inRange){
       await updateSignalHistoryStatus(h.id,"ACTIVE",undefined,undefined);
       active.push({...h,status:"ACTIVE",scale:h.type,target:h.tp2??h.target});
       console.log(`[STATE] Recovered legacy tactical ACTIVE position: ${h.pair}_${h.direction}_${h.type} @ ${rp}`);
     }
   }catch(e){console.error(`[STATE] Legacy tactical recovery failed for ${h.pair}`,e);}
 }
 const activeKeys=new Set(active.map((x:any)=>`${x.pair}|${x.direction}`));
 const recoverable=historyAtStart
   .filter((h:any)=>h.status==="ACTIVE"&&!activeKeys.has(`${h.pair}|${h.direction}`))
   .reduce((map:any,h:any)=>{
     const key=`${h.pair}|${h.direction}`;
     if(!map.has(key)||h.timestamp>map.get(key).timestamp)map.set(key,h);
     return map;
   },new Map<string,any>());
 if(recoverable.size){
   for(const h of recoverable.values()){
     active.push({...h,status:"ACTIVE",scale:h.type,target:h.tp2??h.target});
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


 for(const pair of PAIRS){try{
  const c1=await getCandles(krakenPairFormat(pair+"/USD"),60);
  const c4=await getCandles(krakenPairFormat(pair+"/USD"),240);
  const c15=await getCandles(krakenPairFormat(pair+"/USD"),15);
  if(!c1?.length||!c4?.length||!c15?.length){console.log(`[PAIR] ${pair} — SKIP insufficient candles`);alerts.push({pair,status:"skip",reason:"insufficient_candles"});continue;}
  const ema513=get4HEmaDiagnostic(c4);
  console.log(`[EMA 4H 5/13] ${pair} — ${ema513.label} | 5=${ema513.ema5.toFixed(4)} | 13=${ema513.ema13.toFixed(4)} | spread=${ema513.spread.toFixed(4)} (${ema513.spreadPct.toFixed(3)}%) | spreadATR=${ema513.spreadAtr.toFixed(3)} | contracting=${ema513.spreadContracting?"YES":"NO"} | Δspread=${ema513.spreadChangePct.toFixed(2)}% | 5slope=${ema513.ema5Slope.toFixed(4)} | 13slope=${ema513.ema13Slope.toFixed(4)} | cross=${ema513.crossNow?"YES":"NO"}`);
  const price=c1.at(-1)!.close;
  const existing=active.find(x=>x.pair===pair);
  const result=generateSignal(pair,c1,c4,c15,price);
  const snapshot:any=result.market||getMarketSnapshot(pair,c1,c4,c15);
  // Persist the canonical 4H diagnostics alongside the market snapshot so the dashboard
  // copy card reads the same live values the cron just calculated.
  snapshot.ema8_4h=snapshot.ema8;
  snapshot.ema21_4h=snapshot.ema21;
  snapshot.fourH513=ema513;
  const dailyPrice=Number(snapshot.price||price),dailyE8=Number(snapshot.ema8_1d),dailyE21=Number(snapshot.ema21_1d),dailySpread=Math.abs(dailyE8-dailyE21)/Math.max(dailyPrice,1e-12)*100;
  snapshot.dailyDirection=dailySpread<=0.5?"NEUTRAL":dailyE8>dailyE21?"BULL":"BEAR";
  snapshot.fourHDirection=snapshot.ema8_4h>snapshot.ema21_4h?"BULL":snapshot.ema8_4h<snapshot.ema21_4h?"BEAR":"NEUTRAL";
  snapshot.dailyLive={state:snapshot.dailyDirection,candidateState:snapshot.dailyDirection,direction:snapshot.dailyDirection==="BULL"?"LONG":snapshot.dailyDirection==="BEAR"?"SHORT":"NEUTRAL"};
  const dbg=result.debug||[];
  if(VERBOSE_CRON_LOGS)dbg.forEach(x=>console.log(`[PAIR] ${pair} — ${x}`));
  marketData.push(snapshot);
  const signal=result.signal;
  if(!signal){if(!existing)console.log(`[PAIR] ${pair} | 1D=${snapshot.dailyDirection||"—"} | 4H=${ema513.label} | WAIT`);continue;}
  console.log(`[SIGNAL] ${pair} — ${signal.type} ${signal.direction} @ ${signal.entry} | SL ${signal.stop} | TP ${signal.tp2} | RR ${signal.rr}`);
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
  if(jarvisReview?.verdict==="VETO"){
    await releaseTelegramAlert(alertKey);
    console.log(`[JARVIS] ${pair} — ${signal.type} ${signal.direction} vetoed: ${jarvisReview.reason}`);
    alerts.push({pair,direction:signal.direction,type:signal.type,status:"jarvis_veto",reason:jarvisReview.reason});
    continue;
  }
  try{
    await sendAlert({symbol:signal.pair,state:"ENTRY",price:round(signal.entry),bias:signal.direction,stopLoss:round(signal.stop),takeProfit:round(signal.tp2),takeProfit1:signal.tp1,takeProfit2:signal.tp2,rr:signal.rr,expectedMove:signal.expectedMove,adx:signal.adx,rsi:signal.rsi,stochK:signal.stochK,stochD:signal.stochD,reason:signal.reason,updatedAt:new Date(signal.timestamp).toISOString(),signalType:signal.type,signalEmoji:"📊",context:signal.context,jarvis:jarvisReview});
  }catch(e){await releaseTelegramAlert(alertKey);throw e;}
  await appendSignalHistory(signal);
  newSignals.push(signal);
  alerts.push({pair,direction:signal.direction,type:signal.type,status:"sent"});
  console.log(`[ALERT] ${pair} — ${signal.type} sent @ ${signal.entry} | SL ${signal.stop} | TP ${signal.tp2}`);
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
 // Jarvis refresh completes before management.
 try{
   const jarvis=await runJarvis(marketData,await getActiveSignals());
   console.log(`[JARVIS] Portfolio ${jarvis.portfolioState} | ${jarvis.whatChanged}`);
 }catch(error){
   console.error("[JARVIS] State refresh failed; existing strategy continues unchanged",error);
 }
 active=await manageActivePositions(active,marketData,managementByPair,alerts);
 await setActiveSignals(active);
 const finalActive=await getActiveSignals();
 console.log(`[CRON v${CXSWITCH_VERSION}] Done active=${finalActive.length} marketData=${marketData.length} new=${newSignals.length} alerts=${alerts.length}`);
 console.log("========================================");
 return NextResponse.json({success:true,version:CXSWITCH_VERSION,activeSignals:finalActive.length,marketData:marketData.length,newSignals:newSignals.length,alerts});
}