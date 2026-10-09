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

test("LONG trendline rejects descending swing lows", () => {
  const candles = trendlineCandles("descending");
  assert.equal(strategy.getTrendline("TEST-DESCENDING-LONG", candles, "LONG"), null);

  const debug = strategy.getTrendlineDebug("TEST-DESCENDING-LONG-DEBUG", candles, "LONG");
  assert.equal(debug.invalidSlope, true);
  assert.equal(debug.validForDirection, false);
  assert.ok(debug.slope < 0);
  assert.equal(debug.pivots.length, 5);
});

test("SHORT trendline rejects ascending swing highs", () => {
  const candles = highTrendlineCandles("ascending");
  assert.equal(strategy.getTrendline("TEST-ASCENDING-SHORT", candles, "SHORT"), null);

  const debug = strategy.getTrendlineDebug("TEST-ASCENDING-SHORT-DEBUG", candles, "SHORT");
  assert.equal(debug.invalidSlope, true);
  assert.equal(debug.validForDirection, false);
  assert.ok(debug.slope > 0);
  assert.equal(debug.pivots.length, 5);
});

test("a cached LONG line is not reused when fresh swing lows descend", () => {
  const pair = "TEST-CACHE-INVERSION";
  const valid = strategy.getTrendline(pair, trendlineCandles("ascending"), "LONG");
  assert.ok(valid);
  assert.ok(valid.slope > 0);

  const inverted = strategy.getTrendline(pair, trendlineCandles("descending"), "LONG");
  assert.equal(inverted, null, "the fresh inverted fit must invalidate the prior cached line");
});

test("SOL-style inverted trendline produces no signal and explicit invalid debug", () => {
  const candles = dailyBullishWithDescendingRecentLows();
  const result = strategy.generateSignal(
    "SOL-REGRESSION",
    candles,
    candles,
    candles,
    candles.at(-1).close,
    Date.UTC(2026, 2, 1),
  );

  assert.equal(result.signal, undefined, "an inverted LONG support line must never produce a signal");
  const gates = result.debug.find((line) => line.startsWith("[GATES]"));
  assert.ok(gates);
  assert.match(gates, /"missing":\["trendline_invalid"\]/);
  assert.doesNotMatch(gates, /"missing":\[[^\]]*"zone"/);

  const swings = result.debug.find((line) => line.startsWith("[SWINGS]"));
  assert.ok(swings);
  assert.match(swings, /"i":130/);
  assert.match(swings, /"i":162/);

  const trendline = result.debug.find((line) => line.startsWith("[TL]"));
  assert.ok(trendline);
  assert.match(trendline, /invalid for LONG \(slope must be positive\)/);
  assert.match(trendline, /r2 /);
});

test("opposed 4H EMA blocks a real ENTRY_2 gate and Jarvis narrates the veto", () => {
  const originalGet4HEmaDiagnostic = emaDiagnostic.get4HEmaDiagnostic;
  const candles = entry2VetoCandles();
  const pair = "SOL-ENTRY2-EMA-REGRESSION";
  const line = strategy.getTrendline(pair, candles, "LONG");
  assert.ok(line);
  assert.ok(line.slope > 0);
  const currentPrice = line.slope * (candles.length - 1) + line.intercept;

  try {
    // Prove the fixture would otherwise qualify as ENTRY_2 at the same price.
    emaDiagnostic.get4HEmaDiagnostic = () => ({ label: "BULLISH MEDIUM", direction: "BULLISH" });
    const aligned = strategy.evaluateGates(pair, candles, currentPrice);
    assert.equal(aligned.direction, "LONG");
    assert.equal(aligned.trigger.entry2, true);
    assert.equal(aligned.trigger.signalType, "ENTRY_2");

    // Flip only the diagnostic state; the exact same candles and price must be vetoed.
    emaDiagnostic.get4HEmaDiagnostic = () => ({ label: "BEARISH MEDIUM", direction: "BEARISH" });
    const opposed = strategy.evaluateGates(pair, candles, currentPrice);
    assert.equal(opposed.trigger.entry2, false);
    assert.equal(opposed.trigger.signalType, null);
    assert.ok(opposed.missing.includes("4h_ema_opposed"));

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
    assert.match(narration, /The 1D is bullish/);
    assert.match(narration, /4H EMA is BEARISH MEDIUM \(opposing\)/);
    assert.match(narration, /ENTRY_2 blocked until the 4H turns bullish/);
    assert.doesNotMatch(narration, /watching for price to come into position/i);
  } finally {
    emaDiagnostic.get4HEmaDiagnostic = originalGet4HEmaDiagnostic;
  }
});
