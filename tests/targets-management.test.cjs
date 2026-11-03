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

function candlesFromCloses(closes, range=100) {
  const candles = [];
  let previous = closes[0];
  for (let i = 0; i < closes.length; i++) {
    const close = closes[i];
    candles.push({
      timestamp: i * FOUR_HOURS,
      open: previous,
      high: Math.max(previous, close) + range,
      low: Math.min(previous, close) - range,
      close,
      volume: 1,
    });
    previous = close;
  }
  // The strategy excludes the currently forming candle.
  candles.push({ timestamp: closes.length * FOUR_HOURS, open: previous, high: previous + range, low: previous - range, close: previous, volume: 1 });
  return candles;
}

function structuralSnapCandles(direction) {
  const closes = [];
  let price = 100;
  for (let i = 0; i < 30; i++) {
    price += direction === "LONG" ? 1 : -1;
    closes.push(price);
  }
  // The final two candles create the Stoch extreme; the second candle
  // causes the EMA5/13 cross on the latest completed candle.
  for (let i = 0; i < 2; i++) {
    price += direction === "LONG" ? -8 : 8;
    closes.push(price);
  }
  return candlesFromCloses(closes);
}

test("LONG structural exit requires Stoch RSI K below 20 and a latest closed EMA5/13 bearish cross", () => {
  const signal = { pair: "LONG_SNAP", direction: "LONG", entry: 100, stop: 1, tp1: 1000, tp2: 1000, timestamp: 1 };
  const result = strategy.shouldHold(signal, structuralSnapCandles("LONG"), 100);
  assert.equal(result.shouldHold, false);
  assert.equal(result.reason, "stoch_extreme_ema5_13_bearish_cross");
});

test("SHORT structural exit requires Stoch RSI K above 80 and a latest closed EMA5/13 bullish cross", () => {
  const signal = { pair: "SHORT_SNAP", direction: "SHORT", entry: 100, stop: 1000, tp1: 1, tp2: 1, timestamp: 1 };
  const result = strategy.shouldHold(signal, structuralSnapCandles("SHORT"), 100);
  assert.equal(result.shouldHold, false);
  assert.equal(result.reason, "stoch_extreme_ema5_13_bullish_cross");
});

test("Chandelier tightens the stop using the last 10 completed 4H candles", () => {
  const closes = Array.from({ length: 40 }, (_, i) => 100 + i);
  const candles = candlesFromCloses(closes, 1);
  const signal = { pair: "TRAIL_UPDATE", direction: "LONG", entry: 100, stop: 90, tp1: 9999, tp2: 9999, timestamp: 1 };
  const result = strategy.shouldHold(signal, candles, 145);
  assert.equal(result.shouldHold, true);
  assert.equal(result.reason, "chandelier_stop_update");
  assert.ok(result.newStop > signal.stop);
});

test("Chandelier exits when current price breaches the trailing stop", () => {
  const closes = Array.from({ length: 40 }, (_, i) => 100 + i);
  const candles = candlesFromCloses(closes, 1);
  const signal = { pair: "TRAIL_EXIT", direction: "LONG", entry: 100, stop: 90, tp1: 9999, tp2: 9999, timestamp: 1 };
  const result = strategy.shouldHold(signal, candles, 130);
  assert.equal(result.shouldHold, false);
  assert.equal(result.reason, "chandelier_trailing_stop");
});

test("Stoch RSI or EMA cross alone does not trigger the structural exit", () => {
  const closes = Array.from({ length: 40 }, (_, i) => 100 + i);
  const candles = candlesFromCloses(closes);
  const signal = { pair: "NO_SNAP", direction: "LONG", entry: 100, stop: 1, tp1: 9999, tp2: 9999, timestamp: 1 };
  const result = strategy.shouldHold(signal, candles, 140);
  assert.equal(result.shouldHold, true);
  assert.equal(result.reason, "thesis_intact");
});
