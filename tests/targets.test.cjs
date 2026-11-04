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

function candles() {
  return Array.from({ length: 30 }, (_, i) => {
    const close = 100 + i * 0.2;
    return { timestamp: i * 14400000, open: close, high: close + 1, low: close - 1, close, volume: 100 };
  });
}
test("LONG stop equals min(20-bar swing low, entry minus 2 ATR)", () => {
  const c = candles(), entry = 110, atr = 2;
  const swingLow = Math.min(...c.slice(-20).map(x => x.low));
  assert.equal(strategy.calculateStop("LONG", entry, atr, c).stop, Math.min(swingLow, entry - 2 * atr));
});
test("SHORT stop equals max(20-bar swing high, entry plus 2 ATR)", () => {
  const c = candles(), entry = 110, atr = 2;
  const swingHigh = Math.max(...c.slice(-20).map(x => x.high));
  assert.equal(strategy.calculateStop("SHORT", entry, atr, c).stop, Math.max(swingHigh, entry + 2 * atr));
});
test("single profit target uses 5 ATR in both directions", () => {
  const source = fs.readFileSync(require.resolve("../lib/strategy.ts"), "utf8");
  assert.match(source, /entry\+5\*a/);
  assert.match(source, /entry-5\*a/);
  assert.match(source, /targetCount:1/);
  assert.doesNotMatch(source, /entry\+15\*a|entry-15\*a/);
});
