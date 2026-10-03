// lib/telegram.ts — canonical CXSwitch alerts
import { CXSWITCH_VERSION } from "./version";

const formatPrice=(value:any)=>{
  if(value===undefined||value===null||value==="-")return "-";
  const n=Number(value);
  if(!Number.isFinite(n))return String(value);
  if(Math.abs(n)>=1000)return n.toFixed(0);
  if(Math.abs(n)>=1)return n.toFixed(2);
  if(Math.abs(n)>=0.1)return n.toFixed(3);
  return n.toFixed(5);
};

export async function sendAlert(signal:any){
  const token=process.env.TELEGRAM_BOT_TOKEN,chatId=process.env.TELEGRAM_CHAT_ID;
  if(!token||!chatId)throw new Error("Telegram alerting is not configured: TELEGRAM_BOT_TOKEN/TELEGRAM_CHAT_ID missing");

  const type=signal.signalType||signal.state;
  if(type!=="ENTRY_1"&&type!=="ENTRY_2"&&type!=="ENTRY"){
    throw new Error("Unsupported alert type: "+String(type));
  }

  const emoji=signal.signalEmoji||(type==="ENTRY_1"?"🟢":type==="ENTRY_2"?"🟠":"📊");
  const labels:Record<string,string>={ENTRY_1:"ENTRY ①",ENTRY_2:"ENTRY ②",ENTRY:"ENTRY"};
  const label=labels[type]||type;
  const dir=signal.bias==="LONG"?"📈":"📉";
  const context=signal.context||{};
  const approach=context.trendlineApproach;
  const singleTarget=signal.takeProfit??signal.target??signal.takeProfit2;
  const tp1=signal.takeProfit1;
  const tp2=signal.takeProfit2??singleTarget;
  const displayTarget=type==="ENTRY_2"?singleTarget:tp2;
  const entry=Number(signal.price??signal.entry);
  const expectedMove=Number.isFinite(entry)&&Number.isFinite(Number(displayTarget))&&entry!==0
    ? Math.round((Math.abs(Number(displayTarget)-entry)/Math.abs(entry))*1000)/10
    : signal.expectedMove??"-";

  const jarvis=signal.jarvis;
  const jarvisLine=jarvis?.verdict
    ? `JARVIS: ${jarvis.verdict} · ${jarvis.summary||""}`
    : "";

  const setupLine=signal.trigger
    ? `Setup: ${signal.trigger}`
    : "";
  const approachLine=approach?.classification
    ? `Trendline: ${approach.classification} · Stoch K ${approach.stochDirection||"—"}${approach.rejectionCandles!==undefined?` · rejection wicks ${approach.rejectionCandles}`:""}`
    : "";
  const transitionLine=context.emaLabel4h
    ? `4H transition: ${context.emaLabel4h}`
    : "";
  const market=context.marketHealth;
  const marketLine=market
    ? `Market: BTC.D ${market.btcDominance??"—"} · USDT.D ${market.usdtDominance??"—"} · TOTAL ${market.totalMarketCapChange24h!=null?((market.totalMarketCapChange24h>=0?"+":"")+market.totalMarketCapChange24h.toFixed(2)+"%"):"—"} · ALT ${market.altContext||"—"}`
    : "";

  const lines=[
    `${emoji} CX SWITCH v${CXSWITCH_VERSION} — ${label}`,"",
    `${dir} ${signal.symbol} — ${signal.bias}`,"",
    `Price: ${formatPrice(signal.price??signal.entry)}`,"",
    jarvisLine,
    setupLine,
    transitionLine,
    approachLine,
    marketLine,
    `4H 5/13: ${signal.fourH513||"—"}`,"",
    `SL: ${formatPrice(signal.stopLoss)}`,
    ...(type==="ENTRY_2"
      ? [`TP: ${formatPrice(displayTarget)}`]
      : [`TP1: ${formatPrice(tp1)}`,`TP2: ${formatPrice(tp2)}`]),
    `RR: ${signal.rr??"-"}`,"",
    `Expected Move: ${expectedMove}%`,
    signal.reason||""
  ].filter((line,i,arr)=>line!==""||arr[i-1]!=="").join("\n");

  const response=await fetch(`https://api.telegram.org/bot${token}/sendMessage`,{method:"POST",headers:{"Content-Type":"application/json"},body:JSON.stringify({chat_id:chatId,text:lines})});
  if(!response.ok){
    const body=await response.text().catch(()=>"");
    throw new Error(`Telegram sendMessage failed (${response.status}): ${body.slice(0,300)}`);
  }
}

export async function sendJarvisUpdate(update:{
  portfolioState:string;
  location:string;
  changes:Array<{pair:string;decision:"STAY IN TRADE"|"EXIT TRADE";reason:string}>;
  summary:string;
  timestamp?:string;
} ){
  const token=process.env.TELEGRAM_BOT_TOKEN,chatId=process.env.TELEGRAM_CHAT_ID;
  if(!token||!chatId)throw new Error("Telegram alerting is not configured: TELEGRAM_BOT_TOKEN/TELEGRAM_CHAT_ID missing");
  const exit=update.changes.some(x=>x.decision==="EXIT TRADE");
  const decision=exit?"EXIT TRADE":"STAY IN TRADE";
  const emoji=exit?"🔴":"🟢";
  const lines=[
    `${emoji} JARVIS — ${decision}`,"",
    ...update.changes.map(x=>`${x.pair}: ${x.decision}${x.reason?" — "+x.reason:""}`),
    "",
    "JARVIS active-trade decision changed; portfolio/momentum diagnostics remain dashboard-only.",
    `Time: ${update.timestamp||new Date().toISOString()}`
  ].join("\n");
  const response=await fetch(`https://api.telegram.org/bot${token}/sendMessage`,{method:"POST",headers:{"Content-Type":"application/json"},body:JSON.stringify({chat_id:chatId,text:lines})});
  if(!response.ok){
    const body=await response.text().catch(()=>"");
    throw new Error(`Telegram JARVIS update failed (${response.status}): ${body.slice(0,300)}`);
  }
}
