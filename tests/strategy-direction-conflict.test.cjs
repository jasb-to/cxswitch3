const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");

const source = fs.readFileSync(path.join(__dirname, "..", "lib", "strategy.ts"), "utf8");
const cronSource = fs.readFileSync(path.join(__dirname, "..", "app", "api", "cron", "route.ts"), "utf8");

test("entry direction conflict uses 1D EMA5/13 plus 4H EMA5/13; EMA8/21 is management context", () => {
  const helper = source.match(/function fourHTrendDirection\(c:Candle\[\]\):Direction\|null\{[\s\S]*?\n\}/);
  assert.ok(helper, "4H EMA8/21 direction helper exists");
  assert.match(helper[0], /ema\(closes,8\)/);
  assert.match(helper[0], /ema\(closes,21\)/);
  assert.match(helper[0], /e8>e21\?"LONG":e8<e21\?"SHORT":null/);

  const resolver = source.match(/function resolveSignalDirection\(c:Candle\[\],dailyDirection:Direction\|null\):Direction\|null\{[\s\S]*?\n\}/);
  assert.ok(resolver, "signal direction resolver exists");
  assert.match(resolver[0], /tacticalDirection\(c\)\.direction/);
  assert.doesNotMatch(resolver[0], /fourHTrendDirection/);
  assert.match(resolver[0], /fourHTacticalDirection && fourHTacticalDirection!==dailyDirection \? null : dailyDirection/);
});

test("ENTRY_1 requires aligned EMA5/13 turn plus a fresh directional Stoch crossover", () => {
  assert.match(source, /const earlyTurnEntry=!!direction&&tactical\.turning&&tactical\.direction===direction&&stochCross/);
  assert.match(source, /const entry1=earlyTurnEntry/);
  assert.doesNotMatch(source, /const entry1=!!direction&&\(extreme\|\|earlyTurnEntry\)/);
  assert.match(source, /const entry2Candidate=!!direction&&near&&turn&&!extreme/);
});

test("cron wait reason uses the 4H EMA 5/13 entry direction", () => {
  assert.match(cronSource, /const fourHSide=normalizeSide\(snapshot\.fourHTacticalDirection\)/);
  assert.doesNotMatch(cronSource, /const fourHSide=ema513\.turning/);
});
