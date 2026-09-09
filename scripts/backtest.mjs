const PAIRS={BTC:'XBTUSD',ETH:'ETHUSD',SOL:'SOLUSD',HYPE:'HYPEUSD'};
const START=Date.parse('2026-07-31T00:00:00Z'),END=Date.parse('2026-09-10T00:00:00Z');
const avg=a=>a.length?a.reduce((x,y)=>x+y,0)/a.length:0;
const median=a=>{if(!a.length)return 0;const x=[...a].sort((a,b)=>a-b),m=Math.floor(x.length/2);return x.length%2?x[m]:(x[m-1]+x[m])/2};
const ema=(a,p)=>{if(!a.length)return[];const k=2/(p+1),r=[a[0]];for(let i=1;i<a.length;i++)r.push(a[i]*k+r[i-1]*(1-k));return r};
const atr=(c,p=14)=>avg(c.slice(-p).map((x,i)=>{const q=c[Math.max(0,c.length-p+i-1)]||x;return Math.max(x.high-x.low,Math.abs(x.high-q.close),Math.abs(x.low-q.close))}));
const rsi=(a,p=14)=>{if(a.length<2)return 50;let g=0,l=0,n=0;for(let i=Math.max(1,a.length-p);i<a.length;i++){const d=a[i]-a[i-1];if(d>0)g+=d;else l-=d;n++}if(!n)return 50;if(!l)return 100;const rs=(g/n)/(l/n);return 100-100/(1+rs)};
function stoch(a){const rv=[];for(let i=14;i<a.length;i++)rv.push(rsi(a.slice(i-14,i+1)));if(rv.length<14)return{k:50,d:50};const raw=[];for(let i=13;i<rv.length;i++){const w=rv.slice(i-13,i+1),lo=Math.min(...w),hi=Math.max(...w);raw.push(hi===lo?50:(rv[i]-lo)/(hi-lo)*100)}return{k:avg(raw.slice(-3)),d:avg(raw.slice(-5))}}
function daily(c){const m=new Map;for(const x of c){const k=new Date(x.timestamp).toISOString().slice(0,10);if(!m.has(k))m.set(k,[]);m.get(k).push(x)}return [...m.values()].map(b=>({timestamp:b[0].timestamp,open:b[0].open,high:Math.max(...b.map(x=>x.high)),low:Math.min(...b.map(x=>x.low)),close:b.at(-1).close,volume:b.reduce((s,x)=>s+x.volume,0)}))}
function bias(c){const d=daily(c);if(d.length<20)return null;const cl=d.map(x=>x.close),f=ema(cl,5).at(-1),s=ema(cl,13).at(-1);return f>s?'LONG':f<s?'SHORT':null}
function pivots(c,dir,w){const r=[];for(let i=w;i<c.length-w;i++){const v=dir==='LONG'?c[i].low:c[i].high,wv=c.slice(i-w,i+w+1).map(x=>dir==='LONG'?x.low:x.high);if(dir==='LONG'?v===Math.min(...wv):v===Math.max(...wv))r.push({index:i,price:v})}return r}
function reg(p,c,dir){if(p.length<3)return null;const n=p.length,sx=p.reduce((s,x)=>s+x.index,0),sy=p.reduce((s,x)=>s+x.price,0),sxy=p.reduce((s,x)=>s+x.index*x.price,0),sx2=p.reduce((s,x)=>s+x.index*x.index,0),den=n*sx2-sx*sx;if(!den)return null;const slope=(n*sxy-sx*sy)/den;if(dir==='LONG'&&slope<=0||dir==='SHORT'&&slope>=0)return null;const inter=(sy-slope*sx)/n;return{price:slope*(c.length-1)+inter,slope,anchor:p.at(-1).index}}
function pt(p,c,dir){if(p.length<2)return null;const a=p.at(-2),b=p.at(-1),s=(b.price-a.price)/(b.index-a.index);if(dir==='LONG'&&s<=0||dir==='SHORT'&&s>=0)return null;return{price:a.price+s*(c.length-1-a.index),slope:s,anchor:b.index}}
function tl(c,dir,v){const w=v===5||v===6?5:2,recent=pivots(c,dir,w).filter(x=>x.index>=c.length-(v===5||v===6?120:60));if(recent.length<(v===4||v===6?2:3))return null;let p=recent.slice(-5);if(v===5||v===6){p=[];for(const x of recent){if(!p.length||(dir==='LONG'?x.price>p.at(-1).price:x.price<p.at(-1).price))p.push(x)}p=p.slice(-5)}if(p.length<(v===4||v===6?2:3))return null;const q=(v===4||v===6)?pt(p,c,dir):reg(p,c,dir);if(!q)return null;const buf=Math.max(q.price*.005,atr(c)*.35);for(let i=q.anchor+1;i<c.length;i++){const line=q.slope*i+(q.price-q.slope*(c.length-1));if(dir==='LONG'&&c[i].close<line-buf||dir==='SHORT'&&c[i].close>line+buf)return null}return q}
const f513=(c,d)=>{const cl=c.map(x=>x.close),f=ema(cl,5).at(-1),s=ema(cl,13).at(-1);return d==='LONG'?f>s:f<s};
function struct(c,d,w=2){const h=pivots(c,'SHORT',w),l=pivots(c,'LONG',w);if(h.length<2||l.length<2)return false;return d==='LONG'?h.at(-1).price>h.at(-2).price&&l.at(-1).price>l.at(-2).price:h.at(-1).price<h.at(-2).price&&l.at(-1).price<l.at(-2).price}
function sig(c,d,v){const t=tl(c,d,v);if(!t)return null;const p=c.at(-1).close,near=Math.abs((p-t.price)/t.price)<.012,beyond=d==='LONG'?p>t.price*1.008:p<t.price*.992,cl=c.map(x=>x.close),e8=ema(cl,8).at(-1),e21=ema(cl,21).at(-1),aligned=d==='LONG'?p>e8&&p>e21:p<e8&&p<e21,s=stoch(cl),turn=d==='LONG'?s.k>s.d:s.k<s.d,ext=d==='LONG'?s.k<20:s.k>80,confirm=d==='LONG'?p>c.at(-1).open:p<c.at(-1).open,vol=c.at(-1).volume>avg(c.slice(-10).map(x=>x.volume))*1.3,raw=near&&ext?'ENTRY_1':near&&turn&&!ext?'ENTRY_2':beyond&&confirm&&aligned&&(vol||turn)?'ADD':null;if(!raw)return null;if(v===2&&(!f513(c,d))||v===3&&(!f513(c,d)||!struct(c,d))||v===6&&(!struct(c,d,5)))return null;const a=atr(c),entry=p,lo=Math.min(...c.slice(-10).map(x=>x.low)),hi=Math.max(...c.slice(-10).map(x=>x.high)),structural=d==='LONG'?Math.min(lo,entry-a*(raw==='ADD'?1.25:2)):Math.max(hi,entry+a*(raw==='ADD'?1.25:2));const stop=d==='LONG'?Math.max(Math.min(structural,entry*.992),entry*.965):Math.min(Math.max(structural,entry*1.008),entry*1.035),risk=Math.abs(entry-stop);return risk?{d,entry,stop,tp1:d==='LONG'?entry+risk:entry-risk,tp2:d==='LONG'?entry+1.5*risk:entry-1.5*risk,tp3:d==='LONG'?entry+2*risk:entry-2*risk,raw,risk}:null}
async function get(pair){const u=`https://api.kraken.com/0/public/OHLC?pair=${PAIRS[pair]}&interval=240&since=${Math.floor((START-30*86400000)/1000)}`;const j=await (await fetch(u)).json(),k=Object.keys(j.result).find(x=>x!=='last');return j.result[k].map(x=>({timestamp:x[0]*1000,open:+x[1],high:+x[2],low:+x[3],close:+x[4],volume:+x[6]})).filter(x=>x.timestamp>=START&&x.timestamp<=END)}
function run(c,v){let t=null,o={trades:0,wins:0,losses:0,netR:0,r1:0,r15:0,r2:0,slBeforeR1:0,dur:[],mae:[],mfe:[],dur24:0,dur48:0,byType:{ENTRY_1:0,ENTRY_2:0,ADD:0}};for(let i=40;i<c.length;i++){const x=c[i];if(t){const sign=t.d==='LONG'?1:-1;const fav=(x.high-t.entry)*sign,adv=(t.entry-x.low)*sign;t.mfe=Math.max(t.mfe,fav/t.risk);t.mae=Math.min(t.mae,-adv/t.risk);let done=false;
      // Stops are evaluated at the stop level active at the START of this candle. Target hits update stops only for the NEXT candle.
      const stopAtOpen=t.stop;
      const hitSL=sign>0?x.low<=stopAtOpen:x.high>=stopAtOpen;
      if(hitSL){
        if(t.stage===0){o.trades++;o.losses++;o.netR-=1;o.slBeforeR1++}
        else if(t.stage===1){o.trades++;o.wins++;o.netR+=0}
        else {o.trades++;o.wins++;o.netR+=.2}
        done=true;
      } else {
        const hitR1=!t.r1&&(sign>0?x.high>=t.tp1:x.low<=t.tp1);
        const hitR15=!t.r15&&(sign>0?x.high>=t.tp2:x.low<=t.tp2);
        const hitR2=!t.r2&&(sign>0?x.high>=t.tp3:x.low<=t.tp3);
        if(hitR1){t.r1=true;t.stage=1;o.r1++;o.netR+=.4;t.stop=t.entry}
        if(hitR15){t.r15=true;t.stage=2;o.r15++;o.netR+=.6;t.stop=t.d==='LONG'?t.entry+t.risk:t.entry-t.risk}
        if(hitR2){t.r2=true;o.r2++;o.trades++;o.wins++;o.netR+=.4;done=true}
      }
      if(done){o.dur.push((x.timestamp-t.ts)/3600000);o.mae.push(t.mae);o.mfe.push(t.mfe);if(o.dur.at(-1)>=24)o.dur24++;if(o.dur.at(-1)>=48)o.dur48++;t=null}
    }
    if(!t){const d=bias(c.slice(0,i+1));if(d){const s=sig(c.slice(0,i+1),d,v);if(s){t={...s,ts:x.timestamp,r1:false,r15:false,r2:false,stage:0,mae:0,mfe:0};o.byType[s.raw]++}}}
  }
  if(t){const z=c.at(-1),sign=t.d==='LONG'?1:-1,p=(z.close-t.entry)*sign/t.risk;o.trades++;if(p>=0)o.wins++;else o.losses++;o.netR+=p;o.dur.push((z.timestamp-t.ts)/3600000);o.mae.push(t.mae);o.mfe.push(t.mfe);if(o.dur.at(-1)>=24)o.dur24++;if(o.dur.at(-1)>=48)o.dur48++}
  return o}
const all={};for(const pair of Object.keys(PAIRS)){const c=await get(pair);all[pair]={candles:c.length,variants:{}};for(let v=1;v<=6;v++)all[pair].variants[v]=run(c,v)}
function summarize(v){let a={trades:0,wins:0,losses:0,netR:0,r1:0,r15:0,r2:0,slBeforeR1:0,dur:[],mae:[],mfe:[],dur24:0,dur48:0,byType:{ENTRY_1:0,ENTRY_2:0,ADD:0}};for(const p of Object.keys(all)){const x=all[p].variants[v];for(const k of ['trades','wins','losses','netR','r1','r15','r2','slBeforeR1','dur24','dur48'])a[k]+=x[k];a.dur.push(...x.dur);a.mae.push(...x.mae);a.mfe.push(...x.mfe);for(const k of Object.keys(a.byType))a.byType[k]+=x.byType[k]}return{trades:a.trades,wins:a.wins,losses:a.losses,winRate:+(100*a.wins/a.trades).toFixed(2),netR:+a.netR.toFixed(3),avgR:+(a.netR/a.trades).toFixed(3),avgDurationHours:+avg(a.dur).toFixed(2),medianDurationHours:+median(a.dur).toFixed(2),duration24Pct:+(100*a.dur24/(a.trades||1)).toFixed(2),duration48Pct:+(100*a.dur48/(a.trades||1)).toFixed(2),slBeforeR1Pct:+(100*a.slBeforeR1/(a.losses||1)).toFixed(2),r1Rate:+(100*a.r1/a.trades).toFixed(2),r15Rate:+(100*a.r15/a.trades).toFixed(2),r2Rate:+(100*a.r2/a.trades).toFixed(2),avgMAE_R:+avg(a.mae).toFixed(3),avgMFE_R:+avg(a.mfe).toFixed(3),maxMAE_R:+Math.min(...a.mae).toFixed(3),maxMFE_R:+Math.max(...a.mfe).toFixed(3),byType:a.byType}}
const names={1:'Current V28 / regression TL',2:'V28 + 4H 5/13 qualification',3:'V28 + 4H 5/13 + 4H structure',4:'Point-to-point pivot TL',5:'±5 structured pivots',6:'±5 structure regime + point-to-point TL'};
const summary={};for(let v=1;v<=6;v++)summary[v]={model:names[v],...summarize(v)};
console.log(JSON.stringify({period:{start:new Date(START).toISOString(),end:new Date(END).toISOString()},summary,byPair:all},null,2));
