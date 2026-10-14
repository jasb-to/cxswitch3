// lib/telegram.ts — canonical CXSwitch alerts
import { CXSWITCH_VERSION } from "./version";

function formatPrice(value:any):string{
  if(value===undefined||value===null||value==="-")return "-";
  const n=Number(value);
  if(!Number.isFinite(n))return String(value);
  if(n>=1000)return n.toFixed(0);
  if(n>=100)return n.toFixed(1);
  if(n>=1)return n.toFixed(2);
  if(n>=0.1)return n.toFixed(3);
  if(n>=0.01)return n.toFixed(5); // Preserve five-decimal runtime prices such as DOGE.
  return n.toFixed(6);
}

export async function sendAlert(signal:any){
  const token=process.env.TELEGRAM_BOT_TOKEN,chatId=process.env.TELEGRAM_CHAT_ID;
  if(!token||!chatId)throw new Error("Telegram alerting is not configured: TELEGRAM_BOT_TOKEN/TELEGRAM_CHAT_ID missing");

  const type=signal.signalType||signal.state;
  if(type!=="ENTRY_1"&&type!=="ENTRY_2") throw new Error("Only ENTRY_1 and ENTRY_2 alerts are permitted: "+String(type));

  const emoji=signal.signalEmoji||"📊";
  const dir=signal.bias==="LONG"?"📈":"📉";
  const entry=Number(signal.price??signal.entry);
  const tp1=Number(signal.takeProfit1??signal.tp1);
  const tp2=Number(signal.takeProfit2??signal.tp2);
  const stop=Number(signal.stopLoss??signal.stop);
  const riskDistance=Number.isFinite(entry)&&Number.isFinite(stop)?Math.abs(entry-stop):0;
  const rrTp1=riskDistance>0&&Number.isFinite(tp1)?Math.abs(tp1-entry)/riskDistance:null;
  const rrTp2=riskDistance>0&&Number.isFinite(tp2)?Math.abs(tp2-entry)/riskDistance:null;

  const signalClass=signal.signalClass??signal.context?.signalClass;
  const sizeMultiplier=signal.sizeMultiplier??signal.context?.sizeMultiplier;
  const jarvis=signal.jarvis;

  const sizeText=Number(sizeMultiplier??1)===0.25?"25% (recent cross + low regime)":Number(sizeMultiplier??1)===0.5?(signal.context?.entryCrossType==="recent"?"50% (recent cross)":signal.context?.entryCrossType==="fresh"?"50% (low regime)":signalClass==="REVERSAL"?"50% (counter-trend)":"50% (reduced size)"):"100%";
  const reasonText=signal.context?.entryCrossType==="recent"
    ? "Reason: recent 4H Stoch RSI cross ("+(signal.context?.crossAgeInCandles??"?")+" candles ago)"
    : signal.context?.entryCrossType==="fresh"
      ? "Reason: fresh 4H Stoch RSI cross"
      : type==="ENTRY_2"?"Reason: ENTRY_2 retest confirmed":"";
  const lines=[
    `${emoji} CX SWITCH v${CXSWITCH_VERSION} — ${type}`,"",
    `${dir} ${signal.symbol} — ${signal.bias}`,
    `Entry: ${formatPrice(entry)} · MARKET`,
    `SL: ${formatPrice(stop)}`,
    `TP1: ${formatPrice(tp1)}`,
    `TP2: ${formatPrice(tp2)}`,
    `RR (TP1): ${rrTp1==null?"-":rrTp1.toFixed(2)+"R"}`,
    `RR (TP2): ${rrTp2==null?"-":rrTp2.toFixed(2)+"R"}`,
    `Size: ${sizeText}`,
    jarvis?.verdict ? `JARVIS: ${jarvis.verdict}` : "",
    reasonText
  ].filter(Boolean).join("\n");

  if(Number.isFinite(tp1)&&Number.isFinite(tp2)&&tp1===tp2){
    throw new Error(`Telegram alert refused: TP1 and TP2 are identical (${formatPrice(tp1)}).`);
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


export async function sendJarvisOpportunity(update:{
  pair:string;
  direction:"LONG"|"SHORT";
  strength:"DEVELOPING"|"CONFIRMED";
  reason:string;
  activePosition?: "LONG"|"SHORT";
  positionConflict?: boolean;
}){
  const token=process.env.TELEGRAM_BOT_TOKEN,chatId=process.env.TELEGRAM_CHAT_ID;
  if(!token||!chatId)throw new Error("Telegram alerting is not configured: TELEGRAM_BOT_TOKEN/TELEGRAM_CHAT_ID missing");
  const conflict=update.positionConflict===true && (update.activePosition==="LONG" || update.activePosition==="SHORT") && update.activePosition!==update.direction;
  const emoji=conflict?"⚠️":update.direction==="LONG"?"🟢":"🔴";
  const title=conflict
    ? "JARVIS — "+update.direction+" REVERSAL WATCH"
    : "JARVIS — "+update.direction+" OPPORTUNITY · "+update.strength;
  const positionLine=conflict
    ? "You’re currently "+update.activePosition+". This is moving against you — review the position."
    : update.activePosition
      ? "You’re already "+update.activePosition+". Jarvis is watching for continuation."
      : "No position. This is a watch signal, not an entry.";
  const lines=[
    emoji+" "+title,
    "",
    update.pair,
    update.reason,
    positionLine,
    "",
    "Jarvis is flagging the opportunity. The V28 engine still decides ENTRY_1 / ENTRY_2."
  ].join("\n");
  const response=await fetch("https://api.telegram.org/bot"+token+"/sendMessage",{method:"POST",headers:{"Content-Type":"application/json"},body:JSON.stringify({chat_id:chatId,text:lines})});
  if(!response.ok){
    const body=await response.text().catch(()=>"");
    throw new Error("Telegram JARVIS opportunity failed ("+response.status+"): "+body.slice(0,300));
  }
}

export async function sendManagementAlert(update:{
  pair:string;
  direction:"LONG"|"SHORT";
  kind:"TRAIL"|"TRAIL_EXIT"|"RSI_EXTREME"|"1D_REVERSAL"|"4H_REVERSAL";
  stop?:number;
}){
  const token=process.env.TELEGRAM_BOT_TOKEN,chatId=process.env.TELEGRAM_CHAT_ID;
  if(!token||!chatId)throw new Error("Telegram alerting is not configured: TELEGRAM_BOT_TOKEN/TELEGRAM_CHAT_ID missing");
  const text=update.kind==="TRAIL"
    ? `CX — ${update.pair} ${update.direction}. Trail stop raised to ${formatPrice(update.stop)}.`
    : update.kind==="TRAIL_EXIT"
      ? `CX — ${update.pair} ${update.direction}. Confirmed chandelier trailing-stop breach. EXIT TRADE.`
      : update.kind==="RSI_EXTREME"
        ? `CX — ${update.pair} ${update.direction}. 4H RSI extreme confirmed on two closed candles. EXIT TRADE.`
        : update.kind==="1D_REVERSAL"
          ? `CX — ${update.pair} ${update.direction}. 1D EMA 5/13 reversal confirmed on two closed daily candles. EXIT TRADE.`
          : `CX — ${update.pair} ${update.direction}. 4H EMA 8/21 reversal confirmed on two closed candles. EXIT TRADE.`;
  const response=await fetch(`https://api.telegram.org/bot${token}/sendMessage`,{method:"POST",headers:{"Content-Type":"application/json"},body:JSON.stringify({chat_id:chatId,text})});
  if(!response.ok){
    const body=await response.text().catch(()=>"");
    throw new Error(`Telegram management alert failed (${response.status}): ${body.slice(0,300)}`);
  }
}
