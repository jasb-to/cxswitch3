const { test } = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const ts = require("typescript");
require.extensions[".ts"] = (module, filename) => {
  const source = fs.readFileSync(filename, "utf8");
  const output = ts.transpileModule(source, { fileName: filename, compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022, esModuleInterop: true } }).outputText;
  module._compile(output, filename);
};
const strategySource = fs.readFileSync("lib/strategy.ts", "utf8");
const { getStochHistoryPointCount, generateSignal } = require("../lib/strategy.ts");

test("ENTRY_1, ENTRY_2 and ADD are all inside the global Momentum/Exhaustion gate", () => {
  assert.equal(strategySource.split("const filtersPass=!!dailyTrend.direction&&momentumAligned&&!exhaustion;").length - 1, 2);
  assert.equal(strategySource.split("if(filtersPass){").length - 1, 2);
  assert.equal(strategySource.split('if(nearTrendline&&stochExtreme)rawType="ENTRY_1";').length - 1, 2);
  assert.equal(strategySource.split('else if(nearTrendline&&stochTurning&&!stochExtreme)rawType="ENTRY_2";').length - 1, 2);
  assert.equal(strategySource.split('else if(beyondTrendline&&confirming&&emaAligned&&(volUp||stochMomentum||adxStrong))rawType="ADD";').length - 1, 2);
});

test("global Momentum uses 4H EMA5/13 aligned to the one daily direction", () => {
  assert.equal(strategySource.split('const momentumAligned=dailyTrend.direction==="LONG"?e5_4h>e13_4h:dailyTrend.direction==="SHORT"?e5_4h<e13_4h:false;').length - 1, 2);
});

test("global Exhaustion retains RSI 78/22, Stoch 95/5 and ADX >50 turning-against vetoes", () => {
  assert.equal(strategySource.split('const rsiExhausted=dailyTrend.direction==="LONG"?rv>78:dailyTrend.direction==="SHORT"?rv<22:false;').length - 1, 2);
  assert.equal(strategySource.split('const stochVeto=dailyTrend.direction==="LONG"?st.k>95:dailyTrend.direction==="SHORT"?st.k<5:false;').length - 1, 2);
  assert.equal(strategySource.split("const adxExhausted=av>50&&turningAgainst;").length - 1, 2);
});

test("daily direction unavailable with no usable candle history", () => {
  const result = generateSignal("TEST", [], [], []);
  assert.ok(result.debug.some(x => x.includes("Insufficient 4H candle data")));
});

test("insufficient Stoch history is reported as zero usable smoothed points", () => {
  assert.equal(getStochHistoryPointCount([]), 0);
  assert.equal(getStochHistoryPointCount(Array.from({ length: 30 }, (_, i) => 100 + i)), 0);
});
