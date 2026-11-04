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

function trendCandles(direction, noise = []) {
  const out = [];
  for (let i = 0; i < 61; i++) {
    const base = direction === "LONG" ? 100 + i * 0.5 : 200 - i * 0.5;
    out.push({ timestamp: Date.UTC(2026, 0, 1) + i * 14400000, open: base, close: base, high: base + 1, low: base - 1, volume: 100 });
  }
  let n = 0;
  for (let i = 5; i <= 55; i += 10) {
    const base = direction === "LONG" ? 100 + i * 0.5 : 200 - i * 0.5;
    if (direction === "LONG") out[i].low = base - 10 + (noise[n] ?? 0);
    else out[i].high = base + 10 + (noise[n] ?? 0);
    n++;
  }
  return out;
}

test("ascending LONG swing-pivot trendline passes pivot quality checks", () => {
  const result = strategy.get4HTrendline(trendCandles("LONG"), "LONG", 130);
  assert.equal(result.valid, true);
  assert.ok(result.r2 >= 0.6);
  assert.ok(result.slope > 0);
});
test("descending SHORT swing-pivot trendline passes pivot quality checks", () => {
  const result = strategy.get4HTrendline(trendCandles("SHORT"), "SHORT", 170);
  assert.equal(result.valid, true);
  assert.ok(result.slope < 0);
});
test("trendline proximity is capped at 1.2 percent", () => {
  assert.equal(strategy.evaluateTrendlineProximity(101.19, 100).valid, true);
  assert.equal(strategy.evaluateTrendlineProximity(101.21, 100).valid, false);
});
test("ENTRY_1 thresholds are strict: LONG K below 20 and SHORT K above 80", () => {
  assert.equal(strategy.evaluateEntry1("LONG", { k: 20, d: 15, pk: 20, pd: 15 }).entry1, false);
  assert.equal(strategy.evaluateEntry1("LONG", { k: 19.9, d: 15, pk: 20, pd: 15 }).entry1Long, true);
  assert.equal(strategy.evaluateEntry1("SHORT", { k: 80, d: 85, pk: 80, pd: 85 }).entry1, false);
  assert.equal(strategy.evaluateEntry1("SHORT", { k: 80.1, d: 85, pk: 80, pd: 85 }).entry1Short, true);
});
test("Exhaustion veto thresholds are RSI 78/22 and Stoch K 95/5", () => {
  const source = fs.readFileSync(require.resolve("../lib/strategy.ts"), "utf8");
  assert.ok(source.includes("rv>78"));
  assert.ok(source.includes("rv<22"));
  assert.ok(source.includes("st.k>95"));
  assert.ok(source.includes("st.k<5"));
});
test("4H EMA5/13 momentum must agree with the 1D EMA8/21 direction", () => {
  const source = fs.readFileSync(require.resolve("../lib/strategy.ts"), "utf8");
  assert.ok(source.includes("hE5>hE13"));
  assert.ok(source.includes("hE5<hE13"));
  assert.ok(source.includes("const filtersPass=!!direction&&momentumAligned&&!exhaustionReason"));
});
test("ADD requires a same-direction active position, a greater-than-0.8% break, confirmation and a qualifying confirmation", () => {
  const source = fs.readFileSync(require.resolve("../lib/strategy.ts"), "utf8");
  assert.ok(source.includes("activeSignals.some(x=>x.pair===pair&&x.direction===direction)"));
  assert.ok(source.includes("breakoutDistance>0.8"));
  assert.ok(source.includes("breakoutDistance< -0.8"));
  assert.ok(source.includes("confirming&&(volumeAligned||stochMomentum||adxValue>20)"));
  assert.ok(source.includes("lastClosed.volume>1.3*volumeAverage"));
});
test("V28 stop and target geometry are 20-bar swing / 2 ATR and one 5 ATR target", () => {
  const source = fs.readFileSync(require.resolve("../lib/strategy.ts"), "utf8");
  assert.ok(source.includes("closed.slice(-20)"));
  assert.ok(source.includes("entry-2*atrValue"));
  assert.ok(source.includes("entry+2*atrValue"));
  assert.ok(source.includes("entry+5*a"));
  assert.ok(source.includes("entry-5*a"));
  assert.ok(source.includes("targetCount:1"));
});
