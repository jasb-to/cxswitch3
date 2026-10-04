import test from "node:test";
import assert from "node:assert/strict";
import { generateSignal, shouldHold } from "../lib/strategy.ts";

const start=Date.UTC(2026,0,1);
function candlesFromCloses(closes){
  return closes.map((close,i)=>({timestamp:start+i*4*60*60*1000,open:close,high:close+1,low:close-1,close,volume:1000}));
}
function bullishBase(){
  return Array.from({length:240},(_,i)=>100+0.05*i+Math.sin(i*0.2+1));
}
function hotPullback(){
  const a=bullishBase().slice(0,220);
  const inc=[0.7347048754515322,0.5359425536333721,0.5701247425269469,0.605305715021942,0.9828056382738617,1.085472733540853,1.1963991533690765,0.6130724364156482,0.44603042491468053,0.7228875575019296,0.7734664600718457,0.7361453641902957,-0.17703119914681265,0.551764829094345,-0.7823349406465063,0.43168719014178825,-0.03240731781143058,-0.4810234372684862,0.34138969451435597,-0.09791011657399129];
  for(const x of inc)a.push(a.at(-1)+x);
  return a;
}
function swings(closes,high=false){
  const out=[];
  for(let i=2;i<closes.length-2;i++){
    const p=closes[i]; let ok=true;
    for(const j of [1,2]) if(high?(p<=closes[i-j]||p<=closes[i+j]):(p>=closes[i-j]||p>=closes[i+j])) ok=false;
    if(ok)out.push({index:i,price:p});
  }
  return out;
}
function trendline(closes,high=false){
  const pts=swings(closes,high).slice(-5);
  const n=pts.length,sx=pts.reduce((s,x)=>s+x.index,0),sy=pts.reduce((s,x)=>s+x.price,0),sxy=pts.reduce((s,x)=>s+x.index*x.price,0),sx2=pts.reduce((s,x)=>s+x.index*x.index,0);
  const slope=(n*sxy-sx*sy)/(n*sx2-sx*sx),intercept=(sy-slope*sx)/n;
  return{slope,price:slope*(closes.length-1)+intercept};
}
function scaleToLine(closes,target){
  const tl=trendline(closes,false).price;
  const k=target/tl;
  return closes.map(x=>x*k);
}
function marketCandles(closes){return candlesFromCloses(closes)}
function flat1d(count=240){
  return Array.from({length:count},(_,i)=>100+0.0005*i+Math.sin(i*.2)*.02);
}
function managementSignal(){
  return {id:"TEST",pair:"SOL",direction:"LONG",type:"ENTRY_1",entryType:"MARKET",entry:100,stop:90,tp1:105,tp2:110,rr:2,adx:30,rsi:50,stochK:15,stochD:20,reason:"test",timestamp:Date.now(),version:31};
}

test("1. SOL at trendline with 4H Stoch K=15 fires ENTRY_1 LONG at MARKET",()=>{
  const raw=bullishBase(), scaled=scaleToLine(raw,116.5), c4=marketCandles(scaled);
  const result=generateSignal("SOL",c4,c4,c4,116.5,Date.now());
  assert.equal(result.signal?.direction,"LONG");
  assert.equal(result.signal?.type,"ENTRY_1");
  assert.equal(result.signal?.entryType,"MARKET");
  assert.ok(Math.abs(result.signal.entry-116.5)<0.01);
  assert.ok(Math.abs(result.signal.stop-115.5)<0.05);
  assert.ok(Math.abs(result.signal.tp1-122.325)<0.02);
  assert.ok(Math.abs(result.signal.tp2-128.15)<0.02);
});

test("2. SOL 3%+ above trendline with Stoch K>80 produces no signal",()=>{
  const raw=hotPullback(),scaled=scaleToLine(raw,117.55),c4=marketCandles(scaled);
  const result=generateSignal("SOL",c4,c4,c4,121.08,Date.now());
  assert.equal(result.signal,undefined);
  assert.ok(result.debug.some(x=>x.includes("[TRIGGER]")&&x.includes("ENTRY_1=false")));
});

test("3. SOL 0.86% above trendline with deep Stoch pullback fires ENTRY_1 LIMIT at the line",()=>{
  const raw=bullishBase(),scaled=scaleToLine(raw,116.5),c4=marketCandles(scaled);
  const result=generateSignal("SOL",c4,c4,c4,117.5,Date.now());
  assert.equal(result.signal?.type,"ENTRY_1");
  assert.equal(result.signal?.entryType,"LIMIT");
  assert.ok(Math.abs(result.signal.entry-116.5)<0.02);
});

test("4. RSI exhaustion blocks an otherwise valid deep-pullback LONG",()=>{
  const raw=hotPullback(),scaled=scaleToLine(raw,115.15),c4=marketCandles(scaled);
  const result=generateSignal("SOL",c4,c4,c4,116.0,Date.now());
  assert.equal(result.signal,undefined);
  assert.ok(result.debug.some(x=>x.includes("[EXHAUST]")&&x.includes("RSI")));
});

test("5. 1D EMA spread under 0.5% is NEUTRAL and produces no signal",()=>{
  const c=marketCandles(flat1d());
  const result=generateSignal("SOL",c,c,c,c.at(-1).close,Date.now());
  assert.equal(result.signal,undefined);
  assert.ok(result.debug.some(x=>x.includes("[1D] NEUTRAL | spread < 0.5%")));
});

test("6. Once +3% in profit, chandelier management becomes active",()=>{
  const s=managementSignal(),c=marketCandles(bullishBase());
  const result=shouldHold(s,c,103);
  assert.equal(result.shouldHold,true);
  assert.equal(result.reason,"chandelier_stop");
  assert.ok(result.newStop>s.stop);
});

test("7. TP1 returns 50% scale-out and breakeven stop",()=>{
  const s=managementSignal(),c=marketCandles(bullishBase());
  const result=shouldHold(s,c,105);
  assert.equal(result.shouldHold,true);
  assert.equal(result.reason,"tp1_hit_scale_out");
  assert.equal(result.newStop,100);
  assert.equal(result.scaleOut?.size,0.5);
});

test("8. 4H Stoch at 85 during an open LONG does not exit the trade",()=>{
  const s={...managementSignal(),stochK:85,stochD:80};
  const c=marketCandles(bullishBase());
  const result=shouldHold(s,c,102);
  assert.equal(result.shouldHold,true);
  assert.equal(result.reason,"thesis_intact");
});
