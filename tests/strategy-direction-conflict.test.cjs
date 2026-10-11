const { test } = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const ts = require("typescript");
require.extensions[".ts"] = (module, filename) => {
  const source = fs.readFileSync(filename, "utf8");
  const output = ts.transpileModule(source, { fileName: filename, compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022, esModuleInterop: true } }).outputText;
  module._compile(output, filename);
};
const strategy = require("../lib/strategy.ts");
const FOUR_HOURS = 4 * 60 * 60 * 1000;
function candles({days=40, rising=true, bearishCurrent4h=false}={}) {
  const start=Date.UTC(2026,0,1), out=[]; let prev=100;
  for(let day=0;day<days;day++)for(let slot=0;slot<6;slot++){
    const timestamp=start+(day*6+slot)*FOUR_HOURS;
    let close;
    if(bearishCurrent4h&&day===days-1)close=prev-(slot+1)*18;
    else close=100+day*(rising?1:-1)+slot*(rising?0.12:-0.12);
    prev=close;out.push({timestamp,open:close,high:close+1,low:close-1,close,volume:1});
  }
  return out;
}
function chopCandles(){
  const targets=[];
  for(let i=0;i<20;i++)targets.push(100+i*2.5);
  for(let i=20;i<35;i++)targets.push(147.5-(i-19)*2);
  for(let i=35;i<39;i++)targets.push(117+3*(i-34));
  targets.push(132);
  const out=[];let prev=targets[0];
  for(let day=0;day<targets.length;day++){
    const target=targets[day];
    for(let slot=0;slot<6;slot++){
      const close=prev+(target-prev)*(slot+1)/6,timestamp=Date.UTC(2026,0,1)+(day*6+slot)*FOUR_HOURS;
      out.push({timestamp,open:close,high:close+1,low:close-1,close,volume:1});
    }
    prev=target;
  }
  return out;
}
test("BULL regime and 4H LONG align",()=>{
  const a=strategy.trendAlignment(candles());
  assert.equal(a.regime,"BULL");assert.equal(a.fourH,"LONG");assert.equal(a.aligned,"LONG");
  assert.ok(a.dailyClose>a.dailyE21&&a.dailyE5>a.dailyE13);
});
test("BEAR regime and 4H SHORT align",()=>{
  const a=strategy.trendAlignment(candles({rising:false}));
  assert.equal(a.regime,"BEAR");assert.equal(a.fourH,"SHORT");assert.equal(a.aligned,"SHORT");
});
test("BULL regime with 4H SHORT waits because 4H disagrees",()=>{
  const c=candles({bearishCurrent4h:true}),a=strategy.trendAlignment(c),g=strategy.evaluateGates("BTC",c,80);
  assert.equal(a.regime,"BULL");assert.equal(a.fourH,"SHORT");assert.equal(a.aligned,null);
  assert.equal(g.direction,null);assert.equal(g.allPassed,false);assert.ok(g.missing.includes("fourH_disagrees_with_regime"));
});
test("CHOP regime blocks signals regardless of 4H direction",()=>{
  const c=chopCandles(),a=strategy.trendAlignment(c),g=strategy.evaluateGates("BTC",c,c.at(-1).close);
  assert.equal(a.regime,"CHOP");assert.equal(a.aligned,null);assert.ok(g.missing.includes("regime_chop"));
});
test("ENTRY_1 LONG fires on fresh bullish Stoch RSI cross at K below 40",()=>{
  const e=strategy.evaluateEntry1("LONG",{pk:25,pd:30,k:30,d:28});
  assert.equal(e.entry1Long,true);assert.equal(e.direction,"LONG");
});
test("ENTRY_1 SHORT fires on fresh bearish Stoch RSI cross at K above 60",()=>{
  const e=strategy.evaluateEntry1("SHORT",{pk:80,pd:78,k:75,d:77});
  assert.equal(e.entry1Short,true);assert.equal(e.direction,"SHORT");
});
test("4H EMA calculations include the latest candle already returned closed",()=>{
  const c=candles(),a=strategy.trendAlignment(c);
  const ema=(v,p)=>{const k=2/(p+1),o=[v[0]];for(let i=1;i<v.length;i++)o.push(v[i]*k+o[i-1]*(1-k));return o};
  const closes=c.map(x=>x.close);
  assert.equal(a.fourHE5,ema(closes,5).at(-1));assert.equal(a.fourHE13,ema(closes,13).at(-1));
});
test("structural stop uses the last five closed candles and the 1.5 ATR floor",()=>{
  const c=candles(),result=strategy.calculateStop("LONG",110,2,c),low=Math.min(...c.slice(-5).map(x=>x.low));
  assert.equal(result.valid,true);assert.equal(result.stop,Math.min(low,107));
});
test("daily EMA reversal alone no longer exits an open trade",()=>{
  const c=candles({rising:false}),s={direction:"LONG",entry:100,stop:90,tp1:103,tp2:106,timestamp:Date.UTC(2026,0,1),version:30};
  const hold=strategy.shouldHold(s,c,99.5);
  assert.equal(hold.shouldHold,true);assert.equal(hold.managementState,"STAY");assert.notEqual(hold.reason,"1d_ema_reversal");
});
test("shouldHold stays at -0.5% and +2%, scales out at TP1, and trails after +3%",()=>{
  const c=candles({days:40}),base={direction:"LONG",entry:100,stop:90,tp1:103,tp2:106,timestamp:Date.UTC(2026,0,1),version:30};
  assert.equal(strategy.shouldHold(base,c,99.5).managementState,"STAY");
  assert.equal(strategy.shouldHold(base,c,102).managementState,"STAY");
  const tp1=strategy.shouldHold(base,c,103);
  assert.equal(tp1.reason,"tp1_hit_scale_out");assert.equal(tp1.scaleOut.size,0.5);assert.equal(tp1.newStop,100);
  const rising=[...c];for(let i=0;i<5;i++){const close=101+i*.5;rising[rising.length-5+i]={...rising[rising.length-5+i],open:close,close,high:close+.2,low:close-.2};}
  const managed={...base,tp1HitAt:Date.UTC(2026,1,1)};
  const trail=strategy.shouldHold(managed,rising,103.5);
  assert.equal(trail.reason,"chandelier_stop");assert.ok(trail.newStop>managed.stop);
  const protectedTrade={...managed,stop:trail.newStop};
  assert.equal(strategy.shouldHold(protectedTrade,rising,trail.newStop-.01).reason,"stop_hit");
});
