// app/api/cron/route.ts — canonical CXSwitch execution loop
import { NextResponse } from "next/server";
import { getCandles, krakenPairFormat } from "@/lib/kraken";
import { generateSignal, getMarketSnapshot } from "@/lib/strategy";
import type { Signal } from "@/lib/strategy";
import { get4HEmaDiagnostic } from "@/lib/ema-diagnostic";
import { CXSWITCH_VERSION } from "@/lib/version";
import { getActiveSignals, setActiveSignals, addActiveSignal, getSignalHistory, appendSignalHistory, updateSignalHistoryStatus, updateHistoryMilestones, setMarketData, getLastCronRun, setLastCronRun, getCooldowns, getCardResets, claimTelegramAlert, releaseTelegramAlert, runPersistenceCleanup, getLastBreakout, setLastBreakout, clearLastBreakout } from "@/lib/state";
import { sendAlert } from "@/lib/telegram";
import { narratePairState, runJarvis, reviewFiredSignal } from "@/lib/jarvis";

export const dynamic="force-dynamic";
export const revalidate=0;
const PAIRS=["BTC","ETH","SOL","HYPE","DOGE","LINK","VIRTUAL","ZEC"] as const;
// All Kraken-backed pairs are live. JARVIS observes and interprets; it never gates alerts.
const PAUSED_ALERT_PAIRS=new Set<string>();
const MIN_CRON_INTERVAL_MS=2*60*1000;
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

async function reconcileAlertOutcomes(initialActive:any[], marketData:any[], alerts:any[]){
  let active=[...initialActive];
  for(const alert of [...active]){
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
  }
  await setActiveSignals(active);
  return active;
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
 // Reconcile the persistent position store against ACTIVE history before any
 // management runs. This recovers a live position if the active-state key was
 // lost/reset while its corresponding history entry remained ACTIVE.
 const historyAtStart=await getSignalHistory();
 const activeKeys=new Set(active.map((x:any)=>`${x.pair}|${x.direction}`));
 const recoverable=historyAtStart
   .filter((h:any)=>h.status==="ACTIVE"&&(h.type==="ENTRY_1"||h.type==="ENTRY_2")&&Number.isFinite(Number(h.tp1))&&Number.isFinite(Number(h.tp2))&&!activeKeys.has(`${h.pair}|${h.direction}`))
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
 let marketData:any[]=[],alerts:any[]=[],newSignals:Signal[]=[];


 for(const batch of [PAIRS.slice(0,4),PAIRS.slice(4)]){ await Promise.all(batch.map(async (pair)=>{let stateMarket:any=undefined;let stateCandles4h:any[]=[];let stateCandles15m:any[]=[];let stateSignal:Signal|undefined=undefined;try{
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
  const historyForEntry=await getSignalHistory();
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
  if(VERBOSE_CRON_LOGS&&gateDebug)console.log(`[GATES] ${pair} — ${gateDebug.slice(8)}`);
  if(VERBOSE_CRON_LOGS)dbg.filter(x=>x.startsWith("[SWINGS]")||x.startsWith("[TL]")||x.startsWith("[TL POINTS]")).forEach(x=>console.log(x));
  if(VERBOSE_CRON_LOGS)dbg.forEach(x=>console.log(`[PAIR] ${pair} — ${x}`));
  marketData.push(snapshot);
  const signal=result.signal;
  if(signal)snapshot.strategyStatus=`FIRED — ${signal.type} ${signal.direction}`;
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
  if(existing&&!entry2Continuation){console.log(`[PAIR] ${pair} — ${signal.type} suppressed because position is already active`);return;}
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
    await sendAlert({symbol:signal.pair,state:"ENTRY",price:signal.entry,bias:signal.direction,stopLoss:signal.stop,takeProfit:signal.tp2,takeProfit1:signal.tp1,takeProfit2:signal.tp2,rr:signal.rr,expectedMove:signal.expectedMove,signalClass:signal.signalClass,sizeMultiplier:signal.sizeMultiplier,adx:signal.adx,rsi:signal.rsi,stochK:signal.stochK,stochD:signal.stochD,reason:signal.reason,updatedAt:new Date(signal.timestamp).toISOString(),signalType:signal.type,signalEmoji:"📊",context:signal.context,jarvis:jarvisReview});
  }catch(e){await releaseTelegramAlert(alertKey);throw e;}
  await appendSignalHistory(signal);
  stateSignal=signal;
  newSignals.push(signal);
  alerts.push({pair,direction:signal.direction,type:signal.type,status:"sent"});
  console.log(`[ALERT] ${pair} — ${signal.type} sent @ ${signal.entry} | SL ${signal.stop} | TP ${signal.tp2}`);
  await addActiveSignal(signal);
  active=await getActiveSignals();
 } catch(e){
    console.error(`[PAIR] ${pair} — ERROR`,e);
    alerts.push({pair,status:"error",error:String(e)});
  } finally {
    const jarvisState=narratePairState(pair,stateMarket,stateCandles4h,stateSignal,stateCandles15m);
    if(stateMarket)stateMarket.jarvisState=jarvisState;
    if(VERBOSE_CRON_LOGS)console.log(jarvisState);
  }
 })); }
 await setMarketData(marketData);
 // Jarvis refresh completes before management.
 try{
   const jarvis=await runJarvis(marketData,await getActiveSignals());
   console.log(`[JARVIS] Portfolio ${jarvis.portfolioState} | ${jarvis.whatChanged}`);
   // Jarvis is dashboard guidance only. Telegram stays strictly actionable:
   // V28 ENTRY_1/ENTRY_2 alerts and position-management alerts are the only
   // strategy notifications sent to Telegram. 4H turns and Jarvis opportunities
   // remain visible in the dashboard but never create Telegram noise.
 }catch(error){
   console.error("[JARVIS] State refresh failed; existing strategy continues unchanged",error);
 }
 active=await reconcileAlertOutcomes(active,marketData,alerts);
 const finalActive=await getActiveSignals();
 console.log(`[CRON v${CXSWITCH_VERSION}] Done active=${finalActive.length} marketData=${marketData.length} new=${newSignals.length} alerts=${alerts.length}`);
 console.log("========================================");
 return NextResponse.json({success:true,version:CXSWITCH_VERSION,activeSignals:finalActive.length,marketData:marketData.length,newSignals:newSignals.length,alerts});}