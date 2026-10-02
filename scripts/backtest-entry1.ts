import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { execFileSync } from "node:child_process";
import { generateSignal, type Candle } from "../lib/strategy";

type Pair = "BTC"|"ETH"|"SOL"|"DOGE";
type NearMissRow = {
  pair:string; direction:"LONG"|"SHORT"; timestamp:number; blocker:string;
  r24h:number|null; r48h:number|null; r72h:number|null; mae72:number|null; mfe72:number|null;
  stopHit72:boolean; tp1Hit72:boolean; tp2Hit72:boolean; passed:number;
};

type Row = {
  pair:string; direction:"LONG"|"SHORT"; timestamp:number; entry:number;
  stop:number|null; tp1:number|null; tp2:number|null;
  r4h:number|null; r8h:number|null; r12h:number|null; r24h:number|null;
  r48h:number|null; r72h:number|null;
  mae72:number|null; mfe72:number|null;
  stopHit72:boolean; tp1Hit72:boolean; tp2Hit72:boolean;
  exhaustion:string; reason:string; mode:Mode;
};

const VISION_BASE="https://data.binance.vision/data/futures/um";
const PAIRS=(process.env.BACKTEST_PAIRS||"BTC,ETH,SOL,DOGE").split(",").map(x=>x.trim().toUpperCase()).filter(Boolean) as Pair[];
const MONTHS=Math.max(6,Number(process.env.BACKTEST_MONTHS||18));
const FOUR_H=4*60*60*1000;
const MODES=["BASELINE","RELAX_RSI","RELAX_PREBREAK","RELAX_RSI_AND_PREBREAK"] as const;
type Mode=typeof MODES[number];
const END=Date.now()-2*24*60*60*1000;
const START=END-MONTHS*30.4375*24*60*60*1000;
const CACHE_DIR=process.env.BACKTEST_CACHE||path.join(os.tmpdir(),"cxswitch-binance-vision");

function monthStarts(start:number,end:number){
  const out:string[]=[];
  const d=new Date(start); d.setUTCDate(1); d.setUTCHours(0,0,0,0);
  while(d.getTime()<=end){out.push(d.toISOString().slice(0,7));d.setUTCMonth(d.getUTCMonth()+1);}
  return out;
}
function archiveUrl(symbol:string,interval:string,ym:string,kind:"monthly"|"daily",day?:string){
  const suffix=kind==="monthly"?ym:ym+"-"+day;
  return VISION_BASE+"/"+kind+"/klines/"+symbol+"/"+interval+"/"+symbol+"-"+interval+"-"+suffix+".zip";
}
function csvToCandles(csv:string):Candle[]{
  const out:Candle[]=[];
  for(const line of csv.split(/\r?\n/)){
    if(!line||/^open time/i.test(line))continue;
    const x=line.split(",");
    if(x.length<6)continue;
    let timestamp=Number(x[0]);
    if(!Number.isFinite(timestamp))continue;
    if(timestamp<1e12)timestamp*=1000;
    const open=Number(x[1]),high=Number(x[2]),low=Number(x[3]),close=Number(x[4]),volume=Number(x[5]);
    if([open,high,low,close,volume].every(Number.isFinite))out.push({timestamp,open,high,low,close,volume});
  }
  return out;
}
async function downloadArchive(url:string,cachePath:string){
  await fs.promises.mkdir(path.dirname(cachePath),{recursive:true});
  if(fs.existsSync(cachePath))return;
  const res=await fetch(url);
  if(!res.ok)throw new Error("Binance Vision archive HTTP "+res.status+": "+url);
  const buf=Buffer.from(await res.arrayBuffer());
  await fs.promises.writeFile(cachePath,buf);
}
async function readArchive(url:string,cachePath:string):Promise<Candle[]>{
  await downloadArchive(url,cachePath);
  const csv=execFileSync("unzip",["-p",cachePath],{encoding:"utf8",maxBuffer:256*1024*1024});
  return csvToCandles(csv);
}
function aggregateWeekly(rows:Candle[]):Candle[]{
  const buckets=new Map<number,Candle>();
  for(const row of rows){
    const d=new Date(row.timestamp); const day=d.getUTCDay();
    const mondayOffset=day===0?6:day-1;
    const ts=Date.UTC(d.getUTCFullYear(),d.getUTCMonth(),d.getUTCDate()-mondayOffset);
    const existing=buckets.get(ts);
    if(!existing)buckets.set(ts,{timestamp:ts,open:row.open,high:row.high,low:row.low,close:row.close,volume:row.volume});
    else{existing.high=Math.max(existing.high,row.high);existing.low=Math.min(existing.low,row.low);existing.close=row.close;existing.volume+=row.volume;}
  }
  return [...buckets.values()].sort((a,b)=>a.timestamp-b.timestamp);
}

async function fetchKlines(symbol:string,interval:string,start:number,end:number):Promise<Candle[]>{
  if(interval==="1w")return aggregateWeekly(await fetchKlines(symbol,"1d",start,end));
  const months=monthStarts(start,end);
  const out:Candle[]=[];
  for(const ym of months){
    const parts=ym.split("-"); const year=parts[0],month=parts[1];
    const file=path.join(CACHE_DIR,symbol,interval,symbol+"-"+interval+"-"+ym+".zip");
    try{
      const rows=await readArchive(archiveUrl(symbol,interval,ym,"monthly"),file);
      out.push(...rows);
      continue;
    }catch(err){
      const d=new Date(Date.UTC(Number(year),Number(month)-1,1));
      const next=new Date(Date.UTC(Number(year),Number(month),1));
      const monthEnd=Math.min(end,next.getTime()-1);
      if(monthEnd<start)continue;
      for(;d.getTime()<=monthEnd;d.setUTCDate(d.getUTCDate()+1)){
        const day=d.toISOString().slice(8,10);
        const dayStart=Math.max(start,d.getTime()),dayEnd=Math.min(end,d.getTime()+24*60*60*1000-1);
        if(dayEnd<dayStart)continue;
        const dailyFile=path.join(CACHE_DIR,symbol,interval,symbol+"-"+interval+"-"+ym+"-"+day+".zip");
        try{
          const rows=await readArchive(archiveUrl(symbol,interval,ym,"daily",day),dailyFile);
          out.push(...rows);
        }catch(dailyErr){
          throw new Error("Could not load Binance Vision data for "+symbol+" "+interval+" "+ym+": monthly and daily archives unavailable. "+String(dailyErr));
        }
      }
    }
  }
  const byTs=new Map<number,Candle>();
  for(const row of out)if(row.timestamp>=start&&row.timestamp<=end)byTs.set(row.timestamp,row);
  const rows=[...byTs.values()].sort((a,b)=>a.timestamp-b.timestamp);
  if(!rows.length)throw new Error("No Binance Vision candles loaded for "+symbol+" "+interval);
  return rows;
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

async function runPair(pair:Pair):Promise<{rows:Row[];nearMisses:NearMissRow[]}>{
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
  const nearMisses:NearMissRow[]=[];
  let p1=-1,p15=-1,pw=-1;
  let lastBreakout:any=undefined;
  for(let i=300;i<c4.length-18;i++){
    const t=c4[i].timestamp;
    while(p1+1<c1.length&&c1[p1+1].timestamp<=t)p1++;
    while(p15+1<c15.length&&c15[p15+1].timestamp<=t)p15++;
    while(pw+1<cw.length&&cw[pw+1].timestamp<=t)pw++;
    if(p1<0||p15<0||pw<0)continue;
    const h1=c1.slice(Math.max(0,p1-1200),p1+1), m15=c15.slice(Math.max(0,p15-3000),p15+1), w=cw.slice(Math.max(0,pw-40),pw+1);
    const current=c4[i];
    const result=generateSignal(pair,h1,c4.slice(Math.max(0,i-500),i+1),m15,[],current.close,lastBreakout,undefined,w,undefined,t);
    if(result.breakout)lastBreakout=result.breakout;
    const market:any=result.market;
    const future=c4.slice(i+1,i+19);
    const outcome=(dir:"LONG"|"SHORT")=>{
      const entry=current.close;
      const stopGuess=dir==="LONG" ? Math.min(...c4.slice(Math.max(0,i-10),i+1).map(x=>x.low)) : Math.max(...c4.slice(Math.max(0,i-10),i+1).map(x=>x.high));
      const highs=future.map(x=>x.high),lows=future.map(x=>x.low);
      const mfe=dir==="LONG"?(Math.max(...highs)-entry)/entry*100:(entry-Math.min(...lows))/entry*100;
      const mae=dir==="LONG"?(Math.min(...lows)-entry)/entry*100:(entry-Math.max(...highs))/entry*100;
      return {entry,stop:stopGuess,mfe,mae,stopHit:future.some(x=>dir==="LONG"?x.low<=stopGuess:x.high>=stopGuess)};
    };
    const sig=result.signal;
    if(!sig||sig.type!=="ENTRY_1"){
      for(const direction of ["LONG","SHORT"] as const){
        const ch=direction==="LONG"?market?.entry1CheckLong:market?.entry1CheckShort;
        if(!ch)continue;
        const dailyDirection=market?.entry1Direction||"NEUTRAL";
        const directionGate=direction==="LONG"?dailyDirection==="LONG":dailyDirection==="SHORT";
        const gates=[directionGate,!!ch.dailyPreBreak,!!ch.dailyRsiTurn,!!ch.fourHPreBreak,!!ch.transition,!ch.exhausted];
        const passed=gates.filter(Boolean).length;
        if(passed!==5)continue;
        const blockerNames=["DAILY_DIRECTION","1D_PREBREAK","1D_RSI_TURN","4H_PREBREAK","4H_TRANSITION","EXHAUSTION"];
        const blocker=blockerNames[gates.findIndex(x=>!x)];
        const o=outcome(direction);
        nearMisses.push({pair,direction,timestamp:t,blocker,r24h:ret(o.entry,future[5]?.close,direction),r48h:ret(o.entry,future[11]?.close,direction),r72h:ret(o.entry,future[17]?.close,direction),mae72:round(o.mae),mfe72:round(o.mfe),stopHit72:o.stopHit,tp1Hit72:false,tp2Hit72:false,passed});
      }
      continue;
    }

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
      pair,direction:dir,timestamp:t,entry,mode:process.env.BACKTEST_MODE as Mode,
      stop:Number.isFinite(stop)?stop:null,tp1,tp2,
      r4h:ret(entry,horizon(1)?.close,dir),r8h:ret(entry,horizon(2)?.close,dir),
      r12h:ret(entry,horizon(3)?.close,dir),r24h:ret(entry,horizon(6)?.close,dir),
      r48h:ret(entry,horizon(12)?.close,dir),r72h:ret(entry,horizon(18)?.close,dir),
      mae72:round(mae),mfe72:round(mfe),stopHit72:stopHit,tp1Hit72:tp1Hit,tp2Hit72:tp2Hit,
      exhaustion:String((result.market as any)?.entry1Exhaustion||"NONE"),reason:sig.reason
    });
  }
  return {rows,nearMisses};
}

function avg(xs:(number|null)[]){const a=xs.filter((x):x is number=>x!==null&&Number.isFinite(x));return a.length?a.reduce((s,x)=>s+x,0)/a.length:null;}
function pct(xs:(number|null)[],fn:(x:number)=>boolean){const a=xs.filter((x):x is number=>x!==null&&Number.isFinite(x));return a.length?a.filter(fn).length/a.length*100:null;}

async function main(){
const all:Row[]=[];
const nearAll:NearMissRow[]=[];
for(const mode of MODES){ process.env.BACKTEST_MODE=mode; console.log("\n=== MODE "+mode+" ==="); for(const pair of PAIRS){const r=await runPair(pair); all.push(...r.rows); nearAll.push(...r.nearMisses.map(x=>({...x,blocker:x.blocker+"@"+mode})));} }
console.log("\n=== CX SWITCH ENTRY_1 BACKTEST ===");
console.log(`Period: ${new Date(START).toISOString()} → ${new Date(END).toISOString()}`);
console.log(`Pairs: ${PAIRS.join(", ")} | Modes: ${MODES.join(", ")} | Raw ENTRY_1 signals: ${all.length} | 5/6 near-misses: ${nearAll.length}`);
for(const mode of MODES){
for(const pair of PAIRS){
  const r=all.filter(x=>x.pair===pair&&x.mode===mode);
  console.log(`\\n${pair}: n=${r.length} | +24H avg=${round(avg(r.map(x=>x.r24h)))}% | +48H avg=${round(avg(r.map(x=>x.r48h)))}% | +72H avg=${round(avg(r.map(x=>x.r72h)))}% | MFE72 avg=${round(avg(r.map(x=>x.mfe72)))}% | MAE72 avg=${round(avg(r.map(x=>x.mae72)))}% | stop72=${round(pct(r.map(x=>x.stopHit72?1:0),x=>x>0))}% | TP1 72H=${round(pct(r.map(x=>x.tp1Hit72?1:0),x=>x>0))}% | TP2 72H=${round(pct(r.map(x=>x.tp2Hit72?1:0),x=>x>0))}%`);
}
}
console.log("\n=== 5/6 NEAR-MISS ANALYSIS ===");
for(const mode of MODES){
  for(const pair of PAIRS){
    const r=nearAll.filter(x=>x.pair===pair&&x.blocker.endsWith("@"+mode));
    if(!r.length){console.log(pair+" "+mode+": n=0");continue;}
    const blockers=[...new Set(r.map(x=>x.blocker.split("@")[0]))];
    console.log(pair+" "+mode+": n="+r.length+" | blockers="+blockers.map(b=>b+":"+r.filter(x=>x.blocker===b+"@"+mode).length).join(" ")+" | +24H avg="+round(avg(r.map(x=>x.r24h)) )+"% | +48H avg="+round(avg(r.map(x=>x.r48h)))+"% | +72H avg="+round(avg(r.map(x=>x.r72h)))+"% | MFE72 avg="+round(avg(r.map(x=>x.mfe72)))+"% | MAE72 avg="+round(avg(r.map(x=>x.mae72)))+"% | stop72="+round(pct(r.map(x=>x.stopHit72?1:0),x=>x>0))+"%");
  }
}
console.log("\nTop individual 5/6 near-misses:");
for(const r of nearAll.slice().sort((a,b)=>(b.mfe72??-999)-(a.mfe72??-999)).slice(0,30)) console.log(new Date(r.timestamp).toISOString()+","+r.pair+","+r.direction+",BLOCKER="+r.blocker+",24H="+(r.r24h?.toFixed(3)??"")+",48H="+(r.r48h?.toFixed(3)??"")+",72H="+(r.r72h?.toFixed(3)??"")+",MAE="+(r.mae72??"")+",MFE="+(r.mfe72??"")+",STOP="+r.stopHit72);

if(all.length){
  console.log("\nTimestamp,Pair,Direction,Entry,+4H,+8H,+12H,+24H,+48H,+72H,MAE72,MFE72,Stop72,TP1_72,TP2_72");
  for(const r of all)console.log([
    new Date(r.timestamp).toISOString(),r.pair,r.direction,r.entry.toFixed(6),
    r.r4h?.toFixed(3)??"",r.r8h?.toFixed(3)??"",r.r12h?.toFixed(3)??"",
    r.r24h?.toFixed(3)??"",r.r48h?.toFixed(3)??"",r.r72h?.toFixed(3)??"",
    r.mae72??"",r.mfe72??"",r.stopHit72,r.tp1Hit72,r.tp2Hit72
  ].join(","));
}

}

main().catch(err=>{console.error(err);process.exit(1);});
