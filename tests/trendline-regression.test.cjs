const { test } = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const ts = require("typescript");

// This repository has no test runner dependency. Transpile its TypeScript modules
// in-process with the already-installed TypeScript compiler for Node's test runner.
require.extensions[".ts"] = (module, filename) => {
  const source = fs.readFileSync(filename, "utf8");
  const output = ts.transpileModule(source, {
    fileName: filename,
    compilerOptions: {
      module: ts.ModuleKind.CommonJS,
      target: ts.ScriptTarget.ES2022,
      esModuleInterop: true,
    },
  }).outputText;
  module._compile(output, filename);
};

const strategy = require("../lib/strategy.ts");
const emaDiagnostic = require("../lib/ema-diagnostic.ts");
const jarvis = require("../lib/jarvis.ts");
const FOUR_HOURS = 4 * 60 * 60 * 1000;

function trendlineCandles(direction, count = 40) {
  const indexes = [5, 12, 19, 26, 33];
  const ascending = [106, 109, 112, 115, 118];
  const descending = [118, 115, 112, 109, 106];
  const levels = direction === "ascending" ? ascending : descending;
  const start = Date.UTC(2026, 0, 1);
  return Array.from({ length: count }, (_, i) => {
    const low = indexes.includes(i) ? levels[indexes.indexOf(i)] : 124;
    return {
      timestamp: start + i * FOUR_HOURS,
      open: low + 2,
      high: low + 5,
      low,
      close: low + 3,
      volume: 1,
    };
  });
}

function highTrendlineCandles(direction, count = 40) {
  const indexes = [5, 12, 19, 26, 33];
  const ascending = [128, 131, 134, 137, 140];
  const descending = [140, 137, 134, 131, 128];
  const levels = direction === "ascending" ? ascending : descending;
  const start = Date.UTC(2026, 0, 1);
  return Array.from({ length: count }, (_, i) => ({
    timestamp: start + i * FOUR_HOURS,
    open: 114,
    high: indexes.includes(i) ? levels[indexes.indexOf(i)] : 120,
    low: 110,
    close: 116,
    volume: 1,
  }));
}

function entry2VetoCandles() {
  const count = 28 * 6;
  const pivotIndexes = [130, 138, 146, 154, 162];
  const pivotLows = [108, 109, 110, 111, 112];
  const start = Date.UTC(2026, 0, 1);
  return Array.from({ length: count }, (_, i) => {
    const close = 100 + i * 0.1 + 0.2 * Math.sin((i + 2) * Math.PI / 2);
    const pivotIndex = pivotIndexes.indexOf(i);
    const low = pivotIndex >= 0 ? pivotLows[pivotIndex] : 100 + i * 0.1 - 2;
    return {
      timestamp: start + i * FOUR_HOURS,
      open: close - 0.25,
      high: close + 2,
      low,
      close,
      volume: 1,
    };
  });
}

function dailyBullishWithDescendingRecentLows() {
  // 28 full UTC days of 4H candles gives the daily direction logic enough history.
  const count = 28 * 6;
  const pivotIndexes = [130, 138, 146, 154, 162];
  const pivotLows = [108, 106, 104, 102, 100];
  const start = Date.UTC(2026, 0, 1);
  return Array.from({ length: count }, (_, i) => {
    const close = 100 + i * 0.1 + Math.sin(i * Math.PI / 4) * 0.35;
    const pivotIndex = pivotIndexes.indexOf(i);
    const low = pivotIndex >= 0 ? pivotLows[pivotIndex] : 100 + i * 0.1 - 2;
    return {
      timestamp: start + i * FOUR_HOURS,
      open: close - 0.25,
      high: close + 2,
      low,
      close,
      volume: 1,
    };
  });
}

function withRecent4HTrend(candles, direction, count = 10) {
  const out = candles.map((c) => ({ ...c }));
  const start = out.length - count;
  const base = out[start - 1].close;
  const sign = direction === "bullish" ? 1 : -1;
  for (let i = 0; i < count; i++) {
    const close = base + sign * 0.25 * (i + 1);
    const open = close - sign * 0.05;
    out[start + i] = {
      ...out[start + i],
      open,
      high: Math.max(open, close) + 0.4,
      low: Math.min(open, close) - 0.4,
      close,
    };
  }
  return out;
}

test("LONG trendline accepts descending swing lows; slope is diagnostic, not a veto", () => {
  const candles = trendlineCandles("descending");
  const line = strategy.getTrendline("TEST-DESCENDING-LONG", candles, "LONG");
  assert.ok(line);
  assert.ok(line.slope < 0);

  const debug = strategy.getTrendlineDebug("TEST-DESCENDING-LONG-DEBUG", candles, "LONG");
  assert.equal(debug.trendlineAvailable, true);
  assert.ok(debug.slope < 0);
  assert.equal(debug.pivots.length, 5);
});

test("SHORT trendline accepts ascending swing highs; slope is diagnostic, not a veto", () => {
  const candles = highTrendlineCandles("ascending");
  const line = strategy.getTrendline("TEST-ASCENDING-SHORT", candles, "SHORT");
  assert.ok(line);
  assert.ok(line.slope > 0);

  const debug = strategy.getTrendlineDebug("TEST-ASCENDING-SHORT-DEBUG", candles, "SHORT");
  assert.equal(debug.trendlineAvailable, true);
  assert.ok(debug.slope > 0);
  assert.equal(debug.pivots.length, 5);
});

test("a cached LONG line is refreshed when fresh swing lows descend", () => {
  const pair = "TEST-CACHE-INVERSION";
  const initial = strategy.getTrendline(pair, trendlineCandles("ascending"), "LONG");
  assert.ok(initial);
  assert.ok(initial.slope > 0);

  const inverted = strategy.getTrendline(pair, trendlineCandles("descending"), "LONG");
  assert.ok(inverted);
  assert.ok(inverted.slope < 0, "fresh pivots replace the cache when the anchors no longer fit");
});

test("SOL-style inverted trendline is diagnostic and does not create a slope-invalid gate", () => {
  const candles = dailyBullishWithDescendingRecentLows();
  const result = strategy.generateSignal(
    "SOL-REGRESSION",
    candles,
    candles,
    candles,
    candles.at(-1).close,
    Date.UTC(2026, 2, 1),
  );

  assert.equal(result.signal?.type, "ENTRY_1", "an inverted trendline must not veto the existing ENTRY_1 Stoch extreme trigger");
  const gates = result.debug.find((line) => line.startsWith("[GATES]"));
  assert.ok(gates);
  assert.doesNotMatch(gates, /trendline_invalid/);
  assert.doesNotMatch(gates, /4h_ema_opposed/);

  const swings = result.debug.find((line) => line.startsWith("[SWINGS]"));
  assert.ok(swings);
  assert.match(swings, /"i":130/);
  assert.match(swings, /"i":162/);

  const trendline = result.debug.find((line) => line.startsWith("[TL]"));
  assert.ok(trendline);
  assert.match(trendline, /slope is diagnostic only, not an entry gate/);
  assert.match(trendline, /r2 /);
});

test("tactical 4H EMA 5/13 does not veto ENTRY_2 when 4H EMA 8/21 agrees", () => {
  const originalGet4HEmaDiagnostic = emaDiagnostic.get4HEmaDiagnostic;
  const candles = entry2VetoCandles();
  const pair = "SOL-ENTRY2-EMA-REGRESSION";
  const line = strategy.getTrendline(pair, candles, "LONG");
  assert.ok(line);
  assert.ok(line.slope > 0);
  const currentPrice = line.slope * (candles.length - 1) + line.intercept;

  try {
    emaDiagnostic.get4HEmaDiagnostic = () => ({ label:"BULLISH MEDIUM", direction:"BULLISH", stage:"BULLISH_MEDIUM", turning:false, spread:1 });
    const aligned = strategy.evaluateGates(pair, candles, currentPrice);
    assert.equal(aligned.direction, "LONG");
    assert.equal(aligned.trigger.entry2, true);
    assert.equal(aligned.trigger.signalType, "ENTRY_2");

    // Flip only the fast tactical diagnostic; 4H EMA 8/21 remains bullish.
    emaDiagnostic.get4HEmaDiagnostic = () => ({ label:"BEARISH MEDIUM", direction:"BEARISH", stage:"BEARISH_MEDIUM", turning:false, spread:-1 });
    const opposed = strategy.evaluateGates(pair, candles, currentPrice);
    assert.equal(opposed.direction, "LONG");
    assert.equal(opposed.trigger.entry2, true);
    assert.equal(opposed.trigger.signalType, "ENTRY_2");
    assert.equal(opposed.missing.includes("direction"), false);

    const narration = jarvis.narratePairState(
      "SOL",
      {
        currentPrice,
        dailyDirection: "BULL",
        fourHDirection: "BEAR",
        fourH513: { label: "BEARISH MEDIUM" },
      },
      candles,
      undefined,
    );
    assert.match(narration, /The 4H is bearish/);
    assert.match(narration, /trendline \+ StochRSI entry setup/i);
    assert.doesNotMatch(narration, /ENTRY_2 blocked/i);
  } finally {
    emaDiagnostic.get4HEmaDiagnostic = originalGet4HEmaDiagnostic;
  }
});


test("aligned 4H bullish turn plus fresh StochRSI crossover can fire early ENTRY_1", () => {
  const originalGet4HEmaDiagnostic = emaDiagnostic.get4HEmaDiagnostic;
  const candles = entry2VetoCandles();
  const pair = "EARLY-TURN-ENTRY1";
  const line = strategy.getTrendline(pair, candles, "LONG");
  assert.ok(line);
  const currentPrice = line.slope * (candles.length - 1) + line.intercept;
  try {
    emaDiagnostic.get4HEmaDiagnostic = () => ({
      turning: true, spread: -1, stage: "EARLY_BULLISH_L1", label: "BULLISH TREND TURNING",
    });
    const result = strategy.evaluateGates(pair, candles, currentPrice);
    assert.equal(result.direction, "LONG");
    assert.equal(result.trigger.entry1, true, "early aligned EMA turn + StochRSI crossover should qualify as ENTRY_1");
    assert.equal(result.trigger.signalType, "ENTRY_1");
  } finally {
    emaDiagnostic.get4HEmaDiagnostic = originalGet4HEmaDiagnostic;
  }
});

test("1D LONG follows 4H EMA 8/21; fast EMA 5/13 disagreement is only tactical", () => {
  const originalGet4HEmaDiagnostic = emaDiagnostic.get4HEmaDiagnostic;
  const candles = dailyBullishWithDescendingRecentLows();
  const pair = "DIRECTION-AGREEMENT-LONG";
  try {
    emaDiagnostic.get4HEmaDiagnostic = () => ({ turning:false, spread:1, stage:"BULLISH_MEDIUM", label:"BULLISH MEDIUM" });
    assert.equal(strategy.evaluateGates(pair, candles, candles.at(-1).close).direction, "LONG");

    emaDiagnostic.get4HEmaDiagnostic = () => ({ turning:false, spread:-1, stage:"BEARISH_MEDIUM", label:"BEARISH MEDIUM" });
    const tacticalDisagreement = strategy.evaluateGates(pair, candles, candles.at(-1).close);
    assert.equal(tacticalDisagreement.direction, "LONG");
    assert.equal(tacticalDisagreement.missing.includes("direction"), false);

    const conflictingCandles = withRecent4HTrend(candles, "bearish");
    emaDiagnostic.get4HEmaDiagnostic = () => ({ turning:false, spread:1, stage:"BULLISH_MEDIUM", label:"BULLISH MEDIUM" });
    const conflict = strategy.evaluateGates(pair + "-REAL-CONFLICT", conflictingCandles, conflictingCandles.at(-1).close);
    assert.equal(conflict.direction, null);
    assert.ok(conflict.missing.includes("direction"));
    assert.equal(conflict.allPassed, false);

    emaDiagnostic.get4HEmaDiagnostic = () => ({ turning:false, spread:0, stage:"NEUTRAL", label:"NEUTRAL" });
    assert.equal(strategy.evaluateGates(pair, candles, candles.at(-1).close).direction, "LONG");
  } finally { emaDiagnostic.get4HEmaDiagnostic = originalGet4HEmaDiagnostic; }
});

test("1D SHORT follows 4H EMA 8/21; fast EMA 5/13 disagreement is only tactical", () => {
  const originalGet4HEmaDiagnostic = emaDiagnostic.get4HEmaDiagnostic;
  const bullish = dailyBullishWithDescendingRecentLows();
  const bearish = bullish.map(c => ({ ...c, open:300-c.open, close:300-c.close, high:300-c.low, low:300-c.high }));
  const pair = "DIRECTION-AGREEMENT-SHORT";
  try {
    assert.equal(strategy.evaluateGates(pair, bearish, bearish.at(-1).close).direction, "SHORT");

    emaDiagnostic.get4HEmaDiagnostic = () => ({ turning:false, spread:1, stage:"BULLISH_MEDIUM", label:"BULLISH MEDIUM" });
    assert.equal(strategy.evaluateGates(pair, bearish, bearish.at(-1).close).direction, "SHORT");

    const conflictingCandles = withRecent4HTrend(bearish, "bullish");
    const conflict = strategy.evaluateGates(pair + "-REAL-CONFLICT", conflictingCandles, conflictingCandles.at(-1).close);
    assert.equal(conflict.direction, null);
    assert.ok(conflict.missing.includes("direction"));
    assert.equal(conflict.allPassed, false);

    emaDiagnostic.get4HEmaDiagnostic = () => ({ turning:false, spread:-1, stage:"BEARISH_MEDIUM", label:"BEARISH MEDIUM" });
    assert.equal(strategy.evaluateGates(pair, bearish, bearish.at(-1).close).direction, "SHORT");
    emaDiagnostic.get4HEmaDiagnostic = () => ({ turning:false, spread:0, stage:"NEUTRAL", label:"NEUTRAL" });
    assert.equal(strategy.evaluateGates(pair, bearish, bearish.at(-1).close).direction, "SHORT");
  } finally { emaDiagnostic.get4HEmaDiagnostic = originalGet4HEmaDiagnostic; }
});

test("4H EMA 5/13 turning state is tactical and does not override 1D + 4H EMA 8/21 bias", () => {
  const originalGet4HEmaDiagnostic = emaDiagnostic.get4HEmaDiagnostic;
  const candles = dailyBullishWithDescendingRecentLows();
  try {
    emaDiagnostic.get4HEmaDiagnostic = () => ({ turning:true, spread:-1, stage:"NEUTRAL", label:"BULLISH TREND TURNING" });
    assert.equal(strategy.evaluateGates("TURN-BULL", candles, candles.at(-1).close).direction, "LONG");
    emaDiagnostic.get4HEmaDiagnostic = () => ({ turning:true, spread:1, stage:"NEUTRAL", label:"BEARISH TREND TURNING" });
    assert.equal(strategy.evaluateGates("TURN-BEAR", candles, candles.at(-1).close).direction, "LONG");
  } finally { emaDiagnostic.get4HEmaDiagnostic = originalGet4HEmaDiagnostic; }
});
