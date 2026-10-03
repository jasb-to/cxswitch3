import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";
import { classifyTrendlineApproach, shouldHold } from "../lib/strategy.ts";

const candle=(index, open, high, low, close)=>({timestamp:index*240*60*1000,open,high,low,close,volume:100});

test("descending-resistance rejection is classified from closed candles",()=>{
  const candles=[
    candle(0,100,102,98,100),
    candle(1,99,101,97,99),
    candle(2,98,100,96,98),
  ];
  const result=classifyTrendlineApproach(candles,102,-1,40,45);
  assert.equal(result.classification,"REJECTION");
  assert.equal(result.stochDirection,"FALLING");
  assert.equal(result.rejectionCandles,3);
});

test("ascending-support rejection is classified from closed candles",()=>{
  const candles=[
    candle(0,100,102,98,100),
    candle(1,101,103,99,101),
    candle(2,102,104,100,102),
  ];
  const result=classifyTrendlineApproach(candles,98,1,60,55);
  assert.equal(result.classification,"REJECTION");
  assert.equal(result.stochDirection,"RISING");
  assert.equal(result.rejectionCandles,3);
  assert.equal(result.closeBackInside,false);
});

test("tactical SHORT exits when a closed 4H candle reclaims its originating line",()=>{
  const candles=[
    candle(0,10,11,9,10),
    candle(1,9,10,8,9),
    candle(2,8,9,7,8),
    candle(3,7,8,6,7),
    candle(4,8,9,7,8),
  ];
  const signal={
    id:"TEST",
    pair:"LINK",
    direction:"SHORT",
    type:"ENTRY_1",
    scale:"ENTRY_1",
    entry:7.5,
    stop:9,
    target:5,
    rr:2,
    adx:30,
    rsi:50,
    stochK:50,
    stochD:50,
    expectedMove:30,
    reason:"test",
    timestamp:Date.now(),
    version:28,
    context:{
      trendlineApproach:{tacticalRejection:true},
      trendlineSlope:-0.25,
      trendlineIntercept:8.0,
    },
  };
  const result=shouldHold(signal,candles,8);
  assert.equal(result.shouldHold,false);
  assert.equal(result.reason,"TACTICAL_REJECTION_TRENDLINE_RECLAIMED");
});

test("the generateSignal path contains the tactical direction flip",async()=>{
  const source=await readFile(new URL("../lib/strategy.ts",import.meta.url),"utf8");
  assert.match(source,/approach\.classification==="REJECTION"/);
  assert.match(source,/signalDirection="SHORT"/);
  assert.match(source,/signalDirection="LONG"/);
  assert.match(source,/t.direction==="SHORT"&&near&&approach.classification==="REJECTION"/);
  assert.match(source,/tacticalRejection=true/);
  assert.match(source,/ema513\.turning&&ema513\.direction==="BULLISH"/);
  assert.match(source,/ema513\.turning&&ema513\.direction==="BEARISH"/);
  assert.match(source,/trigger15=!!x15&&!!p15/);
  assert.match(source,/hysteresis direction flip bypass/);
});

test("TP1/TP2 are separate lifecycle fields in the signal engine",async()=>{
  const source=await readFile(new URL("../lib/strategy.ts",import.meta.url),"utf8");
  assert.match(source,/tp1:round\(tp1\)/);
  assert.match(source,/tp2:round\(tp2\)/);
  assert.match(source,/tp1=price\+\(tp2-price\)\*0\.5/);
  assert.match(source,/price\+3\*av/);
  assert.doesNotMatch(source,/trendlinePrice:round\(tlPrice\),ema5_4h:[^\n]*trendlinePrice:round\(tlPrice\)/);
});
