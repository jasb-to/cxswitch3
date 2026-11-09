const { test } = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const strategy = fs.readFileSync("lib/strategy.ts", "utf8");

test("V28 ENTRY_1/ENTRY_2 stop uses the wider 20-bar swing or 2 ATR", () => {
  assert.ok(strategy.includes("recent=bars.slice(-20)"));
  assert.ok(strategy.includes("Math.min(low,price-2*avalue)"));
  assert.ok(strategy.includes("Math.max(high,price+2*avalue)"));
});

test("V28 has one 5 ATR objective; TP2 mirrors TP1 for compatibility", () => {
  assert.ok(strategy.includes("price+5*avalue"));
  assert.ok(strategy.includes("price-5*avalue"));
  assert.match(strategy, /target=signalDirection==="LONG"\?price\+5\*avalue:price-5\*avalue/);
  assert.ok(strategy.includes("tp2:Math.round(target*100)/100"));
  assert.doesNotMatch(strategy, /price\+15\*avalue|price-15\*avalue/);
});
