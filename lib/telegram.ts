import { Signal } from "./strategy";

export async function sendTelegramAlert(signal: Signal) {
  const botToken = process.env.TELEGRAM_BOT_TOKEN;
  const chatId = process.env.TELEGRAM_CHAT_ID;

  if (!botToken || !chatId) {
    console.log("[TELEGRAM] Missing credentials - alert not sent");
    return false;
  }

  // Handle both old and new Signal formats
  const state = signal.state || "UNKNOWN";
  const stochD = signal.stochD || signal.stochK || 0;
  
  const isLong = state === "LONG";
  const isShort = state === "SHORT";
  const emoji = isLong ? "🟢" : isShort ? "🔴" : "⚪";
  const stateText = state.toUpperCase();

  const message = `${emoji} **${signal.symbol} ${stateText}** — $${signal.price.toFixed(2)}

**Bias:** ${signal.bias || "—"}
**Setup:** ${signal.reason}
**Confidence:** ${signal.confidence}%

ADX: ${signal.adx.toFixed(1)} | Stoch K: ${signal.stochK.toFixed(1)} | Stoch D: ${stochD.toFixed(1)}
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

    console.log(`[TELEGRAM] Alert sent for ${signal.symbol} ${stateText}`);
    return true;
  } catch (err) {
    console.error(`[TELEGRAM] Error: ${err}`);
    return false;
  }
}

export async function sendTestAlert() {
  const botToken = process.env.TELEGRAM_BOT_TOKEN;
  const chatId = process.env.TELEGRAM_CHAT_ID;

  console.log("[TELEGRAM] Test alert - checking credentials...");
  console.log(`[TELEGRAM] Bot token exists: ${!!botToken}`);
  console.log(`[TELEGRAM] Chat ID exists: ${!!chatId}`);
  console.log(`[TELEGRAM] Chat ID value: ${chatId}`);

  if (!botToken || !chatId) {
    console.error("[TELEGRAM] Missing credentials - bot token or chat ID not set");
    return { success: false, message: "Telegram credentials not configured" };
  }

  const message = `✅ **CX Switch - Test Alert**

This is a test message to verify Telegram integration is working correctly.

⏰ ${new Date().toLocaleString()}`;

  try {
    const url = `https://api.telegram.org/bot${botToken}/sendMessage`;
    console.log("[TELEGRAM] Sending to URL: (masked for security)");
    
    const response = await fetch(url, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        chat_id: chatId,
        text: message,
        parse_mode: "Markdown",
      }),
    });

    const responseText = await response.text();
    console.log(`[TELEGRAM] Response status: ${response.status}`);
    console.log(`[TELEGRAM] Response body: ${responseText}`);

    if (!response.ok) {
      console.error(`[TELEGRAM] Test failed with status ${response.status}: ${responseText}`);
      return { success: false, message: `Telegram API error: ${response.status} - ${responseText}` };
    }

    console.log("[TELEGRAM] Test alert sent successfully");
    return { success: true, message: "Test alert sent to Telegram!" };
  } catch (err) {
    console.error(`[TELEGRAM] Test error: ${err}`);
    return { success: false, message: `Error sending test alert: ${err}` };
  }
}
