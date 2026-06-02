export async function sendAlert(signal: any) {
  const token = process.env.TELEGRAM_BOT_TOKEN;
  const chatId = process.env.TELEGRAM_CHAT_ID;

  if (!token || !chatId) {
    console.log("[TELEGRAM DISABLED]", signal);
    return;
  }

  const text = `
📊 CX SWITCH ALERT

${signal.symbol} — ${signal.state}
Price: ${signal.price}

Bias: ${signal.bias}
Confidence: ${signal.confidence}%

Expected Move: ${signal.expectedMove}%

SL: ${signal.stopLoss ?? "-"}
TP: ${signal.takeProfit ?? "-"}
RR: ${signal.rr ?? "-"}

Time: ${signal.timestamp}
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
