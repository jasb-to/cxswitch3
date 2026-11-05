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
  if(type!=="ENTRY_1"&&type!=="ADD") throw new Error("Only ENTRY_1 and ADD alerts are permitted: "+String(type));

  const emoji=signal.signalEmoji||"📊";
  const dir=signal.bias==="LONG"?"📈":"📉";
  const entry=Number(signal.price??signal.entry);
  const rawTp1=Number(signal.takeProfit1??signal.tp1);
  const rawTp2=Number(signal.takeProfit2??signal.tp2);
  const singleTarget=Number.isFinite(rawTp1)&&Number.isFinite(rawTp2)&&rawTp1===rawTp2;
  const tp1=rawTp1;
  const tp2=rawTp2;
  const stop=Number(signal.stopLoss??signal.stop);
  const riskDistance=Number.isFinite(entry)&&Number.isFinite(stop)?Math.abs(entry-stop):0;
  const rrTp1=riskDistance>0&&Number.isFinite(Number(tp1))?Math.abs(Number(tp1)-entry)/riskDistance:null;
  const rrTp2=riskDistance>0&&Number.isFinite(Number(tp2))?Math.abs(Number(tp2)-entry)/riskDistance:null;

  const signalClass=signal.signalClass??signal.context?.signalClass;
  const sizeMultiplier=signal.sizeMultiplier??signal.context?.sizeMultiplier;
  const jarvis=signal.jarvis;

  const ctx=signal.context??{};
  const regimePct=Math.round(Number(ctx.regimeSizeMultiplier??1)*100);
  const entryPct=Math.round(Number(ctx.entrySizeMultiplier??1)*100);
  const riskPct=Math.round(Number(ctx.riskSizeMultiplier??1)*100);
  const sizePct=Math.round(Number(sizeMultiplier??1)*100);
  const riskAdjusted=Number(ctx.riskSizeMultiplier??1)<1;
  const sizeText=riskAdjusted
    ? `${sizePct}% (regime ${regimePct}% × entry ${entryPct}% × risk ${riskPct}%)`
    : sizePct===25 ? "25% (recent cross + low regime)"
    : sizePct===50 ? (ctx.entryCrossType==="recent"?"50% (recent cross)":ctx.entryCrossType==="fresh"?"50% (low regime)":signalClass==="REVERSAL"?"50% (counter-trend)":"50% (reduced size)")
    : `${sizePct}%`;
  const reasonText=signal.context?.entryCrossType==="recent"
    ? "Reason: recent 4H Stoch RSI cross ("+(signal.context?.crossAgeInCandles??"?")+" candles ago)"
    : signal.context?.entryCrossType==="fresh"
      ? "Reason: fresh 4H Stoch RSI cross"
      : type==="ENTRY_2"?"Reason: ENTRY_2 retest confirmed":"";
  const lines=[
    `${emoji} CX SWITCH v${CXSWITCH_VERSION} — ${type==="ADD"?"ADD (Position Building)":type}`,"",
    `${dir} ${signal.symbol} — ${signal.bias}`,
    `Entry: ${formatPrice(entry)} · MARKET`,
    `SL: ${formatPrice(stop)}`,
    singleTarget?`TP: ${formatPrice(tp1)}`:`TP1: ${formatPrice(tp1)}`,
    ...(singleTarget?[]:[`TP2: ${formatPrice(tp2)}`]),
    `RR${singleTarget?"":" (TP1)"}: ${rrTp1==null?"-":rrTp1.toFixed(2)+"R"}`,
    ...(singleTarget?[]:[`RR (TP2): ${rrTp2==null?"-":rrTp2.toFixed(2)+"R"}`]),
    `Size: ${sizeText}`,
    jarvis?.verdict ? `JARVIS: ${jarvis.verdict}` : "",
    reasonText
  ].filter(Boolean).join("\n");

  // V28 mirrors its single executable target into tp1 and tp2 for compatibility; display it once.

  const response=await fetch(`https://api.telegram.org/bot${token}/sendMessage`,{method:"POST",headers:{"Content-Type":"application/json"},body:JSON.stringify({chat_id:chatId,text:lines}),signal:AbortSignal.timeout(6000)});
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
  kind:"TRAIL"|"TRAIL_EXIT"|"RSI_EXTREME"|"1D_REVERSAL"|"4H_REVERSAL"|"STOP_HIT"|"TARGET_HIT"|"EXPIRED";
  stop?:number;
  price?:number;
}){
  const token=process.env.TELEGRAM_BOT_TOKEN,chatId=process.env.TELEGRAM_CHAT_ID;
  if(!token||!chatId)throw new Error("Telegram alerting is not configured: TELEGRAM_BOT_TOKEN/TELEGRAM_CHAT_ID missing");
  const text=update.kind==="EXPIRED"
    ? `⌛ EXPIRED — ${update.pair} ${update.direction} signal expired or price moved beyond the V28 entry window.`
    : update.kind==="STOP_HIT"
    ? `🛑 EXIT — ${update.pair} ${update.direction} hit stop at ${formatPrice(update.price)}.`
    : update.kind==="TARGET_HIT"
      ? `🎯 TARGET HIT — ${update.pair} ${update.direction} reached ${formatPrice(update.price)}. Trade closed.`
    : update.kind==="TRAIL"
    ? `CX — ${update.pair} ${update.direction}. Trail stop raised to ${formatPrice(update.stop)}.`
    : update.kind==="TRAIL_EXIT"
      ? `🛑 EXIT — ${update.pair} ${update.direction} hit stop at ${formatPrice(update.price??update.stop)} (Chandelier).`
      : update.kind==="RSI_EXTREME"
        ? `CX — ${update.pair} ${update.direction}. 4H RSI extreme confirmed on two closed candles. EXIT TRADE.`
        : update.kind==="1D_REVERSAL"
          ? `CX — ${update.pair} ${update.direction}. 1D EMA 5/13 reversal confirmed on two closed daily candles. EXIT TRADE.`
          : `🛑 EXIT — ${update.pair} ${update.direction} hit stop at ${formatPrice(update.price)} (4H structural exit).`;
  const response=await fetch(`https://api.telegram.org/bot${token}/sendMessage`,{method:"POST",headers:{"Content-Type":"application/json"},body:JSON.stringify({chat_id:chatId,text})});
  if(!response.ok){
    const body=await response.text().catch(()=>"");
    throw new Error(`Telegram management alert failed (${response.status}): ${body.slice(0,300)}`);
  }
}
