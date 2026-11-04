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

test("single V28 target is 5 ATR; RR remains informational, not a gate", () => {
  const source = fs.readFileSync(require.resolve("../lib/strategy.ts"), "utf8");
  assert.match(source, /entry\+5\*a/);
  assert.match(source, /entry-5\*a/);
  assert.match(source, /targetCount:1/);
  assert.doesNotMatch(source, /entry\+15\*a|entry-15\*a/);
  assert.doesNotMatch(source, /rr\s*<\s*\d|minimumRR|rrGate|R:R gate/i);
});
test("15x leverage remains a diagnostic assumption, not an entry gate", () => {
  const source = fs.readFileSync(require.resolve("../lib/strategy.ts"), "utf8");
  assert.match(source, /const MAX_LEVERAGE=15/);
  assert.equal(typeof strategy.calculateLiquidationBufferPct("LONG", 100, 95), "number");
});
