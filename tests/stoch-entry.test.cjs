const { test } = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const strategy = fs.readFileSync("lib/strategy.ts", "utf8");
const { getStochHistoryPointCount, generateSignal } = require("../lib/strategy.ts");

test("ENTRY_1 LONG threshold is Stoch RSI K below 20, no crossover requirement", () => {
  assert.ok(strategy.includes('st.k<20:st.k>80'));
  assert.ok(strategy.includes('if(near&&extreme&&momentum&&exhaustionClear)raw="ENTRY_1"'));
});
test("ENTRY_1 SHORT threshold is Stoch RSI K above 80, no crossover requirement", () => {
  assert.ok(strategy.includes('st.k<20:st.k>80'));
  assert.ok(strategy.includes('if(near&&extreme&&momentum&&exhaustionClear)raw="ENTRY_1"'));
});
test("daily direction is unavailable when V28 EMA8/21 trend cannot be established", () => {
  const result = generateSignal("TEST", [], [], []);
  assert.ok(result.debug.some(x => x.includes("Insufficient 4H candle data")));
  assert.ok(strategy.includes("if(!trend.direction)"));
});
test("insufficient Stoch history is reported as zero usable smoothed points", () => {
  assert.equal(getStochHistoryPointCount([]), 0);
  assert.equal(getStochHistoryPointCount(Array.from({ length: 30 }, (_, i) => 100 + i)), 0);
});
test("ENTRY_2 retains its separate V28 near-trendline Stoch-turning path", () => {
  assert.ok(strategy.includes('else if(near&&turning&&!extreme&&exhaustionClear)raw="ENTRY_2"'));
});
test("Stoch history diagnostics count usable smoothed points", () => {
  const closes32 = Array.from({ length: 32 }, (_, i) => 100 + Math.sin(i / 2) * 5 + i * 0.1);
  const closes33 = Array.from({ length: 33 }, (_, i) => 100 + Math.sin(i / 2) * 5 + i * 0.1);
  assert.equal(getStochHistoryPointCount(closes32), 1);
  assert.equal(getStochHistoryPointCount(closes33), 2);
});
