const { test } = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const strategy = fs.readFileSync("lib/strategy.ts", "utf8");
const state = fs.readFileSync("lib/state.ts", "utf8");
const cron = fs.readFileSync("app/api/cron/route.ts", "utf8");

test("V28 macro daily direction remains EMA 8/21 and fast direction is EMA 5/13", () => {
  assert.ok(strategy.includes("const ema8 = ema(closes, 8)"));
  assert.ok(strategy.includes("const ema21 = ema(closes, 21)"));
  assert.ok(strategy.includes("function trend1DEntry1"));
  assert.ok(strategy.includes("fastDailyDirection,macroDailyDirection"));
});

test("V28 trendline uses one shared pair key with seven-day state and 1.2% proximity", () => {
  assert.ok(strategy.includes("const maxAge = 7 * 24 * 60 * 60 * 1000"));
  assert.ok(strategy.includes("if (deviation < 0.02)"));
  assert.ok(strategy.includes("r2: 0.85"));
  assert.ok(strategy.includes("fast.direction?getTrendline(pair,c,fast.direction):null"));
  assert.ok(strategy.includes("getTrendline(pair,c,macro.direction)"));
  assert.doesNotMatch(strategy, /pair\s*\+\s*["']:\s*ENTRY_1/);
  assert.ok(strategy.includes("fastDist<1.2"));
  assert.ok(strategy.includes("macroDistance<1.2"));
});

test("ENTRY_1 uses FAST EMA5/13, trendline proximity, Stoch extreme and global filters", () => {
  assert.ok(strategy.includes("fastNear&&fastExtreme&&fastFilters.pass&&!fastActive"));
  assert.ok(strategy.includes('const fastExtreme=fast.direction==="LONG"?st.k<20:fast.direction==="SHORT"?st.k>80:false'));
  assert.ok(strategy.includes('const momentum=dir==="LONG"?e5>e13:e5<e13'));
  assert.ok(strategy.includes("RSI exhaustion"));
  assert.ok(strategy.includes("Stoch extreme veto"));
  assert.ok(strategy.includes("ADX >50 with Stoch turning against"));
});

test("ENTRY_2 and ADD use MACRO EMA8/21 and both require the same global directional filters", () => {
  assert.ok(strategy.includes("macroNear&&turning&&!macroExtreme&&macroFilters.pass&&macroActive"));
  assert.ok(strategy.includes("macroActive&&beyond&&confirming&&macroFilters.pass"));
  assert.ok(strategy.includes("ENTRY_2/ADD 4H EMA5/13 momentum misaligned"));
  assert.ok(strategy.includes("ENTRY_2/ADD exhaustion veto"));
});

test("ENTRY_1 is evaluated before MACRO and trendline state is overwritten under one pair key", () => {
  assert.ok(strategy.indexOf("fast.direction&&fastNear&&fastExtreme&&fastFilters.pass") < strategy.indexOf("getTrendline(pair,c,macro.direction)"));
  assert.ok(strategy.includes("One shared KV key per pair"));
  assert.ok(strategy.includes("trendlineDistancePct"));
});

test("V28 stop/target arithmetic is preserved and TP2 mirrors the single TP1 target", () => {
  assert.ok(strategy.includes("recent=c.slice(-20)"));
  assert.ok(strategy.includes("price-2*avalue"));
  assert.ok(strategy.includes("price+2*avalue"));
  assert.ok(strategy.includes("price+5*avalue"));
  assert.ok(strategy.includes("price-5*avalue"));
  assert.ok(strategy.includes("targetCount:1,targetAtrMultiple:5"));
  assert.ok(strategy.includes("tp2:Math.round(target*100)/100"));
});

test("V28 hysteresis and trendline state are persisted through shared KV", () => {
  assert.ok(strategy.includes("HYSTERESIS_BAND = 0.005"));
  assert.ok(state.includes("cxswitch:v28_hysteresis_state"));
  assert.ok(state.includes("cxswitch:v28_trendline_state"));
  assert.ok(cron.includes("await loadHysteresisFromKV()"));
  assert.ok(cron.includes("await loadTrendlinesFromKV()"));
  assert.ok(cron.includes("await saveHysteresisToKV()"));
  assert.ok(cron.includes("await saveTrendlinesToKV()"));
});

test("target and stop hits are management exits immediately, with explicit history statuses", () => {
  assert.ok(cron.includes('"expired_ttl","missed_entry","sl_hit","tp_hit"'));
  assert.ok(cron.includes('hold.reason==="tp_hit"?"TP_HIT"'));
  assert.ok(cron.includes('hold.reason==="sl_hit"?"SL_HIT"'));
});
