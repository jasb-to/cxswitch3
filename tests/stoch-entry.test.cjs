const { test } = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const ts = require("typescript");
require.extensions[".ts"] = (module, filename) => {
  const source = fs.readFileSync(filename, "utf8");
  const output = ts.transpileModule(source, { fileName: filename, compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022, esModuleInterop: true } }).outputText;
  module._compile(output, filename);
};
const strategy = require("../lib/strategy.ts");

test("ENTRY_1 LONG fires on fresh bullish Stoch RSI cross at K=30",()=>{
  const result=strategy.evaluateEntry1("LONG",{pk:20,pd:25,k:30,d:28});
  assert.equal(result.entry1Long,true);
  assert.equal(result.entry1,true);
  assert.equal(result.direction,"LONG");
});
test("ENTRY_1 LONG fires on a fresh bullish cross at K=55 under the <70 threshold",()=>{
  const result=strategy.evaluateEntry1("LONG",{pk:20,pd:25,k:55,d:28});
  assert.equal(result.entry1Long,true);
  assert.equal(result.entry1,true);
});
test("ENTRY_1 SHORT fires on a fresh bearish cross at K=55 under the >30 threshold",()=>{
  assert.equal(strategy.evaluateEntry1("SHORT",{pk:80,pd:75,k:70,d:72}).entry1Short,true);
  assert.equal(strategy.evaluateEntry1("SHORT",{pk:80,pd:75,k:55,d:72}).entry1Short,true);
  assert.equal(strategy.evaluateEntry1("SHORT",{pk:80,pd:75,k:30,d:32}).entry1Short,false);
});
test("ENTRY_2 retest qualifies after a 1.5% first wave, pullback within 1%, EMA8 support and a fresh cross at K=45",()=>{
  assert.equal(strategy.entry2RetestConditions("LONG",100,100.5,102,99.8,{pk:30,pd:35,k:45,d:40},false,false),true);
});
test("ENTRY_2 is blocked when EMA8/21 crossed bearish after ENTRY_1",()=>{
  assert.equal(strategy.entry2RetestConditions("LONG",100,100.5,102,99.8,{pk:30,pd:35,k:45,d:40},true,false),false);
});
test("ENTRY_2 requires pullback, correct EMA8 side, K threshold, and one-time state",()=>{
  const st={pk:30,pd:35,k:45,d:40};
  assert.equal(strategy.entry2RetestConditions("LONG",100,102,102,99,st,false,false),false);
  assert.equal(strategy.entry2RetestConditions("LONG",100,100.5,102,101,st,false,false),false);
  assert.equal(strategy.entry2RetestConditions("LONG",100,100.5,102,99,{...st,k:65},false,false),false);
  assert.equal(strategy.entry2RetestConditions("LONG",100,100.5,102,99,st,false,true),false);
});
test("ENTRY_2 SHORT retest requires first wave down, pullback, below EMA8 and K above 40 on bearish cross",()=>{
  assert.equal(strategy.entry2RetestConditions("SHORT",100,99.5,98,100,{pk:70,pd:65,k:55,d:60},false,false),true);
});
test("entry logic contains no retired EMA, trendline, pivot, fib, RR, or K exhaustion gates",()=>{
  const source=fs.readFileSync(require.resolve("../lib/strategy.ts"),"utf8");
  for(const retired of ["dailyTrend(","fourHTrendDirection(","tacticalDirection(","resolveSignalDirection(","structureTargets(","emaAdvisory","trendlinePivots",">=95","<=5","3% above 4H EMA(21)"]) assert.equal(source.includes(retired),false,retired);
});

test("EMA8/21 bearish cross after the stored ENTRY_1 candle invalidates a LONG retest",()=>{
  const step=4*60*60*1000,start=Date.UTC(2026,0,1);
  const c=Array.from({length:48},(_,i)=>{
    const close=i<=35?100+i:135-(i-35)*15;
    return{timestamp:start+i*step,open:close,high:close+1,low:close-1,close,volume:1};
  });
  const state={pair:"BTC",direction:"LONG",entry:135,timestamp:start+35*step+step/2,context:{closed4hTimestamp:start+35*step}};
  assert.equal(strategy.hasAdverseEmaCrossSince(c,state),true);
});
test("EMA8/21 remaining bullish after ENTRY_1 does not invalidate a LONG retest",()=>{
  const step=4*60*60*1000,start=Date.UTC(2026,0,1);
  const c=Array.from({length:48},(_,i)=>{
    const close=100+i;
    return{timestamp:start+i*step,open:close,high:close+1,low:close-1,close,volume:1};
  });
  const state={pair:"BTC",direction:"LONG",entry:135,timestamp:start+35*step+step/2,context:{closed4hTimestamp:start+35*step}};
  assert.equal(strategy.hasAdverseEmaCrossSince(c,state),false);
});
