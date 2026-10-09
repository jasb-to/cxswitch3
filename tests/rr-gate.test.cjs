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
const { evaluateTp2RewardRisk, calculateStop, structureTargets, calculateLiquidationBufferPct, passesLiquidationBuffer } = loaded.exports;

function candle(index, { high = 0.0845, low = 0.0835, close = 0.084, open = close } = {}) {
  return { timestamp: index * 14_400_000, open, high, low, close, volume: 1 };
}

test("TP2 RR 1.5 passes the minimum", () => {
  const result = evaluateTp2RewardRisk("LONG", 100, 98, 103);
  assert.equal(result.rr, 1.5);
  assert.equal(result.passes, true);
});

test("TP2 RR below 1.5 is blocked", () => {
  const result = evaluateTp2RewardRisk("LONG", 100, 98, 102.8);
  assert.ok(Math.abs(result.rr - 1.4) < 1e-9);
  assert.equal(result.passes, false);
});

test("TP2 RR affected only by floating-point noise at 1.5 passes", () => {
  const result = evaluateTp2RewardRisk("SHORT", 0.08490791686390503, 0.08964, 0.077804);
  assert.ok(result.rr < 1.5);
  assert.ok(result.rr > 1.5 - 1e-10);
  assert.equal(result.passes, true);
});

test("TP2 RR meaningfully below 1.5 remains blocked despite tolerance", () => {
  const result = evaluateTp2RewardRisk("LONG", 100, 98, 102.799999);
  assert.equal(result.passes, false);
});

test("short stop uses the highest high from the last 10 closed candles, not the open candle", () => {
  const candles = Array.from({ length: 12 }, (_, i) => candle(i, { high: 0.085, low: 0.083, close: 0.084 }));
  candles[10] = candle(10, { high: 0.08693, low: 0.083, close: 0.084 });
  candles[11] = candle(11, { high: 0.2, low: 0.083, close: 0.084 });
  const result = calculateStop("SHORT", 0.08431, 0.084, 0.0005, candles);
  assert.equal(result.stop, 0.08693);
  assert.equal(result.calc.structuralAnchor, 0.08693);
});

test("when recent swing is close, the stop respects the 1.5 ATR floor", () => {
  const candles = Array.from({ length: 12 }, (_, i) => candle(i, { high: 100.2, low: 99.8, close: 100 }));
  const result = calculateStop("SHORT", 100, 100, 2, candles);
  assert.equal(result.stop, 103);
});

test("low ATR cannot reduce TP1 minimum below 3.5%", () => {
  const entry = 100;
  const candles = Array.from({ length: 24 }, (_, i) => candle(i, { high: 101, low: 99, close: 100 }));
  const targets = structureTargets("LONG", entry, candles, 0.01, 98);
  assert.equal(targets.tp1, 103.5);
  assert.ok(targets.tp2 >= 107);
});

test("DOGE-style short selects structural TP1 and TP2 at the required distances", () => {
  const entry = 0.08431;
  const candles = Array.from({ length: 25 }, (_, i) => candle(i));
  candles[5] = candle(5, { high: 0.0845, low: 0.081, close: 0.083 });
  candles[10] = candle(10, { high: 0.0845, low: 0.078, close: 0.083 });
  candles[15] = candle(15, { high: 0.0845, low: 0.077, close: 0.083 });
  const stop = 0.08693;
  const targets = structureTargets("SHORT", entry, candles, 0.0005, stop);
  assert.ok((entry - targets.tp1) / entry >= 0.035);
  assert.ok((entry - targets.tp2) / entry >= 0.07);
  assert.ok(targets.tp2 < targets.tp1);
  assert.ok(evaluateTp2RewardRisk("SHORT", entry, stop, targets.tp2).rr >= 1.5);
});

test("DOGE short at 15x remains blocked when buffer is below the 0.5% minimum", () => {
  const entry = 0.08524;
  const stop = 0.08964;
  const candles = Array.from({ length: 12 }, (_, i) => candle(i, { high: 0.088, low: 0.084, close: 0.085 }));
  candles[10] = candle(10, { high: stop, low: 0.084, close: entry });
  const result = calculateStop("SHORT", entry, 0.085, 0.0005, candles);
  const expectedLiq = entry * (1 + 1 / 15 - 0.01);
  const expectedBuffer = (expectedLiq - stop) / expectedLiq * 100;
  assert.equal(result.stop, stop);
  assert.ok(Math.abs(result.calc.liquidationPrice - expectedLiq) < 0.00001);
  assert.ok(Math.abs(result.calc.liquidationBufferPct - expectedBuffer) < 0.01);
  assert.ok(result.calc.liquidationBufferPct > 0);
  assert.ok(result.calc.liquidationBufferPct < 0.5);
  assert.equal(result.valid, false);
  assert.equal(passesLiquidationBuffer(result.calc.liquidationBufferPct), false);
});

test("15x short with entry 100 and stop 108 is blocked beyond modelled liquidation", () => {
  const liq = 100 * (1 + 1 / 15 - 0.01);
  const buffer = calculateLiquidationBufferPct("SHORT", 100, 108);
  assert.ok(Math.abs(liq - 105.6666666667) < 1e-8);
  assert.ok(buffer < 0);
  assert.equal(passesLiquidationBuffer(buffer), false);
});

test("15x short with entry 100 and stop 105 passes the 0.5% liquidation buffer", () => {
  const liq = 100 * (1 + 1 / 15 - 0.01);
  const buffer = calculateLiquidationBufferPct("SHORT", 100, 105);
  assert.ok(Math.abs(liq - 105.6666666667) < 1e-8);
  assert.ok(Math.abs(buffer - ((liq - 105) / liq * 100)) < 1e-9);
  assert.ok(buffer >= 0.5);
  assert.equal(passesLiquidationBuffer(buffer), true);
});

test("ETH-like short at 15x has a positive buffer for entry 2572 and stop 2585", () => {
  const entry = 2572;
  const stop = 2585;
  const liq = entry * (1 + 1 / 15 - 0.01);
  const buffer = calculateLiquidationBufferPct("SHORT", entry, stop);
  assert.ok(Math.abs(liq - 2717.7466666667) < 1e-6);
  assert.ok(Math.abs(buffer - ((liq - stop) / liq * 100)) < 1e-9);
  assert.ok(buffer > 4.8 && buffer < 5.0);
  assert.equal(passesLiquidationBuffer(buffer), true);
});
