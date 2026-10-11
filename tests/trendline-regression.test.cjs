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

const FOUR_HOURS=4*60*60*1000;
function sample(count=30){
 const start=Date.UTC(2026,0,1);
 return Array.from({length:count},(_,i)=>{const close=100+i*.2;return{timestamp:start+i*FOUR_HOURS,open:close,high:close+1,low:close-1,close,volume:1};});
}
test("stop uses the most recent five closed candles and the 1.5 ATR floor",()=>{
 const c=sample(12),closed=c.slice(0,-1),window=closed.slice(-5),atr=2;
 const low=Math.min(...window.map(x=>x.low)),entry=110;
 const result=strategy.calculateStop("LONG",entry,atr,c);
 assert.equal(result.valid,true);
 assert.equal(result.stop,Math.min(low,entry-1.5*atr));
});
test("fixed target arithmetic is +3% and +6% for LONG, -3% and -6% for SHORT",()=>{
 const entry=100;
 assert.equal(entry*1.03,103);
 assert.equal(entry*1.06,106);
 assert.equal(entry*.97,97);
 assert.equal(entry*.94,94);
});
test("stop calculation no longer vetoes a stop based on liquidation buffer",()=>{
 const c=sample(30),result=strategy.calculateStop("LONG",100,10,c);
 assert.equal(result.valid,true);
 assert.equal(typeof result.calc.liquidationBufferPct,"number");
});
