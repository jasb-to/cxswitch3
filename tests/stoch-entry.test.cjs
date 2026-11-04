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
const { getStochHistoryPointCount, generateSignal } = require("../lib/strategy.ts");

test("ENTRY_1 LONG/SHORT use FAST daily EMA5/13 and Stoch extremes without requiring a crossover", () => {
  assert.ok(strategy.includes("fast.direction===\"LONG\"?st.k<20:fast.direction===\"SHORT\"?st.k>80:false"));
  assert.ok(strategy.includes("fastNear&&fastExtreme&&fastFilters.pass&&!fastActive"));
});
test("ENTRY_1 is vetoed when 4H EMA5/13 momentum is not aligned or exhaustion is present", () => {
  assert.ok(strategy.includes("fastFilters.pass"));
  assert.ok(strategy.includes("momentum:dir===\"LONG\"?e5>e13:e5<e13"));
  assert.ok(strategy.includes("fastFilters.exhaustion"));
});
test("ENTRY_2 uses MACRO EMA8/21, trendline proximity, Stoch turn and global filters", () => {
  assert.ok(strategy.includes("macroNear&&turning&&!macroExtreme&&macroFilters.pass&&macroActive"));
});
test("ADD uses MACRO EMA8/21 breakout confirmation and global filters", () => {
  assert.ok(strategy.includes("macroActive&&beyond&&confirming&&macroFilters.pass"));
});
test("daily direction unavailable with no usable candle history", () => {
  const result = generateSignal("TEST", [], [], []);
  assert.ok(result.debug.some(x => x.includes("Insufficient 4H candle data")));
});
test("insufficient Stoch history is reported as zero usable smoothed points", () => {
  assert.equal(getStochHistoryPointCount([]), 0);
  assert.equal(getStochHistoryPointCount(Array.from({ length: 30 }, (_, i) => 100 + i)), 0);
});
