const { test } = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const strategy = fs.readFileSync("lib/strategy.ts", "utf8");
const state = fs.readFileSync("lib/state.ts", "utf8");
const cron = fs.readFileSync("app/api/cron/route.ts", "utf8");
const telegram = fs.readFileSync("lib/telegram.ts", "utf8");
const dashboard = fs.readFileSync("app/page.tsx", "utf8");
const jarvis = fs.readFileSync("lib/jarvis.ts", "utf8");

test("V28 has one daily trend using EMA 5/13 only", () => {
  const trend = strategy.match(/function trend1D\([\s\S]*?\n\}/)?.[0] ?? "";
  assert.match(trend, /ema\(closes, 5\)/);
  assert.match(trend, /ema\(closes, 13\)/);
  assert.doesNotMatch(trend, /ema\(closes, 8\)|ema\(closes, 21\)/);
});

test("V28 uses one shared trendline KV key: pair", () => {
  assert.ok(strategy.includes("const maxAge = 7 * 24 * 60 * 60 * 1000"));
  assert.ok(strategy.includes("if (deviation < 0.02)"));
  assert.ok(strategy.includes("r2: 0.85"));
  assert.match(strategy, /getTrendline\(pair,c,dailyTrend\.direction\)/);
  assert.doesNotMatch(strategy, /pair\s*\+\s*["']:(?:FAST|MACRO)/);
  assert.equal((strategy.match(/getTrendline\(pair,c,dailyTrend\.direction\)/g) ?? []).length, 2);
});

test("ENTRY_1 is blocked when 4H momentum is misaligned", () => {
  const filter = /const filtersPass=!!dailyTrend\.direction&&momentumAligned&&!exhaustion;/;
  assert.equal((strategy.match(new RegExp(filter.source, "g")) ?? []).length, 2);
  assert.match(strategy, /if\(filtersPass\)\{\s*if\(nearTrendline&&stochExtreme\)rawType="ENTRY_1";/);
  assert.match(strategy, /const momentumAligned=dailyTrend\.direction==="LONG"\?e5_4h>e13_4h:dailyTrend\.direction==="SHORT"\?e5_4h<e13_4h:false;/);
});

test("ENTRY_1 is blocked when any exhaustion veto is present", () => {
  assert.match(strategy, /const exhaustion=rsiExhausted\?"4H RSI exhaustion":stochVeto\?"4H Stoch extreme veto":adxExhausted\?"ADX >50 with Stoch turning against":null;/);
  assert.match(strategy, /const filtersPass=!!dailyTrend\.direction&&momentumAligned&&!exhaustion;/);
  assert.match(strategy, /if\(filtersPass\)\{\s*if\(nearTrendline&&stochExtreme\)rawType="ENTRY_1";/);
});

test("Original V28 raw trigger ordering and thresholds are shared by both evaluators", () => {
  for (const name of ["evaluateGates", "generateSignal"]) {
    const start = strategy.indexOf("export function " + name);
    const end = strategy.indexOf("\nexport function ", start + 20);
    const body = strategy.slice(start, end > 0 ? end : strategy.length);
    assert.ok(body.includes("Math.abs(dist)<0.012"));
    assert.ok(body.includes("st.k<20"));
    assert.ok(body.includes("st.k>80"));
    assert.ok(body.includes("price>tlPrice*1.008"));
    assert.ok(body.includes("price<tlPrice*0.992"));
    assert.ok(body.includes("last.volume>avg("));
    assert.ok(body.includes("price>(ema8_4h.at(-1)??0)"));
    assert.ok(body.includes("price<(ema21_4h.at(-1)??0)"));
    assert.ok(body.includes("let rawType:"));
    assert.ok(body.includes("if(filtersPass)"));
  }
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

test("tp_hit remains a management exit and reconciles history to TP_HIT", () => {
  assert.ok(cron.includes('"expired_ttl","missed_entry","sl_hit","tp_hit"'));
  assert.ok(cron.includes('hold.reason==="tp_hit"?"TP_HIT"'));
  assert.ok(cron.includes('updateSignalHistoryStatus(alert.id,"TP_HIT","tp_hit",price)'));
  assert.ok(cron.includes('hold.reason==="tp_hit"?"TARGET_HIT"'));
});

test("Telegram displays mirrored V28 targets once instead of TRAILING", () => {
  assert.ok(telegram.includes('singleTarget?\x60TP: \x24{formatPrice(tp1)}\x60'));
  assert.doesNotMatch(telegram, /TRAILING/);
  assert.ok(telegram.includes("Trade closed."));
});

test("Dashboard and Jarvis expose one daily bias, trendline distance and global filters", () => {
  assert.ok(dashboard.includes("DAILY BIAS (5/13)"));
  assert.ok(dashboard.includes("TL DISTANCE:"));
  assert.ok(dashboard.includes("momentumAligned"));
  assert.ok(dashboard.includes("EXHAUSTION:"));
  assert.doesNotMatch(dashboard, /fastDailyDirection|macroDailyDirection|entry1DailyDirection|FAST BIAS|MACRO BIAS/);
  assert.ok(jarvis.includes("DAILY BIAS (1D EMA5/13)"));
  assert.ok(jarvis.includes("momentumAligned"));
  assert.ok(jarvis.includes("exhaustion veto"));
  assert.doesNotMatch(jarvis, /fastDailyDirection|macroDailyDirection|entry1DailyDirection/);
});
