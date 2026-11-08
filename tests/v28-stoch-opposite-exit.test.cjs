const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");

const strategy = fs.readFileSync(
  path.join(__dirname, "..", "lib", "strategy.ts"),
  "utf8"
);

test("V28 StochRSI entry and opposite-extreme exit directions do not contradict", () => {
  const holdStart = strategy.indexOf("export function shouldHold(");
  assert.notEqual(holdStart, -1, "shouldHold must exist");
  const holdSource = strategy.slice(holdStart);

  // A LONG is entered at the oversold extreme; it must only Stoch-exit
  // at the opposite, overbought extreme.
  assert.match(
    holdSource,
    /s\.direction\s*===\s*"LONG"\s*\?\s*st\.k\s*>\s*80\s*:\s*st\.k\s*<\s*20/
  );

  // Keep the ENTRY_1 timing rules unchanged: LONG oversold, SHORT overbought.
  const entryStart = strategy.indexOf("export function evaluateGates(");
  const entryEnd = strategy.indexOf("export function generateSignal(", entryStart);
  assert.notEqual(entryStart, -1, "evaluateGates must exist");
  assert.notEqual(entryEnd, -1, "generateSignal must follow evaluateGates");
  const entrySource = strategy.slice(entryStart, entryEnd);
  assert.match(
    entrySource,
    /fast\.direction\s*===\s*"LONG"\s*\?\s*st\.k\s*<\s*20\s*:\s*fast\.direction\s*===\s*"SHORT"\s*\?\s*st\.k\s*>\s*80/
  );
});
