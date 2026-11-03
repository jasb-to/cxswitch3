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

test("RR remains informational; target fields are distant safety values and risk sizing remains separate",()=>{
 const source=fs.readFileSync(require.resolve("../lib/strategy.ts"),"utf8");
 assert.match(source,/entry\+15\*a/);
 assert.match(source,/entry-15\*a/);
 assert.doesNotMatch(source,/calculateTargetsFromPivots|export function calculateTargets\(/);
 assert.match(source,/calculateRiskSizeMultiplier\(riskPct\)/);
 assert.doesNotMatch(source,/rr\s*<\s*\d|minimumRR|rrGate|R:R gate/i);
});
test("15x leverage is used for modelled liquidation diagnostics",()=>{
 const source=fs.readFileSync(require.resolve("../lib/strategy.ts"),"utf8");
 assert.match(source,/const MAX_LEVERAGE=15/);
});
