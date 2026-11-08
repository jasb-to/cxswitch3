const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");

const route = fs.readFileSync(
  path.join(__dirname, "../app/api/cron/route.ts"),
  "utf8"
);

test("cron runs position management and persists active state before signal evaluation", () => {
  const preflight = route.indexOf("Stage preflight observeAlertManagement started");
  const evaluation = route.indexOf("generateSignal(pair");
  assert.notEqual(preflight, -1, "preflight management stage must exist");
  assert.notEqual(evaluation, -1, "signal evaluation must exist");
  assert.ok(preflight < evaluation, "preflight must run before generateSignal");
  assert.match(route, /try\{await setActiveSignals\(active\);\}/,
    "management must persist the filtered active list");
});

test("every shouldHold=false result is removed, not only an allowlisted reason", () => {
  assert.match(route, /if\(!hold\.shouldHold\)\s*\{/,
    "all terminal shouldHold results must enter exit cleanup");
  assert.doesNotMatch(route, /MANAGEMENT_EXIT_REASONS\.has\(hold\.reason\)/,
    "exit cleanup must not be restricted to a partial reason allowlist");
});

test("preflight market snapshot uses current pair price and 4H candles", () => {
  assert.match(route, /currentPrice:Number\(candles\.c1\.at\(-1\)\?\.close\),momentumCandles4h:candles\.c4\.slice\(-220\)/);
});
