const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");

const source = fs.readFileSync(path.join(__dirname, "..", "lib", "strategy.ts"), "utf8");

test("direction conflict uses 1D EMA5/13 plus 4H EMA8/21, not the tactical EMA5/13 turn", () => {
  const helper = source.match(/function fourHTrendDirection\(c:Candle\[\]\):Direction\|null\{[\s\S]*?\n\}/);
  assert.ok(helper, "4H EMA8/21 direction helper exists");
  assert.match(helper[0], /ema\(closes,8\)/);
  assert.match(helper[0], /ema\(closes,21\)/);
  assert.match(helper[0], /e8>e21\?"LONG":e8<e21\?"SHORT":null/);

  const resolver = source.match(/function resolveSignalDirection\(c:Candle\[\],dailyDirection:Direction\|null\):Direction\|null\{[\s\S]*?\n\}/);
  assert.ok(resolver, "signal direction resolver exists");
  assert.match(resolver[0], /fourHTrendDirection\(c\)/);
  assert.doesNotMatch(resolver[0], /tacticalDirection/);
  assert.match(resolver[0], /fourHDirection && fourHDirection!==dailyDirection \? null : dailyDirection/);
});

test("the 4H EMA5/13 remains a tactical early-entry signal, not the direction conflict gate", () => {
  assert.match(source, /const earlyTurnEntry=!!direction&&tactical\.turning&&tactical\.direction===direction&&stochCross/);
  assert.match(source, /const entry2Candidate=!!direction&&near&&turn&&!extreme/);
});
