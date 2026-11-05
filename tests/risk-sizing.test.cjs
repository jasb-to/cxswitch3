const { test } = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const strategy = fs.readFileSync("lib/strategy.ts", "utf8");

test("regime sizing is 50% for LOW/CHOP and 100% for HIGH/MED", () => {
  assert.ok(strategy.includes('strength==="LOW"||state==="CHOP"?0.5:1'));
  assert.ok(strategy.includes('"BULL_HIGH"'));
  assert.ok(strategy.includes('"BULL_MED"'));
  assert.ok(strategy.includes('"BULL_LOW"'));
  assert.ok(strategy.includes('"BEAR_HIGH"'));
  assert.ok(strategy.includes('"BEAR_MED"'));
  assert.ok(strategy.includes('"BEAR_LOW"'));
  assert.ok(strategy.includes('"CHOP"'));
});

test("Regime size multiplier remains separate from the 15x protective-stop clamp", () => {
  assert.ok(strategy.includes('strength==="LOW"||state==="CHOP"?0.5:1'));
  assert.ok(strategy.includes("const MAX_LEVERAGE = 15"));
  assert.ok(strategy.includes("liquidationPrice"));
  assert.doesNotMatch(strategy, /calculateRiskSizeMultiplier/);
});
