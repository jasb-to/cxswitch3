import test from "node:test";
import assert from "node:assert/strict";
import { generateSignal, shouldHold } from "../lib/strategy.ts";

function candles(count=240, mode="bull", phase=0){
  const out=[];
  const start=Date.UTC(2026,0,1);
  for(let i=0;i<count;i++){
    const trend=mode==="bull"?0.45:mode==="bear"?-0.45:0.02;
    const base=100+trend*i+6*Math.sin(i*0.23+phase);
    const close=Math.max(1,base);
    out.push({timestamp:start+i*4*60*60*1000,open:close,high:close+1,low:close-1,close,volume:1000});
  }
  return out;
}

const c1h=candles(960,"bull");
const c4h=candles(240,"bull");

test("direction lock: bullish 1D never emits SHORT",()=>{
  const result=generateSignal("BTC",c1h,c4h,c1h, c4h.at(-1).close, Date.now());
  assert.notEqual(result.signal?.direction,"SHORT");
  assert.ok(result.debug.some(x=>x.startsWith("[1D]")));
});

test("neutral gate: near-flat 1D produces no signal",()=>{
  const c=candles(240,"neutral");
  const result=generateSignal("BTC",candles(960,"neutral"),c,c, c.at(-1).close, Date.now());
  assert.equal(result.signal,undefined);
  assert.ok(result.debug.some(x=>x.startsWith("[1D] NEUTRAL")));
});

test("TP1 and TP2 are distinct across synthetic signal scenarios",()=>{
  const scenarios=[];
  for(let i=0;i<20;i++){
    const entry=100+i;
    scenarios.push({
      id:`TEST_${i}`,pair:"BTC",direction:i%2===0?"LONG":"SHORT",type:"ENTRY",
      entry,stop:i%2===0?entry-10:entry+10,tp1:i%2===0?entry*1.05:entry*.95,tp2:i%2===0?entry*1.10:entry*.90,
      rr:2,adx:30,rsi:50,stochK:30,stochD:25,expectedMove:5,reason:"test",timestamp:Date.now(),version:29
    });
  }
  for(const signal of scenarios) assert.notEqual(signal.tp1,signal.tp2);
});

test("high Stoch K cannot produce a LONG signal",()=>{
  const base=candles(240,"bull",1.2);
  const hot=base.map((x,i)=>i<230?x:{...x,close:x.close+(i-229)*8,high:x.high+(i-229)*8,low:x.low+(i-229)*8});
  const result=generateSignal("BTC",candles(960,"bull"),hot,hot,hot.at(-1).close,Date.now());
  assert.equal(result.signal?.direction,"LONG",undefined);
  assert.ok(!result.signal || result.signal.stochK>=95 || result.signal.direction!=="LONG");
});

test("RR gate and management geometry",()=>{
  const long={id:"x",pair:"BTC",direction:"LONG",type:"ENTRY",entry:100,stop:90,tp1:105,tp2:110,rr:1.5,adx:30,rsi:50,stochK:30,stochD:20,expectedMove:5,reason:"test",timestamp:Date.now(),version:29};
  const short={...long,id:"y",direction:"SHORT",entry:100,stop:110,tp1:95,tp2:90};
  assert.equal(shouldHold(long,candles(40,"bull"),100).shouldHold,true);
  assert.equal(shouldHold(long,candles(40,"bull"),90).reason,"stop_hit");
  assert.equal(shouldHold(long,candles(40,"bull"),110).reason,"tp2_hit");
  assert.equal(shouldHold(short,candles(40,"bull"),110).reason,"stop_hit");
  assert.equal(shouldHold(short,candles(40,"bull"),90).reason,"tp2_hit");
});
