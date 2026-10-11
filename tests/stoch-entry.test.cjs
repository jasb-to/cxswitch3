const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const vm = require("node:vm");
const ts = require("typescript");

const helperPath = path.join(__dirname, "..", "lib", "stoch-entry.ts");
const helperSource = fs.readFileSync(helperPath, "utf8");
const js = ts.transpileModule(helperSource, {
  compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2020 }
}).outputText;
const module = { exports: {} };
vm.runInNewContext(js, { exports: module.exports, module, require });
const { evaluateStochEntryTriggers } = module.exports;

const longCross = { pk: 20, pd: 25, k: 30, d: 28 };
const shortCross = { pk: 80, pd: 75, k: 70, d: 72 };
const noCross = { pk: 30, pd: 25, k: 35, d: 28 };

test("ENTRY_1 fires on a fresh 4H bullish crossover without requiring a daily crossover", () => {
  const result = evaluateStochEntryTriggers("LONG", longCross, noCross);
  assert.equal(result.entry1, true);
  assert.equal(result.entry2, false);
  assert.equal(result.fourHCross, true);
  assert.equal(result.dailyCross, false);
});

test("ENTRY_2 requires fresh daily and 4H bullish crossovers in the same direction", () => {
  const result = evaluateStochEntryTriggers("LONG", longCross, longCross);
  assert.equal(result.entry1, true);
  assert.equal(result.entry2, true);
});

test("a daily crossover cannot trigger ENTRY_2 without a fresh 4H crossover", () => {
  const result = evaluateStochEntryTriggers("LONG", noCross, longCross);
  assert.equal(result.entry1, false);
  assert.equal(result.entry2, false);
  assert.equal(result.dailyCross, true);
});

test("short entries use the bearish crossover rule", () => {
  const result = evaluateStochEntryTriggers("SHORT", shortCross, shortCross);
  assert.equal(result.entry1, true);
  assert.equal(result.entry2, true);
});

test("a crossover against the daily EMA direction does not trigger", () => {
  const result = evaluateStochEntryTriggers("LONG", shortCross, shortCross);
  assert.equal(result.entry1, false);
  assert.equal(result.entry2, false);
});

test("neutral daily direction blocks both entry types", () => {
  const result = evaluateStochEntryTriggers(null, longCross, longCross);
  assert.equal(result.entry1, false);
  assert.equal(result.entry2, false);
});

test("strategy uses closed 4H and closed daily candles for Stoch RSI triggers", () => {
  const strategy = fs.readFileSync(path.join(__dirname, "..", "lib", "strategy.ts"), "utf8");
  assert.match(strategy, /const closed4h=c\.slice\(0,-1\)/);
  assert.match(strategy, /const closedDaily=daily\(closed4h\)\.slice\(0,-1\)/);
  assert.match(strategy, /evaluateStochEntryTriggers\(direction,st4,st1d\)/);
  assert.doesNotMatch(strategy, /const entry2Candidate=!!direction&&near/);
  assert.doesNotMatch(strategy, /tactical\.turning&&tactical\.direction===direction&&stochCross/);
});
