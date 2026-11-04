const { test } = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const strategy = fs.readFileSync("lib/strategy.ts", "utf8");
const state = fs.readFileSync("lib/state.ts", "utf8");
const cron = fs.readFileSync("app/api/cron/route.ts", "utf8");
const telegram = fs.readFileSync("lib/telegram.ts", "utf8");
const dashboard = fs.readFileSync("app/page.tsx", "utf8");
const jarvis = fs.readFileSync("lib/jarvis.ts", "utf8");

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
  assert.ok(strategy.includes("entry1TriggerPass(fast.direction,fastNear,st.k,fastFilters.pass,fastActive)"));
  assert.ok(strategy.includes('stochK<20:direction==="SHORT"?stochK>80:false'));
  assert.ok(strategy.includes('const momentum=direction==="LONG"?e5>e13:e5<e13'));
  assert.ok(strategy.includes("RSI exhaustion"));
  assert.ok(strategy.includes("Stoch extreme veto"));
  assert.ok(strategy.includes("ADX >50 with Stoch turning against"));
});

test("ENTRY_2 and ADD use MACRO EMA8/21 and both require the same global directional filters", () => {
  assert.ok(strategy.includes("entry2TriggerPass(macro.direction,macroNear,st.k,st.d,macroFilters.pass,macroActive)"));
  assert.ok(strategy.includes("macroActive&&beyond&&confirming&&macroFilters.pass"));
  assert.ok(strategy.includes("ENTRY_2/ADD 4H EMA5/13 momentum misaligned"));
  assert.ok(strategy.includes("ENTRY_2/ADD exhaustion veto"));
});

test("ENTRY_1 is evaluated before MACRO and trendline state is overwritten under one pair key", () => {
  assert.ok(strategy.indexOf("if(entry1TriggerPass(fast.direction,fastNear,st.k,fastFilters.pass,fastActive))") < strategy.indexOf("const macroTl=macro.direction?getTrendline(pair,c,macro.direction):null"));
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
  assert.ok(cron.includes('updateSignalHistoryStatus(alert.id,"TP_HIT","tp_hit",price)'));
  assert.ok(cron.includes('kind:"TARGET_HIT"'));
  assert.ok(cron.includes('hold.reason==="tp_hit"?"TARGET_HIT"'));
});

test("Telegram displays mirrored V28 targets once instead of TRAILING", () => {
  assert.ok(telegram.includes('singleTarget?\x60TP: \x24{formatPrice(tp1)}\x60'));
  assert.doesNotMatch(telegram, /TRAILING/);
  assert.ok(telegram.includes("Trade closed."));
});

test("Dashboard and Jarvis expose FAST/MACRO daily bias and trendline distance", () => {
  assert.ok(dashboard.includes("FAST BIAS (5/13)"));
  assert.ok(dashboard.includes("MACRO BIAS (8/21)"));
  assert.ok(dashboard.includes("TL DISTANCE:"));
  assert.ok(jarvis.includes("FAST bias (1D EMA5/13)"));
  assert.ok(jarvis.includes("MACRO bias (1D EMA8/21)"));
  assert.ok(jarvis.includes("fourHTacticalDirection"));
  assert.ok(jarvis.includes("Shared 4H trendline distance"));
});
