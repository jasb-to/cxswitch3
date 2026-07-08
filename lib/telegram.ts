// lib/telegram.ts — Telegram Alert Dispatcher
// ============================================================

interface AlertPayload {
  symbol: string;
  direction: "LONG" | "SHORT";
  stage: string;
  confidence: number;
  entry: number;
  stop: number;
  target: number;
  rr: number;
  reason: string;
  id: string;
}

interface ExitAlertPayload {
  pair: string;
  direction: "LONG" | "SHORT";
  exitPrice: number;
  reason: string;
  pnl: number;
  id: string;
}

export async function sendAlert(payload: AlertPayload): Promise<void> {
  const botToken = process.env.TELEGRAM_BOT_TOKEN;
  const chatId = process.env.TELEGRAM_CHAT_ID;
  if (!botToken || !chatId) {
    console.log("[TELEGRAM] No credentials, skipping alert");
    return;
  }

  const emoji = payload.direction === "LONG" ? "🟢" : "🔴";
  const text = `${emoji} <b>${payload.symbol} ${payload.direction}</b>
📊 Confidence: ${payload.confidence}%
🎯 Entry: ${payload.entry}
🛑 Stop: ${payload.stop}
💰 Target: ${payload.target}
📈 R:R: ${payload.rr}
📝 ${payload.reason}
🆔 ${payload.id}`;

  try {
    await fetch(`https://api.telegram.org/bot${botToken}/sendMessage`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ chat_id: chatId, text, parse_mode: "HTML" }),
    });
  } catch (e) {
    console.error("[TELEGRAM] Send alert failed:", e);
    throw e;
  }
}

export async function sendExitAlert(payload: ExitAlertPayload): Promise<void> {
  const botToken = process.env.TELEGRAM_BOT_TOKEN;
  const chatId = process.env.TELEGRAM_CHAT_ID;
  if (!botToken || !chatId) {
    console.log("[TELEGRAM] No credentials, skipping exit alert");
    return;
  }

  const emoji = payload.pnl >= 0 ? "✅" : "❌";
  const text = `${emoji} <b>${payload.pair} ${payload.direction} EXIT</b>
💵 Exit: ${payload.exitPrice.toFixed(2)}
📉 PnL: ${payload.pnl.toFixed(2)}%
📝 Reason: ${payload.reason}
🆔 ${payload.id}`;

  try {
    await fetch(`https://api.telegram.org/bot${botToken}/sendMessage`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ chat_id: chatId, text, parse_mode: "HTML" }),
    });
  } catch (e) {
    console.error("[TELEGRAM] Send exit alert failed:", e);
    throw e;
  }
}
