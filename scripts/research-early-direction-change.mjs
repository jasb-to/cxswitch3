const PAIRS={BTC:['PI_XBTUSD','PF_XBTUSD'],ETH:['PI_ETHUSD','PF_ETHUSD'],SOL:['PI_SOLUSD','PF_SOLUSD'],HYPE:['PI_HYPEUSD','PF_HYPEUSD']};
const START=Date.parse('2026-03-13T00:00:00Z'), END=Date.parse('2026-09-14T00:00:00Z');
const TRAIN=84*86400000, OOS=42*86400000;
const avg=a=>a.length?a.reduce((s,x)=>s+x,0)/a.length:0;
const ema=(a,p)=>{if(!a.length)return [];const k=2/(p+1),r=[a[0]];for(let i=1;i<a.length;i++)r.push(a[i]*k+r[i-1]*(1-k));return r};
const atr=(c,p=14)=>avg(c.slice(-p).map((x,i)=>{const q=c[Math.max(0,c.length-p+i-1)]||x;return Math.max(x.h-x.l,Math.abs(x.h-q.c),Math.abs(x.l-q.c))}));
const rsi=(a,p=14)=>{let g=0,l=0;for(let i=Math.max(1,a.length-p);i<a.length;i++){const d=a[i]-a[i-1];if(d>0)g+=d;else l-=d}return l?100-100/(1+(g/p)/(l/p)):100};
const fetchC=async sym=>{let out=[],from=Math.floor((START-30*86400000)/1000),last=0;for(let n=0;n<12;n++){const u=`https://futures.kraken.com/api/charts/v1/trade/${sym}/4h?from=${from}&to=${Math.floor(END/1000)}&count=720`;const j=await(await fetch(u)).json();if(!j.candles?.length)break;const r=j.candles.map(x=>({t:+x.time,o:+x.open,h:+x.high,l:+x.low,c:+x.close,v:+x.volume}));out.push(...r);last=r.at(-1).t;if(!j.more_candles||last>=END)break;from=Math.floor(last/1000)+1}return [...new Map(out.map(x=>[x.t,x])).values()].sort((a,b)=>a.t-b.t).filter(x=>x.t>=START-30*86400000)};
function feats(c,i,dir){const x=c[i],cl=c.slice(0,i+1).map(z=>z.c),e5=ema(cl,5),e8=ema(cl,8),e13=ema(cl,13),e21=ema(cl,21),a=atr(c.slice(0,i+1)),r=rsi(cl),prev=c[i-1],sg=dir;const roc6=(x.c-c[Math.max(0,i-6)].c)/(a||x.c);const slope5=(e5.at(-1)-e5.at(-2))/(a||x.c);const slope13=(e13.at(-1)-e13.at(-2))/(a||x.c);const cross5_13=sg>0?e5.at(-1)>e13.at(-1)&&e5.at(-2)<=e13.at(-2):e5.at(-1)<e13.at(-1)&&e5.at(-2)>=e13.at(-2);const slopeTurn=sg>0?slope5>0&&((e5.at(-2)-e5.at(-3))/(a||x.c))<=0:slope5<0&&((e5.at(-2)-e5.at(-3))/(a||x.c))>=0;const priceCross8=sg>0?x.c>e8.at(-1)&&prev.c<=e8.at(-2):x.c<e8.at(-1)&&prev.c>=e8.at(-2);const rocTurn=sg>0?roc6>0&&((c[Math.max(0,i-1)].c-c[Math.max(0,i-7)].c)/(a||x.c))<=0:roc6<0&&((c[Math.max(0,i-1)].c-c[Math.max(0,i-7)].c)/(a||x.c))>=0;const rsiCross=sg>0?r>50&&rsi(cl.slice(0,-1))<=50:r<50&&rsi(cl.slice(0,-1))>=50;const body=Math.abs(x.c-x.o)/(x.h-x.l||1);const candle=body>=.4&&(sg>0?x.c>x.o:x.c<x.o);const vol=x.v/avg(c.slice(Math.max(0,i-20),i).map(z=>z.v));const volume=vol>=1;const higherLow=sg>0?x.l>Math.min(...c.slice(Math.max(0,i-4),i).map(z=>z.l)):x.h<Math.max(...c.slice(Math.max(0,i-4),i).map(z=>z.h));const trendAlign=sg>0?e8.at(-1)>e21.at(-1):e8.at(-1)<e21.at(-1);return{cross5_13,slopeTurn,priceCross8,rocTurn,rsiCross,candle,volume,higherLow,trendAlign,slope5,slope13,roc6,rsi:r,atr:a}};
const detectors={
 CROSS_5_13:f=>f.cross5_13,
 SLOPE_TURN:f=>f.slopeTurn,
 PRICE_CROSS_8:f=>f.priceCross8,
 ROC_TURN:f=>f.rocTurn,
 RSI_50_TURN:f=>f.rsiCross,
 CANDLE:f=>f.candle,
 VOLUME:f=>f.volume,
 HIGHER_LOW:f=>f.higherLow,
 TREND_ALIGN:f=>f.trendAlign,
 CROSS_PLUS_SLOPE:f=>f.cross5_13&&f.slopeTurn,
 SLOPE_PLUS_PRICE:f=>f.slopeTurn&&f.priceCross8,
 ROC_PLUS_SLOPE:f=>f.rocTurn&&f.slopeTurn,
 CROSS_PLUS_ROC:f=>f.cross5_13&&f.rocTurn,
 EARLY_2OF4:f=>[f.cross5_13,f.slopeTurn,f.priceCross8,f.rocTurn].filter(Boolean).length>=2,
 EARLY_3OF6:f=>[f.cross5_13,f.slopeTurn,f.priceCross8,f.rocTurn,f.rsiCross,f.candle].filter(Boolean).length>=3,
};
function simulate(c,start,end,detector,dir,entryDelay=1){let pos=null,out={n:0,w:0,r:0,lead:[]};for(let i=80;i<c.length-5;i++){const x=c[i];if(x.t<start)continue;if(x.t>=end)break;if(pos){const hit=dir>0?x.l<=pos.sl:x.h>=pos.sl;if(hit){out.n++;out.r-=1;pos=null;continue}const rr=((x.c-pos.entry)*dir)/pos.risk;if(rr>=2){out.n++;out.w++;out.r+=2;pos=null;continue}}
if(!pos&&i+entryDelay<c.length&&x.t<end){const f=feats(c,i,dir);if(detector(f)){const en=c[i+entryDelay].o,a=f.atr,sl=dir>0?en-Math.max(1.5*a,en*.008):en+Math.max(1.5*a,en*.008);pos={entry:en,sl,risk:Math.abs(en-sl)};out.lead.push(0)}}}
if(pos){const x=c.filter(z=>z.t<end).at(-1);const rr=((x.c-pos.entry)*dir)/pos.risk;out.n++;out.r+=rr;if(rr>0)out.w++}return{trades:out.n,wins:out.w,winRate:+(100*out.w/(out.n||1)).toFixed(1),netR:+out.r.toFixed(2),avgR:+(out.r/(out.n||1)).toFixed(3)}}
async function run(){const all={};for(const [asset,pairs] of Object.entries(PAIRS)){let c=[];for(const s of pairs){try{const q=await fetchC(s);if(q.length>c.length)c=q}catch{}}const models={};for(const [name,det] of Object.entries(detectors)){let n=0,w=0,r=0,windows=[];for(let st=START+TRAIN;st<END;st+=OOS){const e=Math.min(st+OOS,END);for(const dir of [1,-1]){const q=simulate(c,st,e,det,dir);n+=q.trades;w+=q.wins;r+=q.netR;windows.push({st:new Date(st).toISOString().slice(0,10),dir:dir>0?'L':'S',...q})}}models[name]={trades:n,winRate:+(100*w/(n||1)).toFixed(1),netR:+r.toFixed(2),avgR:+(r/(n||1)).toFixed(3),windows};}all[asset]={candles:c.length,models}}console.log(JSON.stringify({method:'Early direction-change research; 84d train / 42d OOS; entry next 4H open; TP +2R; SL 1.5 ATR or 0.8%; no V28 gate',results:all},null,2))}run();