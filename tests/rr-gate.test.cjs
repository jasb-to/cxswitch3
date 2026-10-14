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

test("RR is informational and targets use pivot structure with minimum R distances",()=>{
 const source=fs.readFileSync(require.resolve("../lib/strategy.ts"),"utf8");
 assert.match(source,/minTp1Distance=1\.5\*riskDistance/);
 assert.match(source,/minTp2Distance=2\.0\*riskDistance/);
 assert.match(source,/calculateTargets\(direction,entry,stopResult\.stop,c\)/);
 assert.match(source,/calculateRiskSizeMultiplier\(riskPct\)/);
 assert.doesNotMatch(source,/rr\s*<\s*\d|minimumRR|rrGate|R:R gate/i);
});
test("15x leverage is used for modelled liquidation diagnostics",()=>{
 const source=fs.readFileSync(require.resolve("../lib/strategy.ts"),"utf8");
 assert.match(source,/const MAX_LEVERAGE=15/);
});
