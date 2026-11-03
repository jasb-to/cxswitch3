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

test("ENTRY_1 SHORT requires a fresh bearish cross with K strictly above 75",()=>{
  assert.equal(strategy.evaluateEntry1("SHORT",{pk:80,pd:75,k:60,d:65}).entry1,false);
  const pass=strategy.evaluateEntry1("SHORT",{pk:90,pd:85,k:80,d:85});
  assert.equal(pass.entry1Short,true);
  assert.equal(pass.case,"fresh");
});
test("ENTRY_1 LONG requires a fresh bullish cross with K strictly below 25",()=>{
  assert.equal(strategy.evaluateEntry1("LONG",{pk:20,pd:25,k:40,d:35}).entry1,false);
  assert.equal(strategy.evaluateEntry1("LONG",{pk:10,pd:15,k:20,d:15}).entry1Long,true);
});
test("a cross on the immediately preceding closed candle remains eligible",()=>{
  const series=[{k:90,d:85},{k:80,d:85},{k:79,d:84}];
  const result=strategy.evaluateEntry1("SHORT",series);
  assert.equal(result.entry1,true);
  assert.equal(result.crossAgeInCandles,1);
});
test("a cross three candles old is rejected with cross_too_old",()=>{
  const series=[{k:90,d:85},{k:80,d:85},{k:79,d:84},{k:78,d:83},{k:77,d:82}];
  const result=strategy.evaluateEntry1("SHORT",series);
  assert.equal(result.entry1,false);
  assert.equal(result.reason,"cross_too_old");
});
test("ENTRY_2 retest still requires wave, pullback, EMA side and fresh cross",()=>{
  assert.equal(strategy.entry2RetestConditions("LONG",100,100.5,102,99.8,{pk:30,pd:35,k:45,d:40},false,false),true);
  assert.equal(strategy.entry2RetestConditions("LONG",100,102,102,99.8,{pk:30,pd:35,k:45,d:40},false,false),false);
});
test("ENTRY_2 remains blocked after an adverse EMA cross",()=>{
  assert.equal(strategy.entry2RetestConditions("LONG",100,100.5,102,99.8,{pk:30,pd:35,k:45,d:40},true,false),false);
});

test("Stoch RSI history diagnostics report the closed-candle minimum for two crossover points",()=>{
  const closes32=Array.from({length:32},(_,i)=>100+Math.sin(i/2)*5+i*.1);
  const closes33=Array.from({length:33},(_,i)=>100+Math.sin(i/2)*5+i*.1);
  assert.equal(strategy.getStochHistoryPointCount(closes32),1);
  assert.equal(strategy.getStochHistoryPointCount(closes33),2);
});

test("sufficient Stoch history with no aligned crossover reports no_cross_found",()=>{
  const series=[{k:90,d:85},{k:91,d:86},{k:92,d:87},{k:93,d:88}];
  const result=strategy.evaluateEntry1("SHORT",series);
  assert.equal(result.reason,"no_cross_found");
  assert.equal(result.crossDetected,null);
  assert.equal(result.entry1,false);
});
test("only fewer than two Stoch points reports insufficient_stoch_history",()=>{
  assert.equal(strategy.evaluateEntry1("SHORT",[{k:90,d:85}]).reason,"insufficient_stoch_history");
  assert.equal(strategy.evaluateEntry1("SHORT",[{k:90,d:85},{k:91,d:86}]).reason,"no_cross_found");
});
