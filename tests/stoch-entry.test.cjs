const { test } = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const ts = require("typescript");
require.extensions[".ts"] = (module, filename) => {
  const source = fs.readFileSync(filename, "utf8");
  const output = ts.transpileModule(source, { fileName: filename, compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022, esModuleInterop: true } }).outputText;
  module._compile(output, filename);
};
const strategySource = fs.readFileSync("lib/strategy.ts", "utf8");
const { getStochHistoryPointCount, generateSignal } = require("../lib/strategy.ts");
const body = (name) => {
  const start = strategySource.indexOf("export function " + name);
  const end = strategySource.indexOf("\nexport function ", start + 20);
  return strategySource.slice(start, end > 0 ? end : strategySource.length);
};

test("ENTRY_1, ENTRY_2 and ADD all reference one shared 4H trendline", () => {
  const evaluate = body("evaluateGates");
  const generate = body("generateSignal");
  assert.match(evaluate, /getTrendline\(pair,bars,trendlineDirection\)/);
  assert.match(generate, /getTrendline\(pair,bars,trendlineDirection\)/);
  assert.match(generate, /const signalTl=trendline/);
  assert.doesNotMatch(strategySource, /getTrendline\(pair,bars,fast\.direction/);
  assert.doesNotMatch(strategySource, /track: "FAST" \| "MACRO"/);
});

test("ENTRY_1 uses fast daily EMA5/13, shared-line proximity and Stoch extreme", () => {
  const generate = body("generateSignal");
  assert.match(generate, /entry1Eligible=!!entry1TradeDirection&&!entry1DailyOpposes&&nearFast&&stochExtremeFast&&!hardCap/);
  assert.match(generate, /rawType="ENTRY_1";rawDirection=entry1TradeDirection/);
});

test("ENTRY_2 uses macro EMA8/21, shared-line proximity and Stoch turn without requiring ENTRY_1", () => {
  const generate = body("generateSignal");
  assert.match(generate, /entry2Eligible=!!macro.direction&&nearMacro&&stochTurningMacro&&!stochExtremeMacro&&!hardCap/);
  assert.match(generate, /rawType="ENTRY_2";rawDirection=macro\.direction/);
  assert.match(generate, /const finalType=rawType/);
  assert.match(generate, /entry2Eligible=!!macro\.direction&&nearMacro&&stochTurningMacro/);
});

test("ADD alone requires an active same-direction position and the 4H breakout confirmations", () => {
  const evaluate = body("evaluateGates");
  const generate = body("generateSignal");
  assert.match(evaluate, /activeMatch=!!macro\.direction&&activeSignals\.some/);
  assert.match(generate, /activeMatch=!!macro\.direction&&_activeSignals\.some/);
  assert.ok(generate.includes("else if(activeMatch&&macro.direction&&trendline&&beyondTrendline&&confirming&&emaAligned&&(volUp||stochMomentum||adxStrong)&&!hardCap)"));
  assert.match(generate, /volUp\|\|stochMomentum\|\|adxStrong/);
});

test("No global RSI or ADX exhaustion veto is applied to the entry stages", () => {
  assert.doesNotMatch(strategySource, /rsiExhausted|adxExhausted|RSI exhaustion|ADX >50/);
  assert.match(strategySource, /st\.k>95/);
  assert.match(strategySource, /st\.k<5/);
});

test("insufficient 4H history is reported clearly", () => {
  const result = generateSignal("TEST", [], [], []);
  assert.ok(result.debug.some(x => x.includes("Insufficient 4H candle data")));
});

test("insufficient Stoch history is reported as zero usable smoothed points", () => {
  assert.equal(getStochHistoryPointCount([]), 0);
  assert.equal(getStochHistoryPointCount(Array.from({ length: 30 }, (_, i) => 100 + i)), 0);
});
