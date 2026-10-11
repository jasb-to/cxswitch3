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
function candles({days=45, rising=true}={}) {
  const start=Date.UTC(2026,0,1), out=[];
  for(let day=0;day<days;day++){
    for(let slot=0;slot<6;slot++){
      const timestamp=start+(day*6+slot)*FOUR_HOURS;
      const close=100+day*(rising?1:-1)+slot*(rising?0.12:-0.12);
      out.push({timestamp,open:close,high:close+1,low:close-1,close,volume:1});
    }
  }
  return out;
}

test("daily strength is HIGH for a wide, expanding bullish EMA 5/13 regime",()=>{
  const c=candles({rising:true});
  const alignment=strategy.trendAlignment(c);
  assert.equal(alignment.daily,"LONG");
  assert.equal(strategy.classifyDailyStrength(c,alignment),"HIGH");
  assert.equal(strategy.getMarketSnapshot("BTC",c,c,c).dailyStrength,"HIGH");
});

test("daily strength is HIGH for a wide, expanding bearish EMA 5/13 regime",()=>{
  const c=candles({rising:false});
  const alignment=strategy.trendAlignment(c);
  assert.equal(alignment.daily,"SHORT");
  assert.equal(strategy.classifyDailyStrength(c,alignment),"HIGH");
  assert.equal(strategy.getMarketSnapshot("BTC",c,c,c).dailyStrength,"HIGH");
});

test("daily strength remains NEUTRAL when there is insufficient closed daily history",()=>{
  const c=candles({days:12,rising:true});
  const alignment=strategy.trendAlignment(c);
  assert.equal(strategy.classifyDailyStrength(c,alignment),"NEUTRAL");
});
