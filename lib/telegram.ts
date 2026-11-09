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
  if(type!=="ENTRY_1"&&type!=="ENTRY_2"&&type!=="ADD") throw new Error("Only ENTRY_1, ENTRY_2 and ADD alerts are permitted: "+String(type));

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
    `${emoji} CX SWITCH v${CXSWITCH_VERSION} — ${type==="ADD"?"ADD (Position Building)":type}`,
    ...(signal.testOnly===true?["🧪 TEST ONLY — NOT A TRADING SIGNAL",""]:[]),
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
  const body=await response.text().catch(()=>"");
  let payload:any=null;
  try{payload=JSON.parse(body);}catch{}
  if(!response.ok){
    throw new Error(`Telegram sendMessage failed (${response.status}): ${body.slice(0,300)}`);
  }
  if(!payload||typeof payload!=="object"){
    throw new Error("Telegram sendMessage returned invalid JSON; delivery status ambiguous");
  }
  if(payload.ok!==true){
    throw new Error(`Telegram sendMessage rejected by API (${response.status}): ${String(payload.description||"ok=false").slice(0,300)}`);
  }
  const messageId=Number(payload.result?.message_id);
  if(!Number.isSafeInteger(messageId)||messageId<=0){
    throw new Error("Telegram sendMessage response missing message_id; delivery status ambiguous");
  }
  console.log(`[TELEGRAM] accepted type=${type} message_id=${messageId}`);
  return {messageId};
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
  kind:"TRAIL"|"TRAIL_EXIT"|"RSI_EXTREME"|"1D_REVERSAL"|"4H_REVERSAL"|"4H_MOMENTUM_MISALIGNED"|"STOCH_EXTREME_OPPOSITE"|"STOP_HIT"|"TARGET_HIT"|"EXPIRED";
  reason?:string;
  stop?:number;
  price?:number;
}){
  const token=process.env.TELEGRAM_BOT_TOKEN,chatId=process.env.TELEGRAM_CHAT_ID;
  if(!token||!chatId)throw new Error("Telegram alerting is not configured: TELEGRAM_BOT_TOKEN/TELEGRAM_CHAT_ID missing");
  let text:string;
  // Exit copy is reason-driven. Never label a management exit as a stop hit
  // unless the recorded exit reason is exactly sl_hit.
  if(update.reason==="sl_hit"){
    text=`🛑 EXIT — ${update.pair} ${update.direction} hit stop at ${formatPrice(update.price)}`;
  }else if(update.reason==="4h_ema5_13_misaligned_unprofitable_exit"){
    text=`🛑 EXIT — ${update.pair} ${update.direction} closed at ${formatPrice(update.price)} (4H Momentum Misaligned)`;
  }else if(update.reason==="stoch_extreme_opposite_exit"){
    text=`🛑 EXIT — ${update.pair} ${update.direction} closed at ${formatPrice(update.price)} (StochRSI Opposite Extreme)`;
  }else if(update.kind==="EXPIRED"){
    text=`⌛ EXPIRED — ${update.pair} ${update.direction} signal expired or price moved beyond the V28 entry window.`;
  }else if(update.kind==="TARGET_HIT"){
    text=`🎯 TARGET HIT — ${update.pair} ${update.direction} reached ${formatPrice(update.price)}. Trade closed.`;
  }else if(update.kind==="TRAIL"){
    text=`CX — ${update.pair} ${update.direction}. Trail stop raised to ${formatPrice(update.stop)}.`;
  }else if(update.kind==="TRAIL_EXIT"){
    text=`🛑 EXIT — ${update.pair} ${update.direction} closed at ${formatPrice(update.price??update.stop)} (Chandelier Stop)`;
  }else if(update.kind==="RSI_EXTREME"){
    text=`🛑 EXIT — ${update.pair} ${update.direction} closed at ${formatPrice(update.price)} (4H RSI Extreme)`;
  }else if(update.kind==="1D_REVERSAL"){
    text=`🛑 EXIT — ${update.pair} ${update.direction} closed at ${formatPrice(update.price)} (1D EMA Reversal)`;
  }else if(update.kind==="4H_REVERSAL"){
    text=`🛑 EXIT — ${update.pair} ${update.direction} closed at ${formatPrice(update.price)} (4H Structural Exit)`;
  }else{
    text=`🛑 EXIT — ${update.pair} ${update.direction} closed at ${formatPrice(update.price)} (${update.reason||"Management Exit"})`;
  }
  const response=await fetch(`https://api.telegram.org/bot${token}/sendMessage`,{method:"POST",headers:{"Content-Type":"application/json"},body:JSON.stringify({chat_id:chatId,text})});
  if(!response.ok){
    const body=await response.text().catch(()=>"");
    throw new Error(`Telegram management alert failed (${response.status}): ${body.slice(0,300)}`);
  }
}
