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

function trendCandles(direction, noise=[]) {
  const out=[];
  for(let i=0;i<61;i++){
    const base=direction==="LONG"?100+i*.5:200-i*.5;
    out.push({timestamp:Date.UTC(2026,0,1)+i*14400000,open:base,close:base,high:base+1,low:base-1,volume:100});
  }
  let n=0;
  for(let i=5;i<=55;i+=10){
    const base=direction==="LONG"?100+i*.5:200-i*.5;
    if(direction==="LONG")out[i].low=base-10+(noise[n]??0);
    else out[i].high=base+10+(noise[n]??0);
    n++;
  }
  return out;
}

test("LOW and CHOP regimes are blocked at the direction layer",()=>{
  for(const state of ["BEAR_LOW","BULL_LOW","CHOP"])assert.equal(strategy.regimeAllowsTrading(state),false,state);
});
test("HIGH and MED regimes retain directional permission",()=>{
  for(const state of ["BEAR_HIGH","BEAR_MED","BULL_HIGH","BULL_MED"])assert.equal(strategy.regimeAllowsTrading(state),true,state);
});
test("a clean ascending LONG support trendline passes R-squared validation",()=>{
  const result=strategy.get4HTrendline(trendCandles("LONG"),"LONG",130);
  assert.equal(result.valid,true);
  assert.ok(result.r2>=.60);
  assert.ok(result.slope>0);
});
test("a clean descending SHORT resistance trendline passes R-squared validation",()=>{
  const result=strategy.get4HTrendline(trendCandles("SHORT"),"SHORT",170);
  assert.equal(result.valid,true);
  assert.ok(result.slope<0);
});
test("a trendline with R-squared below 0.60 is rejected",()=>{
  const result=strategy.get4HTrendline(trendCandles("LONG",[0,20,-20,20,-20,0]),"LONG",130);
  assert.equal(result.valid,false);
  assert.equal(result.reason,"r2_below_0.60");
});
test("LONG trendlines with negative slope are rejected",()=>{
  const result=strategy.get4HTrendline(trendCandles("SHORT"),"LONG",170);
  assert.equal(result.valid,false);
  assert.equal(result.reason,"slope_mismatch_long");
});
test("price 2 percent from trendline is blocked at the 1.2 percent boundary",()=>{
  const result=strategy.evaluateTrendlineProximity(102,100);
  assert.equal(result.valid,false);
  assert.equal(result.reason,"price_too_far_from_trendline");
});
test("price within 1.2 percent of trendline passes proximity",()=>{
  assert.equal(strategy.evaluateTrendlineProximity(101,100).valid,true);
});
test("breakout requires current volume above 1.2 times the previous-five average",()=>{
  const base=Array.from({length:5},(_,i)=>({timestamp:i,open:1,high:2,low:1,close:1,volume:100}));
  assert.equal(strategy.hasBreakoutVolumeConfirmation([...base,{...base[0],volume:119}]),false);
  assert.equal(strategy.hasBreakoutVolumeConfirmation([...base,{...base[0],volume:121}]),true);
});
