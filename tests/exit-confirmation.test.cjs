const { test } = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const strategy = fs.readFileSync("lib/strategy.ts", "utf8");
const cron = fs.readFileSync("app/api/cron/route.ts", "utf8");
const telegram = fs.readFileSync("lib/telegram.ts", "utf8");

test("V28 exit checks include hard stop, single 5 ATR target, daily reversal and EMA21/Stoch", () => {
  assert.ok(strategy.includes('reason:"stop_hit"'));
  assert.ok(strategy.includes('reason:"target_hit"'));
  assert.ok(strategy.includes('reason:"daily_trend_reversal_unprofitable"'));
  assert.ok(strategy.includes('reason:"4h_ema21_stoch_exit"'));
  assert.ok(strategy.includes("p<e21&&st.k<st.d"));
  assert.ok(strategy.includes("p>e21&&st.k>st.d"));
  assert.doesNotMatch(strategy, /chandelier_trailing_stop|chandelier_stop_update/);
});
test("target is one 5 ATR objective; no 15 ATR safety target remains", () => {
  assert.ok(strategy.includes("targetCount:1"));
  assert.ok(strategy.includes("targetAtrMultiple:5"));
  assert.doesNotMatch(strategy, /entry\+15\*a|entry-15\*a/);
});
test("hard stop and target are both recognized by signal validity", () => {
  assert.ok(strategy.includes('reason:"sl_hit"'));
  assert.ok(strategy.includes('reason:"target_hit"'));
  assert.ok(strategy.includes('return"TP_HIT"'));
});
test("alert matrix still permits ENTRY_1 and ADD while ENTRY_2 remains silent", () => {
  assert.ok(telegram.includes('type!=="ENTRY_1"&&type!=="ADD"&&type!=="ENTRY_2"'));
  assert.ok(cron.includes("ENTRY_2"));
});
