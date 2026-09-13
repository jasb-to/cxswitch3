const PAIRS={BTC:'PF_XBTUSD',ETH:'PF_ETHUSD',SOL:'PF_SOLUSD',HYPE:'PF_HYPEUSD'};
const START=Date.parse('2026-03-13T00:00:00Z'), END=Date.parse('2026-09-13T23:59:59Z');
const W=2, TL_LOOKBACK=60, TL_SPAN=72, TH=.012, BREAK_PCT=.005, BREAK_ATR=.35;
const avg=a=>a.length?a.reduce((s,x)=>s+x,0)/a.length:0;
const median=a=>{if(!a.length)return 0;const x=[...a].sort((a,b)=>a-b),m=Math.floor(x.length/2);return x.length%2?x[m]:(x[m-1]+x[m])/2};
const ema=(a,p)=>{if(!a.length)return[];const k=2/(p+1),r=[a[0]];for(let i=1;i<a.length;i++)r.push(a[i]*k+r[i-1]*(1-k));return r};
const atr=(c,p=14)=>{const r=[];for(let i=Math.max(1,c.length-p);i<c.length;i++){const x=c[i],q=c[i-1];r.push(Math.max(x.high-x.low,Math.abs(x.high-q.close),Math.abs(x.low-q.close)))}return avg(r)};
const rsi=(a,p=14)=>{if(a.length<2)return 50;let g=0,l=0,n=0;for(let i=Math.max(1,a.length-p);i<a.length;i++){const d=a[i]-a[i-1];if(d>0)g+=d;else l-=d;n++}if(!n||!l)return l?50:100;return 100-100/(1+(g/n)/(l/n))};
function stoch(a){const rv=[];for(let i=14;i<a.length;i++)rv.push(rsi(a.slice(i-14,i+1)));if(rv.length<14)return{k:50,d:50};const raw=[];for(let i=13;i<rv.length;i++){const w=rv.slice(i-13,i+1),lo=Math.min(...w),hi=Math.max(...w);raw.push(hi===lo?50:(rv[i]-lo)/(hi-lo)*100)}return{k:avg(raw.slice(-3)),d:avg(raw.slice(-5))}}
function daily(c){const m=new Map;for(const x of c){const k=new Date(x.timestamp).toISOString().slice(0,10);if(!m.has(k))m.set(k,[]);m.get(k).push(x)}return[...m.values()].map(b=>({timestamp:b[0].timestamp,open:b[0].open,high:Math.max(...b.map(x=>x.high)),low:Math.min(...b.map(x=>x.low)),close:b.at(-1).close,volume:b.reduce((s,x)=>s+x.volume,0)}))}
function bias(c){const d=daily(c);if(d.length<20)return null;const cl=d.map(x=>x.close),f=ema(cl,5).at(-1),s=ema(cl,13).at(-1);return f>s?'LONG':f<s?'SHORT':null}
function pivots(c,dir,w=W){const r=[];for(let i=w;i<c.length-w;i++){const v=dir==='LONG'?c[i].low:c[i].high;const z=c.slice(i-w,i+w+1).map(x=>dir==='LONG'?x.low:x.high);if(v===(dir==='LONG'?Math.min(...z):Math.max(...z)))r.push({index:i,price:v,timestamp:c[i].timestamp})}return r}
function p2(p,c,dir){if(p.length<2)return null;const a=p.at(-2),b=p.at(-1),dx=b.index-a.index;if(dx<=0)return null;const slope=(b.price-a.price)/dx;if(dir==='LONG'&&slope<=0||dir==='SHORT'&&slope>=0)return null;return{a,b,slope,price:slope*(c.length-1)+b.price-slope*b.index,anchor:b.index}}
function prodTL(c,dir){const all=pivots(c,dir),recent=all.filter(x=>x.index>=Math.max(0,c.length-TL_LOOKBACK));if(recent.length<2)return null;let p=recent.slice(-5),latest=p.at(-1).index;p=p.filter(x=>x.index>=latest-TL_SPAN);const q=p2(p,c,dir);if(!q)return null;const buf=Math.max(q.price*BREAK_PCT,atr(c)*BREAK_ATR);for(let i=q.anchor+1;i<c.length;i++){const line=q.slope*i+q.b.price-q.slope*q.b.index;if(dir==='LONG'&&c[i].close<line-buf||dir==='SHORT'&&c[i].close>line+buf)return null}return q}
function pointTL(c,dir){const all=pivots(c,dir),recent=all.filter(x=>x.index>=Math.max(0,c.length-60));return p2(recent,c,dir)}
function aligned(c,dir){const cl=c.map(x=>x.close),f=ema(cl,8).at(-1),s=ema(cl,21).at(-1),p=cl.at(-1);return dir==='LONG'?p>f&&p>s:p<f&&p<s}
function f513(c,dir){const cl=c.map(x=>x.close),f=ema(cl,5).at(-1),s=ema(cl,13).at(-1);return dir==='LONG'?f>s:f<s}
function structure(c,dir){const h=pivots(c,'SHORT'),l=pivots(c,'LONG');if(h.length<2||l.length<2)return false;return dir==='LONG'?h.at(-1).price>h.at(-2).price&&l.at(-1).price>l.at(-2).price:h.at(-1).price<h.at(-2).price&&l.at(-1).price<l.at(-2).price}
function rawSignal(c,dir,tl,allowAdd=false){if(!tl)return null;const price=c.at(-1).close,dist=(price-tl.price)/tl.price,near=Math.abs(dist)<TH,beyond=dir==='LONG'?price>tl.price*1.008:price<tl.price*.992,cl=c.map(x=>x.close),s=stoch(cl),turn=dir==='LONG'?s.k>s.d:s.k<s.d,ext=dir==='LONG'?s.k<20:s.k>80,confirm=dir==='LONG'?price>c.at(-1).open:price<c.at(-1).open,vol=c.at(-1).volume>avg(c.slice(-10).map(x=>x.volume))*1.3,raw=near&&ext?'ENTRY_1':near&&turn&&!ext?'ENTRY_2':allowAdd&&beyond&&confirm&&aligned(c,dir)&&(vol||turn)?'ADD':null;return raw?{raw,price,tl:tl.price,dist,stoch:s}:null}
function structuralTrade(c,s,dir,ts){const a=atr(c),entry=s.price,lo=Math.min(...c.slice(-10).map(x=>x.low)),hi=Math.max(...c.slice(-10).map(x=>x.high)),struct=dir==='LONG'?Math.min(lo,entry-a*2):Math.max(hi,entry+a*2),stop=dir==='LONG'?Math.max(Math.min(struct,entry*.992),entry*.965):Math.min(Math.max(struct,entry*1.008),entry*1.035),risk=Math.abs(entry-stop);if(!risk)return null;return{dir,raw:s.raw,entry,stop,tp1:dir==='LONG'?entry+risk:entry-risk,tp15:dir==='LONG'?entry+1.5*risk:entry-1.5*risk,tp2:dir==='LONG'?entry+2*risk:entry-2*risk,risk,ts,mfe:0,mae:0,stage:0,r1:false,r15:false}}
function lineAt(q,i){return q.slope*i+q.b.price-q.slope*q.b.index}
function persistentEngine(c,dir,state,mode){
  // P2 lifecycle: a line is created only when both pivots are confirmed. It persists until a closed candle breaks it.
  const confirmed=pivots(c,dir).filter(x=>x.index<=c.length-3);
  const last=confirmed.at(-1),prev=confirmed.at(-2);
  if(!state.line&&prev&&last){const q=p2([prev,last],c,dir);if(q)state.line={...q,createdAt:last.index,id:`${dir}-${last.index}`};}
  if(state.line){const q=state.line,buf=Math.max(q.price*BREAK_PCT,atr(c)*BREAK_ATR);const i=c.length-1,line=lineAt(q,i);
    if(!state.broken && ((dir==='LONG'&&c.at(-1).close<line-buf)||(dir==='SHORT'&&c.at(-1).close>line+buf))){state.broken=true;state.breakIndex=i;state.breakPrice=c.at(-1).close;state.breakDir=dir==='LONG'?'SHORT':'LONG';state.retestUntil=i+12;}
    if(state.broken && i>state.breakIndex && i<=state.retestUntil){const nd=state.breakDir;const ret=nd==='SHORT'?c.at(-1).high>=line*(1-0.015)&&c.at(-1).close<line&&c.at(-1).close<c.at(-2).close:c.at(-1).low<=line*(1+0.015)&&c.at(-1).close>line&&c.at(-1).close>c.at(-2).close;if(ret&&nd===dir){state.retested=true;state.retestIndex=i;state.retestDir=nd;}}
    if(state.broken&&i>state.retestUntil){state.line=null;state.broken=false;state.retested=false;}
  }
  if(mode==='persistent'){if(state.line&&state.retested&&state.retestIndex===c.length-1){return {q:state.line,dir,price:c.at(-1).close,mode:'RETEST'}};if(state.line&&!state.broken)return {q:state.line,dir,price:c.at(-1).close,mode:'PERSISTENT'}}
  if(mode==='breakretest'&&state.line&&state.retested&&state.retestIndex===c.length-1)return{q:state.line,dir,price:c.at(-1).close,mode:'BREAK_RETEST'};
  return null;
}
function signalFor(c,dir,engine,state){let tl,tag='';if(engine==='A'){tl=prodTL(c,dir);tag='PROD'}else if(engine==='B'){tl=pointTL(c,dir);tag='P2'}else{const z=persistentEngine(c,dir,state,engine==='C'?'persistent':'breakretest');if(z){tl=z.q;tag=z.mode}else return null}
  const s=rawSignal(c,dir,tl,false);if(!s)return null;
  // Keep the production V28 directional filters for ENTRY_1/ENTRY_2.
  if(dir==='SHORT'&&!f513(c,dir))return null;
  if(s.raw==='ENTRY_2'&&dir==='LONG'&&(() => {const cl=c.map(x=>x.close),f=ema(cl,5).at(-1),g=ema(cl,13).at(-1);return f<g})())return null;
  return {...s,tag,dir};
}
function run(c,engine){let t=null,signals=[],state={line:null,broken:false,retested:false};const stats={trades:0,wins:0,losses:0,netR:0,byType:{ENTRY_1:0,ENTRY_2:0,ADD:0},signals:[],mae:[],mfe:[],dur:[],slBeforeR1:0};
 for(let i=45;i<c.length;i++){
   const x=c[i];
   if(t){const sg=t.dir==='LONG'?1:-1;const fav=(x.high-t.entry)*sg,adv=(t.entry-x.low)*sg;t.mfe=Math.max(t.mfe,fav/t.risk);t.mae=Math.max(t.mae,adv/t.risk);let done=false;
     const hitSL=sg>0?x.low<=t.stop:x.high>=t.stop;if(hitSL){stats.trades++;if(t.stage===0){stats.losses++;stats.netR-=1;stats.slBeforeR1++}else{stats.wins++;stats.netR+=t.stage===1?0:.2}done=true}
     if(!done){if(!t.r1&&(sg>0?x.high>=t.tp1:x.low<=t.tp1)){t.r1=true;t.stage=1;stats.netR+=.4;t.stop=t.entry}
       if(!t.r15&&(sg>0?x.high>=t.tp15:x.low<=t.tp15)){t.r15=true;t.stage=2;stats.netR+=.6;t.stop=t.dir==='LONG'?t.entry+t.risk:t.entry-t.risk}
       if(!t.r2&&(sg>0?x.high>=t.tp2:x.low<=t.tp2)){t.r2=true;stats.trades++;stats.wins++;stats.netR+=.4;done=true}}
     if(done){stats.dur.push((x.timestamp-t.ts)/3600000);stats.mae.push(t.mae);stats.mfe.push(t.mfe);t=null}
   }
   const d=bias(c.slice(0,i+1));if(!d)continue;
   // update persistent state before evaluating this closed candle; pivots are only confirmed with two future bars.
   if(engine==='C'||engine==='D'){
     const dirState=state.line?.dir||d;
     // Preserve line identity; when bias changes, do not silently rebuild it. A new line is allowed only after old lifecycle is gone.
     if(!state.line&&!state.broken) state.line=null;
     const ps=persistentEngine(c.slice(0,i+1),d,state,engine==='C'?'persistent':'breakretest');
     if(ps&&ps.retestIndex===i){};
   }
   if(!t){const s=signalFor(c.slice(0,i+1),d,engine,state);if(s){const tr=structuralTrade(c.slice(0,i+1),s,d,x.timestamp);if(tr){t=tr;stats.byType[s.raw]++;stats.signals.push({timestamp:x.timestamp,direction:d,type:s.raw,entry:s.price,tl:s.tl,distPct:s.dist*100,tag:s.tag});}}}
 }
 if(t){const z=c.at(-1),sg=t.dir==='LONG'?1:-1,p=(z.close-t.entry)*sg/t.risk;stats.trades++;p>=0?stats.wins++:stats.losses++;stats.netR+=p;stats.dur.push((z.timestamp-t.ts)/3600000);stats.mae.push(t.mae);stats.mfe.push(t.mfe)}
 return stats;
}
async function get(pair){const from=Math.floor((START-40*86400000)/1000),to=Math.floor(END/1000);const u=`https://futures.kraken.com/api/charts/v1/trade/${PAIRS[pair]}/4h?from=${from}&to=${to}`;const j=await(await fetch(u)).json();const a=j.candles||[];return a.map(x=>({timestamp:+x.time,open:+x.open,high:+x.high,low:+x.low,close:+x.close,volume:+x.volume})).filter(x=>x.timestamp>=START&&x.timestamp<=END).sort((a,b)=>a.timestamp-b.timestamp)}
function summary(x){const pf=x.netR>=0?null:null;return{trades:x.trades,wins:x.wins,losses:x.losses,winRate:+(100*x.wins/(x.trades||1)).toFixed(2),netR:+x.netR.toFixed(3),avgR:+(x.netR/(x.trades||1)).toFixed(3),avgMFE_R:+avg(x.mfe).toFixed(3),avgMAE_R:+avg(x.mae).toFixed(3),maxMFE_R:+Math.max(0,...x.mfe).toFixed(3),maxMAE_R:+Math.max(0,...x.mae).toFixed(3),avgDurationH:+avg(x.dur).toFixed(2),entry1:x.byType.ENTRY_1,entry2:x.byType.ENTRY_2,add:x.byType.ADD,slBeforeR1:x.slBeforeR1}}
const engines={A:'Current V28 TL',B:'Point-to-point TL',C:'Persistent point-to-point TL',D:'Persistent break/retest TL'};const out={period:{start:new Date(START).toISOString(),end:new Date(END).toISOString()},engines,assets:{}};
for(const pair of Object.keys(PAIRS)){const c=await get(pair);out.assets[pair]={candles:c.length,results:{}};for(const e of Object.keys(engines)){const r=run(c,e);out.assets[pair].results[e]={...summary(r),signals:r.signals}}}
function agg(e){const z={trades:0,wins:0,losses:0,netR:0,mfe:[],mae:[],dur:[],entry1:0,entry2:0,add:0,slBeforeR1:0};for(const p of Object.keys(out.assets)){const r=out.assets[p].results[e];for(const k of ['trades','wins','losses','netR','entry1','entry2','add','slBeforeR1'])z[k]+=r[k];}return{trades:z.trades,wins:z.wins,losses:z.losses,winRate:+(100*z.wins/(z.trades||1)).toFixed(2),netR:+z.netR.toFixed(3),avgR:+(z.netR/(z.trades||1)).toFixed(3),entry1:z.entry1,entry2:z.entry2,add:z.add,slBeforeR1:z.slBeforeR1}}
out.aggregate={};for(const e of Object.keys(engines))out.aggregate[e]=agg(e);
// Explicit HYPE/BTC recent-move diagnostics: list signals in the last 14 days and whether each engine produced a signal before a >5% move in the next 24h/48h.
for(const p of ['BTC','HYPE']){out.assets[p].moveDiagnostics={};const c=await get(p);for(const e of Object.keys(engines)){const ss=out.assets[p].results[e].signals;const misses=[];for(let i=0;i<c.length;i++){const x=c[i],n24=c.slice(i+1,i+7),n48=c.slice(i+1,i+13);const up24=n24.length?Math.max(...n24.map(q=>q.high))/x.close-1:0,down24=x.close/Math.min(...n24.map(q=>q.low))-1,up48:n48.length?Math.max(...n48.map(q=>q.high))/x.close-1:0,down48:x.close/Math.min(...n48.map(q=>q.low))-1;const big=Math.max(up48,down48);if(big>=.05&&!ss.some(s=>s.timestamp>=x.timestamp-8*3600000&&s.timestamp<=x.timestamp))misses.push({time:new Date(x.timestamp).toISOString(),close:x.close,up48:+(up48*100).toFixed(2),down48:+(down48*100).toFixed(2)});}out.assets[p].moveDiagnostics[e]={bigMoveWindows:misses.slice(-12)}}}
console.log(JSON.stringify(out,null,2));
