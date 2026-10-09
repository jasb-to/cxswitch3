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
const { evaluateTp1RewardRisk } = loaded.exports;

test("TP1 RR 1.5 passes the 1.35 minimum", () => {
  const result = evaluateTp1RewardRisk("LONG", 100, 98, 103);
  assert.equal(result.rr, 1.5);
  assert.equal(result.passes, true);
});

test("TP1 RR 1.0 is blocked by the 1.35 minimum", () => {
  const result = evaluateTp1RewardRisk("LONG", 100, 98, 102);
  assert.equal(result.rr, 1);
  assert.equal(result.passes, false);
});
