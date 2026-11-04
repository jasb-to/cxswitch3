#!/usr/bin/env node
"use strict";

/*
 * A: exact June V28 source at 35d717c.
 * B: current main source pinned at 13e648ff (signal version 32).
 * Sources are fetched by immutable commit, transpiled and isolated in VM contexts.
 * Binance Vision SPOT monthly 4h + 1d data. One extra warm-up month is downloaded;
 * only the latest six complete calendar months are scored.
 * Signal at 4h close; manage from subsequent candles. OHLC stop/target checks
 * are conservative (stop first if both levels are touched). Gross PnL excludes
 * fees, slippage and funding. Fixed $100 risk on $10,000 starting equity.
 */

const fs = require("node:fs");
const path = require("node:path");
const os = require("node:os");
const vm = require("node:vm");
const { execFileSync } = require("node:child_process");

const REPO = "jasb-to/cxswitch3";
const V28_SHA = "35d717c";
const CURRENT_SHA = "13e648ffef18d15b6107621b0a9b787c103460f6";
const SYMBOLS = ["BTCUSDT", "SOLUSDT", "DOGEUSDT", "ZECUSDT"];
const START_EQUITY = 10000;
const RISK_DOLLARS = 100;
let replayNow = Date.now();

class ReplayDate extends Date { static now() { return replayNow; } }

function monthKey(d) {
  return String(d.getUTCFullYear()) + "-" + String(d.getUTCMonth()+1).padStart(2,"0");
}
function addMonths(d,n) { return new Date(Date.UTC(d.getUTCFullYear(),d.getUTCMonth()+n,1)); }
function parseKlineCsv(csv) {
  const out=[];
  for (const line of csv.split(/\r?\n/)) {
    if (!line || !/^\d/.test(line)) continue;
    const p=line.split(",");
    if (p.length<6) continue;
    let timestamp=Number(p[0]);
    if (!Number.isFinite(timestamp)) continue;
    if (timestamp>1e14) timestamp=Math.floor(timestamp/1000);
    out.push({timestamp,open:Number(p[1]),high:Number(p[2]),low:Number(p[3]),close:Number(p[4]),volume:Number(p[5])});
  }
  return out.filter(c=>[c.timestamp,c.open,c.high,c.low,c.close,c.volume].every(Number.isFinite));
}
async function fetchWithRetry(url,attempts=4) {
  let last;
  for(let i=0;i<attempts;i++) {
    try {
      const res=await fetch(url,{headers:{"user-agent":"cxswitch-v28-comparison/1.0"}});
      if(!res.ok) throw new Error("HTTP "+res.status+" "+url);
      return Buffer.from(await res.arrayBuffer());
    } catch(e) { last=e; await new Promise(r=>setTimeout(r,500*(i+1))); }
  }
  throw last;
}
async function downloadMonthly(symbol,interval,month,tmp) {
  const filename=symbol+"-"+interval+"-"+month+".zip";
  const url="https://data.binance.vision/data/spot/monthly/klines/"+symbol+"/"+interval+"/"+filename;
  const zipPath=path.join(tmp,filename);
  fs.writeFileSync(zipPath,await fetchWithRetry(url));
  let csv;
  try { csv=execFileSync("unzip",["-p",zipPath],{encoding:"utf8",maxBuffer:64*1024*1024}); }
  catch(e) { throw new Error("Could not extract "+filename+": "+e.message); }
  return parseKlineCsv(csv);
}
async function loadMarketData(tmp,simStart,simEnd) {
  const warmupStart=addMonths(new Date(simStart),-1),months=[];
  for(let d=warmupStart;d<new Date(simEnd);d=addMonths(d,1)) months.push(monthKey(d));
  const all={};
  for(const symbol of SYMBOLS) {
    const four=[],one=[];
    for(const month of months) {
      process.stdout.write("Downloading "+symbol+" "+month+" 4h + 1d ... ");
      const pair=await Promise.all([
        downloadMonthly(symbol,"4h",month,tmp),
        downloadMonthly(symbol,"1d",month,tmp)
      ]);
      four.push(...pair[0]); one.push(...pair[1]);
      process.stdout.write(pair[0].length+" / "+pair[1].length+"\n");
    }
    const dedupe=rows=>[...new Map(rows.map(x=>[x.timestamp,x])).values()].sort((a,b)=>a.timestamp-b.timestamp);
    all[symbol]={four:dedupe(four),one:dedupe(one)};
  }
  return all;
}
async function fetchStrategy(sha) {
  const url="https://raw.githubusercontent.com/"+REPO+"/"+sha+"/lib/strategy.ts";
  return (await fetchWithRetry(url)).toString("utf8");
}
function loadStrategy(source,label) {
  const ts=require("typescript");
  const js=ts.transpileModule(source,{compilerOptions:{module:ts.ModuleKind.CommonJS,target:ts.ScriptTarget.ES2022,esModuleInterop:true},reportDiagnostics:true});
  const errors=(js.diagnostics||[]).filter(d=>d.category===ts.DiagnosticCategory.Error);
  if(errors.length) throw new Error(label+" transpile failed: "+errors.map(d=>ts.flattenDiagnosticMessageText(d.messageText,"\n")).join("; "));
  const mod={exports:{}};
  const sandbox={module:mod,exports:mod.exports,require,process:{env:{}},Date:ReplayDate,console,Buffer,setTimeout,clearTimeout};
  vm.runInNewContext(js.outputText,sandbox,{filename:label+"-strategy.js",timeout:10000});
  if(typeof mod.exports.generateSignal!=="function"||typeof mod.exports.shouldHold!=="function") throw new Error(label+" source missing strategy exports");
  return mod.exports;
}
function dailyFrom4h(candles) {
  const groups=new Map();
  for(const c of candles) {
    const key=new Date(c.timestamp).toISOString().slice(0,10);
    if(!groups.has(key)) groups.set(key,[]);
    groups.get(key).push(c);
  }
  return [...groups.values()].map(b=>({timestamp:b[0].timestamp,open:b[0].open,high:Math.max(...b.map(x=>x.high)),low:Math.min(...b.map(x=>x.low)),close:b[b.length-1].close,volume:b.reduce((s,x)=>s+x.volume,0)}));
}
function checkDailyIntegrity(four,one) {
  const agg=dailyFrom4h(four),dailyMap=new Map(one.map(x=>[new Date(x.timestamp).toISOString().slice(0,10),x]));
  let compared=0,mismatches=0,maxDiff=0;
  for(const d of agg) {
    const ref=dailyMap.get(new Date(d.timestamp).toISOString().slice(0,10));
    if(!ref) continue;
    const diff=Math.abs(d.close-ref.close)/ref.close*100;
    compared++; maxDiff=Math.max(maxDiff,diff);
    if(diff>0.15) mismatches++;
  }
  return {compared,mismatches,maxCloseDifferencePct:+maxDiff.toFixed(4)};
}
function makeTrade(pair,signal,time,variant) {
  const entry=Number(signal.entry),stop=Number(signal.stop),risk=Math.abs(entry-stop);
  if(!(entry>0&&risk>0&&Number.isFinite(risk))) return null;
  return {pair,direction:signal.direction,entry,initialStop:stop,stop,target:variant==="V28"?Number(signal.target):null,
    entryTime:time,exitTime:null,exit:null,exitReason:null,pnlPct:null,r:null,pnlUsd:null,
    initialRisk:risk,signalType:signal.scale||signal.type,strategy:variant};
}
function closeTrade(t,price,time,reason) {
  t.exit=price; t.exitTime=time; t.exitReason=reason;
  const move=t.direction==="LONG"?(price-t.entry)/t.entry:(t.entry-price)/t.entry;
  t.pnlPct=move*100; t.r=move/(t.initialRisk/t.entry); t.pnlUsd=t.r*RISK_DOLLARS;
}
function summarize(trades) {
  let equity=START_EQUITY,peak=START_EQUITY,maxDd=0,wins=0,sumR=0,net=0;
  for(const t of trades) {
    if(t.r>0) wins++;
    sumR+=t.r; net+=t.pnlUsd; equity+=t.pnlUsd; peak=Math.max(peak,equity);
    maxDd=Math.max(maxDd,(peak-equity)/peak*100);
  }
  return {totalTrades:trades.length,winRate:trades.length?100*wins/trades.length:0,
    averageR:trades.length?sumR/trades.length:0,maxDrawdownPct:maxDd,netPnlUsd:net,netReturnPct:net/START_EQUITY*100};
}
function fmt(n,d=2) { return Number(n).toFixed(d); }
function renderTable(a,b) {
  const rows=[["Total Trades",a.totalTrades,b.totalTrades],["Win Rate",fmt(a.winRate)+"%",fmt(b.winRate)+"%"],
    ["Average R",fmt(a.averageR,3),fmt(b.averageR,3)],["Max Drawdown",fmt(a.maxDrawdownPct)+"%",fmt(b.maxDrawdownPct)+"%"],
    ["Net PnL","$"+fmt(a.netPnlUsd),"$"+fmt(b.netPnlUsd)],["Net Return",fmt(a.netReturnPct)+"%",fmt(b.netReturnPct)+"%"]];
  console.log("\nMETRIC                 JUNE V28       CURRENT MAIN");
  console.log("--------------------------------------------------");
  for(const row of rows) console.log(row[0].padEnd(22)+" "+String(row[1]).padStart(12)+" "+String(row[2]).padStart(15));
}
function runVariant(label,strategy,market,startTs,endTs) {
  const trades=[];
  for(const symbol of SYMBOLS) {
    const rows=market[symbol].four;
    let open=null;
    for(let i=100;i<rows.length;i++) {
      const bar=rows[i];
      if(bar.timestamp<startTs||bar.timestamp>=endTs) continue;
      replayNow=bar.timestamp;
      const history=rows.slice(0,i+1);
      if(open) {
        const stopHit=open.direction==="LONG"?bar.low<=open.stop:bar.high>=open.stop;
        const targetHit=open.target!==null&&(open.direction==="LONG"?bar.high>=open.target:bar.low<=open.target);
        if(stopHit) { closeTrade(open,open.stop,bar.timestamp,"initial_stop"); trades.push(open); open=null; continue; }
        if(targetHit) { closeTrade(open,open.target,bar.timestamp,"5ATR_target"); trades.push(open); open=null; continue; }
        const hold=strategy.shouldHold(open._signal,history,bar.close,bar.timestamp);
        // V28 validity has signal-only expiry checks (missed_entry / TTL). Once
        // filled, these are not position exits; preserve the requested EMA21/Stoch
        // exit comparison and let the hard stop / 5ATR target manage the position.
        const v28SignalExpiry=label==="V28"&&hold&&["missed_entry","expired_ttl"].includes(hold.reason);
        if(hold&&hold.newStop!==undefined&&Number.isFinite(hold.newStop)) { open.stop=hold.newStop; open._signal.stop=hold.newStop; }
        if(hold&&hold.shouldHold===false&&!v28SignalExpiry) { closeTrade(open,bar.close,bar.timestamp,hold.reason||"strategy_exit"); trades.push(open); open=null; continue; }
        continue;
      }
      let result;
      try { result=strategy.generateSignal(symbol,[],history,[],bar.close,bar.timestamp,undefined,undefined,false,[]); }
      catch(e) { throw new Error(label+" "+symbol+" "+new Date(bar.timestamp).toISOString()+" signal error: "+e.message); }
      const signal=result&&result.signal;
      if(!signal) continue;
      const scale=signal.scale||signal.type;
      if(scale!=="ENTRY_1"&&scale!=="ENTRY_2") continue;
      const trade=makeTrade(symbol,signal,bar.timestamp,label);
      if(!trade) continue;
      trade._signal=signal; open=trade;
    }
    if(open) {
      const last=rows.filter(x=>x.timestamp<endTs).at(-1);
      if(last) { closeTrade(open,last.close,last.timestamp,"end_of_test"); trades.push(open); }
    }
  }
  return trades.sort((a,b)=>a.exitTime-b.exitTime||a.entryTime-b.entryTime);
}
function stripInternal(trades) { return trades.map(({_signal,...t})=>t); }
function writeCsv(file,trades) {
  const fields=["strategy","pair","direction","signalType","entryTime","entry","stop","target","exitTime","exit","exitReason","pnlPct","r","pnlUsd"];
  const q=v=>'"'+String(v??"").replace(/"/g,'""')+'"';
  fs.writeFileSync(file,[fields.join(","),...trades.map(t=>fields.map(k=>q(t[k])).join(","))].join("\n"));
}
async function main() {
  const now=new Date(),end=new Date(Date.UTC(now.getUTCFullYear(),now.getUTCMonth(),1)),start=addMonths(end,-6);
  const startTs=start.getTime(),endTs=end.getTime(),tmp=fs.mkdtempSync(path.join(os.tmpdir(),"cxswitch-backtest-"));
  fs.mkdirSync("artifacts",{recursive:true});
  console.log("Scored window: "+start.toISOString().slice(0,10)+" through "+new Date(endTs-1).toISOString().slice(0,10));
  console.log("Warm-up starts: "+addMonths(start,-1).toISOString().slice(0,10));
  console.log("V28 source: "+V28_SHA+" | current source: "+CURRENT_SHA);
  const sources=await Promise.all([fetchStrategy(V28_SHA),fetchStrategy(CURRENT_SHA)]);
  const v28=loadStrategy(sources[0],"June V28"),current=loadStrategy(sources[1],"Current main");
  const versionA=v28.CURRENT_SIGNAL_VERSION,versionB=current.CURRENT_SIGNAL_VERSION;
  console.log("Loaded source versions: V28="+versionA+", current="+versionB);
  if(versionA!==28) throw new Error("Expected V28 version 28, got "+versionA);
  if(versionB!==32) throw new Error("Pinned current source is not version 32, got "+versionB);
  const market=await loadMarketData(tmp,startTs,endTs),integrity={};
  for(const symbol of SYMBOLS) {
    const m=market[symbol],inWindow=m.four.filter(c=>c.timestamp>=startTs&&c.timestamp<endTs);
    if(inWindow.length<800) throw new Error(symbol+": only "+inWindow.length+" 4h bars; expected approximately 1,100");
    integrity[symbol]={fourHourBars:inWindow.length,dailyBars:m.one.filter(c=>c.timestamp>=startTs&&c.timestamp<endTs).length,dailyCheck:checkDailyIntegrity(m.four,m.one)};
    console.log(symbol+": "+JSON.stringify(integrity[symbol]));
  }
  const tradesA=runVariant("V28",v28,market,startTs,endTs),tradesB=runVariant("CURRENT",current,market,startTs,endTs);
  const a=summarize(tradesA),b=summarize(tradesB);
  renderTable(a,b);
  const all=[...stripInternal(tradesA),...stripInternal(tradesB)].sort((x,y)=>x.entryTime-y.entryTime||x.pair.localeCompare(y.pair)||x.strategy.localeCompare(y.strategy));
  writeCsv("artifacts/trades.csv",all);
  const report={window:{start:start.toISOString(),end:end.toISOString()},
    source:{v28:{commit:V28_SHA,signalVersion:versionA},current:{commit:CURRENT_SHA,signalVersion:versionB}},
    assumptions:{startingEquityUsd:START_EQUITY,fixedRiskUsdPerTrade:RISK_DOLLARS,feesAndSlippage:"excluded",
      execution:"signal at 4H close; exits from subsequent 4H candles; stop-first if stop and target both touched"},
    dataIntegrity:integrity,summary:{v28:a,current:b},trades:all};
  fs.writeFileSync("artifacts/report.json",JSON.stringify(report,null,2));
  console.log("\nTrade records: artifacts/trades.csv ("+all.length+" rows)");
  console.log("Full report: artifacts/report.json");
  fs.rmSync(tmp,{recursive:true,force:true});
}
main().catch(e=>{console.error("\nBACKTEST FAILED:",e.stack||e);process.exitCode=1;});
