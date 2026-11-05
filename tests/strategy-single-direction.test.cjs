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
test("BEAR_LOW is a half-size regime; daily EMA5/13 direction remains available", () => {
  const candles = candlesFromDaily(trendTargets("bearLow"));
  const regime = strategy.computeRegime(candles);
  const snapshot = strategy.getMarketSnapshot("TEST", [], candles, []);
  assert.equal(regime.state, "BEAR_LOW");
  assert.equal(regime.sizeMultiplier, 0.5);
  assert.equal(snapshot.dailyDirection, "SHORT");
});
test("BULL_LOW is a half-size regime", () => {
  const regime = strategy.computeRegime(candlesFromDaily(trendTargets("bullLow")));
  assert.equal(regime.state, "BULL_LOW");
  assert.equal(regime.sizeMultiplier, 0.5);
});
test("CHOP is a half-size regime without erasing the daily EMA5/13 trend", () => {
  const chopTargets = [...Array.from({ length: 36 }, (_, i) => 100 + i * (50 / 35)), 145, 140, 135, 138];
  const candles = candlesFromDaily(chopTargets);
  const regime = strategy.computeRegime(candles);
  const snapshot = strategy.getMarketSnapshot("TEST", [], candles, []);
  assert.equal(regime.state, "CHOP");
  assert.equal(regime.sizeMultiplier, 0.5);
  assert.ok(["LONG", "SHORT", null].includes(snapshot.dailyDirection));
});
test("MED regimes use full size; daily EMA5/13 and 4H EMA5/13 roles are aligned", () => {
  const candles = candlesFromDaily(trendTargets("bearMed"));
  const regime = strategy.computeRegime(candles);
  const snapshot = strategy.getMarketSnapshot("TEST", [], candles, []);
  assert.equal(regime.state, "BEAR_MED");
  assert.equal(regime.sizeMultiplier, 1);
  assert.equal(snapshot.dailyDirection, "SHORT");
  assert.ok(["BULL", "BEAR", "NEUTRAL"].includes(snapshot.fourHTacticalDirection));
  assert.match(source, /ema\(closes,\s*5\)/);
  assert.match(source, /ema\(closes,\s*13\)/);
});

test("trend1D uses EMA5/13 for its only daily direction", () => {
  const trendStart = source.indexOf("function trend1D(");
  const trendEnd = source.indexOf(String.fromCharCode(10) + "}", trendStart);
  const trend = source.slice(trendStart, trendEnd);
  assert.ok(trend.includes("ema(closes, 5)"));
  assert.ok(trend.includes("ema(closes, 13)"));
  assert.ok(!trend.includes("ema(closes, 8)"));
  assert.ok(!trend.includes("ema(closes, 21)"));
});
test("both evaluateGates and generateSignal gate ENTRY_1 on momentum and exhaustion", () => {
  const filter = "const filtersPass=!!dailyTrend.direction&&momentumAligned&&!exhaustion;";
  assert.equal(source.split(filter).length - 1, 2);
  assert.equal(source.split('if(filtersPass){').length - 1, 2);
  assert.equal(source.split('if(!hasEntry1&&!hasSameDirectionPosition&&nearTrendline&&stochExtreme)rawType="ENTRY_1";').length - 1, 2);
});
