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
const CURRENT_SHA = "81d64df974632d8d9f2a355e9e6a9a90c62ed6c0";
const CURRENT_VERSION = 38;
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
async function fetchSource(sha,filePath) {
  const url="https://raw.githubusercontent.com/"+REPO+"/"+sha+"/"+filePath;
  return (await fetchWithRetry(url)).toString("utf8");
}
function compileModule(source,label,dependencies={}) {
  const ts=require("typescript");
  const js=ts.transpileModule(source,{compilerOptions:{module:ts.ModuleKind.CommonJS,target:ts.ScriptTarget.ES2022,esModuleInterop:true},reportDiagnostics:true});
  const errors=(js.diagnostics||[]).filter(d=>d.category===ts.DiagnosticCategory.Error);
  if(errors.length) throw new Error(label+" transpile failed: "+errors.map(d=>ts.flattenDiagnosticMessageText(d.messageText,"\n")).join("; "));
  const mod={exports:{}};
  const moduleRequire=(id)=>Object.prototype.hasOwnProperty.call(dependencies,id)?dependencies[id]:require(id);
  const sandbox={module:mod,exports:mod.exports,require:moduleRequire,process:{env:{}},Date:ReplayDate,console,Buffer,setTimeout,clearTimeout};
  vm.runInNewContext(js.outputText,sandbox,{filename:label+".js",timeout:10000});
  return mod.exports;
}
function loadStrategy(source,label,dependencies={}) {
  const out=compileModule(source,label+"-strategy",dependencies);
  if(typeof out.generateSignal!=="function"||typeof out.shouldHold!=="function") throw new Error(label+" source missing strategy exports");
  return out;
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
function makeTrade(pair,signal,time,variant,exitLabel,useV28Target) {
  const entry=Number(signal.entry),stop=Number(signal.stop),risk=Math.abs(entry-stop);
  if(!(entry>0&&risk>0&&Number.isFinite(risk))) return null;
  const exitSignal={...signal};
  if(exitLabel==="CURRENT_V38") {
    if(!Number.isFinite(Number(exitSignal.tp1))) exitSignal.tp1=signal.direction==="LONG"?entry*1.05:entry*0.95;
    if(!Number.isFinite(Number(exitSignal.tp2))) exitSignal.tp2=signal.direction==="LONG"?entry*1.10:entry*0.90;
  }
  return {pair,direction:signal.direction,entry,initialStop:stop,stop,stopType:"initial",
    target:useV28Target?Number(signal.target):null,
    tp1:exitLabel==="CURRENT_V38"?Number(exitSignal.tp1):null,
    tp2:exitLabel==="CURRENT_V38"?Number(exitSignal.tp2):null,
    entryTime:time,exitTime:null,exit:null,exitReason:null,pnlPct:null,r:null,pnlUsd:null,
    initialRisk:risk,signalType:signal.scale||signal.type,strategy:variant,
    remainingFraction:1,realizedPnlUsd:0,realizedPct:0,tp1Done:false,tp1Exit:null,tp1PnlUsd:0,
    _signal:exitSignal};
}
function addPartial(t,price,time,fraction,reason) {
  const take=Math.min(t.remainingFraction,fraction);
  if(take<=0)return;
  const move=t.direction==="LONG"?(price-t.entry)/t.entry:(t.entry-price)/t.entry;
  const tradeR=move/(t.initialRisk/t.entry),pnl=tradeR*RISK_DOLLARS*take;
  t.realizedPnlUsd+=pnl;t.realizedPct+=move*100*take;t.remainingFraction-=take;
  if(reason==="tp1_scale_out"){t.tp1Done=true;t.tp1Exit=price;t.tp1PnlUsd=pnl;t.tp1HitAt=time;}
}
function closeTrade(t,price,time,reason) {
  const remain=t.remainingFraction??1;
  const move=t.direction==="LONG"?(price-t.entry)/t.entry:(t.entry-price)/t.entry;
  const tradeR=move/(t.initialRisk/t.entry);
  t.pnlUsd=(t.realizedPnlUsd??0)+tradeR*RISK_DOLLARS*remain;
  t.r=t.pnlUsd/RISK_DOLLARS;
  t.pnlPct=(t.realizedPct??0)+move*100*remain;
  t.exit=price;t.exitTime=time;t.exitReason=reason;t.remainingFraction=0;
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
function renderTable(a,b,c) {
  const rows=[["Total Trades",a.totalTrades,b.totalTrades,c.totalTrades],
    ["Win Rate",fmt(a.winRate)+"%",fmt(b.winRate)+"%",fmt(c.winRate)+"%"],
    ["Average R",fmt(a.averageR,3),fmt(b.averageR,3),fmt(c.averageR,3)],
    ["Max Drawdown",fmt(a.maxDrawdownPct)+"%",fmt(b.maxDrawdownPct)+"%",fmt(c.maxDrawdownPct)+"%"],
    ["Net PnL","$"+fmt(a.netPnlUsd),"$"+fmt(b.netPnlUsd),"$"+fmt(c.netPnlUsd)],
    ["Net Return",fmt(a.netReturnPct)+"%",fmt(b.netReturnPct)+"%",fmt(c.netReturnPct)+"%"]];
  console.log("\nMETRIC                 JUNE V28       PROD V38         MATCHED V28 ENTRIES");
  console.log("--------------------------------------------------------------------------");
  for(const row of rows) console.log(row[0].padEnd(22)+" "+String(row[1]).padStart(12)+" "+String(row[2]).padStart(15)+" "+String(row[3]).padStart(20));
}
function runVariant(label,entryStrategy,exitStrategy,exitLabel,useV28Target,market,startTs,endTs) {
  const trades=[];
  for(const symbol of SYMBOLS) {
    const rows=market[symbol].four;
    let open=null,lastBreakout;
    for(let i=100;i<rows.length;i++) {
      const bar=rows[i];
      if(bar.timestamp>=endTs) break;
      replayNow=bar.timestamp;
      const history=rows.slice(0,i+1);
      if(bar.timestamp<startTs) {
        try {
          const warm=entryStrategy.generateSignal(symbol,[],history,[],bar.close,bar.timestamp,lastBreakout);
          if(entryStrategy.CURRENT_SIGNAL_VERSION===38) lastBreakout=warm?.breakoutRecord;
        } catch(e) { throw new Error(label+" warm-up "+symbol+" "+new Date(bar.timestamp).toISOString()+": "+e.message); }
        continue;
      }
      if(open) {
        const stopHit=open.direction==="LONG"?bar.low<=open.stop:bar.high>=open.stop;
        if(stopHit) {
          closeTrade(open,open.stop,bar.timestamp,open.stopType==="initial"?"initial_stop":open.stopType+"_stop_hit");
          trades.push(open);open=null;continue;
        }
        if(open.target!==null) {
          const targetHit=open.direction==="LONG"?bar.high>=open.target:bar.low<=open.target;
          if(targetHit){closeTrade(open,open.target,bar.timestamp,"5ATR_target");trades.push(open);open=null;continue;}
        } else if(exitLabel==="CURRENT_V38") {
          const tp1Hit=open.direction==="LONG"?bar.high>=open.tp1:bar.low<=open.tp1;
          const tp2Hit=open.direction==="LONG"?bar.high>=open.tp2:bar.low<=open.tp2;
          if(tp1Hit&&!open.tp1Done) {
            addPartial(open,open.tp1,bar.timestamp,0.5,"tp1_scale_out");
            open._signal.tp1HitAt=bar.timestamp;
            open.stop=open.entry;open._signal.stop=open.entry;open.stopType="break_even";
          }
          if(tp2Hit) {
            closeTrade(open,open.tp2,bar.timestamp,"tp2_target");
            trades.push(open);open=null;continue;
          }
          if(open.tp1Done) {
            const beHit=open.direction==="LONG"?bar.low<=open.stop:bar.high>=open.stop;
            if(beHit){closeTrade(open,open.stop,bar.timestamp,"break_even_after_tp1");trades.push(open);open=null;continue;}
          }
        }
        const hold=exitStrategy.shouldHold(open._signal,history,bar.close,bar.timestamp);
        if(exitLabel==="V28"&&hold&&["missed_entry","expired_ttl"].includes(hold.reason)) continue;
        if(hold&&hold.scaleOut&&!open.tp1Done) {
          const level=Number(hold.scaleOut.level)||open.tp1;
          addPartial(open,level,bar.timestamp,Number(hold.scaleOut.size)||0.5,"tp1_scale_out");
          open._signal.tp1HitAt=bar.timestamp;
        }
        if(hold&&hold.newStop!==undefined&&Number.isFinite(hold.newStop)) {
          open.stop=hold.newStop;open._signal.stop=hold.newStop;
          open.stopType=Math.abs(open.stop-open.entry)<1e-10?"break_even":"chandelier";
        }
        if(hold&&hold.shouldHold===false) {
          closeTrade(open,bar.close,bar.timestamp,hold.reason||"strategy_exit");
          trades.push(open);open=null;continue;
        }
        continue;
      }
      let result;
      try { result=entryStrategy.generateSignal(symbol,[],history,[],bar.close,bar.timestamp,lastBreakout); }
      catch(e) { throw new Error(label+" "+symbol+" "+new Date(bar.timestamp).toISOString()+" signal error: "+e.message); }
      if(entryStrategy.CURRENT_SIGNAL_VERSION===38) lastBreakout=result?.breakoutRecord;
      const signal=result&&result.signal;
      if(!signal) continue;
      const scale=signal.scale||signal.type;
      if(scale!=="ENTRY_1"&&scale!=="ENTRY_2") continue;
      const trade=makeTrade(symbol,signal,bar.timestamp,label,exitLabel,useV28Target);
      if(!trade) continue;
      open=trade;
    }
    if(open) {
      const last=rows.filter(x=>x.timestamp<endTs).at(-1);
      if(last){closeTrade(open,last.close,last.timestamp,"end_of_test");trades.push(open);}
    }
  }
  return trades.sort((a,b)=>a.exitTime-b.exitTime||a.entryTime-b.entryTime);
}
function stripInternal(trades) { return trades.map(({_signal,...t})=>t); }
function writeCsv(file,trades) {
  const fields=["strategy","pair","direction","signalType","entryTime","entry","initialStop","stop","stopType","target","tp1","tp2","tp1Exit","tp1PnlUsd","exitTime","exit","exitReason","pnlPct","r","pnlUsd"];
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
  const sources=await Promise.all([fetchSource(V28_SHA,"lib/strategy.ts"),fetchSource(CURRENT_SHA,"lib/strategy.ts"),fetchSource(CURRENT_SHA,"lib/ema-diagnostic.ts")]);
  const emaDiagnostic=compileModule(sources[2],"production-ema-diagnostic");
  const v28Native=loadStrategy(sources[0],"June V28 native"),v28Matched=loadStrategy(sources[0],"June V28 matched entries");
  const currentDeps={"./ema-diagnostic":emaDiagnostic};
  const currentNative=loadStrategy(sources[1],"Production V38 native",currentDeps),currentMatched=loadStrategy(sources[1],"Production V38 matched exits",currentDeps);
  const versionA=v28Native.CURRENT_SIGNAL_VERSION,versionB=currentNative.CURRENT_SIGNAL_VERSION;
  console.log("Loaded source versions: V28="+versionA+", production="+versionB);
  if(versionA!==28) throw new Error("Expected V28 version 28, got "+versionA);
  if(versionB!==CURRENT_VERSION) throw new Error("Expected production version "+CURRENT_VERSION+", got "+versionB);
  const market=await loadMarketData(tmp,startTs,endTs),integrity={};
  for(const symbol of SYMBOLS) {
    const m=market[symbol],inWindow=m.four.filter(c=>c.timestamp>=startTs&&c.timestamp<endTs);
    if(inWindow.length<800) throw new Error(symbol+": only "+inWindow.length+" 4h bars; expected approximately 1,100");
    integrity[symbol]={fourHourBars:inWindow.length,dailyBars:m.one.filter(c=>c.timestamp>=startTs&&c.timestamp<endTs).length,dailyCheck:checkDailyIntegrity(m.four,m.one)};
    console.log(symbol+": "+JSON.stringify(integrity[symbol]));
  }
  const tradesA=runVariant("V28_NATIVE",v28Native,v28Native,"V28",true,market,startTs,endTs);
  const tradesB=runVariant("PRODUCTION_V38",currentNative,currentNative,"CURRENT_V38",false,market,startTs,endTs);
  const tradesC=runVariant("V28_ENTRIES_PRODUCTION_V38_EXITS",v28Matched,currentMatched,"CURRENT_V38",false,market,startTs,endTs);
  const a=summarize(tradesA),b=summarize(tradesB),c=summarize(tradesC);
  renderTable(a,b,c);
  const all=[...stripInternal(tradesA),...stripInternal(tradesB),...stripInternal(tradesC)].sort((x,y)=>x.entryTime-y.entryTime||x.pair.localeCompare(y.pair)||x.strategy.localeCompare(y.strategy));
  writeCsv("artifacts/trades.csv",all);
  const report={window:{start:start.toISOString(),end:end.toISOString()},
    source:{v28:{commit:V28_SHA,signalVersion:versionA,configuration:"Stoch 20/80; 5 ATR target; 20-bar swing / 2 ATR stop; EMA21 + Stoch exit"},production:{commit:CURRENT_SHA,signalVersion:versionB,configuration:"Stoch 20/80; 1D EMA5/13 direction; TP1 5% / TP2 10%; structural / 1.5 ATR stop; 5-bar / 0.5 ATR Chandelier after +3%; 1D EMA5/13 and 4H EMA8/21 exits"}},
    assumptions:{startingEquityUsd:START_EQUITY,fixedRiskUsdPerTrade:RISK_DOLLARS,feesAndSlippage:"excluded",
      execution:"signal at 4H close; exits from subsequent 4H candles; stop-first if stop and target both touched; production TP1 scales out 50% and moves stop to entry"},
    dataIntegrity:integrity,summary:{v28Native:a,productionV38Native:b,matchedV28EntriesProductionV38Exits:c},trades:all};
  fs.writeFileSync("artifacts/report.json",JSON.stringify(report,null,2));
  console.log("\nTrade records: artifacts/trades.csv ("+all.length+" rows)");
  console.log("Full report: artifacts/report.json");
  fs.rmSync(tmp,{recursive:true,force:true});
}
main().catch(e=>{console.error("\nBACKTEST FAILED:",e.stack||e);process.exitCode=1;});
