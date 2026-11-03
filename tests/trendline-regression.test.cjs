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
test("stop uses the last 20 candle swing and a 2 ATR floor",()=>{
 const c=sample(30),window=c.slice(-20),atr=2;
 const low=Math.min(...window.map(x=>x.low)),entry=110;
 const result=strategy.calculateStop("LONG",entry,atr,c);
 assert.equal(result.valid,true);
 assert.equal(result.stop,Math.min(low,entry-2*atr));
});
test("short stop uses the last 20 candle swing and a 2 ATR ceiling",()=>{
 const c=sample(30),window=c.slice(-20),atr=2;
 const high=Math.max(...window.map(x=>x.high)),entry=110;
 const result=strategy.calculateStop("SHORT",entry,atr,c);
 assert.equal(result.valid,true);
 assert.equal(result.stop,Math.max(high,entry+2*atr));
});
test("stop calculation no longer vetoes a stop based on liquidation buffer",()=>{
 const c=sample(30),result=strategy.calculateStop("LONG",100,10,c);
 assert.equal(result.valid,true);
 assert.equal(typeof result.calc.liquidationBufferPct,"number");
});
