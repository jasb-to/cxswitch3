import https from 'node:https';

const SYMBOL = 'PI_XBTUSD';
const TF = 240;
const COST_R = 0.0006;
const START = Date.parse('2025-01-01T00:00:00Z');
const DISCOVERY_END = Date.parse('2026-05-31T23:59:59Z');
const END = Date.parse('2026-09-14T23:59:59Z');
const RSI_LEN = 14;
const EMA_LEN = 50;
const DAILY_EMA_LEN = 200;
const ATR_LEN = 14;
const STOP_ATR = 1.5;
const MAX_HOLD = 12;
const TARGETS = [1, 1.5, 2];

function get(url){return new Promise((resolve,reject)=>https.get(url,{headers:{'user-agent':'cxswitch-research/1.0'}},r=>{let b='';r.on('data',x=>b+=x);r.on('end',()=>{try{resolve(JSON.parse(b))}catch(e){reject(new Error('bad json '+url+' '+b.slice(0,200)))}})}).on('error',reject))}
async function candles(interval,start,end){
  const u=`https://futures.kraken.com/derivatives/api/v3/ohlc?symbol=${SYMBOL}&interval=${interval}&from=${Math.floor(start/1000)}&to=${Math.floor(end/1000)}`;
  const j=await get(u); const rows=j?.candles||j?.result?.candles||[];
  return rows.map(x=>({t:Number(x.time??x.timestamp??x[0])*1000,o:Number(x.open??x[1]),h:Number(x.high??x[2]),l:Number(x.low??x[3]),c:Number(x.close??x[4])})).filter(x=>Number.isFinite(x.c)).sort((a,b)=>a.t-b.t);
}
function ema(vals,n){const out=Array(vals.length).fill(null); if(vals.length<n)return out; let s=0;for(let i=0;i<n;i++)s+=vals[i];out[n-1]=s/n;const k=2/(n+1);for(let i=n;i<vals.length;i++)out[i]=vals[i]*k+out[i-1]*(1-k);return out}
function rsi(vals,n){const out=Array(vals.length).fill(null);let g=0,d=0;for(let i=1;i<=n;i++){const z=vals[i]-vals[i-1];g+=Math.max(z,0);d+=Math.max(-z,0)};let ag=g/n,ad=d/n;out[n]=ad===0?100:100-100/(1+ag/ad);for(let i=n+1;i<vals.length;i++){const z=vals[i]-vals[i-1];ag=(ag*(n-1)+Math.max(z,0))/n;ad=(ad*(n-1)+Math.max(-z,0))/n;out[i]=ad===0?100:100-100/(1+ag/ad)}return out}
function atr(rows,n){const tr=rows.map((x,i)=>i?Math.max(x.h-x.l,Math.abs(x.h-rows[i-1].c),Math.abs(x.l-rows[i-1].c)):x.h-x.l);const out=Array(rows.length).fill(null);if(rows.length<n)return out;let s=0;for(let i=0;i<n;i++)s+=tr[i];out[n-1]=s/n;for(let i=n;i<rows.length;i++)out[i]=(out[i-1]*(n-1)+tr[i])/n;return out}
function daily(rows){const m=new Map();for(const x of rows){const d=new Date(x.t);const k=Date.UTC(d.getUTCFullYear(),d.getUTCMonth(),d.getUTCDate());m.set(k,{t:k,c:x.c})}return [...m.values()].sort((a,b)=>a.t-b.t)}
function addDailyEMA(ds,n){const e=ema(ds.map(x=>x.c),n);return ds.map((x,i)=>({...x,e200:e[i]}))}
function regimeBefore(ds,t){let lo=0,hi=ds.length-1,best=null;while(lo<=hi){const m=(lo+hi)>>1;if(ds[m].t<t){best=ds[m];lo=m+1}else hi=m-1}return best}
function retR(entry,stop,target,rows,startIndex){for(let k=1;k<=MAX_HOLD && startIndex+k<rows.length;k++){const b=rows[startIndex+k];const stopHit=b.l<=stop,targetHit=b.h>=target;if(stopHit&&targetHit)return -1; if(stopHit)return -1;if(targetHit)return target;}
 return null}
function summarize(trades){const done=trades.filter(x=>x.r!=null);const wins=done.filter(x=>x.r>0);const losses=done.filter(x=>x.r<0);const sum=done.reduce((a,x)=>a+x.r,0);const gp=wins.reduce((a,x)=>a+x.r,0),gl=-losses.reduce((a,x)=>a+x.r,0);let eq=0,peak=0,dd=0,con=0,maxCon=0;for(const x of done){eq+=x.r;peak=Math.max(peak,eq);dd=Math.max(dd,peak-eq);con=x.r<0?con+1:0;maxCon=Math.max(maxCon,con)}const mfe=done.map(x=>x.mfe),mae=done.map(x=>x.mae);const avg=a=>a.length?a.reduce((x,y)=>x+y,0)/a.length:null;const med=a=>{if(!a.length)return null;const z=[...a].sort((x,y)=>x-y);return z[(z.length-1)>>1]};return {n:done.length,wins:wins.length,losses:losses.length,wr:done.length?wins.length/done.length:null,netR:sum,expectancy:done.length?sum/done.length:null,pf:gl?gp/gl:null,maxDD:dd,maxConsecutiveLosses:maxCon,avgMFE:avg(mfe),medianMFE:med(mfe),avgMAE:avg(mae),medianMAE:med(mae),unfinished:trades.length-done.length}}
function simulate(entryIndex,entry,atrV,rows,targetR){const stop=entry-STOP_ATR*atrV,target=entry+targetR*STOP_ATR*atrV;let mfe=-Infinity,mae=Infinity,r=null,bars=null;for(let k=1;k<=MAX_HOLD&&entryIndex+k<rows.length;k++){const b=rows[entryIndex+k];mfe=Math.max(mfe,(b.h-entry)/(STOP_ATR*atrV));mae=Math.min(mae,(b.l-entry)/(STOP_ATR*atrV));if(b.l<=stop&&b.h>=target){r=-1;bars=k;break}if(b.l<=stop){r=-1;bars=k;break}if(b.h>=target){r=targetR;bars=k;break}}if(r==null&&mfe>-Infinity)r=((rows[Math.min(rows.length-1,entryIndex+MAX_HOLD)].c-entry)/(STOP_ATR*atrV));return {r:r==null?null:r-COST_R/(STOP_ATR*atrV),mfe,mae,bars,entry,stop,target}}
function buildSetup(rows,ds){const close=rows.map(x=>x.c),e50=ema(close,EMA_LEN),rr=rsi(close,RSI_LEN),aa=atr(rows,ATR_LEN),out=[];for(let i=EMA_LEN+ATR_LEN;i<rows.length-1;i++){const prev=rows[i-1],b=rows[i],dailyReg=regimeBefore(ds,b.t);if(!dailyReg?.e200||dailyReg.c<=dailyReg.e200)continue;if(rr[i]>=35)continue;const touched=b.l<=e50[i]&&b.h>=e50[i];if(!touched)continue;const bullish=b.c>b.o && b.c>b.h-(b.h-b.l)*0.35;const continuation=bullish && b.c>prev.h;const touchEntry=e50[i];if(!(touchEntry>0&&aa[i]>0))continue;const sameStop=touchEntry-STOP_ATR*aa[i];out.push({i,t:b.t,ema50:e50[i],rsi:rr[i],atr:aa[i],touchEntry,sameStop,confirmation:continuation,regimeTs:dailyReg.t,regimeClose:dailyReg.c});}return out}
function paired(rows,sets,targetR){const touch=[],cont=[];for(const s of sets){if(s.confirmation){const a=simulate(s.i,s.touchEntry,s.atr,rows,targetR);touch.push({...a,t:s.t,setup:s.i});const ci=s.i+1;if(ci<rows.length){const entry=rows[ci].o;const stop=s.sameStop;const risk=entry-stop;if(risk>0){const x=simulate(ci,entry,risk/STOP_ATR,rows,targetR);cont.push({...x,t:s.t,setup:s.i,confirmationEntry:entry})}}}}return {touch,cont}}
function randomControl(rows,sets,targetR,seed=17){let s=seed>>>0;const rnd=()=>{s=(1664525*s+1013904223)>>>0;return s/4294967296};const eligible=[];for(let i=EMA_LEN+ATR_LEN+1;i<rows.length-MAX_HOLD;i++){const d=regimeBefore(dsGlobal,rows[i].t);if(d?.e200&&d.c>d.e200)eligible.push(i)}const out=[];for(const x of sets){if(!eligible.length)break;const i=eligible[Math.floor(rnd()*eligible.length)];const aa=atr(rows,ATR_LEN)[i];if(!aa)continue;const entry=rows[i].o;out.push({...simulate(i,entry,aa,rows,targetR),t:rows[i].t,setup:x.i});}return out}

const four=await candles(TF,START-40*86400000,END);const one=await candles(1440,START-300*86400000,END);const ds=addDailyEMA(daily(one),DAILY_EMA_LEN);globalThis.dsGlobal=ds;
const rows=four.filter(x=>x.t>=START&&x.t<=END);const setups=buildSetup(rows,ds);
const discovery=setups.filter(x=>x.t<=DISCOVERY_END);const holdout=setups.filter(x=>x.t>DISCOVERY_END);const result={meta:{symbol:SYMBOL,timeframe:'4H',start:new Date(START).toISOString(),discoveryEnd:new Date(DISCOVERY_END).toISOString(),end:new Date(END).toISOString(),dailyRegime:'latest fully closed UTC daily candle strictly before setup timestamp; price > 200D EMA',setup:'4H price touches 50 EMA and RSI14 < 35',stop:'1.5 ATR from entry',targets:TARGETS,maxHoldBars:MAX_HOLD,cost:'0.06% round trip converted to R',paired:'same setup events; touch at 50EMA vs next-bar confirmation; identical event definition',control:'random eligible long entries while price > 200D, matched to setup count',killCriteria:{expectancyLT0:true,plus1RMFELT35pct:true,touchMustBeatContinuation:true}},counts:{all:setups.length,discovery:discovery.length,holdout:holdout.length}};
for(const tr of TARGETS){const a=paired(rows,discovery,tr),b=paired(rows,holdout,tr);result[`R${tr}`]={discovery:{touch:summarize(a.touch),continuation:summarize(a.cont)},holdout:{touch:summarize(b.touch),continuation:summarize(b.cont)},pairedDelta:{touchMinusContinuationNetR:summarize(b.touch).netR-summarize(b.cont).netR,touchMinusContinuationExpectancy:summarize(b.touch).expectancy-summarize(b.cont).expectancy}}}
const r=TARGETS[1];const allPair=paired(rows,setups,r);const controls=Array.from({length:25},(_,k)=>summarize(randomControl(rows,setups,r,17+k)));result.randomControl={targetR:r,bootstrapRuns:controls.length,meanNetR:controls.reduce((a,x)=>a+x.netR,0)/controls.length,meanExpectancy:controls.reduce((a,x)=>a+x.expectancy,0)/controls.length,runs:controls};
result.killCheck={holdoutR15TouchExpectancy:result.R1.5.holdout.touch.expectancy,holdoutR15TouchPlus1RMFE:(result.R1.5.holdout.touch.filter(x=>x.mfe>=1).length/result.R1.5.holdout.touch.length)||0,touchBeatsContinuationByNetR:result.R1.5.holdout.touch.netR>result.R1.5.holdout.continuation.netR};
console.log(JSON.stringify(result,null,2));
