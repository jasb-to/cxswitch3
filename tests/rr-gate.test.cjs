const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const Module = require("node:module");
const ts = require("typescript");

const filename = path.resolve(__dirname, "../lib/strategy.ts");
const source = fs.readFileSync(filename, "utf8");
const compiled = ts.transpileModule(source, {
  compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022 },
}).outputText;
const loaded = new Module(filename, module);
loaded.filename = filename;
loaded.paths = Module._nodeModulePaths(path.dirname(filename));
const originalRequire = loaded.require.bind(loaded);
loaded.require = (id) => id === "./ema-diagnostic"
  ? { get4HEmaDiagnostic: () => ({ turning: false, spread: 0, stage: "NEUTRAL", label: "NEUTRAL" }) }
  : originalRequire(id);
loaded._compile(compiled, filename);
const { calculateStop, calculateLiquidationBufferPct, structureTargets, CURRENT_SIGNAL_VERSION } = loaded.exports;

function candle(index, { high = 100.2, low = 99.8, close = 100, open = close } = {}) {
  return { timestamp: index * 14_400_000, open, high, low, close, volume: 1 };
}

test("signal engine identifies itself as restored V28", () => {
  assert.equal(CURRENT_SIGNAL_VERSION, 28);
});

test("stop uses the highest high from the last 10 closed candles and ignores the open candle", () => {
  const candles = Array.from({ length: 12 }, (_, i) => candle(i));
  candles[10] = candle(10, { high: 108, low: 99.8, close: 100 });
  candles[11] = candle(11, { high: 150, low: 99.8, close: 100 });
  const result = calculateStop("SHORT", 100, 100, 2, candles);
  assert.equal(result.stop, 108);
  assert.equal(result.calc.structuralAnchor, 108);
  assert.equal(result.valid, true);
});

test("when the recent swing is close, the stop respects the 1.5 ATR floor", () => {
  const candles = Array.from({ length: 12 }, (_, i) => candle(i));
  const result = calculateStop("SHORT", 100, 100, 2, candles);
  assert.equal(result.stop, 103);
  assert.equal(result.valid, true);
});

test("TP1 is the nearest profit-side pivot and TP2 is the next pivot beyond it", () => {
  const candles = Array.from({ length: 30 }, (_, i) => candle(i, { high: 101, low: 99, close: 100 }));
  candles[8] = candle(8, { high: 110, low: 99, close: 100 });
  candles[15] = candle(15, { high: 120, low: 99, close: 100 });
  const targets = structureTargets("LONG", 100, candles);
  assert.equal(targets.tp1, 110);
  assert.equal(targets.tp2, 120);
  assert.equal(targets.tp1Source, "nearest 4H swing pivot");
  assert.equal(targets.tp2Source, "next 4H swing pivot");
});

test("short targets choose the nearest lower pivot then the next lower pivot", () => {
  const candles = Array.from({ length: 30 }, (_, i) => candle(i, { high: 101, low: 99, close: 100 }));
  candles[8] = candle(8, { high: 101, low: 90, close: 100 });
  candles[15] = candle(15, { high: 101, low: 80, close: 100 });
  const targets = structureTargets("SHORT", 100, candles);
  assert.equal(targets.tp1, 90);
  assert.equal(targets.tp2, 80);
});

test("20x liquidation distance is diagnostic and does not invalidate a V28 stop", () => {
  const entry = 0.08524;
  const stop = 0.08964;
  const candles = Array.from({ length: 12 }, (_, i) => candle(i, { high: 0.086, low: 0.084, close: entry }));
  candles[10] = candle(10, { high: stop, low: 0.084, close: entry });
  const result = calculateStop("SHORT", entry, entry, 0.0005, candles);
  const expectedLiq = entry * (1 + 1 / 20 - 0.01);
  const expectedBuffer = (expectedLiq - result.stop) / expectedLiq * 100;
  assert.equal(result.stop, stop);
  assert.ok(Math.abs(result.calc.liquidationPrice - expectedLiq) < 0.00001);
  assert.ok(Math.abs(result.calc.liquidationBufferPct - expectedBuffer) < 0.01);
  assert.ok(result.calc.liquidationBufferPct < 0);
  assert.equal(result.valid, true);
});

test("liquidation diagnostic defaults to 20x", () => {
  const expectedLiq = 100 * (1 + 1 / 20 - 0.01);
  const buffer = calculateLiquidationBufferPct("SHORT", 100, 105);
  assert.ok(Math.abs(expectedLiq - 104) < 1e-9);
  assert.ok(Math.abs(buffer - ((expectedLiq - 105) / expectedLiq * 100)) < 1e-9);
});
