// app/api/cron/route.ts — canonical CXSwitch execution loop
import { NextResponse } from "next/server";
import { getCandles, krakenPairFormat } from "@/lib/kraken";
import { generateSignal, getMarketSnapshot, shouldHold, Signal } from "@/lib/strategy";
import { get4HEmaDiagnostic } from "@/lib/ema-diagnostic";
import { CXSWITCH_VERSION } from "@/lib/version";
import { getActiveSignals, setActiveSignals, addActiveSignal, getSignalHistory, appendSignalHistory, updateSignalHistoryStatus, updateActiveTradeMilestones, updateHistoryMilestones, setMarketData, getLastCronRun, setLastCronRun, getCooldowns } from "@/lib/state";
import { sendAlert } from "@/lib/telegram";

export const dynamic="force-dynamic";
export const revalidate=0;
const PAIRS=["BTC","ETH","SOL","HYPE"] as const;
const MIN_CRON_INTERVAL_MS=2*60*1000;
const ADD_DEDUP_MS=45*60*1000;
const ADD_DEDUP_ENTRY_PCT=0.004;
const API_DELAY_MS=450;
const sleep=(ms:number)=>new Promise(r=>setTimeout(r,ms));
const round=(n:number)=>n>=10000?Math.round(n):n>=1000?Math.round(n*10)/10:n>=100?Math.round(n*100)/100:Math.round(n*1000)/1000;
function sameRecentSignal(history:any[],s:Signal,now:number){return history.some(h=>h.pair===s.pair&&h.direction===s.direction&&h.type===s.type&&now-h.timestamp<ADD_DEDUP_MS&&Math.abs((h.entry-s.entry)/s.entry)<ADD_DEDUP_ENTRY_PCT);}
function toSignalLike(t:any):Signal{return{...t,scale:t.type,adx:t.adx??0,rsi:t.rsi??0,stochK:t.stochK??0,stochD:t.stochD??0,expectedMove:t.expectedMove??0,reason:t.reason||"",trend:t.trend||t.direction,location:t.location||"",trigger:t.trigger||""} as Signal;}

export async function GET(request:Request){
 const started=Date.now(),url=new URL(request.url),secret=url.searchParams.get("secret"),auth=request.headers.get("authorization");
 if(secret!==process.env.CRON_SECRET&&auth!==`Bearer ${process.env.CRON_SECRET}`)return NextResponse.json({error:"Unauthorized"},{status:401});
 const last=await getLastCronRun();
 if(started-last<MIN_CRON_INTERVAL_MS){console.log(`[CRON v${CXSWITCH_VERSION}] Guard: run skipped; previous run ${Math.round((started-last)/1000)}s ago`);return NextResponse.json({success:true,skipped:true,reason:"concurrency_guard"});}
 await setLastCronRun(started);
 console.log("========================================");console.log(`[CRON v${CXSWITCH_VERSION}] Started at ${new Date(started).toISOString()}`);
 let active=await getActiveSignals();console.log(`[STATE] Active signals on entry: ${active.map(a=>`${a.pair}_${a.direction}_${a.type}`).join(", ")||"none"}`);
 let marketData:any[]=[],alerts:any[]=[],newSignals:Signal[]=[];
 for(const trade of [...active]){try{
  const c=await getCandles(krakenPairFormat(trade.pair+"/USD"),240);await sleep(API_DELAY_MS);const price=c.at(-1)?.close;if(price===undefined){console.log(`[MANAGE] ${trade.pair} — no price`);continue;}
  const milestoneTrade=await updateActiveTradeMilestones(trade.id,price);if(milestoneTrade)Object.assign(trade,milestoneTrade);await updateHistoryMilestones(trade.id,price);
  let hold=shouldHold(toSignalLike(trade),c,price);if(!hold.shouldHold&&hold.reason==="price_too_far_from_alert"){console.log(`[MANAGE] ${trade.pair} — alert stale; manual position remains tracked`);hold={shouldHold:true,reason:"active_alert_stale"};}
  console.log(`[MANAGE] ${trade.pair} ${trade.direction} | Entry ${trade.entry} | Price ${price} | SL ${trade.stop} | TP1 ${trade.tp1??"—"} | TP2 ${trade.tp2??"—"} | TP3 ${trade.tp3??"—"} | Thesis ${hold.reason}`);
  if(!hold.shouldHold){await updateSignalHistoryStatus(trade.id,hold.reason==="tp3_hit"||hold.reason==="tp2_hit_lock_2r"?"TP_HIT":"FAILED",hold.reason,price);active=active.filter(x=>x.id!==trade.id);alerts.push({pair:trade.pair,status:"exit",reason:hold.reason,price});console.log(`[EXIT] ${trade.pair} ${trade.direction} — ${hold.reason} @ ${price}`);continue;}
  if(hold.newStop&&hold.newStop!==trade.stop){console.log(`[MGT] ${trade.pair} — stop ${trade.stop} -> ${hold.newStop} (${hold.reason})`);trade.stop=hold.newStop;}
  if(hold.scaleOut)console.log(`[MGT] ${trade.pair} — scale-out ${hold.scaleOut.label} ${hold.scaleOut.size*100}% @ ${hold.scaleOut.level}`);
  const snapshot=getMarketSnapshot(trade.pair,c,c,c);snapshot.positionState="ACTIVE";snapshot.positionDirection=trade.direction;snapshot.positionEntry=trade.entry;snapshot.positionStop=trade.stop;snapshot.positionTarget=trade.tp2??trade.target;snapshot.positionTp1=trade.tp1;snapshot.positionTp2=trade.tp2;snapshot.positionTp3=trade.tp3;snapshot.positionTp1HitAt=trade.tp1HitAt;snapshot.positionTp2HitAt=trade.tp2HitAt;snapshot.positionTp3HitAt=trade.tp3HitAt;snapshot.positionThesis=hold.reason;marketData.push(snapshot);
 }catch(e){console.error(`[MANAGE] ${trade.pair} ERROR`,e);}}
 await setActiveSignals(active);
 for(const pair of PAIRS){try{
  const c1=await getCandles(krakenPairFormat(pair+"/USD"),60);await sleep(API_DELAY_MS);const c4=await getCandles(krakenPairFormat(pair+"/USD"),240);await sleep(API_DELAY_MS);const c15=await getCandles(krakenPairFormat(pair+"/USD"),15);await sleep(API_DELAY_MS);
  if(!c1?.length||!c4?.length||!c15?.length){console.log(`[PAIR] ${pair} — SKIP insufficient candles`);alerts.push({pair,status:"skip",reason:"insufficient_candles"});continue;}
  const ema513=get4HEmaDiagnostic(c4);
  console.log(`[EMA 4H 5/13] ${pair} — ${ema513.label} | 5=${ema513.ema5.toFixed(4)} | 13=${ema513.ema13.toFixed(4)} | spread=${ema513.spread.toFixed(4)} (${ema513.spreadPct.toFixed(3)}%) | spreadATR=${ema513.spreadAtr.toFixed(3)} | contracting=${ema513.spreadContracting?"YES":"NO"} | Δspread=${ema513.spreadChangePct.toFixed(2)}% | 5slope=${ema513.ema5Slope.toFixed(4)} | 13slope=${ema513.ema13Slope.toFixed(4)} | cross=${ema513.crossNow?"YES":"NO"}`);
  const price=c1.at(-1)!.close,existing=active.find(x=>x.pair===pair);const result=await generateSignal(pair,c1,c4,c15,active,price);const snapshot=result.market||getMarketSnapshot(pair,c1,c4,c15);snapshot.fourH513=ema513;const dbg=result.debug||[];dbg.forEach(x=>console.log(`[PAIR] ${pair} — ${x}`));
  if(existing){snapshot.positionState="ACTIVE";snapshot.positionDirection=existing.direction;snapshot.positionEntry=existing.entry;snapshot.positionStop=existing.stop;snapshot.positionTarget=existing.tp2??existing.target;snapshot.positionTp1=existing.tp1;snapshot.positionTp2=existing.tp2;snapshot.positionTp3=existing.tp3;snapshot.positionTp1HitAt=existing.tp1HitAt;snapshot.positionTp2HitAt=existing.tp2HitAt;snapshot.positionTp3HitAt=existing.tp3HitAt;console.log(`[PAIR] ${pair} — POSITION ACTIVE (${existing.direction}) — entry engine paused`);}
  marketData.push(snapshot);const signal=result.signal;if(!signal){if(!existing)console.log(`[PAIR] ${pair} — NO SIGNAL`);continue;}
  console.log(`[SIGNAL] ${pair} — ${signal.type} ${signal.direction} @ ${signal.entry} | SL ${signal.stop} | TP1 ${signal.tp1??"—"} | TP2 ${signal.tp2??"—"} | TP3 ${signal.tp3??"—"} | RR ${signal.rr}`);
  const hasSameDirection=active.some(x=>x.pair===pair&&x.direction===signal.direction);if(signal.type==="ADD"&&!hasSameDirection){console.log(`[PAIR] ${pair} — ADD blocked: no active same-direction position`);continue;}if(existing&&signal.type!=="ADD"){console.log(`[PAIR] ${pair} — signal suppressed because position is already active`);continue;}
  const history=await getSignalHistory();if(signal.type==="ADD"&&sameRecentSignal(history,signal,Date.now())){console.log(`[PAIR] ${pair} — ADD deduped: same entry condition was alerted recently; waiting for a new retest/price`);continue;}
  const cooldowns=await getCooldowns(),cd=cooldowns[`${pair}_${signal.direction}`];if(cd&&Date.now()<cd){console.log(`[PAIR] ${pair} — COOLDOWN until ${new Date(cd).toISOString()}`);continue;}
  const emoji=signal.type==="ENTRY_1"?"🟢":signal.type==="ENTRY_2"?"🟠":"🔵";
  await sendAlert({symbol:signal.pair,state:signal.type==="ADD"?"ADD":"ENTRY",price:round(signal.entry),bias:signal.direction,stopLoss:round(signal.stop),takeProfit:round(signal.tp2??signal.target),takeProfit1:signal.tp1,takeProfit2:signal.tp2,takeProfit3:signal.tp3,rr:signal.rr,expectedMove:signal.expectedMove,adx:signal.adx,rsi:signal.rsi,stochK:signal.stochK,stochD:signal.stochD,reason:signal.reason,trend:signal.trend,location:signal.location,trigger:signal.trigger,updatedAt:new Date(signal.timestamp).toISOString(),signalType:signal.type,signalEmoji:emoji,context:signal.context,marketPhase:signal.context?.marketPhase,structure:signal.context?.structure,momentum:signal.context?.momentum,pullback:signal.context?.pullback});
  await appendSignalHistory(signal);newSignals.push(signal);alerts.push({pair,direction:signal.direction,type:signal.type,status:"sent"});console.log(`[ALERT] ${pair} — ${signal.type} sent @ ${signal.entry} | SL ${signal.stop} | TP1 ${signal.tp1} | TP2 ${signal.tp2} | TP3 ${signal.tp3}`);
  if(signal.type!=="ADD"&&!existing){await addActiveSignal(signal);active=await getActiveSignals();console.log(`[STATE] ${pair} — active position created`);}
 }catch(e){console.error(`[PAIR] ${pair} — ERROR`,e);alerts.push({pair,status:"error",error:String(e)});}}
 await setMarketData(marketData);const finalActive=await getActiveSignals();console.log(`[CRON v${CXSWITCH_VERSION}] Done active=${finalActive.length} marketData=${marketData.length} new=${newSignals.length} alerts=${alerts.length}`);console.log("========================================");
 return NextResponse.json({success:true,version:CXSWITCH_VERSION,activeSignals:finalActive.length,marketData:marketData.length,newSignals:newSignals.length,alerts});
}