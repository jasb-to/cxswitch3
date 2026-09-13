import { NextResponse } from 'next/server';
const PAIRS:Record<string,string>={BTC:'PF_XBTUSD',ETH:'PF_ETHUSD',SOL:'PF_SOLUSD',HYPE:'PF_HYPEUSD'};
const START=Date.parse('2026-03-13T00:00:00Z'), END=Date.parse('2026-09-13T00:00:00Z');
type C={timestamp:number;open:number;high:number;low:number;close:number;volume:number};
const avg=(a:number[])=>a.length?a.reduce((x,y)=>x+y,0)/a.length:0;
function ema(a:number[],p:number){if(!a.length)return[];const k=2/(p+1),r=[a[0]];for(let i=1;i<a.length;i++)r.push(a[i]*k+r[i-1]*(1-k));return r}
function sma(a:number[],p:number){return a.length<p?null:avg(a.slice(-p))}
function atrSeries(c:C[],p=22){const tr=c.map((x,i)=>i?Math.max(x.high-x.low,Math.abs(x.high-c[i-1].close),Math.abs(x.low-c[i-1].close)):x.high-x.low);const out:(number|null)[]=[];for(let i=0;i<c.length;i++)out.push(i+1<p?null:avg(tr.slice(i-p+1,i+1)));return out}
function highest(a:number[],p:number){return Math.max(...a.slice(-p))}
function lowest(a:number[],p:number){return Math.min(...a.slice(-p))}
function zlsma(a:number[],p=50){const lin=(v:number[],n:number)=>{const out:(number|null)[]=Array(v.length).fill(null);const sx=n*(n-1)/2,sx2=n*(n-1)*(2*n-1)/6,den=n*sx2-sx*sx;for(let i=n-1;i<v.length;i++){let sy=0,sxy=0;for(let j=0;j<n;j++){const y=v[i-n+1+j];sy+=y;sxy+=j*y}const b=(n*sxy-sx*sy)/den,aa=(sy-b*sx)/n;out[i]=aa+b*(n-1)}return out};const l1=lin(a,p);const l2=lin(l1.map(x=>x??a[0]),p);return l1.map((x,i)=>x==null||l2[i]==null?null:x+(x-l2[i]!))}
function run(c:C[],lead=3,prox=0.35,volMult=1.5,mode:'confirmed'|'presignal'='confirmed'){
 const closes=c.map(x=>x.close), vols=c.map(x=>x.volume), atrs=atrSeries(c,22), z=zlsma(closes,50), e5=ema(closes,5),e13=ema(closes,13);
 let longStop:number|null=null,shortStop:number|null=null,dir=1,prevDir=1;let tr:any=null;const trades:any[]=[];let preBuyAge=999,preSellAge=999;
 for(let i=0;i<c.length;i++){
  const x=c[i],a=atrs[i]; if(a==null||i<50)continue;
  const atrCE=3*a; const longRaw=highest(closes,22)-atrCE, shortRaw=lowest(closes,22)+atrCE;
  const lprev=longStop??longRaw, sprev=shortStop??shortRaw;
  longStop=x.close>lprev?Math.max(longRaw,lprev):longRaw;
  shortStop=x.close<sprev?Math.min(shortRaw,sprev):shortRaw;
  prevDir=dir; dir=x.close>sprev?1:x.close<lprev?-1:dir;
  const confirmedBuy=dir===1&&prevDir===-1, confirmedSell=dir===-1&&prevDir===1;
  const volAvg=sma(vols,20);const volOK=volAvg!=null&&x.volume>volAvg*volMult;
  const buyProx=x.close>(sprev-atrCE*prox), sellProx=x.close<(lprev+atrCE*prox);
  const preBuy=buyProx&&dir===-1&&volOK, preSell=sellProx&&dir===1&&volOK;
  preBuyAge=preBuy?0:preBuyAge+1; preSellAge=preSell?0:preSellAge+1;
  const preBuyPersist=preBuyAge<=lead, preSellPersist=preSellAge<=lead;
  if(tr){
    if(tr.dir==='LONG'&&x.low<=longStop!){trades.push({...tr,exit:x.close,r:(x.close-tr.entry)/Math.abs(tr.entry-tr.stop),reason:'CE_STOP',bars:i-tr.i});tr=null;continue}
    if(tr&&tr.dir==='SHORT'&&x.high>=shortStop!){trades.push({...tr,exit:x.close,r:(tr.entry-x.close)/Math.abs(tr.entry-tr.stop),reason:'CE_STOP',bars:i-tr.i});tr=null;continue}
    if(tr&&((tr.dir==='LONG'&&confirmedSell)||(tr.dir==='SHORT'&&confirmedBuy))){const r=tr.dir==='LONG'?(x.close-tr.entry)/Math.abs(tr.entry-tr.stop):(tr.entry-x.close)/Math.abs(tr.entry-tr.stop);trades.push({...tr,exit:x.close,r,reason:'REVERSE',bars:i-tr.i});tr=null;}
  }
  if(!tr){let sig:null|'LONG'|'SHORT'=null;if(mode==='confirmed'){if(confirmedBuy)sig='LONG';else if(confirmedSell)sig='SHORT'}else{if(preBuyPersist)sig='LONG';else if(preSellPersist)sig='SHORT'}if(sig){const stop=sig==='LONG'?longStop!:shortStop!;const risk=Math.abs(x.close-stop);if(risk>0)tr={dir:sig,entry:x.close,stop,i}}}
 }
 if(tr){const x=c.at(-1)!;const r=tr.dir==='LONG'?(x.close-tr.entry)/Math.abs(tr.entry-tr.stop):(tr.entry-x.close)/Math.abs(tr.entry-tr.stop);trades.push({...tr,exit:x.close,r,reason:'END',bars:c.length-1-tr.i})}
 const wins=trades.filter(t=>t.r>0).length,losses=trades.length-wins,gp=trades.filter(t=>t.r>0).reduce((s,t)=>s+t.r,0),gl=-trades.filter(t=>t.r<=0).reduce((s,t)=>s+t.r,0);
 return {trades,wins,losses,winRate:trades.length?100*wins/trades.length:0,netR:trades.reduce((s,t)=>s+t.r,0),pf:gl?gp/gl:Infinity,avgR:trades.length?trades.reduce((s,t)=>s+t.r,0)/trades.length:0,avgBars:trades.length?trades.reduce((s,t)=>s+t.bars,0)/trades.length:0};
}
async function fetchPair(pair:string,tf:string){const u=`https://futures.kraken.com/api/charts/v1/trade/${PAIRS[pair]}/${tf}?from=${Math.floor((START-10*86400000)/1000)}&to=${Math.floor(END/1000)}`;const r=await fetch(u,{cache:'no-store'});if(!r.ok)throw new Error(`${pair} ${tf} ${r.status}`);const d=await r.json();return (d.candles||[]).map((x:any)=>({timestamp:Number(x.time),open:+x.open,high:+x.high,low:+x.low,close:+x.close,volume:+x.volume})).filter((x:C)=>x.timestamp>=START&&x.timestamp<=END)}
export async function GET(){const result:any={period:{start:new Date(START).toISOString(),end:new Date(END).toISOString()},note:'Research only. Pine v6 ZLSMA + Chandelier Exit replication. Defaults: ZLSMA 50, CE ATR 22 x3, close extremums, EMA 5/13. Confirmed mode enters on CE direction flip; exits on trailing CE stop or reverse signal. Pre-signal mode tests the script pre-signal logic as an early entry. No production strategy changes.'};for(const tf of ['4h','1h']){result[tf]={};for(const pair of Object.keys(PAIRS)){const c=await fetchPair(pair,tf);result[tf][pair]={candles:c.length,confirmed:run(c,3,.35,1.5,'confirmed'),presignal:run(c,3,.35,1.5,'presignal')}}}return NextResponse.json(result)}