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
  if(type!=="ENTRY_1"&&type!=="ENTRY_2") throw new Error("Unsupported alert type: "+String(type));

  const emoji=signal.signalEmoji||"📊";
  const dir=signal.bias==="LONG"?"📈":"📉";
  const entry=Number(signal.price??signal.entry);
  const tp1=Number(signal.takeProfit1??signal.tp1);
  const tp2=Number(signal.takeProfit2??signal.tp2);
  const expectedMove=Number.isFinite(entry)&&Number.isFinite(tp2)&&entry!==0
    ? Math.round((Math.abs(tp2-entry)/Math.abs(entry))*1000)/10
    : signal.expectedMove??"-";

  const jarvis=signal.jarvis;
  const jarvisLine=jarvis?.verdict
    ? `JARVIS: ${jarvis.verdict} · ${jarvis.reason||""}`
    : "JARVIS: —";

  const lines=[
    `${emoji} CX SWITCH v${CXSWITCH_VERSION} — ${type}`,"",
    `${dir} ${signal.symbol} — ${signal.bias}`,"",
    `${signal.signalClass==="REVERSAL"?"🔄 ":""}Entry: ${formatPrice(entry)}${signal.entryType ? ` · ${signal.entryType}` : ""}${signal.signalClass==="REVERSAL" ? " · 50% size" : ""}`,
    `SL: ${formatPrice(signal.stopLoss??signal.stop)}`,`Risk: ${signal.context?.stopCalc?.riskPct!=null ? signal.context.stopCalc.riskPct.toFixed(2)+"% ("+(signal.context.stopCalc.marginUsagePct?.toFixed(0)??"-")+"% of margin at 20x)" : "-"}`,`Liquidation: ${formatPrice(signal.context?.stopCalc?.liquidationPrice)}`,`Stop-to-liq buffer: ${signal.context?.stopCalc?.liquidationBufferPct!=null ? signal.context.stopCalc.liquidationBufferPct.toFixed(2)+"%" : "-"}`,signal.context?.stopCalc?.liquidationBufferPct!=null&&signal.context.stopCalc.liquidationBufferPct<1?"⚠️ TIGHT — reduce size":"",
    `TP1: ${formatPrice(tp1)}`,
    `TP2: ${formatPrice(tp2)}`,
    `RR (TP1): ${signal.rr??"-"}`,
    jarvisLine,
    `Expected Move: ${expectedMove}%`,
    signal.reason||""
  ].join("\n");

  if(Number.isFinite(tp1)&&Number.isFinite(tp2)&&tp1===tp2){
    throw new Error("Telegram alert refused: TP1 and TP2 are identical");
  }

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
    `Time: ${update.timestamp||new Date().toISOString()}`
  ].join("\n");
  const response=await fetch(`https://api.telegram.org/bot${token}/sendMessage`,{method:"POST",headers:{"Content-Type":"application/json"},body:JSON.stringify({chat_id:chatId,text:lines})});
  if(!response.ok){
    const body=await response.text().catch(()=>"");
    throw new Error(`Telegram JARVIS update failed (${response.status}): ${body.slice(0,300)}`);
  }
}


export async function sendManagementAlert(update:{
  pair:string;
  direction:"LONG"|"SHORT";
  kind:"TRAIL"|"1D_REVERSAL"|"4H_REVERSAL";
  stop?:number;
}){
  const token=process.env.TELEGRAM_BOT_TOKEN,chatId=process.env.TELEGRAM_CHAT_ID;
  if(!token||!chatId)throw new Error("Telegram alerting is not configured: TELEGRAM_BOT_TOKEN/TELEGRAM_CHAT_ID missing");
  const text=update.kind==="TRAIL"
    ? `CX — ${update.pair} ${update.direction}. Trail stop raised to ${formatPrice(update.stop)}.`
    : update.kind==="1D_REVERSAL"
      ? `CX — ${update.pair} ${update.direction}. 1D trend reversed. Exit now.`
      : `CX — ${update.pair} ${update.direction}. 4H trend reversed. Exit now.`;
  const response=await fetch(`https://api.telegram.org/bot${token}/sendMessage`,{method:"POST",headers:{"Content-Type":"application/json"},body:JSON.stringify({chat_id:chatId,text})});
  if(!response.ok){
    const body=await response.text().catch(()=>"");
    throw new Error(`Telegram management alert failed (${response.status}): ${body.slice(0,300)}`);
  }
}
