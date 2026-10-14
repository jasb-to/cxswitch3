const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const ts = require("typescript");
require.extensions[".ts"] = (module, filename) => {
  const source = fs.readFileSync(filename, "utf8");
  const output = ts.transpileModule(source, { fileName: filename, compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022, esModuleInterop: true } }).outputText;
  module._compile(output, filename);
};
const { calculateRiskSizeMultiplier } = require("../lib/strategy.ts");

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
