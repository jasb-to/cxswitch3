const { test } = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const strategy = fs.readFileSync("lib/strategy.ts", "utf8");
const cron = fs.readFileSync("app/api/cron/route.ts", "utf8");
const dashboard = fs.readFileSync("app/page.tsx", "utf8");

const body = (name) => {
  const start = strategy.indexOf("export function " + name);
  const end = strategy.indexOf("\nexport function ", start + 20);
  return strategy.slice(start, end > 0 ? end : strategy.length);
};

test("Daily macro direction is EMA 8/21; fast EMA 5/13 is a separate ENTRY_1 track", () => {
  const macro = strategy.match(/function trend1D\([\s\S]*?\n\}/)?.[0] ?? "";
  const fast = strategy.match(/function trend1DEarly\([\s\S]*?\n\}/)?.[0] ?? "";
  assert.match(macro, /ema\(closes, 8\)/);
  assert.match(macro, /ema\(closes, 21\)/);
  assert.doesNotMatch(macro, /ema\(closes, 5\)|ema\(closes, 13\)/);
  assert.match(fast, /ema\(closes, 5\)/);
  assert.match(fast, /ema\(closes, 13\)/);
  assert.doesNotMatch(fast, /ema\(closes, 8\)|ema\(closes, 21\)/);
});

test("ENTRY_1 uses only fast daily direction, 1.2% trendline proximity and Stoch extreme plus hard cap", () => {
  const generate = body("generateSignal");
  assert.match(generate, /entry1Eligible=!!fastTl&&nearFast&&stochExtremeFast&&!hardCapFast/);
  assert.doesNotMatch(generate, /r2\s*>=\s*0\.60/);
  assert.match(generate, /const stochExtremeFast=fast\.direction==="LONG"\?st\.k<20:fast\.direction==="SHORT"\?st\.k>80:false/);
  assert.match(generate, /hardCapFast=fast\.direction==="LONG"\?st\.k>95:fast\.direction==="SHORT"\?st\.k<5:false/);
  assert.match(generate, /rawType="ENTRY_1";rawDirection=fast\.direction/);
  assert.match(generate, /const finalHardCap=signalDirection==="LONG"\?st\.k>95:st\.k<5/);
});

test("ENTRY_2 and ADD follow macro triggers without saved lifecycle prerequisites", () => {
  const generate = body("generateSignal");
  assert.match(generate, /rawType="ENTRY_2";signalDirection=macro.direction/);
  assert.match(generate, /rawType="ADD";signalDirection=macro.direction/);
  assert.doesNotMatch(generate, /if\([^)]*(?:entry1State|entry2AlreadyFired|hasEntry1|hasEntry2)/);
  assert.doesNotMatch(cron, /entry1_entry2_lifecycle_incomplete|entry1State=|entry2AlreadyFired=/);
});

test("Only directional Stoch hard caps remain; RSI and ADX are not exhaustion vetoes", () => {
  assert.match(strategy, /st\.k>95/);
  assert.match(strategy, /st\.k<5/);
  assert.doesNotMatch(strategy, /rsiExhausted|adxExhausted|RSI exhaustion|ADX >50/);
  assert.doesNotMatch(strategy, /filtersPass=!!dailyTrend/);
});

test("Latest supplied 4H candle is included in strategy and cron processing", () => {
  assert.doesNotMatch(strategy, /slice\(0,\s*-1\)/);
  assert.doesNotMatch(cron, /slice\(0,\s*-1\)/);
  assert.match(body("generateSignal"), /bars=\[\.\.\.candles4h\]/);
  assert.match(cron, /generateSignal\(pair,c1,c4,c15,price\)/);
  assert.match(cron, /4hUsedForStrategy=/);
});

test("4H EMA 5/13 momentum is recorded in signal context and used for trade management, not entry blocking", () => {
  const generate = body("generateSignal");
  const hold = body("shouldHold");
  assert.match(generate, /ema5_4h:e5_4h,ema13_4h:e13_4h,fourHDirection,momentumAligned/);
  assert.match(hold, /ema\(closes,5\)/);
  assert.match(hold, /ema\(closes,13\)/);
  assert.match(hold, /4h_ema5_13_misaligned/);
  assert.match(hold, /newStop:s\.entry/);
  assert.match(cron, /if\(hold\.newStop&&Number\.isFinite\(hold\.newStop\)\)/);
  assert.doesNotMatch(generate, /if\(!momentumAligned\)|if\(momentumAligned/);
});

test("Market snapshot exposes daily macro, ENTRY_1 fast direction and management momentum", () => {
  const snapshot = body("getMarketSnapshot");
  assert.match(snapshot, /dailyDirection:direction/);
  assert.match(snapshot, /entry1Direction/);
  assert.match(snapshot, /momentumAligned/);
  assert.match(snapshot, /ema8_1d|dailyE8/);
  assert.match(snapshot, /ema21_1d|dailyE21/);
});

test("Cron no longer emits a global filter veto or enforces the ENTRY_1 to ENTRY_2 to ADD chain", () => {
  assert.doesNotMatch(cron, /GLOBAL FILTER VETO/);
  assert.match(cron, /stop tightened to entry/);
  assert.doesNotMatch(cron, /entry1_entry2_lifecycle_incomplete/);
});

test("Dashboard presents macro and fast direction without a global red veto state", () => {
  assert.match(dashboard, /DAILY MACRO \(8\/21\)/);
  assert.match(dashboard, /ENTRY_1 FAST \(5\/13\)/);
  assert.match(dashboard, /4H EMA5\/13 MOMENTUM/);
  assert.match(dashboard, /HARD CAP/);
  assert.doesNotMatch(dashboard, /strategyBlocked|border-red-500\/35|VETOED/);
  assert.match(dashboard, /MISALIGNED — MANAGE TRADE/);
});

test("V28 stop/target arithmetic and persisted hysteresis remain intact", () => {
  const generate = body("generateSignal");
  assert.match(generate, /price-2\*avalue/);
  assert.match(generate, /price\+2\*avalue/);
  assert.match(generate, /price\+5\*avalue/);
  assert.match(generate, /price-5\*avalue/);
  assert.match(generate, /targetCount:1,targetAtrMultiple:5/);
  assert.match(strategy, /HYSTERESIS_BAND = 0\.005/);
});
