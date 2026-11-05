const { test } = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");

test("system metadata identifies dual daily directions and one shared 4H V28 trendline", () => {
  const source = fs.readFileSync("lib/version.ts", "utf8");
  assert.ok(source.includes("CXSWITCH_VERSION = 28"));
  assert.ok(source.includes("V28 DUAL DAILY EMA5/13 ENTRY_1 + EMA8/21 MACRO + SHARED 4H TRENDLINE"));
  assert.ok(source.includes("1D EMA8/21 MACRO; 1D EMA5/13 ENTRY_1 FAST"));
  assert.doesNotMatch(source, /SEPARATE FAST.*MACRO TRENDLINES|V31|7-STATE REGIME|4H STOCH RETEST/);
});
