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
function candlesFromCloses(closes, range = 0.5) {
  const candles = [];
  let previous = closes[0];
  for (let i = 0; i < closes.length; i++) {
    const close = closes[i];
    candles.push({ timestamp: i * FOUR_HOURS, open: previous, high: Math.max(previous, close) + range, low: Math.min(previous, close) - range, close, volume: 1 });
    previous = close;
  }
  candles.push({ timestamp: closes.length * FOUR_HOURS, open: previous, high: previous + range, low: previous - range, close: previous, volume: 1 });
  return candles;
}
const signal = (direction, overrides = {}) => ({ pair: "TEST", direction, entry: 100, stop: direction === "LONG" ? 90 : 110, tp1: direction === "LONG" ? 200 : 1, tp2: direction === "LONG" ? 200 : 1, timestamp: 1, ...overrides });

test("LONG hard stop exits immediately", () => {
  const c = candlesFromCloses(Array.from({ length: 30 }, (_, i) => 100 + i * 0.1));
  assert.equal(strategy.shouldHold(signal("LONG"), c, 90).reason, "stop_hit");
});
test("SHORT hard stop exits immediately", () => {
  const c = candlesFromCloses(Array.from({ length: 30 }, (_, i) => 100 - i * 0.1));
  assert.equal(strategy.shouldHold(signal("SHORT"), c, 110).reason, "stop_hit");
});
test("LONG single target hit exits", () => {
  const c = candlesFromCloses(Array.from({ length: 30 }, (_, i) => 100 + i * 0.1));
  assert.equal(strategy.shouldHold(signal("LONG", { tp1: 105 }), c, 105).reason, "target_hit");
});
test("SHORT single target hit exits", () => {
  const c = candlesFromCloses(Array.from({ length: 30 }, (_, i) => 100 - i * 0.1));
  assert.equal(strategy.shouldHold(signal("SHORT", { tp1: 95 }), c, 95).reason, "target_hit");
});
test("Chandelier trailing stop logic is absent", () => {
  const source = fs.readFileSync(require.resolve("../lib/strategy.ts"), "utf8");
  assert.doesNotMatch(source, /chandelier_trailing_stop|chandelier_stop_update|highest high \/ lowest low/);
});
