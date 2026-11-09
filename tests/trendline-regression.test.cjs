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
  assert.match(strategy, /Protected trade R:R=/);
});

test("ENTRY_1 and macro stages persist independent direction-specific 4H trendlines", () => {
  assert.match(strategy, /function getTrendline\(pair: string, candles: Candle\[\], direction: "LONG" \| "SHORT"\)/);
  assert.match(strategy, /const stateKey = `\$\{pair\}:\$\{direction\}`/);
  assert.match(strategy, /trendlineFast=fast\.direction\?getTrendline\(pair,bars,fast\.direction\)/);
  assert.match(strategy, /trendlineMacro=macro\.direction\?getTrendline\(pair,bars,macro\.direction\)/);
  assert.match(strategy, /finalType==="ENTRY_1"\?trendlineFast:trendlineMacro/);
});
