const TELEGRAM_TOKEN = process.env.TELEGRAM_BOT_TOKEN!;
const TELEGRAM_CHAT = process.env.TELEGRAM_CHAT_ID!;

export async function sendTelegramAlert(data: any) {
  const msg = `
📊 CX SWITCH ALERT

${data.symbol} — ${data.state}
Price: ${data.price}

Bias: ${data.bias}
Confidence: ${data.confidence}%

Expected Move: ${(data.expectedMove * 100).toFixed(2)}%

SL: ${data.stopLoss ?? "-"}
TP: ${data.takeProfit ?? "-"}

${new Date().toISOString()}
`;

  await fetch(
    `https://api.telegram.org/bot${TELEGRAM_TOKEN}/sendMessage`,
    {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        chat_id: TELEGRAM_CHAT,
        text: msg,
      }),
    }
  );
}
