const PAIRS={BTC:'PF_XBTUSD',ETH:'PF_ETHUSD',SOL:'PF_SOLUSD',HYPE:'PF_HYPEUSD'};
const START=Date.parse('2026-03-13T00:00:00Z'), END=Date.parse('2026-09-13T00:00:00Z');
const avg=a=>a.length?a.reduce((x,y)=>x+y,0)/a.length:0;
const ema=(a,p)=>{const k=2/(p+1),r=[a[0]];for(let i=1;i<a.length;i++)r.push(a[i]*k+r[i-1]*(1-k));return r};
const highest=(a,p)=>Math.max(...a.slice(-p));
const atrSeries=(c,p=22)=>{const tr=c.map((x,i)=>i?Math.max(x.high-x.low,Math.abs(x.high-c[i-1].close),Math.abs(x.low-c[i-1].close)):x.high-x.low);return c.map((_,i)=>i+1<p?null:avg(tr.slice(i-p+1,i+1)))};
function linreg(a,p){const out=Array(a.length).fill(null),sx=p*(p-1)/2,sx2=p*(p-1)*(2*p-1)/6,den=p*sx2-sx*sx;for(let i=p-1;i<a.length;i++){let sy=0,sxy=0,ok=true;for(let j=0;j<p;j++){const y=a[i-p+1+j];if(y==null){ok=false;break}sy+=y;sxy+=j*y}if(!ok)continue;const b=(p*sxy-sx*sy)/den,aa=(sy-b*sx)/p;out[i]=aa+b*(p-1)}return out}
function zlsma(a,p=50){const l1=linreg(a,p),l2=linreg(l1,p);return l1.map((x,i)=>x==null||l2[i]==null?null:x+(x-l2[i]))}
function run(c,{emaFast=5,emaSlow=13,useEMA=false,useZ=false,zSlope=false}={}){
 const closes=c.map(x=>x.close),atrs=atrSeries(c,22),z=zlsma(closes,50),ef=ema(closes,emaFast),es=ema(closes,emaSlow);
 let ls=null,ss=null,dir=1,tr=null;const out=[];
 for(let i=0;i<c.length;i++){
  const x=c[i],a=atrs[i];if(a==null||i<100)continue;
  const ae=3*a,lr=highest(closes,22)-ae,sr=Math.min(...closes.slice(-22))+ae,lp=ls??lr,sp=ss??sr;
  ls=x.close>lp?Math.max(lr,lp):lr;ss=x.close<sp?Math.min(sr,sp):sr;
  const prev=dir;dir=x.close>sp?1:x.close<lp?-1:dir;
  const cb=dir===1&&prev===-1,cs=dir===-1&&prev===1;
  if(tr){
   if(tr.d==='L'&&x.low<=ls){out.push({...tr,exit:x.close,r:(x.close-tr.entry)/Math.abs(tr.entry-tr.stop),reason:'CE_STOP',bars:i-tr.i});tr=null;continue}
   if(tr&&tr.d==='S'&&x.high>=ss){out.push({...tr,exit:x.close,r:(tr.entry-x.close)/Math.abs(tr.entry-tr.stop),reason:'CE_STOP',bars:i-tr.i});tr=null;continue}
   if(tr&&((tr.d==='L'&&cs)||(tr.d==='S'&&cb))){const r=tr.d==='L'?(x.close-tr.entry)/Math.abs(tr.entry-tr.stop):(tr.entry-x.close)/Math.abs(tr.entry-tr.stop);out.push({...tr,exit:x.close,r,reason:'REVERSE',bars:i-tr.i});tr=null}
  }
  if(!tr){let sig=cb?'L':cs?'S':null;
   if(sig&&useEMA){if(sig==='L'&&ef[i]<=es[i])sig=null;if(sig==='S'&&ef[i]>=es[i])sig=null}
   if(sig&&useZ){if(z[i]==null)sig=null;else if(sig==='L'&&x.close<=z[i])sig=null;else if(sig==='S'&&x.close>=z[i])sig=null}
   if(sig&&zSlope){if(z[i]==null||z[i-1]==null)sig=null;else if(sig==='L'&&z[i]<=z[i-1])sig=null;else if(sig==='S'&&z[i]>=z[i-1])sig=null}
   if(sig){const stop=sig==='L'?ls:ss,r=Math.abs(x.close-stop);if(r>0)tr={d:sig,entry:x.close,stop,i}}
  }
 }
 if(tr){const x=c.at(-1),r=tr.d==='L'?(x.close-tr.entry)/Math.abs(tr.entry-tr.stop):(tr.entry-x.close)/Math.abs(tr.entry-tr.stop);out.push({...tr,exit:x.close,r,reason:'END',bars:c.length-1-tr.i})}
 const wins=out.filter(t=>t.r>0).length,losses=out.length-wins,gp=out.filter(t=>t.r>0).reduce((s,t)=>s+t.r,0),gl=-out.filter(t=>t.r<=0).reduce((s,t)=>s+t.r,0),netR=out.reduce((s,t)=>s+t.r,0);
 return{trades:out.length,wins,losses,winRate:out.length?100*wins/out.length:0,netR,pf:gl?gp/gl:Infinity,avgR:out.length?netR/out.length:0,avgBars:out.length?out.reduce((s,t)=>s+t.bars,0)/out.length:0};
}
async function fetchPair(pair,tf){const u=`https://futures.kraken.com/api/charts/v1/trade/${PAIRS[pair]}/${tf}?from=${Math.floor((START-30*86400000)/1000)}&to=${Math.floor(END/1000)}`;const r=await fetch(u);if(!r.ok)throw Error(`${pair} ${tf} ${r.status}`);const d=await r.json();return(d.candles||[]).map(x=>({timestamp:+x.time,open:+x.open,high:+x.high,low:+x.low,close:+x.close,volume:+x.volume})).filter(x=>x.timestamp>=START&&x.timestamp<=END)}
const variants={A_CE_ONLY:{},B_CE_EMA_5_13:{useEMA:true},C_CE_ZLSMA:{useZ:true},D_CE_EMA_ZLSMA:{useEMA:true,useZ:true},E_CE_EMA_ZLSMA_SLOPE:{useEMA:true,useZ:true,zSlope:true}};
const result={period:{start:new Date(START).toISOString(),end:new Date(END).toISOString()},note:'Research only. Pine v6 ZLSMA + Chandelier Exit replication. Defaults: ZLSMA 50, CE ATR 22 x3, close extremums, EMA 5/13. A=CE flip; B=CE+5/13; C=CE+ZLSMA side; D=CE+5/13+ZLSMA; E adds ZLSMA slope. Entries use confirmed CE direction flips; exits use trailing CE stop or reverse signal.'};
for(const tf of ['4h','1h']){result[tf]={};for(const pair of Object.keys(PAIRS)){const c=await fetchPair(pair,tf);result[tf][pair]={candles:c.length};for(const [name,cfg] of Object.entries(variants))result[tf][pair][name]=run(c,cfg)}}
console.log(JSON.stringify(result,null,2));
