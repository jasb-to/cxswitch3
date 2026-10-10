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

test("an inverted trendline stays diagnostic, but extreme Stoch alone cannot fire ENTRY_1", () => {
  const originalGet4HEmaDiagnostic = emaDiagnostic.get4HEmaDiagnostic;
  const candles = dailyBullishWithDescendingRecentLows();
  try {
    // The fast EMA is turning bearish, against the bullish daily bias. Even if
    // Stoch is extreme, that is not the required aligned ENTRY_1 setup.
    emaDiagnostic.get4HEmaDiagnostic = () => ({
      turning: true, spread: 1, stage: "NEUTRAL", label: "BEARISH TREND TURNING",
    });
    const result = strategy.generateSignal(
      "SOL-REGRESSION",
      candles,
      candles,
      candles,
      candles.at(-1).close,
      Date.UTC(2026, 2, 1),
    );

    assert.equal(result.signal, undefined, "ENTRY_1 must require the EMA5/13 turn and directional Stoch crossover");
    const gates = result.debug.find((line) => line.startsWith("[GATES]"));
    assert.ok(gates);
    assert.doesNotMatch(gates, /trendline_invalid/);
    assert.doesNotMatch(gates, /4h_ema_opposed/);

    const trendline = strategy.getTrendlineDebug("SOL-REGRESSION-TL", candles, "LONG");
    assert.equal(trendline.trendlineAvailable, true);
    assert.ok(trendline.slope < 0, "the inverted line remains available as context");
    assert.ok(trendline.pivots.some((pivot) => pivot.i === 130));
    assert.ok(trendline.pivots.some((pivot) => pivot.i === 162));
    assert.ok(trendline.r2 !== null);
  } finally {
    emaDiagnostic.get4HEmaDiagnostic = originalGet4HEmaDiagnostic;
  }
});

test("20x stop at or beyond modelled liquidation is invalid", () => {
  const candles = Array.from({ length: 12 }, (_, i) => ({
    timestamp: Date.UTC(2026, 0, 1) + i * FOUR_HOURS,
    open: 100,
    high: 104,
    low: 98,
    close: 100,
    volume: 1,
  }));
  const result = strategy.calculateStop("SHORT", 100, 6, candles);
  assert.equal(result.valid, false);
  assert.equal(result.invalidReason, "stop_at_or_beyond_liquidation");
  assert.ok(result.calc.liquidationBufferPct <= 0);
});

test("opposing 4H EMA 5/13 blocks ENTRY_2 even if EMA 8/21 agrees", () => {
  const originalGet4HEmaDiagnostic = emaDiagnostic.get4HEmaDiagnostic;
  const candles = entry2VetoCandles();
  const pair = "SOL-ENTRY2-EMA-REGRESSION";
  const line = strategy.getTrendline(pair, candles, "LONG");
  assert.ok(line);
  const currentPrice = line.slope * (candles.length - 1) + line.intercept;

  try {
    emaDiagnostic.get4HEmaDiagnostic = () => ({ label:"BULLISH MEDIUM", direction:"BULLISH", stage:"BULLISH_MEDIUM", turning:false, spread:1 });
    const aligned = strategy.evaluateGates(pair, candles, currentPrice);
    assert.equal(aligned.direction, "LONG");
    assert.equal(aligned.trigger.entry2, true);
    assert.equal(aligned.trigger.signalType, "ENTRY_2");

    // The same price/line cannot fire while the 4H EMA 5/13 is bearish against a daily LONG.
    emaDiagnostic.get4HEmaDiagnostic = () => ({ label:"BEARISH MEDIUM", direction:"BEARISH", stage:"BEARISH_MEDIUM", turning:false, spread:-1 });
    const opposed = strategy.evaluateGates(pair, candles, currentPrice);
    assert.equal(opposed.direction, null);
    assert.equal(opposed.trigger.entry2, false);
    assert.equal(opposed.missing.includes("direction"), true);

    const narration = jarvis.narratePairState(
      "SOL",
      {
        currentPrice,
        dailyDirection: "BULL",
        fourHDirection: "BULL",
        fourHTacticalDirection: "BEAR",
        fourHTacticalLabel: "BEARISH MEDIUM",
      },
      candles,
      undefined,
    );
    assert.match(narration, /4H EMA 5\/13 is bearish against the daily direction/i);
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

test("1D LONG waits on opposing EMA 5/13 but 4H EMA 8/21 does not gate entry", () => {
  const originalGet4HEmaDiagnostic = emaDiagnostic.get4HEmaDiagnostic;
  const candles = dailyBullishWithDescendingRecentLows();
  const pair = "DIRECTION-AGREEMENT-LONG";
  try {
    emaDiagnostic.get4HEmaDiagnostic = () => ({ turning:false, spread:1, stage:"BULLISH_MEDIUM", label:"BULLISH MEDIUM" });
    assert.equal(strategy.evaluateGates(pair, candles, candles.at(-1).close).direction, "LONG");

    emaDiagnostic.get4HEmaDiagnostic = () => ({ turning:false, spread:-1, stage:"BEARISH_MEDIUM", label:"BEARISH MEDIUM" });
    const tacticalConflict = strategy.evaluateGates(pair, candles, candles.at(-1).close);
    assert.equal(tacticalConflict.direction, null);
    assert.equal(tacticalConflict.missing.includes("direction"), true);

    // A genuinely bearish 4H EMA 8/21 trend does not veto the daily + EMA5/13 entry alignment.
    const conflictingCandles = withRecent4HTrend(candles, "bearish");
    emaDiagnostic.get4HEmaDiagnostic = () => ({ turning:false, spread:1, stage:"BULLISH_MEDIUM", label:"BULLISH MEDIUM" });
    const managementDisagreement = strategy.evaluateGates(pair + "-8-21", conflictingCandles, conflictingCandles.at(-1).close);
    assert.equal(managementDisagreement.direction, "LONG");
    assert.equal(managementDisagreement.missing.includes("direction"), false);

    emaDiagnostic.get4HEmaDiagnostic = () => ({ turning:false, spread:0, stage:"NEUTRAL", label:"NEUTRAL" });
    assert.equal(strategy.evaluateGates(pair, candles, candles.at(-1).close).direction, "LONG");
  } finally { emaDiagnostic.get4HEmaDiagnostic = originalGet4HEmaDiagnostic; }
});

test("1D SHORT waits on opposing EMA 5/13 but 4H EMA 8/21 does not gate entry", () => {
  const originalGet4HEmaDiagnostic = emaDiagnostic.get4HEmaDiagnostic;
  const bullish = dailyBullishWithDescendingRecentLows();
  const bearish = bullish.map(c => ({ ...c, open:300-c.open, close:300-c.close, high:300-c.low, low:300-c.high }));
  const pair = "DIRECTION-AGREEMENT-SHORT";
  try {
    assert.equal(strategy.evaluateGates(pair, bearish, bearish.at(-1).close).direction, "SHORT");

    // A bullish fast 5/13 state against a daily SHORT must wait.
    emaDiagnostic.get4HEmaDiagnostic = () => ({ turning:false, spread:1, stage:"BULLISH_MEDIUM", label:"BULLISH MEDIUM" });
    const tacticalConflict = strategy.evaluateGates(pair, bearish, bearish.at(-1).close);
    assert.equal(tacticalConflict.direction, null);
    assert.ok(tacticalConflict.missing.includes("direction"));

    // A bullish 4H EMA 8/21 alone is not an entry gate when 1D and EMA5/13 align SHORT.
    const conflictingCandles = withRecent4HTrend(bearish, "bullish");
    emaDiagnostic.get4HEmaDiagnostic = () => ({ turning:false, spread:-1, stage:"BEARISH_MEDIUM", label:"BEARISH MEDIUM" });
    const managementDisagreement = strategy.evaluateGates(pair + "-8-21", conflictingCandles, conflictingCandles.at(-1).close);
    assert.equal(managementDisagreement.direction, "SHORT");
    assert.equal(managementDisagreement.missing.includes("direction"), false);

    emaDiagnostic.get4HEmaDiagnostic = () => ({ turning:false, spread:-1, stage:"BEARISH_MEDIUM", label:"BEARISH MEDIUM" });
    assert.equal(strategy.evaluateGates(pair, bearish, bearish.at(-1).close).direction, "SHORT");
    emaDiagnostic.get4HEmaDiagnostic = () => ({ turning:false, spread:0, stage:"NEUTRAL", label:"NEUTRAL" });
    assert.equal(strategy.evaluateGates(pair, bearish, bearish.at(-1).close).direction, "SHORT");
  } finally { emaDiagnostic.get4HEmaDiagnostic = originalGet4HEmaDiagnostic; }
});

test("4H EMA 5/13 turn must point with the daily bias", () => {
  const originalGet4HEmaDiagnostic = emaDiagnostic.get4HEmaDiagnostic;
  const candles = dailyBullishWithDescendingRecentLows();
  try {
    emaDiagnostic.get4HEmaDiagnostic = () => ({ turning:true, spread:-1, stage:"NEUTRAL", label:"BULLISH TREND TURNING" });
    assert.equal(strategy.evaluateGates("TURN-BULL", candles, candles.at(-1).close).direction, "LONG");
    emaDiagnostic.get4HEmaDiagnostic = () => ({ turning:true, spread:1, stage:"NEUTRAL", label:"BEARISH TREND TURNING" });
    assert.equal(strategy.evaluateGates("TURN-BEAR", candles, candles.at(-1).close).direction, null);
  } finally { emaDiagnostic.get4HEmaDiagnostic = originalGet4HEmaDiagnostic; }
});
