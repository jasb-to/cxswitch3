const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");

const strategy = fs.readFileSync(
  path.join(__dirname, "..", "lib", "strategy.ts"),
  "utf8"
);

test("V28 StochRSI exit uses the opposite extreme from entry", () => {
  const holdStart = strategy.indexOf("export function shouldHold(");
  assert.notEqual(holdStart, -1, "shouldHold must exist");
  const holdSource = strategy.slice(holdStart);
  const oppositeMatch = holdSource.match(
    /const st\\s*=\\s*stochRsi\\(closes\\)\\s*,\\s*opposite\\s*=\\s*(s\\.direction\\s*===\\s*"LONG"\\s*\\?\\s*st\\.k\\s*>\\s*80\\s*:\\s*st\\.k\\s*<\\s*20)\\s*;/
  );
  assert.ok(oppositeMatch, "shouldHold must use LONG K > 80 and SHORT K < 20");

  // Exercise the exact directional expression used by shouldHold.
  const isOppositeExtreme = new Function("s", "st", `return ${oppositeMatch[1]};`);
  assert.equal(isOppositeExtreme({ direction: "SHORT" }, { k: 90 }), false,
    "a SHORT at K = 90 must not trigger stoch_extreme_opposite_exit");
  assert.equal(isOppositeExtreme({ direction: "SHORT" }, { k: 10 }), true,
    "a SHORT at K = 10 must trigger stoch_extreme_opposite_exit");
  assert.equal(isOppositeExtreme({ direction: "LONG" }, { k: 10 }), false,
    "a LONG at K = 10 must not trigger stoch_extreme_opposite_exit");
  assert.equal(isOppositeExtreme({ direction: "LONG" }, { k: 90 }), true,
    "a LONG at K = 90 must trigger stoch_extreme_opposite_exit");
});

test("V28 ENTRY_1 StochRSI timing rules remain unchanged", () => {
  const entryStart = strategy.indexOf("export function evaluateGates(");
  const entryEnd = strategy.indexOf("export function generateSignal(", entryStart);
  assert.notEqual(entryStart, -1, "evaluateGates must exist");
  assert.notEqual(entryEnd, -1, "generateSignal must follow evaluateGates");
  const entrySource = strategy.slice(entryStart, entryEnd);
  assert.match(entrySource, /stochExtremeFast/);
  assert.match(
    entrySource,
    /entry1TradeDirection==="LONG"&&st\.k<20\)\|\|\(entry1TradeDirection==="SHORT"&&st\.k>80/
  );
});
