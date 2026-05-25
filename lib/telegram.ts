import type { Signal } from "@/lib/signal-store";

const BOT_TOKEN = process.env.TELEGRAM_BOT_TOKEN;
const CHAT_ID = process.env.TELEGRAM_CHAT_ID;

// Cooldown tracking: symbol → last alert timestamp
const alertCooldowns = new Map<string, number>();
const COOLDOWN_MS = 30 * 60 * 1000; // 30 minutes

/**
 * Check if enough time has passed since last alert for this symbol
 */
function canSendAlert(symbol: string): boolean {
  const lastAlert = alertCooldowns.get(symbol);
  if (!lastAlert) return true;
  
  const timeSinceAlert = Date.now() - lastAlert;
  return timeSinceAlert > COOLDOWN_MS;
}

/**
 * Record an alert as sent
 */
function recordAlert(symbol: string): void {
  alertCooldowns.set(symbol, Date.now());
}

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
 * Send a SNIPER signal alert with trade details
 */
export async function sendSignalAlert(signal: Signal): Promise<{ ok: boolean; error?: string }> {
  if (!BOT_TOKEN || !CHAT_ID) {
    console.warn("[TELEGRAM] Bot not configured");
    return { ok: false, error: "TELEGRAM_BOT_TOKEN or TELEGRAM_CHAT_ID not set" };
  }

  if (signal.state !== "SNIPER" || !signal.direction) {
    return { ok: false, error: "Not a SNIPER signal" };
  }

  // Check cooldown
  if (!canSendAlert(signal.symbol)) {
    console.log(`[TELEGRAM] Cooldown active for ${signal.symbol}, skipping alert`);
    return { ok: false, error: "Cooldown active" };
  }

  const message = `🚨 SNIPER SIGNAL

${signal.symbol}/USD
${signal.direction}

Entry: $${signal.entry?.toFixed(2)}
SL: $${signal.stopLoss?.toFixed(2)}
TP: $${signal.takeProfit?.toFixed(2)}
RR: ${signal.riskReward?.toFixed(2)}

Confidence: ${signal.confidence}%
Reason: ${signal.reason}`;

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
      console.error(`[TELEGRAM] Alert failed: ${json.description}`);
      return { ok: false, error: json.description };
    }
    
    recordAlert(signal.symbol);
    console.log(`[TELEGRAM] Alert sent for ${signal.symbol}`);
    return { ok: true };
  } catch (err) {
    console.error(`[TELEGRAM] Exception:`, err);
    return { ok: false, error: String(err) };
  }
}


