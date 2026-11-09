const { test } = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const strategy = fs.readFileSync("lib/strategy.ts", "utf8");

test("V28 ENTRY_1/ENTRY_2 stops use the last 20 4H candles or 2 ATR, whichever is wider", () => {
  assert.ok(strategy.includes("recent=bars.slice(-20)"));
  assert.ok(strategy.includes("Math.min(low,price-2*avalue)"));
  assert.ok(strategy.includes("Math.max(high,price+2*avalue)"));
});

test("V28 ADD stop retains the trendline buffer and 1.5 ATR floor", () => {
  assert.ok(strategy.includes("signalTl.price*0.995"));
  assert.ok(strategy.includes("signalTl.price*1.005"));
  assert.ok(strategy.includes("price-1.5*avalue"));
  assert.ok(strategy.includes("price+1.5*avalue"));
});

test("Current V28 risk layer clamps stops to the configured 15x liquidation buffer", () => {
  assert.match(strategy, /const MAX_LEVERAGE = 15/);
  assert.match(strategy, /MAINTENANCE_MARGIN_RATE = 0\.01/);
  assert.match(strategy, /liquidationPrice/);
  assert.match(strategy, /after liquidation-buffer clamp/);
});

test("All stages use one shared pair-level 4H trendline oriented by daily macro direction", () => {
  assert.match(strategy, /function getTrendline\(pair: string, candles: Candle\[\], direction: "LONG" \| "SHORT"\)/);
  assert.match(strategy, /const stateKey = pair/);
  assert.match(strategy, /const trendlineDirection=macro\.direction\?\?entry1TradeDirection/);
  assert.doesNotMatch(strategy, /track: "FAST" \| "MACRO"|\$\{pair\}:\$\{track\}:\$\{direction\}/);
});
