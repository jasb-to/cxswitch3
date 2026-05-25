const BOT_TOKEN = process.env.TELEGRAM_BOT_TOKEN;
const CHAT_ID = process.env.TELEGRAM_CHAT_ID;

/**
 * Send a test message to verify the bot is configured correctly.
 */
export async function sendTestMessage(): Promise<{ ok: boolean; error?: string }> {
  if (!BOT_TOKEN || !CHAT_ID) {
    return { ok: false, error: "TELEGRAM_BOT_TOKEN or TELEGRAM_CHAT_ID not set" };
  }

  const res = await fetch(`https://api.telegram.org/bot${BOT_TOKEN}/sendMessage`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      chat_id: CHAT_ID,
      text: "✅ Signal dashboard connected. Telegram alerts are working.",
    }),
  });

  const json = await res.json();
  if (!json.ok) return { ok: false, error: json.description ?? "Unknown error" };
  return { ok: true };
}

/**
 * Send a signal alert when SNIPER state is detected.
 */
export async function sendSignalAlert(symbol: string, price: number, state: string, quality: number): Promise<{ ok: boolean; error?: string }> {
  if (!BOT_TOKEN || !CHAT_ID) {
    console.warn("[TELEGRAM] Bot not configured, skipping alert");
    return { ok: false, error: "TELEGRAM_BOT_TOKEN or TELEGRAM_CHAT_ID not set" };
  }

  if (state !== "SNIPER") {
    console.log(`[TELEGRAM] State is ${state}, not SNIPER - skipping alert`);
    return { ok: false, error: `State ${state} is not SNIPER` };
  }

  const message = `🚨 SNIPER SIGNAL\n\n${symbol}/USD\nPrice: $${price.toLocaleString()}\nQuality: ${quality}%`;

  try {
    const res = await fetch(`https://api.telegram.org/bot${BOT_TOKEN}/sendMessage`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        chat_id: CHAT_ID,
        text: message,
      }),
    });

    const json = await res.json();
    if (!json.ok) {
      console.error(`[TELEGRAM] Alert send failed: ${json.description}`);
      return { ok: false, error: json.description ?? "Unknown error" };
    }
    console.log(`[TELEGRAM] Alert sent for ${symbol}`);
    return { ok: true };
  } catch (err) {
    console.error(`[TELEGRAM] Exception sending alert:`, err);
    return { ok: false, error: String(err) };
  }
}
