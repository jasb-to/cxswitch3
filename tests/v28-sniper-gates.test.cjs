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

test("Daily macro uses EMA 8/21 and fast bias requires EMA 5/13, price confirmation and EMA5 slope", () => {
  const macro = body("trend1DMacro");
  const fast = body("trend1DFast");
  assert.match(macro, /ema\(closes,\s*8\)/);
  assert.match(macro, /ema\(closes,\s*21\)/);
  assert.match(fast, /ema\(closes,\s*5\)/);
  assert.match(fast, /ema\(closes,\s*13\)/);
  assert.match(fast, /priceAboveEma5/);
  assert.match(fast, /slopeUp/);
  assert.match(fast, /ema5 > ema13 && priceAboveEma5 && slopeUp/);
  assert.match(fast, /ema5 < ema13 && price < ema5 && slope < 0/);
});

test("ENTRY_1 uses the fast daily bias and directional 4H Stoch extreme, independent of macro opposition", () => {
  const evaluate = body("evaluateGates");
  const generate = body("generateSignal");
  assert.match(evaluate, /entry1TradeDirection:Direction\|null=fast\.direction/);
  assert.match(evaluate, /entry1Ready=!!entry1TradeDirection&&nearFast&&stochExtremeFast&&!hardCap/);
  assert.match(generate, /entry1TradeDirection:Direction\|null=fast\.direction/);
  assert.match(generate, /entry1Eligible=!!entry1TradeDirection&&nearFast&&stochExtremeFast&&!hardCap/);
  assert.match(generate, /rawType="ENTRY_1";rawDirection=entry1TradeDirection/);
  assert.doesNotMatch(generate, /entry1DailyOpposes/);
});

test("ENTRY_2 uses Daily EMA8/21, shared trendline proximity and a Stoch turn without ENTRY_1 prerequisite", () => {
  const generate = body("generateSignal");
  assert.match(generate, /entry2Eligible=!!macro\.direction&&nearMacro&&stochTurningMacro&&!stochExtremeMacro&&!hardCap/);
  assert.match(generate, /rawType="ENTRY_2";rawDirection=macro\.direction/);
  assert.match(generate, /const finalType=rawType/);
});

test("ADD requires an active same-direction position and original breakout confirmations", () => {
  const evaluate = body("evaluateGates");
  const generate = body("generateSignal");
  assert.match(evaluate, /activeMatch=!!macro\.direction&&activeSignals\.some/);
  assert.match(generate, /activeMatch=!!macro\.direction&&_activeSignals\.some/);
  assert.ok(generate.includes("else if(activeMatch&&macro.direction&&trendlineMacro&&beyondTrendline&&confirming&&emaAligned&&(volUp||stochMomentum||adxStrong)&&!hardCap)"));
});

test("4H EMA5/13 is management context, not an ENTRY_1 or ENTRY_2 entry veto", () => {
  const generate = body("generateSignal");
  assert.doesNotMatch(generate, /if\(!momentumAligned\)|if\(momentumAligned/);
  assert.match(generate, /ema5_4h:e5_4h,ema13_4h:e13_4h,fourHDirection,momentumAligned/);
});

test("4H EMA5/13 misalignment exits an unprofitable trade and protects a profitable trade at breakeven", () => {
  const hold = body("shouldHold");
  assert.match(hold, /momentumAligned===false&&!profitable/);
  assert.match(hold, /4h_ema5_13_misaligned_unprofitable_exit/);
  assert.match(hold, /momentumAligned===false&&profitable/);
  assert.match(hold, /newStop:s\.entry/);
});

test("Daily reversal exit uses macro EMA8/21 only, with opposite Stoch as a separate exit", () => {
  const hold = body("shouldHold");
  assert.ok(strategy.includes("reason:\"sl_hit\""));
  assert.ok(strategy.includes('reason:"tp_hit"'));
  assert.match(hold, /trend1DMacro\(aggregateTo1D\(bars\)\)/);
  assert.match(hold, /daily_ema8_21_reversed_unprofitable/);
  assert.match(hold, /stoch_extreme_opposite_exit/);
  assert.doesNotMatch(hold, /trend1DFast/);
});

test("ENTRY_1 uses the fast-direction trendline while ENTRY_2 and ADD use the macro-direction trendline", () => {
  const evaluate = body("evaluateGates");
  const generate = body("generateSignal");
  assert.match(evaluate, /trendlineFast=fast\.direction\?getTrendline\(pair,bars,fast\.direction\)/);
  assert.match(evaluate, /trendlineMacro=macro\.direction\?getTrendline\(pair,bars,macro\.direction\)/);
  assert.match(generate, /trendlineFast=fast\.direction\?getTrendline\(pair,bars,fast\.direction\)/);
  assert.match(generate, /trendlineMacro=macro\.direction\?getTrendline\(pair,bars,macro\.direction\)/);
  assert.match(generate, /const signalTl=finalType==="ENTRY_1"\?trendlineFast:trendlineMacro/);
  assert.match(strategy, /const stateKey = `\$\{pair\}:\$\{track\}:\$\{direction\}`/);
});

test("hysteresis suppresses duplicate alerts only on the same 4H candle inside the 0.5% price band", () => {
  assert.match(strategy, /const HYSTERESIS_BAND = 0\.005/);
  assert.match(strategy, /lastSignalCandleTimestamp/);
  assert.match(strategy, /previous\.lastSignalCandleTimestamp!==candleTimestamp/);
  assert.match(strategy, /isHysteresisBlocked\(pair,finalType,price,candleTimestamp\)/);
  assert.match(strategy, /getHysteresisState/);
  assert.match(strategy, /setHysteresisState/);
  assert.doesNotMatch(strategy, /lockUntil/);
});

test("cron reports the actual reason a trigger did not produce a Signal object", () => {
  assert.match(cron, /startsWith\("\[HYSTERESIS\]"/);
  assert.match(cron, /detail=\$\{snapshot\.strategyStatus\}/);
  assert.match(cron, /MACRO EMA8\/21=/);
  assert.match(cron, /FAST EMA5\/13=/);
});

test("Telegram permits ENTRY_1, ENTRY_2 and ADD through the same sender", () => {
  assert.match(telegram, /type!=="ENTRY_1"&&type!=="ENTRY_2"&&type!=="ADD"/);
  assert.match(cron, /signalType:signal\.type/);
  assert.match(cron, /4h_ema5_13_misaligned_unprofitable_exit/);
});

test("dashboard keeps macro, fast direction and management momentum separately visible", () => {
  assert.match(dashboard, /DAILY MACRO \(8\/21\)/);
  assert.match(dashboard, /FAST BIAS \(5\/13\)/);
  assert.match(dashboard, /PRICE \{m\?\.dailyFastPriceAboveEma5/);
  assert.match(dashboard, /EMA5 SLOPE/);
  assert.match(dashboard, /4H EMA5\/13 MOMENTUM/);
  assert.match(dashboard, /WEAK \(HOLD\)/);
  assert.doesNotMatch(dashboard, /WEAK \(EXIT\)/);
  assert.match(dashboard, /HARD CAP/);
});
