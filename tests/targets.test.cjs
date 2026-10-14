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

test("stale distant pivots fall back to 1.5R and 2R targets", () => {
  const result = strategy.calculateTargetsFromPivots("SHORT", 2417, 2527, [
    { price: 1914, index: 12 },
    { price: 1911, index: 18 },
  ]);
  assert.equal(result.tp1, 2252);
  assert.equal(result.tp2, 2197);
  assert.equal(result.tp1Source, "fallback 1.5R");
  assert.equal(result.tp2Source, "fallback 2R");
});

test("nearby valid pivots are used in price order and meet R floors", () => {
  const result = strategy.calculateTargetsFromPivots("SHORT", 2417, 2527, [
    { price: 2380, index: 10 },
    { price: 2200, index: 20 },
    { price: 2150, index: 30 },
  ]);
  assert.equal(result.tp1, 2200);
  assert.equal(result.tp2, 2150);
  assert.equal(result.tp1Source, "pivot");
  assert.equal(result.tp2Source, "pivot");
  assert.ok(2417 - result.tp1 >= 1.5 * 110);
  assert.ok(2417 - result.tp2 >= 2 * 110);
});

test("long target fallback mirrors short target distances", () => {
  const result = strategy.calculateTargetsFromPivots("LONG", 100, 90, []);
  assert.equal(result.tp1, 115);
  assert.equal(result.tp2, 120);
});

test("TP2 remains beyond a valid farther TP1 when no second pivot qualifies", () => {
  const result = strategy.calculateTargetsFromPivots("SHORT", 100, 110, [
    { price: 74, index: 10 },
  ]);
  assert.equal(result.tp1, 74);
  assert.equal(result.tp2, 69);
});

test("target debug includes pair, risk, pivots and fallback sources", () => {
  const source = fs.readFileSync(require.resolve("../lib/strategy.ts"), "utf8");
  assert.match(source, /\[TARGETS\].*forward pivots/);
  assert.match(source, /fallback 1\.5R/);
  assert.match(source, /fallback 2R/);
});
