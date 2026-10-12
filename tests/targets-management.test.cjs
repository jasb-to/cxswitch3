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

test("SHORT TP1 uses nearest forward pivot at or beyond 1.5R", () => {
  const targets = strategy.calculateTargetsFromPivots("SHORT", 100, 105, [
    { price: 92, index: 1 },
    { price: 85, index: 2 },
  ]);
  assert.equal(targets.tp1, 92);
  assert.equal(targets.tp2, 85);
});

test("SHORT TP1 uses a farther pivot when no closer pivot reaches 1.5R", () => {
  const targets = strategy.calculateTargetsFromPivots("SHORT", 100, 105, [
    { price: 85, index: 1 },
  ]);
  assert.equal(targets.tp1, 85);
  assert.equal(targets.tp2, 82.5);
});

test("target fallbacks maintain at least 1.5R and 2R", () => {
  const targets = strategy.calculateTargetsFromPivots("SHORT", 100, 105, []);
  assert.equal(targets.tp1, 92.5);
  assert.equal(targets.tp2, 90);
});

test("SHORT exits when closed 4H RSI is at or below 22", () => {
  const candles = Array.from({ length: 40 }, (_, i) => {
    const close = 140 - i;
    return { timestamp: i * 14400000, open: close + 0.2, high: close + 1, low: close - 1, close, volume: 1 };
  });
  const signal = { direction: "SHORT", entry: 100, stop: 105, tp1: 95, tp2: 90, timestamp: 1 };
  const result = strategy.shouldHold(signal, candles, 100);
  assert.equal(result.shouldHold, false);
  assert.equal(result.reason, "4h_rsi_extreme_opposite");
  assert.equal(result.managementState, "EXIT");
});

test("LONG exits when closed 4H RSI is at or above 78", () => {
  const candles = Array.from({ length: 40 }, (_, i) => {
    const close = 60 + i;
    return { timestamp: i * 14400000, open: close - 0.2, high: close + 1, low: close - 1, close, volume: 1 };
  });
  const signal = { direction: "LONG", entry: 100, stop: 95, tp1: 105, tp2: 110, timestamp: 1 };
  const result = strategy.shouldHold(signal, candles, 100);
  assert.equal(result.shouldHold, false);
  assert.equal(result.reason, "4h_rsi_extreme_opposite");
  assert.equal(result.managementState, "EXIT");
});
