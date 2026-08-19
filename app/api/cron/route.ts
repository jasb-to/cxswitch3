// app/api/cron/route.ts — v57 personal/manual execution loop
// Public market data + local signal state only. No private exchange credentials.

import { NextResponse } from "next/server";
import { getCandles, krakenPairFormat } from "@/lib/kraken";
import { generateSignalCompat, getMarketSnapshot, shouldHold, Signal } from "@/lib/strategy";
import {
  getActiveSignals, setActiveSignals, addActiveSignal, removeActiveSignalById,
  getSignalHistory, appendSignalHistory, updateSignalHistoryStatus,
  setMarketData, getLastCronRun, setLastCronRun, getCooldowns,
} from "@/lib/state";
import { sendAlert } from "@/lib/telegram";

export const dynamic = "force-dynamic";
export const revalidate = 0;

const PAIRS = ["BTC", "ETH", "SOL", "HYPE"] as const;
const MIN_CRON_INTERVAL_MS = 9 * 60 * 1000;
const ADD_DEDUP_MS = 4 * 60 * 60 * 1000;
const API_DELAY_MS = 450;
const sleep = (ms:number)=>new Promise(r=>setTimeout(r,ms));
const round=(n:number)=>n>=10000?Math.round(n):n>=1000?Math.round(n*10)/10:n>=100?Math.round(n*100)/100:Math.round(n*1000)/1000;

function sameRecentSignal(history:any[], signal:Signal, now:number){
  return history.some(h=>h.pair===signal.pair&&h.direction===signal.direction&&h.type===signal.type&&now-h.timestamp<ADD_DEDUP_MS&&Math.abs((h.entry-signal.entry)/signal.entry)<0.005);
}
function toSignalLike(t:any):Signal{return{...t,scale:t.type,adx:t.adx??0,rsi:t.rsi??0,stochK:t.stochK??0,stochD:t.stochD??0,expectedMove:t.expectedMove??0,reason:t.reason||"",trend:t.trend||t.direction,location:t.location||"",trigger:t.trigger||""} as Signal;}

export async function GET(request:Request){
  const started=Date.now();
  const url=new URL(request.url), secret=url.searchParams.get("secret"), auth=request.headers.get("authorization");
  if(secret!==process.env.CRON_SECRET&&auth!==`Bearer ${process.env.CRON_SECRET}`)return NextResponse.json({error:"Unauthorized"},{status:401});
  const last=await getLastCronRun();
  if(started-last<MIN_CRON_INTERVAL_MS)return NextResponse.json({success:true,skipped:true,reason:"rate_limited"});
  await setLastCronRun(started);

  let active=await getActiveSignals();
  const history=await getSignalHistory();
  const prices:Record<string,number>={};
  const marketData:any[]=[];
  const alerts:any[]=[];
  const newSignals:Signal[]=[];

  // First: manage any locally tracked working/manual trades.
  for(const trade of [...active]){
    const pair=trade.pair;
    try{
      const candles=await getCandles(krakenPairFormat(pair+"/USD"),240); await sleep(API_DELAY_MS);
      const price=candles.at(-1)?.close; if(price===undefined)continue;
      prices[pair]=price;
      const hold=shouldHold(toSignalLike(trade),candles,price);
      if(!hold.shouldHold){
        await updateSignalHistoryStatus(trade.id,hold.reason==="tp_hit"?"TP_HIT":"FAILED",hold.reason,price);
        active=active.filter(x=>x.id!==trade.id);
        alerts.push({pair,status:"exit",reason:hold.reason,price});
        continue;
      }
      if(hold.newStop&&hold.newStop!==trade.stop)trade.stop=hold.newStop;
      const snapshot=getMarketSnapshot(pair,candles,candles,candles);
      snapshot.positionState="ACTIVE";snapshot.positionDirection=trade.direction;snapshot.positionEntry=trade.entry;snapshot.positionStop=trade.stop;snapshot.positionTarget=trade.target;
      marketData.push(snapshot);
    }catch(e){console.error(`[MANAGE] ${pair}`,e);}
  }

  await setActiveSignals(active);

  for(const pair of PAIRS){
    try{
      const c1=await getCandles(krakenPairFormat(pair+"/USD"),60);await sleep(API_DELAY_MS);
      const c4=await getCandles(krakenPairFormat(pair+"/USD"),240);await sleep(API_DELAY_MS);
      const c15=await getCandles(krakenPairFormat(pair+"/USD"),15);await sleep(API_DELAY_MS);
      if(!c1?.length||!c4?.length||!c15?.length){alerts.push({pair,status:"skip",reason:"insufficient_candles"});continue;}
      const price=c1.at(-1)!.close;prices[pair]=price;
      const existing=active.find(x=>x.pair===pair);
      const result=await generateSignalCompat(pair,c1,c4,c15,active,price);
      const snapshot=result.market||getMarketSnapshot(pair,c1,c4,c15);
      if(existing){snapshot.positionState="ACTIVE";snapshot.positionDirection=existing.direction;snapshot.positionEntry=existing.entry;snapshot.positionStop=existing.stop;snapshot.positionTarget=existing.target;}
      marketData.push(snapshot);

      const signal=result.signal;
      if(!signal){console.log(`[PAIR] ${pair} — NO SIGNAL (${result.debug.join(" | ")})`);continue;}

      // ADD is an event, not a replacement position. ENTRY signals create local working state.
      const historyNow=await getSignalHistory();
      if(signal.type==="ADD"&&sameRecentSignal(historyNow,signal,Date.now())){
        console.log(`[PAIR] ${pair} — ADD deduped`);continue;
      }
      const cooldowns=await getCooldowns();const cd=cooldowns[`${pair}_${signal.direction}`];if(cd&&Date.now()<cd){console.log(`[PAIR] ${pair} — cooldown`);continue;}

      const alertState=signal.type==="ADD"?"ADD":"ENTRY";
      const emoji=signal.type==="ENTRY_1"?"🟢":signal.type==="ENTRY_2"?"🟠":"🔵";
      await sendAlert({symbol:signal.pair,state:alertState,price:round(signal.entry),bias:signal.direction,stopLoss:round(signal.stop),takeProfit:round(signal.target),rr:signal.rr,expectedMove:signal.expectedMove,adx:signal.adx,rsi:signal.rsi,stochK:signal.stochK,stochD:signal.stochD,reason:signal.reason,trend:signal.trend,location:signal.location,trigger:signal.trigger,updatedAt:new Date(signal.timestamp).toISOString(),signalType:signal.type,signalEmoji:emoji,context:signal.context,marketPhase:signal.context?.marketPhase,structure:signal.context?.structure,momentum:signal.context?.momentum,pullback:signal.context?.pullback});
      await appendSignalHistory(signal);
      newSignals.push(signal);
      alerts.push({pair,direction:signal.direction,type:signal.type,status:"sent"});

      // ENTRY_1/2 represent the working trade the user is acting on manually.
      // ADD is only an additional alert and must not overwrite the working trade.
      if(signal.type!=="ADD"&&!existing){await addActiveSignal(signal);active=await getActiveSignals();}
    }catch(e){console.error(`[PAIR] ${pair} — ERROR`,e);alerts.push({pair,status:"error",error:String(e)});}
  }

  await setMarketData(marketData);
  const finalActive=await getActiveSignals();
  console.log(`[CRON v57] Done active=${finalActive.length} marketData=${marketData.length} new=${newSignals.length}`);
  return NextResponse.json({success:true,activeSignals:finalActive.length,marketData:marketData.length,newSignals:newSignals.length,alerts});
}
