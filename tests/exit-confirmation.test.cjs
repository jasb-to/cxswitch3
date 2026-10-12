const { test } = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");

const strategy = fs.readFileSync("lib/strategy.ts", "utf8");
const cron = fs.readFileSync("app/api/cron/route.ts", "utf8");
const state = fs.readFileSync("lib/state.ts", "utf8");
const telegram = fs.readFileSync("lib/telegram.ts", "utf8");

test("active pair and direction suppress a new signal independently of entry price", () => {
  assert.ok(strategy.includes("activeSignals:Array<{pair:string;direction:Direction}>=[]"));
  assert.ok(strategy.includes("active.pair===pair&&active.direction===s.direction"));
  assert.ok(strategy.includes("reason=active_position_exists"));
  assert.ok(cron.includes("entry2AlreadyFired,active.map((x:any)=>({pair:x.pair,direction:x.direction}))"));
});

test("4H EMA reversal requires two consecutive closed candles on the adverse side", () => {
  assert.ok(strategy.includes("const closed4h=x.slice(0,-1)"));
  assert.ok(strategy.includes("const wrongNow=s.direction==="));
  assert.ok(strategy.includes("if(wrongNow&&wrongPrev)return exit(\"4h_ema_reversal_confirmed\")"));
});

test("daily EMA 5/13 reversal requires two consecutive completed daily candles", () => {
  assert.ok(strategy.includes("const d=daily(x).slice(0,-1)"));
  assert.ok(strategy.includes("if(adverseNow&&adversePrev)return exit(\"1d_ema_reversal_confirmed\")"));
});

test("4H RSI extreme requires two consecutive closed-candle readings", () => {
  assert.ok(strategy.includes("const rsiNow=closedRsi.at(-1)??50,rsiPrev=closedRsi.at(-2)??50"));
  assert.ok(strategy.includes("rsiNow>=78&&rsiPrev>=78"));
  assert.ok(strategy.includes("rsiNow<=22&&rsiPrev<=22"));
});

test("indicator exits use a four-hour cooldown persisted outside the strategy module", () => {
  assert.ok(strategy.includes("EXIT_ALERT_COOLDOWN_MS=4*60*60*1000"));
  assert.ok(strategy.includes('reason:"exit_cooldown"'));
  assert.ok(state.includes('const EXIT_ALERT_COOLDOWNS_KEY = "cxswitch:exit_alert_cooldowns"'));
  assert.ok(state.includes("getExitAlertCooldowns"));
  assert.ok(state.includes("setExitAlertCooldowns"));
  assert.ok(cron.includes("persistExitCooldown(trade.pair,hold.reason)"));
});

test("hard stop and TP2 exits are checked before the indicator cooldown", () => {
  const stop = strategy.indexOf('reason:"stop_hit"');
  const target = strategy.indexOf('reason:"tp2_hit"');
  const cooldown = strategy.indexOf('reason:"exit_cooldown"');
  assert.ok(stop >= 0 && target > stop && cooldown > target);
});

test("Telegram management alerts describe confirmed daily, RSI, and trailing-stop exits", () => {
  assert.ok(telegram.includes('"RSI_EXTREME"'));
  assert.ok(telegram.includes('"TRAIL_EXIT"'));
  assert.ok(telegram.includes("1D EMA 5/13 reversal confirmed on two closed daily candles"));
  assert.ok(telegram.includes("4H RSI extreme confirmed on two closed candles"));
});
