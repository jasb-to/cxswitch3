"use client";
import {useEffect,useState} from "react";
import {Clock3,Radio,RefreshCw,ShieldCheck,Copy,Check,LockKeyhole,Target,TrendingUp} from "lucide-react";

type Tone="bull"|"bear"|"neutral"|"warning";
interface Signal{ id:string;pair:string;direction:"LONG"|"SHORT";type:"ENTRY_1"|"ENTRY_2"|"REVERSAL_SHORT"|"REVERSAL_LONG";entry:number;signalClass?:"TREND"|"REVERSAL";sizeMultiplier?:0.25|0.5|1;stop:number;tp1?:number;tp2?:number;rr:number;timestamp:number;expectedMove:number;context?:any;status?:string;exitReason?:string;unrealizedPnlPct?:number;managementState?:"STAY"|"EXIT";managementRecommendation?:string;jarvisVerdict?:"GOOD"|"WARN"|"VETO";jarvisReason?:string; }
interface MomentumStatus{icon:"🟢"|"🟡"|"🟠"|"🔴";label:"STAY IN TRADE"|"EXIT TRADE";detail:string;}
interface Management{status:"healthy"|"warning"|"failed";managementState:"STAY"|"EXIT";recommendation:string;reason:string;newStop?:number;nextAction?:string;}
interface Alert extends Signal{status:string;momentumState?:"IN TRADE"|"OUT OF TRADE";validity:{state:string;reason:string};currentPrice:number;target?:number;ageMinutes?:number;slToEntryAt?:number;tp1HitAt?:number;tp2HitAt?:number;managementAdvice?:Management|null;momentumStatus?:MomentumStatus|null;}
interface Market{pair:string;price:number;trend:string;location:string;trigger:string;adx:number;rsi:number;stochK:number;stochD:number;trendlinePrice:number;distToTrendline:number|null;entry1Direction?:string;entry1Decision?:string;entry1TriggersLong?:number;entry1TriggersShort?:number;entry1StructuralLocation?:string;entry1LiveNearTL?:string;entry1LiveDistPct?:number|null;entry1PreBreak?:boolean;entry1ExecutionAllowed?:boolean;entry1MaxEntry?:number|null;entry1Chase?:boolean;entry1Exhaustion?:string;entry1ClosedRsi?:number;entry1Grade?:string|null;entry1TriggerThreshold?:number;entry1ExhaustionThreshold?:number;ema8_4h?:number;ema21_4h?:number;ema5_1d?:number;ema13_1d?:number;dailyClose?:number;dailyE21?:number;dailySpreadPct?:number;dailySpread3dPct?:number;dailySpreadDelta?:number;sizeMultiplier?:0|0.5|1;dailySlope?:number;regime?:"BULL_HIGH"|"BULL_MED"|"BULL_LOW"|"CHOP"|"BEAR_LOW"|"BEAR_MED"|"BEAR_HIGH";strategyStatus?:string;ema5_4h?:number;ema13_4h?:number;fourH513?:{stage:string;label:string;direction:string;spreadContracting?:boolean;ema5?:number;ema13?:number;spreadPct?:number;turning?:boolean;crossNow?:boolean};daily513?:{stage:string;label:string;direction:string};structureShift?:{structure:"LONG"|"SHORT"|"NEUTRAL";state:"HEALTHY"|"WEAKENING"|"SHIFT_CONFIRMED"|"WATCHING";protectedLevel:number|null;breakDistanceAtr:number|null;breakConfirmed:boolean;reason:string;};entry1Closed4hTimestamp?:number;entry1ClosedStochK?:number;entry1ClosedStochD?:number;entry1NearTL?:boolean;entry1ShortTurn?:boolean;entry1LongTrendlinePrice?:number;entry1ShortTrendlinePrice?:number;fourHTacticalDirection?:"BULL"|"BEAR"|"NEUTRAL";dailyDirection?:"BULL"|"BEAR"|"NEUTRAL"|"CHOP";dailyStrength?:"LOW"|"MED"|"HIGH"|"NEUTRAL";fourHDirection?:"BULL"|"BEAR"|"NEUTRAL";dailyLive?:{state?:string;candidateState?:string;direction?:string;fast513?:{direction?:string}};stochK1d?:number;stochD1d?:number;stochK1dPrev?:number;stochD1dPrev?:number;stochK4h?:number;stochD4h?:number;stochK4hPrev?:number;stochD4hPrev?:number;momentumState?:{signalId:string;direction:"LONG"|"SHORT";entry:number;currentPrice:number;pnlPct:number;managementState:"STAY"|"EXIT";reason:string;newStop:number|null;recommendation:string}|null;positionManagementState?:"STAY"|"EXIT";positionManagementRecommendation?:string;positionManagementReason?:string;jarvisState?:string;}
interface System{version?:number;lastCronRun:number;lastCronAgeMs:number|null;activePositions:number;latestAlerts?:number;historyEntries?:number;}
interface JarvisPair{pair:string;direction:"LONG"|"SHORT"|"NEUTRAL";verdict:"GOOD"|"WARN"|"VETO";reason:string;currentAnalysis?:string;opportunity?:{direction:"LONG"|"SHORT";strength:"DEVELOPING"|"CONFIRMED";reason:string};position?:{direction:string;entry:number;stop:number;tp1?:number;tp2?:number};updatedAt:number;}
interface Jarvis{portfolioState:"GOOD"|"WARN"|"VETO";whatChanged:string;pairs:Record<string,JarvisPair>;updatedAt:number;}
const PAIRS=["BTC","ETH","SOL","HYPE","LINK","VIRTUAL","DOGE","ZEC"];

const KRAKEN:Record<string,string>={BTC:"XBTUSD",ETH:"ETHUSD",SOL:"SOLUSD",HYPE:"HYPEUSD",LINK:"LINKUSD",VIRTUAL:"VIRTUALUSD",DOGE:"DOGEUSD",ZEC:"ZECUSD"};
const money=(n?:number)=>typeof n==="number"&&Number.isFinite(n)?new Intl.NumberFormat("en-US",{style:"currency",currency:"USD",maximumFractionDigits:n>=1000?0:n>=1?2:6}).format(n):"—";
const pct=(n?:number)=>typeof n==="number"&&Number.isFinite(n)?`${n>=0?"+":""}${n.toFixed(2)}%`:"—";
const ago=(ts?:number)=>{if(!ts)return"—";const m=Math.max(0,Math.floor((Date.now()-ts)/60000));if(m<1)return"just now";if(m<60)return`${m}m`;const h=Math.floor(m/60);return h<24?`${h}h ${m%60}m`:`${Math.floor(h/24)}d`};
async function price(pair:string){try{const r=await fetch(`https://api.kraken.com/0/public/Ticker?pair=${KRAKEN[pair]}`,{cache:"no-store"});const d=await r.json();if(d.error?.length)return null;return parseFloat(d.result[Object.keys(d.result)[0]].c[0])}catch{return null}}

function directionClass(d:string){return d==="LONG"||d.includes("BULLISH")||d.startsWith("BULL")?"text-green-400":d==="SHORT"||d.includes("BEARISH")||d.startsWith("BEAR")?"text-red-400":"text-white/45"}
function strengthFrom4H(e?:Market["fourH513"]){return e?.label??"—"}
function stoch4hStatus(m?:Market){if(typeof m?.stochK4h!=="number"||typeof m?.stochD4h!=="number")return"—";const bull=m.stochK4hPrev!=null&&m.stochD4hPrev!=null&&m.stochK4hPrev<=m.stochD4hPrev&&m.stochK4h>m.stochD4h;const bear=m.stochK4hPrev!=null&&m.stochD4hPrev!=null&&m.stochK4hPrev>=m.stochD4hPrev&&m.stochK4h<m.stochD4h;return m.stochK4h.toFixed(1)+" / "+m.stochD4h.toFixed(1)+" — "+(bull?"BULLISH CROSS":bear?"BEARISH CROSS":"WAITING")}
function formatStrategyStatus(value?:string,m?:Market){
  const raw=String(value||"WAIT — awaiting market data");
  const prefix=raw.startsWith("FIRED")?"FIRED":"WAIT";
  const payload=raw.replace(/^(?:WAIT|FIRED)\s*[—-]\s*/,"");
  let detail="";
  try{
    const d=JSON.parse(payload);
    const direction=typeof d.direction==="string"?d.direction:"—";
    const regime=typeof d.alignment?.regime==="string"?d.alignment.regime:(m?.regime||"—");
    const trigger=d.trigger?.entry1Reason;
    const triggerLabel=typeof trigger==="string"&&trigger.toLowerCase().includes("stoch")?"Fresh 4H Stoch RSI cross":d.trigger?.entry1?"Entry 1 detected":"Entry conditions pending";
    if(prefix==="FIRED")return [raw.split(/\s*[—-]\s*/)[0]+" — "+(d.trigger?.signalType||"signal"),direction+" · "+regime+" · Signal generated"].join("\n");
    detail=[direction,regime,triggerLabel].filter(Boolean).join(" · ");
    return ["WAIT — setup not confirmed",detail].join("\n");
  }catch{
    const compact=payload.length>72?payload.slice(0,69)+"…":payload;
    if(prefix==="FIRED")return [raw.split(/\s*[—-]\s*/)[0],m?.regime?m.regime+" · Signal generated":"Signal generated"].join("\n");
    return [compact?("WAIT — "+compact):"WAIT — awaiting market data",m?.regime?m.regime+" · Monitoring setup":"Monitoring setup"].join("\n");
  }
}

function copyText(text:string){if(typeof navigator!=="undefined"&&navigator.clipboard?.writeText)return navigator.clipboard.writeText(text);const t=document.createElement("textarea");t.value=text;document.body.appendChild(t);t.select();document.execCommand("copy");t.remove();return Promise.resolve()}
function cardText(pair:string,p:number,m?:Market,a?:Alert){const mg=a?.managementAdvice,isActive=a?.status==="ACTIVE";const managementDecision=isActive?(mg?.recommendation==="EXIT TRADE"||m?.positionManagementRecommendation==="EXIT TRADE"||m?.positionManagementState==="EXIT"?"EXIT TRADE":"STAY IN TRADE"):null;const dailyState=m?.dailyLive?.state||m?.trend||"—";const dailyDirection=m?.dailyLive?.direction||(m?.dailyDirection==="BULL"?"LONG":m?.dailyDirection==="BEAR"?"SHORT":dailyState.startsWith("LONG")?"LONG":dailyState.startsWith("SHORT")?"SHORT":"—");const fourH513=strengthFrom4H(m?.fourH513);const ema821=typeof m?.ema8_4h==="number"&&typeof m?.ema21_4h==="number"?(m.ema8_4h>=m.ema21_4h?"LONG":"SHORT"):"—";const momentumLabel=isActive?(managementDecision==="EXIT TRADE"?"EXIT NOW":"IN TRADE"):"OUT OF TRADE";return [pair+"/USD "+money(p),"1D Direction: "+dailyDirection,"State: "+(isActive?"ACTIVE POSITION · "+managementDecision:(a?.validity?.state||a?.status||"WAITING")),"1D state: "+dailyState,"4H 5/13: "+fourH513+(m?.fourH513?.label?" ("+m.fourH513.label+")":""),"4H 8/21: "+ema821,isActive?"Active position: "+a.direction+" "+a.type+" · "+managementDecision:a?"Latest alert: "+a.direction+" "+a.type+" · "+a.status:"Alert: none",a?"Entry "+money(a.entry)+" · MARKET · SL "+money(a.stop)+" · TP1 "+money(a.tp1)+" · TP2 "+money(a.tp2??a.target)+" · R:R "+(a.rr?.toFixed(2)||"—"):"","Momentum: "+momentumLabel,isActive&&momentumLabel==="IN TRADE"?"ACTIVE POSITION · MANAGEMENT SAYS STAY":isActive&&momentumLabel==="EXIT NOW"?"ACTIVE POSITION · MANAGEMENT SAYS EXIT NOW":"NO ACTIVE POSITION",isActive&&mg?"Management: "+mg.recommendation+" — "+mg.reason:""].filter(Boolean).join("\n")}
function logClass(line:string,index:number){if(line.startsWith("[MANAGEMENT]"))return"border-l-red-400/70 bg-red-500/[0.045]";if(line.startsWith("[VALIDITY]"))return"border-l-yellow-400/70 bg-yellow-500/[0.035]";if(line.startsWith("[ALERT]"))return"border-l-green-400/70 bg-green-500/[0.035]";if(line.startsWith("[PAIR]"))return"border-l-blue-400/70 bg-blue-500/[0.035]";if(line.startsWith("[SYSTEM]"))return"border-l-orange-400/70 bg-orange-500/[0.035]";if(line.startsWith("[CRON]"))return index%2===0?"border-l-cyan-400/70 bg-cyan-500/[0.035]":"border-l-violet-400/70 bg-violet-500/[0.035]";return"border-l-white/20 bg-white/[0.015]"}
function JarvisCard({m,a,j,isActive}:{m?:Market;a?:Alert;j?:JarvisPair;isActive:boolean}){
 const verdict=j?.verdict||a?.jarvisVerdict||"GOOD";
 const reason=j?.reason||a?.jarvisReason||"No active Jarvis warning";
 const tone=verdict==="VETO"?"red":verdict==="GOOD"?"green":"warning";
 const border=tone==="green"?"border-green-500/20 bg-green-500/[0.035]":tone==="red"?"border-red-500/20 bg-red-500/[0.045]":"border-yellow-500/20 bg-yellow-500/[0.04]";
 const text=tone==="green"?"text-green-400":tone==="red"?"text-red-400":"text-yellow-300";
 const management=isActive?(m?.positionManagementRecommendation==="EXIT TRADE"||m?.positionManagementState==="EXIT"?"EXIT TRADE":"STAY IN TRADE"):null;
 return <div className={"mt-3 rounded-xl border p-3 "+border}>
  <div className="flex items-center justify-between gap-2"><div className="text-[8px] uppercase tracking-widest text-white/25">JARVIS: {verdict}</div></div>
  <div className={`mt-2 text-[9px] leading-4 ${m?.dailyDirection==="BULL"?"text-green-300":m?.dailyDirection==="BEAR"?"text-red-300":"text-white/60"}`}>{m?.jarvisState??"—"}</div>
  {j?.currentAnalysis&&<div className="mt-1 text-[8px] leading-4 text-white/30">{j.currentAnalysis}</div>}
  {management&&<div className="mt-2 text-[8px] uppercase tracking-wider text-white/30">Management: {management}</div>}
 </div>
}
export default function Dashboard(){
 const[market,setMarket]=useState<Record<string,Market>>({}),[active,setActive]=useState<Record<string,Alert>>({}),[latest,setLatest]=useState<Record<string,Alert>>({}),[history,setHistory]=useState<Signal[]>([]),[logs,setLogs]=useState<string[]>([]),[prices,setPrices]=useState<Record<string,number>>({}),[system,setSystem]=useState<System|null>(null),[loading,setLoading]=useState(true),[lastFetch,setLastFetch]=useState(0),[resetting,setResetting]=useState<string|null>(null),[copied,setCopied]=useState<string|null>(null),[jarvis,setJarvis]=useState<Jarvis|null>(null),[showDetails,setShowDetails]=useState<Record<string,boolean>>({});
 async function load(){try{const r=await fetch("/api/signals",{cache:"no-store"});const d=await r.json();const m:Record<string,Market>={};for(const x of d.marketData||[])if(x?.pair){m[x.pair]=x;if(x.dailyDirection===undefined)console.warn("[dashboard] dailyDirection missing from market snapshot",x);if(x.fourHDirection===undefined)console.warn("[dashboard] fourHDirection missing from market snapshot",x);if(x.jarvisState===undefined)console.warn("[dashboard] jarvisState missing from market snapshot",x)}const a:Record<string,Alert>={};for(const x of d.activeSignals||[])if(x?.pair)a[x.pair]=x;setMarket(m);setActive(a);setLatest(d.latestAlerts||{});setHistory(d.signalHistory||[]);setLogs(d.logs||[]);setSystem(d.system||null);try{const jr=await fetch("/api/jarvis",{cache:"no-store"});const jd=await jr.json();setJarvis(jd.data||null)}catch{}setLastFetch(Date.now())}catch(e){console.error("CXSwitch load failed",e)}finally{setLoading(false)}}
 async function reset(pair:string){if(resetting)return;setResetting(pair);try{await fetch("/api/symbol-reset",{method:"POST",headers:{"Content-Type":"application/json"},body:JSON.stringify({pair})});await load()}finally{setResetting(null)}}
 async function copy(id:string,text:string){try{await copyText(text);setCopied(id);setTimeout(()=>setCopied(null),1500)}catch(e){console.error("copy failed",e)}}
 useEffect(()=>{load();const i=setInterval(load,30000);return()=>clearInterval(i)},[]);
 useEffect(()=>{async function lp(){const n:Record<string,number>={};await Promise.all(PAIRS.map(async p=>{const x=await price(p);if(x)n[p]=x}));setPrices(n)}lp();const i=setInterval(lp,10000);return()=>clearInterval(i)},[]);
 if(loading)return <main className="min-h-screen bg-[#070707] text-white flex items-center justify-center"><span className="text-sm text-white/35">Loading CXSwitch…</span></main>;
 return <main className="min-h-screen bg-[#070707] text-white select-text" style={{WebkitUserSelect:"text",userSelect:"text",WebkitTouchCallout:"default"}}>
  <nav className="border-b border-white/[0.08]"><div className="mx-auto max-w-7xl px-5 py-4 flex items-center justify-between"><div className="flex items-center gap-3"><div className="h-9 w-9 rounded-lg bg-[#dc6b27] text-black flex items-center justify-center font-black">CX</div><div><div className="text-sm font-bold tracking-[0.18em]">CXSWITCH</div><div className="text-[9px] text-white/20 uppercase tracking-widest">directional trading console</div></div></div><div className="flex gap-2 text-[9px]"><Badge icon={<Radio size={11}/>} text="LIVE · 10s"/><Badge icon={<Clock3 size={11}/>} text={`CRON ${system?.lastCronRun?ago(system.lastCronRun):"—"}`}/></div></div></nav>
  <section className="mx-auto max-w-7xl px-5 py-6"><div className="flex justify-between items-end mb-4"><div><div className="text-[9px] uppercase tracking-[0.18em] text-white/25">Market board</div><h1 className="mt-1 text-lg font-semibold">directional strategy · current state</h1></div><div className="text-[9px] text-white/20">Updated {lastFetch?new Date(lastFetch).toLocaleTimeString():"—"}</div></div>
   <div className="grid grid-cols-2 gap-px overflow-hidden rounded-2xl border border-white/[0.08] bg-white/[0.08] md:grid-cols-4">{PAIRS.map(pair=>{const m=market[pair],a=active[pair]||latest[pair],j=jarvis?.pairs?.[pair],isActive=!!active[pair],p=prices[pair]??m?.price??a?.currentPrice??a?.entry??0,mg=a?.managementAdvice;const dailyDirection=m?.dailyDirection??undefined;const direction=dailyDirection==="BEAR"?"SHORT":dailyDirection==="BULL"?"LONG":dailyDirection==="NEUTRAL"?"NEUTRAL":"—";const pnlPct=a?((p-a.entry)/a.entry*100)*(a.direction==="LONG"?1:-1):null;const cardId=`card-${pair}`;
    const regime=m?.regime??"—";
    const regimeTone=regime.startsWith("BULL")?"text-green-400":regime.startsWith("BEAR")?"text-red-400":"text-white/65";
    const regimeBadge=regime.startsWith("BULL")?"border-green-500/30 bg-green-500/10":regime.startsWith("BEAR")?"border-red-500/30 bg-red-500/10":"border-white/10 bg-white/[0.04]";
    const sizePct=Math.round((m?.sizeMultiplier??0)*100);
    const status=String(m?.strategyStatus??"").trim()||"WAIT — no setup";
    const statusUpper=status.toUpperCase();
    const statusTone=statusUpper.startsWith("FIRED")?"text-green-300":statusUpper.startsWith("READY")?"text-yellow-300":statusUpper.startsWith("VETO")||statusUpper.startsWith("INVALID")?"text-red-300":"text-white/55";
    const closedK=m?.entry1ClosedStochK??m?.stochK4h;
    const closedD=m?.entry1ClosedStochD??m?.stochD4h;
    const stochState=typeof closedK!=="number"||typeof closedD!=="number"?"WAITING":closedK>closedD?"BULLISH CROSS":closedK<closedD?"BEARISH CROSS":"WAITING";
    const strategyDirection=String(m?.entry1Direction??m?.entry1Decision??status).toUpperCase();
    const staleNote=status.toLowerCase().includes("cross_too_old")?(strategyDirection.includes("SHORT")&&typeof closedK==="number"&&closedK>75?" (K too high for entry)":strategyDirection.includes("LONG")&&typeof closedK==="number"&&closedK<25?" (K too low for entry)":""):"";
    const stochTone=stochState==="BULLISH CROSS"?"text-green-300":stochState==="BEARISH CROSS"?"text-red-300":"text-white/45";
    const trendlineNote=m?.trendlinePrice!=null&&m?.distToTrendline!=null?` · TL ${m.distToTrendline.toFixed(1)}%`:"";
    const verdict=j?.verdict??a?.jarvisVerdict??"GOOD";
    const verdictTone=verdict==="GOOD"?"text-green-300 border-green-500/25 bg-green-500/10":verdict==="VETO"?"text-red-300 border-red-500/25 bg-red-500/10":"text-yellow-300 border-yellow-500/25 bg-yellow-500/10";
    const isDetails=!!showDetails[pair];
    const alertSent=!!a;
    const momentum=m?.momentumState;
    return <article key={pair} className="bg-[#0b0b0b] p-2.5 sm:p-3 min-w-0 flex flex-col gap-1.5 select-text" style={{WebkitUserSelect:"text",userSelect:"text"}}>
      <div className="flex items-center justify-between gap-1 min-w-0">
        <div className="flex items-baseline gap-1.5 min-w-0"><span className={`rounded px-1.5 py-0.5 text-[9px] font-black tracking-wide ${regimeBadge} ${regimeTone}`}>{pair}/USD</span><span className="text-[13px] sm:text-base font-semibold truncate">{money(p)}</span></div>
        <div className={`text-[8px] sm:text-[9px] font-black text-right whitespace-nowrap ${regimeTone}`}>{regime} · {sizePct}% size</div>
      </div>
      <div className="min-w-0 flex items-start gap-1 text-[9px] leading-4"><span className="shrink-0 text-white/30 font-bold tracking-wide">STATUS</span><span className={`min-w-0 break-words ${statusTone}`}>{status}{trendlineNote}</span></div>
      <div className="min-w-0 flex items-start gap-1 text-[9px] leading-4"><span className="shrink-0 text-white/30 font-bold tracking-wide">STOCH</span><span className={`min-w-0 break-words ${stochTone}`}>{typeof closedK==="number"&&typeof closedD==="number"?`${closedK.toFixed(1)} / ${closedD.toFixed(1)}`:"— / —"} — {stochState}{staleNote}</span></div>
      <div className="flex items-center justify-between gap-2 text-[9px] leading-4"><span className="text-white/30 font-bold tracking-wide">JARVIS</span><span className={`rounded border px-2 py-0.5 font-black tracking-wider ${verdictTone}`}>{verdict}</span><button type="button" onClick={()=>setShowDetails(v=>({...v,[pair]:!v[pair]}))} className="ml-auto text-[8px] uppercase tracking-wider text-white/35 hover:text-white/75">{isDetails?"Hide Details":"Show Details"}</button></div>
      {alertSent&&<div className="mt-1 rounded-md border border-white/[0.08] bg-white/[0.025] px-2 py-1.5">
        <div className={`text-[8px] font-black tracking-wide ${a.direction==="LONG"?"text-green-300":"text-red-300"}`}>{isActive?"ACTIVE TRADE":"ALERT SENT"} · {a.direction} {a.type} · ENTRY {money(a.entry)} · SL {money(a.stop)} · TP1 {money(a.tp1)} · TP2 {money(a.tp2??a.target)}</div>
        {momentum&&<div className="mt-1 text-[8px] text-white/55">4H MOMENTUM · {momentum.managementState==="STAY"?"STAY IN TRADE":"EXIT TRADE"} · {momentum.direction} · P/L {pct(momentum.pnlPct)} · {momentum.reason}</div>}
        {isActive&&mg&&<div className="mt-1 text-[8px] text-white/45">{mg.recommendation} — {mg.reason}{mg.nextAction?` · ${mg.nextAction}`:""}</div>}
      </div>}
      {isDetails&&<div className="mt-1 rounded-md border border-white/[0.07] bg-black/30 p-2 space-y-1 text-[8px] text-white/45">
        <div>1D CLOSE / EMA21 · {m?.dailyClose!=null&&m?.dailyE21!=null?`${money(m.dailyClose)} / ${money(m.dailyE21)}`:"—"}</div>
        <div>1D EMA 5/13 · {m?.ema5_1d!=null&&m?.ema13_1d!=null?`${money(m.ema5_1d)} / ${money(m.ema13_1d)}`:"—"}</div>
        <div>4H EMA 5/13 · {m?.ema5_4h!=null&&m?.ema13_4h!=null?`${money(m.ema5_4h)} / ${money(m.ema13_4h)}`:"—"}</div>
        <div>4H EMA 8/21 · {m?.ema8_4h!=null&&m?.ema21_4h!=null?`${money(m.ema8_4h)} / ${money(m.ema21_4h)}`:"—"}</div>
        <div>1D STOCH RSI · {typeof m?.stochK1d==="number"&&typeof m?.stochD1d==="number"?`K ${m.stochK1d.toFixed(1)} / D ${m.stochD1d.toFixed(1)}`:"—"}</div>
        <div>JARVIS STATE · {m?.jarvisState??j?.currentAnalysis??j?.reason??"—"}</div>
        <div>JARVIS REASON · {j?.reason??a?.jarvisReason??"—"}</div>
        <div>4H 5/13 · {m?.fourH513?.label??"—"} · 4H DIRECTION · {m?.fourHDirection??"—"} · 1D DIRECTION · {m?.dailyDirection??"—"}</div>
        <div>STRUCTURE · {m?.structureShift?.reason??"—"}</div>
        <div>STRATEGY STATUS · {status}</div>
        <div>TRENDLINE · {m?.trendlinePrice!=null?money(m.trendlinePrice):"—"} · DISTANCE · {m?.distToTrendline!=null?`${m.distToTrendline.toFixed(2)}%`:"—"}</div>
      </div>}
    </article>})}</div></section>

  <section className="mx-auto max-w-7xl px-5 pb-6"><div className="rounded-2xl border border-white/[0.08] bg-[#0b0b0b] p-4"><div className="flex items-center justify-between"><div><div className="text-[9px] uppercase tracking-[0.18em] text-white/25">Cron / signal log</div><div className="mt-1 text-sm font-semibold">Latest system activity</div></div><div className="flex items-center gap-2"><div className="text-[8px] text-white/25">{logs.length} lines</div><button type="button" onClick={()=>copy("logs",logs.join("\n"))} className="inline-flex items-center gap-1 rounded-md border border-white/[0.08] px-2 py-1 text-[8px] uppercase tracking-wider text-white/45">{copied==="logs"?<Check size={10}/>:<Copy size={10}/>} {copied==="logs"?"COPIED":"COPY LOG"}</button></div></div><div className="mt-3 max-h-[420px] overflow-auto rounded-xl border border-white/[0.06] bg-black/30 p-2 select-text" style={{WebkitUserSelect:"text",userSelect:"text"}}>{logs.length?logs.map((line,i)=><div key={`${i}-${line}`} className={`border-l-2 px-3 py-2 text-[9px] leading-5 text-white/55 font-mono mb-1 rounded-r-md select-text ${logClass(line,i)}`} style={{WebkitUserSelect:"text",userSelect:"text"}}>{line}</div>):<div className="p-3 text-[9px] text-white/30">No cron or signal log recorded.</div>}</div></div></section>

  <section className="mx-auto max-w-7xl px-5 pb-6"><div className="rounded-2xl border border-white/[0.08] bg-[#0b0b0b] p-4"><div className="flex items-center justify-between"><div><div className="text-[9px] uppercase tracking-[0.18em] text-white/25">Signal history</div><div className="mt-1 text-sm font-semibold">Trade history</div></div><div className="text-[8px] text-white/25">{history.length} records</div></div><div className="mt-3 overflow-x-auto select-text" style={{WebkitUserSelect:"text",userSelect:"text"}}><table className="w-full text-left text-[9px]"><thead><tr className="border-b border-white/[0.07] text-white/25"><th className="py-2 pr-3">Time</th><th className="py-2 pr-3">Pair</th><th className="py-2 pr-3">Direction</th><th className="py-2 pr-3">Type</th><th className="py-2 pr-3">Entry</th><th className="py-2 pr-3">SL</th><th className="py-2 pr-3">TP</th><th className="py-2 pr-3">Status</th></tr></thead><tbody>{history.slice().sort((a,b)=>b.timestamp-a.timestamp).slice(0,50).map((h,i)=><tr key={`${h.id||h.pair}-${h.timestamp}-${i}`} className="border-b border-white/[0.04] text-white/55"><td className="py-2 pr-3 whitespace-nowrap">{new Date(h.timestamp).toLocaleString()}</td><td className="py-2 pr-3 font-semibold text-white/70">{h.pair}</td><td className={`py-2 pr-3 font-bold ${h.direction==="LONG"?"text-green-400":"text-red-400"}`}>{h.direction}</td><td className="py-2 pr-3">{h.type}</td><td className="py-2 pr-3">{money(h.entry)}</td><td className="py-2 pr-3 text-red-300">{money(h.stop)}</td><td className="py-2 pr-3 text-green-300">{money(h.tp2??h.tp1)}</td><td className="py-2 pr-3">{h.status||"—"}</td></tr>)}</tbody></table></div></div></section>

  <section className="mx-auto max-w-7xl px-5 pb-8"><div className="rounded-2xl border border-white/[0.08] bg-[#0b0b0b] p-4 text-[9px] leading-5 text-white/40"><div className="text-[8px] uppercase tracking-widest text-white/20">How to read the board</div><div className="mt-2">Green = LONG / bullish. Red = SHORT / bearish. LOW = developing or weakening. MEDIUM = established. STRONG = strong directional trend. State of Play tells you where the setup or active trade is in its lifecycle. Trade Management tells you whether the trade is still valid and exactly when the next stop/target action is due.</div></div></section>

 </main>
}

function TradeManagementGuide({management}:{management:Management}){
  const exit=management.managementState==="EXIT";
  return <div className={`mt-2 rounded-lg border p-2.5 ${exit?"border-red-500/25 bg-red-500/[0.06]":"border-green-500/20 bg-green-500/[0.035]"}`}>
    <div className="text-[7px] uppercase tracking-widest text-white/25">TRADE MANAGEMENT GUIDE</div>
    <div className={`mt-1 text-[9px] font-black ${exit?"text-red-300":"text-green-300"}`}>{management.recommendation}</div>
    <div className="mt-1 text-[8px] leading-4 text-white/55">{management.reason}</div>
    {management.nextAction&&<div className="mt-2 rounded-md bg-black/30 px-2 py-1.5 text-[8px] font-bold uppercase tracking-wide text-white/70">NEXT ACTION · {management.nextAction}</div>}
    {management.newStop!==undefined&&<div className="mt-1 text-[8px] text-white/35">Suggested SL · {money(management.newStop)}</div>}
  </div>;
}
function Badge({icon,text}:{icon:React.ReactNode;text:string}){return <div className="inline-flex items-center gap-1.5 rounded-md border border-white/[0.07] bg-white/[0.02] px-2 py-1 text-white/35">{icon}{text}</div>}
function KV({l,v,tone}:{l:string;v:string;tone?:"red"|"green"}){const t=tone||( /BULL|BULLISH|LONG/i.test(v)?"green":/BEAR|BEARISH|SHORT/i.test(v)?"red":undefined);return <div><div className="text-[7px] uppercase tracking-widest text-white/20">{l}</div><div className={`mt-0.5 text-[9px] font-semibold whitespace-pre-line break-words ${t==="red"?"text-red-300":t==="green"?"text-green-300":"text-white/60"}`}>{v}</div></div>}
function TrendKV({label,value,fourH}:{label:string;value:string;fourH?:Market["fourH513"]}){const red=value.startsWith("SHORT")||value.includes("BEARISH")||value.startsWith("BEAR_")||value.includes("BEAR_DEVELOPING")||value.includes("BEAR_CONFIRMED"),green=value.startsWith("LONG")||value.includes("BULLISH")||value.startsWith("BULL_");return <div><div className="text-[7px] uppercase tracking-widest text-white/20">{label}</div><div className={`mt-0.5 text-[9px] font-bold ${red?"text-red-400":green?"text-green-400":"text-white/55"}`}>{value}</div>{fourH?.label&&<div className="mt-0.5 text-[7px] text-white/25">{fourH.label}</div>}</div>}