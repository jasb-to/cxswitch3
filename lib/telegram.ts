// lib/telegram.ts — v50 Clean Alerts
// ============================================================

export async function sendAlert(signal: any) {
  const token = process.env.TELEGRAM_BOT_TOKEN;
  const chatId = process.env.TELEGRAM_CHAT_ID;

  if (!token || !chatId) {
    console.log("[TELEGRAM DISABLED]", signal.symbol, signal.state);
    return;
  }

  const isEntry = signal.state === "ENTRY";
  const isAdd = signal.state === "ADD";
  const isExit = signal.state === "EXIT";

  const emoji = isEntry ? "🟢" : isAdd ? "🔵" : isExit ? "🔴" : "📊";
  const label = isEntry ? "ENTRY" : isAdd ? "ADD" : isExit ? "EXIT" : "SETUP";
  const dirEmoji = signal.bias === "LONG" ? "📈" : "📉";

  const text = `
${emoji} CX SWITCH — ${label}

${dirEmoji} ${signal.symbol} — ${signal.bias}
Price: ${signal.price}

Trend: ${signal.trend || signal.bias}
Location: ${signal.location || "—"}
Trigger: ${signal.trigger || "—"}

Expected Move: ${signal.expectedMove ?? "-"}%

SL: ${signal.stopLoss ?? "-"}
TP: ${signal.takeProfit ?? "-"}
RR: ${signal.rr ?? "-"}

ADX: ${signal.adx ?? "-"}
RSI: ${signal.rsi ?? "-"}
StochK: ${signal.stochK ?? "-"}
StochD: ${signal.stochD ?? "-"}

${signal.reason}

Time: ${signal.updatedAt}
`;

  await fetch(`https://api.telegram.org/bot${token}/sendMessage`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      chat_id: chatId,
      text,
    }),
  });
}
