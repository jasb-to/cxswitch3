const { test } = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const strategy = fs.readFileSync("lib/strategy.ts", "utf8");

test("V28 ENTRY_1/ENTRY_2 stops use the last 20 4H candles or 2 ATR, whichever is wider", () => {
  assert.ok(strategy.includes("recent=closed4h.slice(-20)"));
  assert.ok(strategy.includes("Math.min(low,price-2*avalue)"));
  assert.ok(strategy.includes("Math.max(high,price+2*avalue)"));
});

test("V28 ADD stop retains the trendline buffer and 1.5 ATR floor", () => {
  assert.ok(strategy.includes("signalTl.price*0.995"));
  assert.ok(strategy.includes("signalTl.price*1.005"));
  assert.ok(strategy.includes("price-1.5*avalue"));
  assert.ok(strategy.includes("price+1.5*avalue"));
});

test("V28 does not add a liquidation-buffer or leverage-based entry veto", () => {
  assert.doesNotMatch(strategy, /liquidationBufferPct|MAX_LEVERAGE|calculateRiskSizeMultiplier/);
});
