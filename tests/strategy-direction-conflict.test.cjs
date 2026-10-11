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

const FOUR_HOURS = 4 * 60 * 60 * 1000;
function candles({days=40, rising=true, bearishCurrent4h=false}={}) {
  const start=Date.UTC(2026,0,1), out=[];
  let prev=100;
  for(let day=0;day<days;day++){
    for(let slot=0;slot<6;slot++){
      const timestamp=start+(day*6+slot)*FOUR_HOURS;
      let close;
      if(bearishCurrent4h&&day===days-1) close=prev-(slot+1)*18;
      else close=100+day*(rising?1:-1)+slot*(rising?0.12:-0.12);
      prev=close;
      out.push({timestamp,open:close,high:close+1,low:close-1,close,volume:1});
    }
  }
  return out;
}
test("both closed EMA 5/13 timeframes aligned bullish permits LONG direction",()=>{
  const result=strategy.trendAlignment(candles());
  assert.equal(result.daily,"LONG");
  assert.equal(result.fourH,"LONG");
  assert.equal(result.aligned,"LONG");
});
test("daily bullish and 4H bearish blocks direction (BTC SHORT failure case)",()=>{
  const data=candles({bearishCurrent4h:true});
  const result=strategy.trendAlignment(data);
  assert.equal(result.daily,"LONG");
  assert.equal(result.fourH,"SHORT");
  assert.equal(result.aligned,null);
  const gates=strategy.evaluateGates("BTC",data,80);
  assert.equal(gates.direction,null);
  assert.equal(gates.allPassed,false);
  assert.ok(gates.missing.includes("alignment"));
});
test("4H EMA alignment includes the newest candle returned by the closed-candle data source",()=>{
  const data=candles();
  const result=strategy.trendAlignment(data);
  const ema=(values,period)=>{const k=2/(period+1),out=[values[0]];for(let i=1;i<values.length;i++)out.push(values[i]*k+out[i-1]*(1-k));return out;};
  const closes=data.map(x=>x.close);
  assert.equal(result.fourHE5,ema(closes,5).at(-1));
  assert.equal(result.fourHE13,ema(closes,13).at(-1));
});
test("closed daily and 4H EMA values are exposed for alignment display",()=>{
  const result=strategy.trendAlignment(candles());
  assert.ok(result.dailyE5>0&&result.dailyE13>0&&result.fourHE5>0&&result.fourHE13>0);
});
