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
const stoch = (k, d, pk = k, pd = d) => ({ k, d, pk, pd });

test("BEAR_HIGH remains a full-size SHORT regime", () => {
  const regime = strategy.computeRegime(candlesFromDaily(trendTargets("bearHigh")));
  assert.equal(regime.state, "BEAR_HIGH");
  assert.equal(regime.direction, "SHORT");
  assert.equal(regime.sizeMultiplier, 1);
});
test("BEAR_LOW is reference-only: EMA8/21 still determines direction and size is 50%", () => {
  const candles = candlesFromDaily(trendTargets("bearLow"));
  const regime = strategy.computeRegime(candles), alignment = strategy.trendAlignment(candles);
  assert.equal(regime.state, "BEAR_LOW");
  assert.equal(regime.sizeMultiplier, 0.5);
  assert.equal(alignment.daily, alignment.dailyE8 < alignment.dailyE21 ? "SHORT" : "LONG");
  assert.equal(alignment.aligned, alignment.daily);
});
test("BULL_LOW is reference-only and applies half size", () => {
  const candles = candlesFromDaily(trendTargets("bullLow"));
  const regime = strategy.computeRegime(candles), alignment = strategy.trendAlignment(candles);
  assert.equal(regime.state, "BULL_LOW");
  assert.equal(regime.sizeMultiplier, 0.5);
  assert.ok(["LONG", "SHORT"].includes(alignment.daily));
  assert.equal(alignment.aligned, alignment.daily);
});
test("CHOP is reference-only and applies half size without nulling EMA8/21 direction", () => {
  const chopTargets = [...Array.from({ length: 36 }, (_, i) => 100 + i * (50 / 35)), 145, 140, 135, 135];
  const candles = candlesFromDaily(chopTargets);
  const regime = strategy.computeRegime(candles), alignment = strategy.trendAlignment(candles);
  assert.equal(regime.state, "CHOP");
  assert.equal(regime.sizeMultiplier, 0.5);
  assert.ok(["LONG", "SHORT"].includes(alignment.daily));
  assert.equal(alignment.aligned, alignment.daily);
});
test("MED regimes use full size; 4H EMA5/13 is a separate momentum filter", () => {
  const candles = candlesFromDaily(trendTargets("bearMed"), { lastDayRising: true });
  const regime = strategy.computeRegime(candles), alignment = strategy.trendAlignment(candles);
  assert.equal(regime.state, "BEAR_MED");
  assert.equal(regime.sizeMultiplier, 1);
  assert.equal(alignment.daily, "SHORT");
  assert.equal(alignment.aligned, "SHORT");
});
test("ENTRY_1 LONG uses K below 20 and SHORT uses K above 80, without requiring a crossover", () => {
  assert.equal(strategy.evaluateEntry1("LONG", stoch(20, 15)).entry1, false);
  assert.equal(strategy.evaluateEntry1("LONG", stoch(19.9, 15)).entry1Long, true);
  assert.equal(strategy.evaluateEntry1("SHORT", stoch(80, 85)).entry1, false);
  assert.equal(strategy.evaluateEntry1("SHORT", stoch(80.1, 85)).entry1Short, true);
});
test("daily EMA8/21 is the direction source even when 4H momentum is opposed", () => {
  const candles = candlesFromDaily(trendTargets("bearMed"), { lastDayRising: true });
  const alignment = strategy.trendAlignment(candles);
  assert.equal(alignment.daily, "SHORT");
  assert.equal(alignment.aligned, "SHORT");
  assert.equal(alignment.fourH, "LONG");
});
test("stop is the more conservative of the 20-bar swing and 2 ATR boundary", () => {
  const candles = candlesFromDaily(trendTargets("bullMed"));
  const result = strategy.calculateStop("LONG", 110, 2, candles);
  const low = Math.min(...candles.slice(-20).map(x => x.low));
  assert.equal(result.stop, Math.min(low, 106));
});
test("single target is 5 ATR and is recorded as targetCount 1", () => {
  const source = fs.readFileSync(require.resolve("../lib/strategy.ts"), "utf8");
  assert.match(source, /entry\+5\*a/);
  assert.match(source, /entry-5\*a/);
  assert.match(source, /targetCount:1/);
});
