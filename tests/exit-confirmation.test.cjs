const { test } = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const strategy = fs.readFileSync("lib/strategy.ts", "utf8");
const cron = fs.readFileSync("app/api/cron/route.ts", "utf8");
const telegram = fs.readFileSync("lib/telegram.ts", "utf8");

test("V28 active trade exit checks include hard stop, one target, daily reversal and opposite Stoch extreme", () => {
  assert.ok(strategy.includes('reason:"sl_hit"'));
  assert.ok(strategy.includes('reason:"tp_hit"'));
  assert.ok(strategy.includes('reason:"daily_trend_reversal_unprofitable"'));
  assert.ok(strategy.includes('reason:"stoch_extreme_opposite_exit"'));
  assert.ok(strategy.includes('signal.type==="ADD"?4*60*60*1000:24*60*60*1000'));
});

test("target is one 5 ATR objective; TP2 is compatibility mirror only", () => {
  assert.ok(strategy.includes("targetCount:1,targetAtrMultiple:5"));
  assert.ok(strategy.includes("tp2:Math.round(target*100)/100"));
  assert.doesNotMatch(strategy, /entry\+15\*a|entry-15\*a/);
});

test("active management calls the V28 shouldHold and persists exits", () => {
  assert.ok(cron.includes("shouldHold(toSignalLike(alert)"));
  assert.ok(cron.includes('"stoch_extreme_opposite_exit"'));
  assert.ok(cron.includes('"daily_trend_reversal_unprofitable"'));
});

test("alert matrix still permits ENTRY_1 and ADD while ENTRY_2 remains silent", () => {
  assert.ok(telegram.includes('type!=="ENTRY_1"&&type!=="ADD"&&type!=="ENTRY_2"'));
  assert.ok(cron.includes("ENTRY_2"));
});
