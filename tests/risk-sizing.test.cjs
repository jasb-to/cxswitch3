const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const vm = require("node:vm");
const ts = require("typescript");

const source = fs.readFileSync(path.join(__dirname, "../lib/strategy.ts"), "utf8");
const compiled = ts.transpileModule(source, {
  compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022 },
}).outputText;
const moduleRef = { exports: {} };
vm.runInNewContext(compiled, { exports: moduleRef.exports, module: moduleRef, require });
const { calculateRiskSizeMultiplier } = moduleRef.exports;

test("risk sizing: 3.4% risk keeps full size", () => {
  assert.equal(calculateRiskSizeMultiplier(3.4), 1);
});

test("risk sizing: 4.0% risk applies half size", () => {
  assert.equal(calculateRiskSizeMultiplier(4.0), 0.5);
});

test("risk sizing: 5.2% risk blocks the signal", () => {
  assert.equal(calculateRiskSizeMultiplier(5.2), null);
});

test("risk sizing: exact boundaries remain inclusive", () => {
  assert.equal(calculateRiskSizeMultiplier(3.5), 1);
  assert.equal(calculateRiskSizeMultiplier(5.0), 0.5);
  assert.equal(calculateRiskSizeMultiplier(5.0001), null);
});
