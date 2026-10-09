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
  if(type!=="ENTRY_1"&&type!=="ENTRY_2"&&type!=="REVERSAL_SHORT"&&type!=="REVERSAL_LONG") throw new Error("Unsupported alert type: "+String(type));

  const emoji=signal.signalEmoji||"📊";
  const dir=signal.bias==="LONG"?"📈":"📉";
  const entry=Number(signal.price??signal.entry);
  const tp1=Number(signal.takeProfit1??signal.tp1);
  const tp2=Number(signal.takeProfit2??signal.tp2);
  const expectedMove=Number.isFinite(entry)&&Number.isFinite(tp2)&&entry!==0
    ? Math.round((Math.abs(tp2-entry)/Math.abs(entry))*1000)/10
    : signal.expectedMove??"-";
  const stop=Number(signal.stopLoss??signal.stop);
  const riskDistance=Number.isFinite(entry)&&Number.isFinite(stop)?Math.abs(entry-stop):0;
  const rrTp1=riskDistance>0&&Number.isFinite(tp1)?Math.abs(tp1-entry)/riskDistance:null;
  const rrTp2=riskDistance>0&&Number.isFinite(tp2)?Math.abs(tp2-entry)/riskDistance:null;
  const bufferValue=signal.context?.stopToLiquidationBufferPct??signal.context?.stopCalc?.liquidationBufferPct;
  const buffer=bufferValue==null?null:Number(bufferValue);
  const bufferText=buffer!=null&&Number.isFinite(buffer)
    ? `${buffer.toFixed(2)}%${buffer<0?" ⚠️ STOP BEYOND MODELLED LIQUIDATION":buffer<0.5?" ⚠️ BELOW 0.50% MINIMUM BUFFER":""}`
    : "-";

  const signalClass=signal.signalClass??signal.context?.signalClass;
  const sizeMultiplier=signal.sizeMultiplier??signal.context?.sizeMultiplier;
  const jarvis=signal.jarvis;
  const jarvisLine=jarvis?.verdict
    ? `JARVIS: ${jarvis.verdict} · ${jarvis.reason||""}`
    : "JARVIS: —";

  const lines=[
    `${emoji} CX SWITCH v${CXSWITCH_VERSION} — ${type}`,"",
    `${dir} ${signal.symbol} — ${signal.bias}`,"",
    `Entry: ${formatPrice(entry)} · MARKET`,
    `SL: ${formatPrice(stop)}`,`Risk: ${riskDistance>0 ? riskDistance.toFixed(2)+" pts ("+(signal.context?.stopCalc?.riskPct?.toFixed(2)??"-")+"%)" : "-"}`,`Liquidation: ${formatPrice(signal.context?.liquidationPrice??signal.context?.stopCalc?.liquidationPrice)}`,`Stop-to-liq buffer: ${bufferText}`,
    `TP1: ${formatPrice(tp1)}`,
    `TP2: ${formatPrice(tp2)}`,
    `RR (TP1): ${rrTp1==null?"-":rrTp1.toFixed(2)+"R"}`,
    `RR (TP2): ${rrTp2==null?"-":rrTp2.toFixed(2)+"R"}`,
    `Size: ${sizeMultiplier===0.5 ? "50%"+(signalClass==="REVERSAL" ? " (counter-trend)" : buffer!=null&&Number.isFinite(buffer)&&buffer<0.5 ? " (⚠️ reduced size does NOT remove liquidation risk)" : " (risk-reduced sizing; liquidation risk remains)") : "100%"}`,
    jarvisLine,
    `Expected Move: ${expectedMove}%`,
    signal.reason||""
  ].join("\n");

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
