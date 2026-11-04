const { test } = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const strategy = fs.readFileSync("lib/strategy.ts", "utf8");
const state = fs.readFileSync("lib/state.ts", "utf8");
const cron = fs.readFileSync("app/api/cron/route.ts", "utf8");

test("V28 daily trend remains EMA 8/21 and regime labels include all seven states", () => {
  assert.ok(strategy.includes("const ema8 = ema(closes, 8)"));
  assert.ok(strategy.includes("const ema21 = ema(closes, 21)"));
  for (const state of ["BULL_HIGH","BULL_MED","BULL_LOW","BEAR_HIGH","BEAR_MED","BEAR_LOW","CHOP"]) assert.ok(strategy.includes(state));
});

test("V28 trendline uses stateful seven-day cache and 1.2% proximity without V32 R2 gate", () => {
  assert.ok(strategy.includes("const maxAge = 7 * 24 * 60 * 60 * 1000"));
  assert.ok(strategy.includes("if (deviation < 0.02)"));
  assert.ok(strategy.includes("r2: 0.85"));
  assert.ok(strategy.includes("Math.abs(dist)<0.012"));
  assert.doesNotMatch(strategy, /r2<0\.60|r2_below_0\.60/);
});

test("ENTRY_1 uses daily EMA5/13 direction plus V28 trendline proximity and Stoch extreme only", () => {
  assert.ok(strategy.includes("function trend1DEntry1"));
  assert.ok(strategy.includes('st.k<20:st.k>80'));
  assert.ok(strategy.includes('if(entry1Near&&entry1Extreme&&entry1Trend.direction)raw="ENTRY_1"'));
  assert.ok(strategy.includes("const entry1=!!entry1Trend.direction&&entry1Near&&entry1Extreme&&!entry1ActiveMatch"));
  assert.doesNotMatch(strategy, /if\(entry1Near&&entry1Extreme&&[^\n]*momentum|if\(entry1Near&&entry1Extreme&&[^\n]*exhaustionClear/);
});

test("momentum exhaustion filter uses RSI 78/22, Stoch 95/5 and ADX above 50 turning against", () => {
  assert.ok(strategy.includes('rv>78:rv<22'));
  assert.ok(strategy.includes('st.k>95:st.k<5'));
  assert.ok(strategy.includes('av>50&&against'));
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

test("active-position monitoring keeps V28 daily reversal and opposite-Stoch exits", () => {
  assert.ok(strategy.includes('reason:"daily_trend_reversal_unprofitable"'));
  assert.ok(strategy.includes('reason:"stoch_extreme_opposite_exit"'));
  assert.ok(cron.includes('"stoch_extreme_opposite_exit"'));
  assert.ok(cron.includes('"daily_trend_reversal_unprofitable"'));
});
