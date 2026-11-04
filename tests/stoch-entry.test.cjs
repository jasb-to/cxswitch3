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

test("ENTRY_1 LONG fires at K below 20, including without a crossover", () => {
  assert.equal(strategy.evaluateEntry1("LONG", { k: 19, d: 25, pk: 22, pd: 24 }).entry1Long, true);
  assert.equal(strategy.evaluateEntry1("LONG", { k: 20, d: 25, pk: 22, pd: 24 }).entry1, false);
});
test("ENTRY_1 SHORT fires at K above 80, including without a crossover", () => {
  assert.equal(strategy.evaluateEntry1("SHORT", { k: 81, d: 75, pk: 78, pd: 76 }).entry1Short, true);
  assert.equal(strategy.evaluateEntry1("SHORT", { k: 80, d: 75, pk: 78, pd: 76 }).entry1, false);
});
test("ENTRY_1 has no daily direction if the 1D EMA8/21 relationship is unavailable", () => {
  const result = strategy.evaluateEntry1(null, { k: 10, d: 15, pk: 20, pd: 18 });
  assert.equal(result.entry1, false);
  assert.equal(result.reason, "daily_ema_8_21_direction_unavailable");
});
test("ENTRY_1 reports insufficient Stoch input cleanly", () => {
  assert.equal(strategy.evaluateEntry1("LONG", []).reason, "insufficient_stoch_history");
});
test("ENTRY_2 helper retains its independent retest checks", () => {
  assert.equal(strategy.entry2RetestConditions("LONG", 100, 100.5, 102, 99.8, { pk: 30, pd: 35, k: 45, d: 40 }, false, false), true);
  assert.equal(strategy.entry2RetestConditions("LONG", 100, 102, 102, 99.8, { pk: 30, pd: 35, k: 45, d: 40 }, false, false), false);
});
test("Stoch history diagnostics count usable smoothed points", () => {
  const closes32 = Array.from({ length: 32 }, (_, i) => 100 + Math.sin(i / 2) * 5 + i * 0.1);
  const closes33 = Array.from({ length: 33 }, (_, i) => 100 + Math.sin(i / 2) * 5 + i * 0.1);
  assert.equal(strategy.getStochHistoryPointCount(closes32), 1);
  assert.equal(strategy.getStochHistoryPointCount(closes33), 2);
});
