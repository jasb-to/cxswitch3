const { test } = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");

const source = fs.readFileSync("app/api/cron/route.ts", "utf8");

test("MANUAL mode clears unconfirmed active positions before history recovery", () => {
  assert.match(source, /if\(EXECUTION_MODE==="MANUAL"\)\{[\s\S]*?await setActiveSignals\(\[\]\);[\s\S]*?active=\[\];/);
  assert.match(source, /manual_mode_signal_not_entered/);
  assert.match(source, /EXECUTION_MODE==="MANUAL"\?new Map<string,any>\(\):historyAtStart/);
});

test("MANUAL mode never auto-creates an active position after sending an alert", () => {
  assert.match(source, /if\(EXECUTION_MODE==="AUTO"\)\{[\s\S]*?await addActiveSignal\(signal\);[\s\S]*?\}/);
  assert.doesNotMatch(source, /if\(EXECUTION_MODE==="MANUAL"\)\s*await addActiveSignal\(signal\)/);
});

test("MANUAL mode skips automated position management and exit alerts", () => {
  assert.match(source, /Skipping position management — no confirmed manual positions/);
  assert.doesNotMatch(source, /else\{\s*await observeManualManagement\(active,marketData\);\s*\}/);
});
