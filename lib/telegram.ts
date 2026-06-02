export async function sendAlert(signal: any) {
  const msg = `
📊 CX SWITCH ALERT

${signal.symbol} — ${signal.state}
Price: ${signal.price}

Bias: ${signal.bias}
Confidence: ${signal.confidence}%

Expected Move: ${signal.expectedMove}%

SL: ${signal.stopLoss ?? "-"}
TP: ${signal.takeProfit ?? "-"}
RR: ${signal.rr ?? "-"}

${signal.timestamp}
`;

  // replace with your bot
  await fetch(`https://api.telegram.org/botYOUR_TOKEN/sendMessage`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      chat_id: "YOUR_CHAT_ID",
      text: msg,
    }),
  });
}
