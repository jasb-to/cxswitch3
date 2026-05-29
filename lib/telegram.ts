import { Signal } from "./strategy";

export async function sendTelegramAlert(signal: Signal) {
  const botToken = process.env.TELEGRAM_BOT_TOKEN;
  const chatId = process.env.TELEGRAM_CHAT_ID;

  if (!botToken || !chatId) {
    console.log("[TELEGRAM] Missing credentials - alert not sent");
    return false;
  }

  const emoji = signal.status === "LONG" ? "🟢" : signal.status === "SHORT" ? "🔴" : "⚪";
  const riskReward = signal.riskReward?.toFixed(2) || "—";

  const message = `${emoji} **${signal.symbol} ${signal.status}** — $${signal.price}

**Setup:** ${signal.reason}
**Confidence:** ${signal.confidence}%

**Entry:** $${signal.entry}
**Stop Loss:** $${signal.stopLoss}
**Take Profit:** $${signal.takeProfit}
**R:R Ratio:** ${riskReward}x

ADX: ${signal.adx.toFixed(1)} | Stoch K: ${signal.stochK}
⏰ ${new Date().toLocaleTimeString()}`;

  try {
    const url = `https://api.telegram.org/bot${botToken}/sendMessage`;
    const response = await fetch(url, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        chat_id: chatId,
        text: message,
        parse_mode: "Markdown",
      }),
    });

    if (!response.ok) {
      console.error(`[TELEGRAM] Failed to send: ${response.status}`);
      return false;
    }

    console.log(`[TELEGRAM] Alert sent for ${signal.symbol} ${signal.status}`);
    return true;
  } catch (err) {
    console.error(`[TELEGRAM] Error: ${err}`);
    return false;
  }
}

export async function sendTestAlert() {
  const botToken = process.env.TELEGRAM_BOT_TOKEN;
  const chatId = process.env.TELEGRAM_CHAT_ID;

  if (!botToken || !chatId) {
    console.log("[TELEGRAM] Missing credentials");
    return { success: false, message: "Telegram credentials not configured" };
  }

  const message = `✅ **CX Switch - Test Alert**

This is a test message to verify Telegram integration is working correctly.

⏰ ${new Date().toLocaleString()}`;

  try {
    const url = `https://api.telegram.org/bot${botToken}/sendMessage`;
    const response = await fetch(url, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        chat_id: chatId,
        text: message,
        parse_mode: "Markdown",
      }),
    });

    if (!response.ok) {
      console.error(`[TELEGRAM] Test failed: ${response.status}`);
      return { success: false, message: `Telegram API error: ${response.status}` };
    }

    console.log("[TELEGRAM] Test alert sent successfully");
    return { success: true, message: "Test alert sent to Telegram!" };
  } catch (err) {
    console.error(`[TELEGRAM] Test error: ${err}`);
    return { success: false, message: `Error sending test alert: ${err}` };
  }
}
