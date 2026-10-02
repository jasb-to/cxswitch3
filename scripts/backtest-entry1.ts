/**
 * CX Switch ENTRY_1 historical validation harness.
 *
 * Usage:
 *   pnpm dlx tsx scripts/backtest-entry1.ts
 *   BACKTEST_MONTHS=24 BACKTEST_PAIRS=BTC,ETH,SOL pnpm dlx tsx scripts/backtest-entry1.ts
 *
 * Data: Binance USD-M perpetual klines. This deliberately does NOT change
 * live strategy defaults; it replays the current generateSignal() logic.
 */

import { generateSignal, type Candle, type Signal } from "../lib/strategy";

type Pair = "BTC"|"ETH"|"SOL";
type Row = {
  pair:string; direction:"LONG"|"SHORT"; timestamp:number; entry:number;
  stop:number|null; tp1:number|null; tp2:number|null;
  r4h:number|null; r8h:number|null; r12h:number|null; r24h:number|null;
  r48h:number|null; r72h:number|null;
  mae72:number|null; mfe72:number|null;
  stopHit72:boolean; tp1Hit72:boolean; tp2Hit72:boolean;
  exhaustion:string; reason:string;
};

const BASE="https://fapi.binance.com/fapi/v1/klines";
const PAIRS=(process.env.BACKTEST_PAIRS||"BTC,ETH,SOL").split(",").map(x=>x.trim().toUpperCase()).filter(Boolean) as Pair[];
const MONTHS=Math.max(6,Number(process.env.BACKTEST_MONTHS||18));
const LIMIT=1500;
const FOUR_H=4*60*60*1000;
const NOW=Date.now();
const START=NOW-MONTHS*30.4375*24*60*60*1000;
const END=NOW;

function sleep(ms:number){return new Promise(r=>setTimeout(r,ms));}

function parseRows(raw:any[]):Candle[]{
  return raw.map(x=>({timestamp:Number(x[0]),open:Number(x[1]),high:Number(x[2]),low:Number(x[3]),close:Number(x[4]),volume:Number(x[5])}));
}

async function fetchKlines(symbol:string,interval:string,start:number,end:number):Promise<Candle[]>{
  const out:Candle[]=[];
  let cursor=start;
  const step=interval==="15m"?15*60*1000:interval==="1h"?60*60*1000:interval==="4h"?FOUR_H:7*24*60*60*1000;
  while(cursor<end){
    const u=new URL(BASE);
    u.searchParams.set("symbol",symbol);
    u.searchParams.set("interval",interval);
    u.searchParams.set("startTime",String(cursor));
    u.searchParams.set("endTime",String(end));
    u.searchParams.set("limit",String(LIMIT));
    const res=await fetch(u);
    if(!res.ok)throw new Error(`Binance ${symbol} ${interval}: HTTP ${res.status} ${await res.text()}`);
    const raw=await res.json() as any[];
    const rows=parseRows(raw);
    if(!rows.length)break;
    for(const row of rows)if(!out.length||row.timestamp>out[out.length-1].timestamp)out.push(row);
    const last=rows[rows.length-1].timestamp;
    if(last<cursor)break;
    cursor=last+step;
    if(rows.length<LIMIT)break;
    await sleep(80);
  }
  return out.filter(x=>x.timestamp<=end);
}

function ptrAtOrBefore(rows:Candle[],ts:number,start=0){
  let lo=start,hi=rows.length-1,ans=-1;
  while(lo<=hi){const m=(lo+hi)>>1;if(rows[m].timestamp<=ts){ans=m;lo=m+1;}else hi=m-1;}
  return ans;
}
function ret(entry:number,value:number|undefined,dir:"LONG"|"SHORT"){
  if(value===undefined||!Number.isFinite(value))return null;
  return (dir==="LONG"?value-entry:entry-value)/entry*100;
}
function round(v:number|null){return v===null?null:Number(v.toFixed(3));}

async function runPair(pair:Pair):Promise<Row[]>{
  const symbol=pair+"USDT";
  console.log(`[BACKTEST] ${pair} downloading 4H/1H/15M/1W...`);
  const [c4,c1,c15,cw]=await Promise.all([
    fetchKlines(symbol,"4h",START,END),
    fetchKlines(symbol,"1h",START,END),
    fetchKlines(symbol,"15m",START,END),
    fetchKlines(symbol,"1w",START,END),
  ]);
  console.log(`[BACKTEST] ${pair} bars 4H=${c4.length} 1H=${c1.length} 15M=${c15.length} 1W=${cw.length}`);
  const rows:Row[]=[];
  let p1=-1,p15=-1,pw=-1;
  let lastBreakout:any=undefined;
  for(let i=300;i<c4.length-18;i++){
    const t=c4[i].timestamp;
    while(p1+1<c1.length&&c1[p1+1].timestamp<=t)p1++;
    while(p15+1<c15.length&&c15[p15+1].timestamp<=t)p15++;
    while(pw+1<cw.length&&cw[pw+1].timestamp<=t)pw++;
    if(p1<0||p15<0||pw<0)continue;
    const h1=c1.slice(0,p1+1), m15=c15.slice(0,p15+1), w=cw.slice(0,pw+1);
    const current=c4[i];
    const result=generateSignal(pair,c1.slice(0,p1+1),c4.slice(0,i+1),m15,[],current.close,lastBreakout,undefined,w,undefined,t);
    if(result.breakout)lastBreakout=result.breakout;
    const sig=result.signal;
    if(!sig||sig.type!=="ENTRY_1")continue;
    const future=c4.slice(i+1,i+19);
    const dir=sig.direction;
    const entry=sig.entry;
    const stop=sig.stop;
    const tp1=sig.tp1??null,tp2=sig.tp2??null;
    const horizon=(n:number)=>future[n-1];
    const highs=future.map(x=>x.high),lows=future.map(x=>x.low);
    const mfe=dir==="LONG"?(Math.max(...highs)-entry)/entry*100:(entry-Math.min(...lows))/entry*100;
    const mae=dir==="LONG"?(Math.min(...lows)-entry)/entry*100:(entry-Math.max(...highs))/entry*100;
    const stopHit=future.some(x=>dir==="LONG"?x.low<=stop:x.high>=stop);
    const tp1Hit=tp1!==null&&future.some(x=>dir==="LONG"?x.high>=tp1:x.low<=tp1);
    const tp2Hit=tp2!==null&&future.some(x=>dir==="LONG"?x.high>=tp2:x.low<=tp2);
    rows.push({
      pair,direction:dir,timestamp:t,entry,
      stop:Number.isFinite(stop)?stop:null,tp1,tp2,
      r4h:ret(entry,horizon(1)?.close,dir),r8h:ret(entry,horizon(2)?.close,dir),
      r12h:ret(entry,horizon(3)?.close,dir),r24h:ret(entry,horizon(6)?.close,dir),
      r48h:ret(entry,horizon(12)?.close,dir),r72h:ret(entry,horizon(18)?.close,dir),
      mae72:round(mae),mfe72:round(mfe),stopHit72:stopHit,tp1Hit72:tp1Hit,tp2Hit72:tp2Hit,
      exhaustion:String((result.market as any)?.entry1Exhaustion||"NONE"),reason:sig.reason
    });
  }
  return rows;
}

function avg(xs:(number|null)[]){const a=xs.filter((x):x is number=>x!==null&&Number.isFinite(x));return a.length?a.reduce((s,x)=>s+x,0)/a.length:null;}
function pct(xs:(number|null)[],fn:(x:number)=>boolean){const a=xs.filter((x):x is number=>x!==null&&Number.isFinite(x));return a.length?a.filter(fn).length/a.length*100:null;}

const all:Row[]=[];
for(const pair of PAIRS)all.push(...await runPair(pair));
console.log("\n=== CX SWITCH ENTRY_1 BACKTEST ===");
console.log(`Period: ${new Date(START).toISOString()} → ${new Date(END).toISOString()}`);
console.log(`Pairs: ${PAIRS.join(", ")} | Raw ENTRY_1 signals: ${all.length}`);
for(const pair of PAIRS){
  const r=all.filter(x=>x.pair===pair);
  console.log(`\\n${pair}: n=${r.length} | +24H avg=${round(avg(r.map(x=>x.r24h)))}% | +48H avg=${round(avg(r.map(x=>x.r48h)))}% | +72H avg=${round(avg(r.map(x=>x.r72h)))}% | MFE72 avg=${round(avg(r.map(x=>x.mfe72)))}% | MAE72 avg=${round(avg(r.map(x=>x.mae72)))}% | stop72=${round(pct(r.map(x=>x.stopHit72?1:0),x=>x>0))}% | TP1 72H=${round(pct(r.map(x=>x.tp1Hit72?1:0),x=>x>0))}% | TP2 72H=${round(pct(r.map(x=>x.tp2Hit72?1:0),x=>x>0))}%`);
}
if(all.length){
  console.log("\nTimestamp,Pair,Direction,Entry,+4H,+8H,+12H,+24H,+48H,+72H,MAE72,MFE72,Stop72,TP1_72,TP2_72");
  for(const r of all)console.log([
    new Date(r.timestamp).toISOString(),r.pair,r.direction,r.entry.toFixed(6),
    r.r4h?.toFixed(3)??"",r.r8h?.toFixed(3)??"",r.r12h?.toFixed(3)??"",
    r.r24h?.toFixed(3)??"",r.r48h?.toFixed(3)??"",r.r72h?.toFixed(3)??"",
    r.mae72??"",r.mfe72??"",r.stopHit72,r.tp1Hit72,r.tp2Hit72
  ].join(","));
}
