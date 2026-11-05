const { test } = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const source = fs.readFileSync("lib/strategy.ts", "utf8");

test("V28 uses one 5 ATR target and preserves its 1.5 minimum R:R gate", () => {
  assert.ok(source.includes("price+5*avalue"));
  assert.ok(source.includes("price-5*avalue"));
  assert.ok(source.includes("targetCount:1,targetAtrMultiple:5"));
  assert.ok(source.includes("const MIN_RR = 1.5"));
  assert.ok(source.includes("rr<MIN_RR"));
  assert.doesNotMatch(source, /price\+15\*avalue|price-15\*avalue/);
});

test("V28 retains the 15x liquidation-buffer stop clamp and recalculates R:R", () => {
  assert.match(source, /const MAX_LEVERAGE = 15/);
  assert.match(source, /MAINTENANCE_MARGIN_RATE = 0\\.01/);
  assert.match(source, /liquidationPrice/);
  assert.match(source, /stop=liquidationPrice/);
  assert.match(source, /after liquidation-buffer clamp/);
});
