const { test } = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const ts = require("typescript");
require.extensions[".ts"] = (module, filename) => {
  const source = fs.readFileSync(filename, "utf8");
  const output = ts.transpileModule(source, { fileName: filename, compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022, esModuleInterop: true } }).outputText;
  module._compile(output, filename);
};
const strategy = require("../lib/strategy.ts");
const FOUR_HOURS = 4 * 60 * 60 * 1000;
const source = fs.readFileSync(require.resolve("../lib/strategy.ts"), "utf8");

function candlesFromDaily(targets, { lastDayRising = false } = {}) {
  const out = [], start = Date.UTC(2026, 0, 1);
  for (let day = 0; day < targets.length; day++) for (let slot = 0; slot < 6; slot++) {
    let close = targets[day];
    if (lastDayRising && day === targets.length - 1) close = targets[day] + slot * Math.max(0.2, targets[day] * 0.01);
    const timestamp = start + (day * 6 + slot) * FOUR_HOURS;
    out.push({ timestamp, open: close, high: close + 0.2, low: close - 0.2, close, volume: 1 });
  }
  return out;
}
function trendTargets(kind, days = 40) {
  return Array.from({ length: days }, (_, i) => {
    if (kind === "bullHigh") return i < 35 ? 100 + i * 2 : 170 + (i - 34) ** 2 * 10;
    if (kind === "bearHigh") return 600 - i * i * 0.22;
    if (kind === "bullLow") return 100 + 5 * i - 0.05 * i * i;
    if (kind === "bearLow") return 500 - 5 * i + 0.05 * i * i;
    if (kind === "bullMed") return 100 + 2 * i;
    if (kind === "bearMed") return 500 - 2 * i;
    if (i < 20) return 100 + i * 2.5;
    if (i < 35) return 147.5 - (i - 19) * 2;
    if (i < 39) return 117 + 3 * (i - 34);
    return 132;
  });
}

test("BEAR_HIGH remains a full-size SHORT regime", () => {
  const regime = strategy.computeRegime(candlesFromDaily(trendTargets("bearHigh")));
  assert.equal(regime.state, "BEAR_HIGH");
  assert.equal(regime.direction, "SHORT");
  assert.equal(regime.sizeMultiplier, 1);
});
test("BEAR_LOW is a half-size regime; daily direction remains independently available", () => {
  const candles = candlesFromDaily(trendTargets("bearLow"));
  const regime = strategy.computeRegime(candles);
  const snapshot = strategy.getMarketSnapshot("TEST", [], candles, []);
  assert.equal(regime.state, "BEAR_LOW");
  assert.equal(regime.sizeMultiplier, 0.5);
  assert.equal(snapshot.dailyDirection, "BEAR");
});
test("BULL_LOW is a half-size regime", () => {
  const regime = strategy.computeRegime(candlesFromDaily(trendTargets("bullLow")));
  assert.equal(regime.state, "BULL_LOW");
  assert.equal(regime.sizeMultiplier, 0.5);
});
test("CHOP is a half-size regime without erasing the separate daily trend", () => {
  const chopTargets = [...Array.from({ length: 36 }, (_, i) => 100 + i * (50 / 35)), 145, 140, 135, 135];
  const candles = candlesFromDaily(chopTargets);
  const regime = strategy.computeRegime(candles);
  const snapshot = strategy.getMarketSnapshot("TEST", [], candles, []);
  assert.equal(regime.state, "CHOP");
  assert.equal(regime.sizeMultiplier, 0.5);
  assert.ok(["BULL", "BEAR", "NEUTRAL"].includes(snapshot.dailyDirection));
});
test("MED regimes use full size; daily EMA8/21 and 4H EMA5/13 have separate roles", () => {
  const candles = candlesFromDaily(trendTargets("bearMed"));
  const regime = strategy.computeRegime(candles);
  const snapshot = strategy.getMarketSnapshot("TEST", [], candles, []);
  assert.equal(regime.state, "BEAR_MED");
  assert.equal(regime.sizeMultiplier, 1);
  assert.equal(snapshot.dailyDirection, "BEAR");
  assert.ok(["BULL", "BEAR", "NEUTRAL"].includes(snapshot.fourHTacticalDirection));
  assert.match(source, /ema\(closes,\s*8\)/);
  assert.match(source, /ema\(closes,\s*21\)/);
  assert.match(source, /ema\(closes,\s*5\)/);
  assert.match(source, /ema\(closes,\s*13\)/);
});
test("ENTRY_1 uses FAST daily EMA5/13, trendline proximity, Stoch extreme and global filters", () => {
  assert.match(source, /function trend1DEntry1[\s\S]*?ema\(closes,5\)[\s\S]*?ema\(closes,13\)/);
  assert.match(source, /entry1TriggerPass\(fast\.direction,fastNear,st\.k,fastFilters\.pass,fastActive\)/);
  assert.match(source, /const momentum=direction==="LONG"\?e5>e13:e5<e13/);
  assert.match(source, /fastFilters\.exhaustion/);
});
test("ENTRY_2 and ADD use MACRO daily EMA8/21 with global momentum and exhaustion filters", () => {
  assert.match(source, /function trend1D[\s\S]*?ema\(closes, 8\)[\s\S]*?ema\(closes, 21\)/);
  assert.match(source, /entry2TriggerPass\(macro\.direction,macroNear,st\.k,st\.d,macroFilters\.pass,macroActive\)/);
  assert.match(source, /macroActive&&beyond&&confirming&&macroFilters\.pass/);
});
test("FAST is evaluated before MACRO and each direction has an independent trendline KV key", () => {
  assert.ok(source.indexOf("if(entry1TriggerPass(fast.direction,fastNear,st.k,fastFilters.pass,fastActive))") < source.indexOf('const macroTl=macro.direction?getTrendline(pair+":MACRO",c,macro.direction):null'));
  assert.match(source, /getTrendline\(key: string, candles: Candle\[\], direction:/);
  assert.match(source, /trendlineStore\.get\(key\)/);
  assert.match(source, /trendlineStore\.set\(key,/);
  assert.ok(source.includes("getTrendlineStateSnapshot"));
  assert.doesNotMatch(source, /pair\s*\+\s*["']:\s*ENTRY_1/);
  assert.ok(source.includes("fastDailyDirection,macroDailyDirection"));
  assert.ok(source.includes("fastTrendlinePrice,fastTrendlineDistance,macroTrendlinePrice,macroTrendlineDistance"));
  assert.ok(source.includes("trendlineDistancePct"));
});
test("V28 stop uses the wider last-20-candle swing or 2 ATR boundary", () => {
  assert.ok(source.includes("recent=c.slice(-20)"));
  assert.ok(source.includes("Math.min(low,price-2*avalue)"));
  assert.ok(source.includes("Math.max(high,price+2*avalue)"));
});
test("V28 uses one 5 ATR target; TP2 is a compatibility mirror", () => {
  assert.ok(source.includes("price+5*avalue"));
  assert.ok(source.includes("price-5*avalue"));
  assert.ok(source.includes("targetCount:1,targetAtrMultiple:5"));
});

test("FAST and MACRO trendline states persist independently and FAST evaluation cannot overwrite MACRO", () => {
  const candles = Array.from({ length: 96 }, (_, i) => {
    const close = 200 + Math.sin(i * 0.55) * 12 + i * 0.05;
    return { timestamp: Date.UTC(2026, 0, 1) + i * FOUR_HOURS, open: close, high: close + 1, low: close - 1, close, volume: 100 };
  });
  const fast = strategy.getTrendline("COLLISION_TEST:FAST", candles, "LONG");
  const macro = strategy.getTrendline("COLLISION_TEST:MACRO", candles, "SHORT");
  assert.ok(fast, "FAST trendline should be calculated");
  assert.ok(macro, "MACRO trendline should be calculated");
  const before = strategy.getTrendlineStateSnapshot();
  assert.equal(before["COLLISION_TEST:FAST"].direction, "LONG");
  assert.equal(before["COLLISION_TEST:MACRO"].direction, "SHORT");
  const macroBefore = { ...before["COLLISION_TEST:MACRO"] };

  const fastAgain = strategy.getTrendline("COLLISION_TEST:FAST", candles, "LONG");
  assert.ok(fastAgain, "FAST trendline should reuse its own cached state");
  const after = strategy.getTrendlineStateSnapshot();
  assert.deepEqual(after["COLLISION_TEST:MACRO"], macroBefore, "FAST recalculation must not overwrite or delete MACRO state");
  assert.equal(after["COLLISION_TEST:FAST"].direction, "LONG");
  assert.equal(after["COLLISION_TEST:MACRO"].direction, "SHORT");
});

test("market snapshot returns separate FAST and MACRO trendline prices and distances", () => {
  const candles = Array.from({ length: 96 }, (_, i) => {
    const close = 200 + Math.sin(i * 0.55) * 12 + i * 0.05;
    return { timestamp: Date.UTC(2026, 0, 1) + i * FOUR_HOURS, open: close, high: close + 1, low: close - 1, close, volume: 100 };
  });
  const snapshot = strategy.getMarketSnapshot("SNAPSHOT_TEST", [], candles, []);
  assert.ok(Object.hasOwn(snapshot, "fastTrendlinePrice"));
  assert.ok(Object.hasOwn(snapshot, "fastTrendlineDistance"));
  assert.ok(Object.hasOwn(snapshot, "macroTrendlinePrice"));
  assert.ok(Object.hasOwn(snapshot, "macroTrendlineDistance"));
});
