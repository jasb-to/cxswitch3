const { test } = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const strategy = fs.readFileSync("lib/strategy.ts", "utf8");
const cron = fs.readFileSync("app/api/cron/route.ts", "utf8");
const dashboard = fs.readFileSync("app/page.tsx", "utf8");
const telegram = fs.readFileSync("lib/telegram.ts", "utf8");

const body = (name) => {
  const start = strategy.indexOf("export function " + name);
  const end = strategy.indexOf("\nexport function ", start + 20);
  return strategy.slice(start, end > 0 ? end : strategy.length);
};

test("Daily macro direction is EMA 8/21; fast EMA 5/13 remains a separate diagnostic", () => {
  const macro = strategy.match(/function trend1D\([\s\S]*?\n\}/)?.[0] ?? "";
  const fast = strategy.match(/function trend1DEarly\([\s\S]*?\n\}/)?.[0] ?? "";
  assert.match(macro, /ema\(closes,8\)/);
  assert.match(macro, /ema\(closes,21\)/);
  assert.match(fast, /ema\(closes,5\)/);
  assert.match(fast, /ema\(closes,13\)/);
});

test("ENTRY_1 uses 4H Stoch extreme and is vetoed only by an explicitly opposing Daily macro", () => {
  const evaluate = body("evaluateGates");
  const generate = body("generateSignal");
  assert.match(evaluate, /entry1TradeDirection:Direction\|null=st\.k<20\?"LONG":st\.k>80\?"SHORT":null/);
  assert.match(evaluate, /entry1DailyOpposes=!!macro\.direction&&!!entry1TradeDirection&&macro\.direction!==entry1TradeDirection/);
  assert.match(evaluate, /entry1Ready=!!entry1TradeDirection&&!entry1DailyOpposes&&nearFast&&stochExtremeFast&&!hardCap/);
  assert.match(generate, /entry1Eligible=!!entry1TradeDirection&&!entry1DailyOpposes&&nearFast&&stochExtremeFast&&!hardCap/);
  assert.match(generate, /rawType="ENTRY_1";rawDirection=entry1TradeDirection/);
});

test("ENTRY_2 uses Daily EMA8/21, shared trendline proximity and a Stoch turn without ENTRY_1 prerequisite", () => {
  const generate = body("generateSignal");
  assert.match(generate, /entry2Eligible=!!macro\.direction&&nearMacro&&stochTurningMacro&&!stochExtremeMacro&&!hardCap/);
  assert.match(generate, /rawType="ENTRY_2";rawDirection=macro\.direction/);
  assert.match(generate, /else finalType=rawType/);
});

test("ADD requires an active same-direction position and original breakout confirmations", () => {
  const evaluate = body("evaluateGates");
  const generate = body("generateSignal");
  assert.match(evaluate, /activeMatch=!!macro\.direction&&activeSignals\.some/);
  assert.match(generate, /activeMatch=!!macro\.direction&&_activeSignals\.some/);
  assert.ok(generate.includes("else if(activeMatch&&macro.direction&&trendline&&beyondTrendline&&confirming&&emaAligned&&(volUp||stochMomentum||adxStrong)&&!hardCap)"));
});

test("4H EMA5/13 is management context, not an ENTRY_1 or ENTRY_2 entry veto", () => {
  const generate = body("generateSignal");
  assert.doesNotMatch(generate, /if\(!momentumAligned\)|if\(momentumAligned/);
  assert.match(generate, /ema5_4h:e5_4h,ema13_4h:e13_4h,fourHDirection,momentumAligned/);
});

test("4H EMA5/13 misalignment cannot immediately close an unprofitable trade", () => {
  const hold = body("shouldHold");
  assert.match(hold, /if\(momentumAligned===false\)/);
  assert.match(hold, /4h_ema5_13_misaligned_unprofitable_hold/);
  assert.doesNotMatch(hold, /4h_ema5_13_misaligned_unprofitable_exit/);
  assert.match(hold, /newStop:s\.entry/);
});

test("V28 exits remain hard stop, single target, Daily reversal and opposite Stoch extreme", () => {
  const hold = body("shouldHold");
  assert.match(hold, /reason:"sl_hit"/);
  assert.match(hold, /reason:"tp_hit"/);
  assert.match(hold, /daily_ema8_21_reversed_unprofitable/);
  assert.match(hold, /stoch_extreme_opposite_exit/);
});

test("all entry stages share one trendline, with Stoch direction fallback when Daily direction is unavailable", () => {
  const evaluate = body("evaluateGates");
  const generate = body("generateSignal");
  assert.match(evaluate, /trendlineDirection=macro\.direction\?\?entry1TradeDirection/);
  assert.match(generate, /trendlineDirection=macro\.direction\?\?entry1TradeDirection/);
  assert.match(generate, /const signalTl=trendline/);
});

test("hysteresis suppresses duplicate alerts only on the same 4H candle inside the 0.5% price band", () => {
  assert.match(strategy, /const HYSTERESIS_BAND = 0\.005/);
  assert.match(strategy, /lastSignalCandleTimestamp/);
  assert.match(strategy, /previous\.lastSignalCandleTimestamp===candleTimestamp/);
  assert.match(strategy, /isHysteresisBlocked\(pair,finalType,price,candleTimestamp\)/);
  assert.match(strategy, /getHysteresisState/);
  assert.match(strategy, /setHysteresisState/);
  assert.doesNotMatch(strategy, /lockUntil/);
});

test("cron reports the actual reason a trigger did not produce a Signal object", () => {
  assert.match(cron, /startsWith\("\\[HYSTERESIS\\]"/);
  assert.match(cron, /detail=\$\{snapshot\.strategyStatus\}/);
});

test("Telegram permits ENTRY_1, ENTRY_2 and ADD through the same sender", () => {
  assert.match(telegram, /type!=="ENTRY_1"&&type!=="ENTRY_2"&&type!=="ADD"/);
  assert.match(cron, /signalType:signal\.type/);
});

test("dashboard keeps macro, fast direction and management momentum separately visible", () => {
  assert.match(dashboard, /DAILY MACRO \(8\/21\)/);
  assert.match(dashboard, /ENTRY_1 FAST \(5\/13\)/);
  assert.match(dashboard, /4H EMA5\/13 MOMENTUM/);
  assert.match(dashboard, /HARD CAP/);
});
