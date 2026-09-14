import fs from 'fs';

const START='2026-03-13T00:00:00Z', END='2026-09-14T00:00:00Z';
const ASSETS={BTC:'PF_XBTUSD',ETH:'PF_ETHUSD',SOL:'PF_SOLUSD',HYPE:'PF_HYPEUSD'};
const BASE='https://futures.kraken.com/api/charts/v1/trade';
const MS=3600000;
async function get(symbol,res,start,end){
  const u=`${BASE}/${symbol}/${res}?from=${Math.floor(new Date(start).getTime()/1000)}&to=${Math.floor(new Date(end).getTime()/1000)}`;
  const r=await fetch(u); if(!r.ok) throw new Error(`${symbol} ${res} ${r.status}`);
  const j=await r.json();
  return (j.candles||[]).map(x=>({t:+x.time,o:+x.open,h:+x.high,l:+x.low,c:+x.close,v:+x.volume})).sort((a,b)=>a.t-b.t);
}
function ema(a,n){let k=2/(n+1),e=a[0]; const out=[e]; for(let i=1;i<a.length;i++){e=a[i]*k+e*(1-k);out.push(e)} return out}
function atr(c,n=14){const tr=c.map((x,i)=>i?Math.max(x.h-x.l,Math.abs(x.h-c[i-1].c),Math.abs(x.l-c[i-1].c)):x.h-x.l);return ema(tr,n)}
function stoch(c,n=14,s=3){let k=[];for(let i=0;i<c.length;i++){let z=c.slice(Math.max(0,i-n+1),i+1),hi=Math.max(...z.map(x=>x.h)),lo=Math.min(...z.map(x=>x.l));k.push(hi===lo?50:100*(c[i].c-lo)/(hi-lo))}return k}
function pivots(c,w,dir){let out=[];for(let i=w;i<c.length-w;i++){let ok=true;if(dir==='LONG'){for(let j=1;j<=w;j++)if(c[i].l>=c[i-j].l||c[i].l>c[i+j].l)ok=false;if(ok)out.push({i,price:c[i].l,t:c[i].t})}else{for(let j=1;j<=w;j++)if(c[i].h<=c[i-j].h||c[i].h<c[i+j].h)ok=false;if(ok)out.push({i,price:c[i].h,t:c[i].t})}}return out}
function tlAt(c,i,dir){if(i<100)return null;let p=pivots(c.slice(0,i+1),3,dir).filter(x=>x.i>=i-60);if(p.length<2)return null;let a=p.at(-2),b=p.at(-1),span=b.i-a.i;if(span<2||span>72)return null;let slope=(b.price-a.price)/span;if(dir==='LONG'&&slope<=0||dir==='SHORT'&&slope>=0)return null;let price=b.price+slope*(i-b.i);let atr14=atr(c.slice(0,i+1),14).at(-1); // invalidate only after B
for(let k=b.i+1;k<=i;k++){let lp=b.price+slope*(k-b.i);let cc=c[k].c;let br=dir==='LONG'?cc<lp-Math.max(lp*.005,atr14*.35):cc>lp+Math.max(lp*.005,atr14*.35);if(br)return null}
return {price,a,b,slope,age:i-b.i,span,atr:atr14};}
function q(v,edges){for(let i=0;i<edges.length-1;i++)if(v>=edges[i]&&v<edges[i+1])return `${edges[i]}..${edges[i+1]}`;return `${edges.at(-1)}+`}
function add(map,key,rec){let x=map.get(key)||{n:0,w:0,mfe:0,mae:0};x.n++;x.w+=rec.win?1:0;x.mfe+=rec.mfe;x.mae+=rec.mae;map.set(key,x)}
function fmt(map){return [...map.entries()].map(([k,x])=>({key:k,n:x.n,winPct:+(100*x.w/x.n).toFixed(1),mfePct:+(100*x.mfe/x.n).toFixed(2),maePct:+(100*x.mae/x.n).toFixed(2)})).sort((a,b)=>b.n-a.n)}

const out={meta:{start:START,end:END,tl:'V28-like: 4H pivot width 3, last 60, last 2 pivots, max span 72, 0.5%/0.35ATR invalidation',horizon:[3,6,12,24]},assets:{}};
for(const [asset,symbol] of Object.entries(ASSETS)){
 const c=await get(symbol,'4h',START,END); const d=await get(symbol,'1d',START,END); const e5=ema(c.map(x=>x.c),5),e13=ema(c.map(x=>x.c),13),k=stoch(c),a=atr(c,22),vol20=ema(c.map(x=>x.v),20);
 const dailyBias=(t)=>{let j=d.findIndex(x=>x.t>t)-1;if(j<20)return 'NA';let ee5=ema(d.map(x=>x.c),5),ee13=ema(d.map(x=>x.c),13);return ee5[j]>ee13[j]?'BULL':'BEAR'};
 let ints=[]; const buckets={distance:new Map(),touches:new Map(),wick:new Map(),close:new Map(),body:new Map(),volume:new Map(),ema:new Map(),stoch:new Map(),daily:new Map(),age:new Map()};
 for(let i=100;i<c.length-24;i++){
  for(const dir of ['LONG','SHORT']){let tl=tlAt(c,i,dir);if(!tl)continue;let x=c[i],dist=(x.c-tl.price)/tl.price;let ad=Math.abs(dist);if(ad>0.035)continue;
   let wick=dir==='LONG'?Math.max(0,tl.price-x.l)/tl.price:Math.max(0,x.h-tl.price)/tl.price;
   let closeDist=Math.abs(x.c-tl.price)/tl.price, body=Math.abs(x.c-x.o)/(x.h-x.l||1), vr=x.v/(vol20[i]||x.v);
   let emaState=dir==='LONG'?(e5[i]>e13[i]?'BULL':'BEAR'):(e5[i]<e13[i]?'BEAR':'BULL');
   let st=k[i], stTurn=dir==='LONG'?(k[i]>k[i-1]&&k[i-1]<=k[i-2]):(k[i]<k[i-1]&&k[i-1]>=k[i-2]);
   let touches=0; const pA=tl.a.i; const pB=tl.b.i; for(let z=Math.max(pA,i-60);z<i;z++){let dd=Math.abs(c[z].c-(tl.price+tl.slope*(z-i)))/(tl.price+tl.slope*(z-i));if(dd<0.012)touches++}
   let fut=c.slice(i+1,i+25);let mfe=dir==='LONG'?Math.max(...fut.map(z=>z.h/x.c-1)):Math.max(...fut.map(z=>1-z.l/x.c));let mae=dir==='LONG'?Math.min(...fut.map(z=>z.l/x.c-1)):Math.min(...fut.map(z=>1-z.h/x.c));
   // success = +1% favorable before -1% adverse, evaluated by first threshold hit
   let win=false;for(let z of fut){let fav=dir==='LONG'?(z.h/x.c-1):(1-z.l/x.c),adv=dir==='LONG'?(1-z.l/x.c):(z.h/x.c-1);if(fav>=.01){win=true;break}if(adv>=.01)break}
   let rec={mfe,mae,win};ints.push({...rec,asset,dir,i,t:x.t,price:x.c,dist,wick,closeDist,body,vr,emaState,st,stTurn,touches,daily:dailyBias(x.t),age:tl.age});
   add(buckets.distance,q(ad,[0,.005,.01,.015,.02,.025,.03]),rec);add(buckets.touches,q(touches,[0,1,2,3,4,6]),rec);add(buckets.wick,q(wick,[0,.0025,.005,.01,.02]),rec);add(buckets.close,q(closeDist,[0,.005,.01,.02,.03]),rec);add(buckets.body,q(body,[0,.2,.4,.6,.8]),rec);add(buckets.volume,q(vr,[0,.8,1,1.25,1.5,2]),rec);add(buckets.ema,emaState,rec);add(buckets.stoch,q(st,[0,20,40,60,80,100]),rec);add(buckets.daily,dailyBias(x.t),rec);add(buckets.age,q(tl.age,[0,6,12,24,48]),rec);
  }
 }
 const near=ints.filter(x=>x.dist<=.012); const best=ints.filter(x=>x.dist<=.02&&x.wick>=.0025&&x.body>=.4&&x.vr>=1);
 out.assets[asset]={candles:c.length,interactions:ints.length,nearV28:near.length,nearV28Win:+(100*near.filter(x=>x.win).length/(near.length||1)).toFixed(1),overallWin:+(100*ints.filter(x=>x.win).length/(ints.length||1)).toFixed(1),overallMFE:+(100*ints.reduce((s,x)=>s+x.mfe,0)/(ints.length||1)).toFixed(2),overallMAE:+(100*ints.reduce((s,x)=>s+x.mae,0)/(ints.length||1)).toFixed(2),bestCount:best.length,bestWin:+(100*best.filter(x=>x.win).length/(best.length||1)).toFixed(1),buckets:Object.fromEntries(Object.entries(buckets).map(([k,m])=>[k,fmt(m)]))};
}
console.log(JSON.stringify(out,null,2));
