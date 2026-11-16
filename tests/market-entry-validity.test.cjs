const { test } = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");

const strategy = fs.readFileSync("lib/strategy.ts", "utf8");
const cron = fs.readFileSync("app/api/cron/route.ts", "utf8");

test("market entries are not invalidated by the missed-entry buffer", () => {
  assert.ok(strategy.includes('orderType?:"MARKET"|"LIMIT"'));
  assert.ok(strategy.includes('if(signal.orderType==="LIMIT")'));
  assert.ok(strategy.includes('reason:"missed_entry"'));
  assert.ok(strategy.includes('const entryBuffer=signal.type==="ADD"?1.005:1.02'));
});

test("explicit limit entries retain the existing missed-entry thresholds", () => {
  const validityStart = strategy.indexOf("export function isSignalStillValid(");
  const validityEnd = strategy.indexOf("export function filterExpiredSignals(", validityStart);
  const validity = strategy.slice(validityStart, validityEnd);
  assert.match(validity, /if\(signal\.orderType==="LIMIT"\)\s*\{[\s\S]*entryBuffer=signal\.type==="ADD"\?1\.005:1\.02/);
  assert.match(validity, /reason:"missed_entry"/);
});

test("cron management defensively retains MARKET signals on missed_entry", () => {
  assert.ok(cron.includes('hold.reason==="missed_entry"&&alert.orderType!=="LIMIT"'));
  assert.ok(cron.includes("retaining active position"));
});
