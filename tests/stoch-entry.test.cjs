const { test } = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const ts = require("typescript");
require.extensions[".ts"] = (module, filename) => {
  const source = fs.readFileSync(filename, "utf8");
  const output = ts.transpileModule(source, { fileName: filename, compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022, esModuleInterop: true } }).outputText;
  module._compile(output, filename);
};
const strategy = fs.readFileSync("lib/strategy.ts", "utf8");
const { getStochHistoryPointCount, generateSignal, evaluateDirectionalFilters, entry1TriggerPass, entry2TriggerPass } = require("../lib/strategy.ts");

test("ENTRY_1 LONG/SHORT use FAST daily EMA5/13 and Stoch extremes without requiring a crossover", () => {
  assert.ok(strategy.includes("entry1TriggerPass(fast.direction,fastNear,st.k,fastFilters.pass,fastActive)"));
  assert.ok(strategy.includes("stochK<20:direction===\"SHORT\"?stochK>80:false"));
});
test("ENTRY_1 applies the shared 4H EMA5/13, RSI, Stoch and ADX filters", () => {
  assert.ok(strategy.includes("evaluateDirectionalFilters(dir,e5,e13,rv,st.k,st.d,av)"));
  assert.ok(strategy.includes("fastFilters.pass"));
});
test("ENTRY_2 uses MACRO EMA8/21, trendline proximity, Stoch turn and global filters", () => {
  assert.ok(strategy.includes("entry2TriggerPass(macro.direction,macroNear,st.k,st.d,macroFilters.pass,macroActive)"));
});
test("ADD uses MACRO EMA8/21 breakout confirmation and global filters", () => {
  assert.ok(strategy.includes("macroActive&&beyond&&confirming&&macroFilters.pass"));
});
test("ENTRY_1 and ENTRY_2 both fail when 4H EMA5/13 momentum is misaligned", () => {
  for (const direction of ["LONG", "SHORT"]) {
    const e5 = direction === "LONG" ? 9 : 11;
    const e13 = 10;
    const filters = evaluateDirectionalFilters(direction, e5, e13, 50, 50, 50, 20);
    assert.equal(filters.momentum, false);
    assert.equal(filters.pass, false);
    const entry1K = direction === "LONG" ? 10 : 90;
    const entry2K = direction === "LONG" ? 40 : 60;
    const entry2D = direction === "LONG" ? 30 : 70;
    assert.equal(entry1TriggerPass(direction, true, entry1K, filters.pass, false), false);
    assert.equal(entry2TriggerPass(direction, true, entry2K, entry2D, filters.pass, true), false);
  }
});
test("ENTRY_1 and ENTRY_2 both fail when directional RSI exhaustion is present", () => {
  for (const direction of ["LONG", "SHORT"]) {
    const rsiValue = direction === "LONG" ? 79 : 21;
    const filters = evaluateDirectionalFilters(direction, direction === "LONG" ? 11 : 9, 10, rsiValue, 50, 50, 20);
    assert.equal(filters.momentum, true);
    assert.equal(filters.exhaustion, "4H RSI exhaustion");
    assert.equal(filters.pass, false);
    assert.equal(entry1TriggerPass(direction, true, direction === "LONG" ? 10 : 90, filters.pass, false), false);
    assert.equal(entry2TriggerPass(direction, true, direction === "LONG" ? 40 : 60, direction === "LONG" ? 30 : 70, filters.pass, true), false);
  }
});
test("global exhaustion veto also blocks Stoch extremes and ADX turns against the trade", () => {
  assert.equal(evaluateDirectionalFilters("LONG", 11, 10, 50, 96, 90, 20).exhaustion, "4H Stoch extreme veto");
  assert.equal(evaluateDirectionalFilters("SHORT", 9, 10, 50, 4, 10, 20).exhaustion, "4H Stoch extreme veto");
  assert.equal(evaluateDirectionalFilters("LONG", 11, 10, 50, 40, 45, 55).exhaustion, "ADX >50 with Stoch turning against");
  assert.equal(evaluateDirectionalFilters("SHORT", 9, 10, 50, 60, 55, 55).exhaustion, "ADX >50 with Stoch turning against");
});
test("daily direction unavailable with no usable candle history", () => {
  const result = generateSignal("TEST", [], [], []);
  assert.ok(result.debug.some(x => x.includes("Insufficient 4H candle data")));
});
test("insufficient Stoch history is reported as zero usable smoothed points", () => {
  assert.equal(getStochHistoryPointCount([]), 0);
  assert.equal(getStochHistoryPointCount(Array.from({ length: 30 }, (_, i) => 100 + i)), 0);
});
