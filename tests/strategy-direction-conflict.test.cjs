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
  for (let day = 0; day < targets.length; day++) {
    for (let slot = 0; slot < 6; slot++) {
      let close = targets[day];
      if (lastDayRising && day === targets.length - 1) close = targets[day] + slot * Math.max(0.2, targets[day] * 0.01);
      const timestamp = start + (day * 6 + slot) * FOUR_HOURS;
      out.push({ timestamp, open: close, high: close + 0.2, low: close - 0.2, close, volume: 1 });
    }
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
function stoch(k, d, pk, pd) { return { k, d, pk, pd }; }

test("BEAR_HIGH regime remains tradeable at full regime size", () => {
  const regime = strategy.computeRegime(candlesFromDaily(trendTargets("bearHigh")));
  assert.equal(regime.state, "BEAR_HIGH");
  assert.equal(regime.direction, "SHORT");
  assert.equal(regime.sizeMultiplier, 1);
  const trigger = strategy.evaluateEntry1(regime.direction, stoch(80, 85, 90, 85));
  assert.equal(trigger.entry1Short, true);
  assert.equal(trigger.direction, "SHORT");
});

test("BEAR_LOW regime blocks direction and has zero size", () => {
  const regime = strategy.computeRegime(candlesFromDaily(trendTargets("bearLow")));
  assert.equal(regime.state, "BEAR_LOW");
  assert.equal(regime.direction, null);
  assert.equal(regime.sizeMultiplier, 0);
  assert.equal(strategy.regimeAllowsTrading(regime.state), false);
});

test("CHOP + fresh bearish Stoch cross => no signal and zero size", () => {
  const regime = strategy.computeRegime(candlesFromDaily(trendTargets("bullMed", 16)));
  assert.equal(regime.state, "CHOP");
  assert.equal(regime.direction, null);
  assert.equal(regime.sizeMultiplier, 0);
  const trigger = strategy.evaluateEntry1(regime.direction, stoch(75, 77, 80, 78));
  assert.equal(trigger.entry1, false);
});

test("BULL_LOW regime blocks direction and has zero size", () => {
  const regime = strategy.computeRegime(candlesFromDaily(trendTargets("bullLow")));
  assert.equal(regime.state, "BULL_LOW");
  assert.equal(regime.direction, null);
  assert.equal(regime.sizeMultiplier, 0);
  assert.equal(strategy.regimeAllowsTrading(regime.state), false);
});

test("MED regimes use full size; direction does not require 4H EMA5/13 agreement", () => {
  const c = candlesFromDaily(trendTargets("bearMed"), { lastDayRising: true });
  const regime = strategy.computeRegime(c);
  const alignment = strategy.trendAlignment(c);
  assert.equal(regime.state, "BEAR_MED");
  assert.equal(regime.sizeMultiplier, 1);
  assert.equal(alignment.daily, "SHORT");
  assert.equal(alignment.aligned, "SHORT");
  assert.equal(alignment.fourH, "LONG");
});

test("Spread output is signed and includes the three-day comparison", () => {
  const regime = strategy.computeRegime(candlesFromDaily(trendTargets("bearMed")));
  assert.ok(regime.spread < 0);
  assert.ok(Number.isFinite(regime.spread3));
  assert.ok(Number.isFinite(regime.spreadDelta));
});

test("ENTRY_1 uses strict V28 K extremes", () => {
  assert.equal(strategy.evaluateEntry1("SHORT", stoch(60, 65, 70, 65)).entry1, false);
  assert.equal(strategy.evaluateEntry1("SHORT", stoch(80, 85, 90, 85)).entry1Short, true);
  assert.equal(strategy.evaluateEntry1("LONG", stoch(40, 35, 30, 35)).entry1, false);
  assert.equal(strategy.evaluateEntry1("LONG", stoch(20, 15, 10, 15)).entry1Long, true);
});

test("ENTRY_1 accepts a crossover on either of the last two candle transitions", () => {
  const previousCandleCross = strategy.evaluateEntry1("SHORT", [
    { k: 90, d: 85 }, { k: 80, d: 85 }, { k: 79, d: 84 },
  ]);
  assert.equal(previousCandleCross.entry1Short, true);
  assert.equal(previousCandleCross.crossAge, "previous candle");
  const noRecentCross = strategy.evaluateEntry1("SHORT", [
    { k: 45, d: 50 }, { k: 42.8, d: 50.3 }, { k: 36, d: 44.7 },
  ]);
  assert.equal(noRecentCross.entry1Short, false);
  assert.equal(noRecentCross.reason, "no_cross_found");
});

test("structural stop uses the last 20 candles and the 2 ATR floor", () => {
  const c = candlesFromDaily(trendTargets("bullMed"));
  const result = strategy.calculateStop("LONG", 110, 2, c);
  const low = Math.min(...c.slice(-20).map(x => x.low));
  assert.equal(result.valid, true);
  assert.equal(result.stop, Math.min(low, 106));
});

test("shouldHold does not scale out at TP1 and only returns a tighter Chandelier stop", () => {
  const c = candlesFromDaily(Array.from({ length: 40 }, (_, i) => 100 + i * 0.02 + (i % 2 ? 0.5 : -0.5)));
  const base = { direction: "LONG", entry: 100, stop: 90, tp1: 103, tp2: 106, timestamp: Date.UTC(2026, 0, 1), version: 32 };
  const result = strategy.shouldHold(base, c, 105);
  assert.equal(result.shouldHold, true);
  assert.equal(result.reason, "chandelier_stop_update");
  assert.ok(result.newStop > base.stop);
});
