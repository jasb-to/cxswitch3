#!/usr/bin/env node
import fs from "node:fs/promises";
import { generateSignal } from "../lib/strategy.ts";

const SYMBOLS={BTC:"BTCUSDT",ETH:"ETHUSDT",SOL:"SOLUSDT",LINK:"LINKUSDT",AVAX:"AVAXUSDT"};
const H4=4*60*60*1000,DAY=24*60*60*1000;
const args=Object.fromEntries(process.argv.slice(2).map(x=>{const [k,v]=x.split("=");return[k.replace(/^--/,""),v||true]}));
const months=Number(args.months||6),output=String(args.output||"backtest-entry.csv");
const now=Date.now(),start=now-Math.round(months*30.4375*DAY);

async function fetchKlines(symbol,startTime,endTime){
  const rows=[];let cursor=startTime;
  while(cursor<endTime){
    const url=new URL("https://data-api.binance.vision/api/v3/klines");
    url.searchParams.set("symbol",symbol);url.searchParams.set("interval","4h");
    url.searchParams.set("startTime",String(cursor));url.searchParams.set("endTime",String(endTime));url.searchParams.set("limit","1000");
    const res=await fetch(url);if(!res.ok)throw new Error(`Binance ${symbol} HTTP ${res.status}`);
    const data=await res.json();if(!Array.isArray(data)||!data.length)break;
    rows.push(...data);const last=Number(data.at(-1)[0]),next=last+H4;if(next<=cursor)break;cursor=next;
    if(data.length<1000)break;await new Promise(r=>setTimeout(r,150));
  }
  const seen=new Set();
  return rows.filter(x=>{const t=Number(x[0]);if(seen.has(t))return false;seen.add(t);return true;}).map(x=>({
    timestamp:Number(x[0]),open:Number(x[1]),high:Number(x[2]),low:Number(x[3]),close:Number(x[4]),volume:Number(x[5])
  })).sort((a,b)=>a.timestamp-b.timestamp);
}
const cell=v=>{const s=String(v??"");return /[",\n]/.test(s)?`"${s.replaceAll('"','""')}"`:s};
const rows=[];
for(const [pair,symbol] of Object.entries(SYMBOLS)){
  console.log(`[BACKTEST] downloading ${pair} ${symbol} ...`);
  const candles=await fetchKlines(symbol,start,now);
  console.log(`[BACKTEST] ${pair}: ${candles.length} 4H candles`);
  for(let i=150;i<candles.length-18;i++){
    const current=candles[i],history=candles.slice(0,i+1);
    const result=generateSignal(pair,history,history,history,current.close,current.timestamp),s=result.signal;
    if(!s)continue;
    const future=candles.slice(i+1,i+19),returns={};
    for(const h of [1,2,3,6,12,18]){
      const bar=candles[i+h];if(!bar)continue;
      returns[`return_${h*4}h_pct`]=s.direction==="LONG"?(bar.close-s.entry)/s.entry*100:(s.entry-bar.close)/s.entry*100;
    }
    let mfe=-Infinity,mae=-Infinity,tp1Hit=false,tp2Hit=false,slHit=false;
    for(const bar of future){
      const favorable=s.direction==="LONG"?(bar.high-s.entry)/s.entry*100:(s.entry-bar.low)/s.entry*100;
      const adverse=s.direction==="LONG"?(s.entry-bar.low)/s.entry*100:(bar.high-s.entry)/s.entry*100;
      mfe=Math.max(mfe,favorable);mae=Math.max(mae,adverse);
      if(s.direction==="LONG"){tp1Hit ||= bar.high>=s.tp1;tp2Hit ||= bar.high>=s.tp2;slHit ||= bar.low<=s.stop;}
      else{tp1Hit ||= bar.low<=s.tp1;tp2Hit ||= bar.low<=s.tp2;slHit ||= bar.high>=s.stop;}
    }
    rows.push({pair,timestamp:new Date(s.timestamp).toISOString(),direction:s.direction,entry:s.entry,stop:s.stop,tp1:s.tp1,tp2:s.tp2,rr:s.rr,
      mfe_pct:Number.isFinite(mfe)?mfe.toFixed(4):"",mae_pct:Number.isFinite(mae)?mae.toFixed(4):"",tp1_hit:tp1Hit,tp2_hit:tp2Hit,sl_hit:slHit,...returns});
  }
}
const columns=["pair","timestamp","direction","entry","stop","tp1","tp2","rr","mfe_pct","mae_pct","tp1_hit","tp2_hit","sl_hit","return_4h_pct","return_8h_pct","return_12h_pct","return_24h_pct","return_48h_pct","return_72h_pct"];
await fs.writeFile(output,[columns.join(","),...rows.map(r=>columns.map(c=>cell(r[c])).join(","))].join("\n")+"\n","utf8");
console.log(`[BACKTEST] wrote ${rows.length} signals to ${output}`);
console.log(`[BACKTEST] requirement check: >=5 total signals = ${rows.length>=5?"PASS":"FAIL"}`);
for(const pair of Object.keys(SYMBOLS))console.log(`[BACKTEST] ${pair}: ${rows.filter(x=>x.pair===pair).length} signals`);
