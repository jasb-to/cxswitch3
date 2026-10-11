const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");

const source = fs.readFileSync(path.join(__dirname, "..", "lib", "strategy.ts"), "utf8");
const cronSource = fs.readFileSync(path.join(__dirname, "..", "app", "api", "cron", "route.ts"), "utf8");

test("daily EMA5/13 owns entry direction; 4H EMA8/21 remains management context", () => {
  const helper = source.match(/function fourHTrendDirection\(c:Candle\[\]\):Direction\|null\{[\s\S]*?\n\}/);
  assert.ok(helper, "4H EMA8/21 direction helper exists");
  assert.match(helper[0], /ema\(closes,8\)/);
  assert.match(helper[0], /ema\(closes,21\)/);
  assert.match(helper[0], /e8>e21\?"LONG":e8<e21\?"SHORT":null/);

  const resolver = source.match(/function resolveSignalDirection\(c:Candle\[\],dailyDirection:Direction\|null\):Direction\|null\{[\s\S]*?\n\}/);
  assert.ok(resolver, "signal direction resolver exists");
  assert.match(resolver[0], /return dailyDirection/);
  assert.doesNotMatch(resolver[0], /tacticalDirection|fourHTacticalDirection|!==dailyDirection/);
});

test("ENTRY_1 and ENTRY_2 use fresh closed-candle Stoch RSI crossovers", () => {
  assert.match(source, /const closed4h=c\.slice\(0,-1\)/);
  assert.match(source, /const closedDaily=daily\(closed4h\)\.slice\(0,-1\)/);
  assert.match(source, /const entry1=stochTriggers\.entry1/);
  assert.match(source, /const entry2=stochTriggers\.entry2/);
  assert.match(source, /entry2:fourHCross&&dailyCross/);
  assert.doesNotMatch(source, /const entry2Candidate=!!direction&&near&&turn&&!extreme/);
});

test("cron wait reason uses the 4H EMA 5/13 entry direction", () => {
  assert.match(cronSource, /const fourHSide=normalizeSide\(snapshot\.fourHTacticalDirection\)/);
  assert.doesNotMatch(cronSource, /const fourHSide=ema513\.turning/);
});
