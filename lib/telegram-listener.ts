/**
 * TELEGRAM LISTENER
 * Subscribes to signal events, sends alerts
 * Decoupled from cron execution
 */

import { signalEvents } from "@/lib/signal-events";
import type { Signal } from "@/lib/signal-store";

const BOT_TOKEN = process.env.TELEGRAM_BOT_TOKEN;
const CHAT_ID = process.env.TELEGRAM_CHAT_ID;

const alertCooldowns = new Map<string, number>();
const COOLDOWN_MS = 30 * 60 * 1000; // 30 minutes

function canSendAlert(symbol: string): boolean {
  const lastAlert = alertCooldowns.get(symbol);
  if (!lastAlert) return true;
  return Date.now() - lastAlert > COOLDOWN_MS;
}

function recordAlert(symbol: string): void {
  alertCooldowns.set(symbol, Date.now());
}

async function handleSignalEvent(event: { symbol: string; state: string; signal: Signal }): Promise<void> {
  // Only send alerts for SNIPER state changes
  if (event.state !== "SNIPER" || !event.signal.direction) return;
  if (!canSendAlert(event.symbol)) return;
  if (!BOT_TOKEN || !CHAT_ID) return;

  const message = `🚨 SNIPER SIGNAL

${event.symbol}/USD
${event.signal.direction}

Entry: $${event.signal.entry?.toFixed(2)}
SL: $${event.signal.stopLoss?.toFixed(2)}
TP: $${event.signal.takeProfit?.toFixed(2)}
RR: ${event.signal.riskReward?.toFixed(2)}

Confidence: ${event.signal.confidence}%
Reason: ${event.signal.reason}`;

  try {
    const res = await fetch(`https://api.telegram.org/bot${BOT_TOKEN}/sendMessage`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ chat_id: CHAT_ID, text: message }),
    });

    if (!res.ok) {
      const json = await res.json();
      console.error(`[TELEGRAM] Send failed: ${json.description}`);
      return;
    }

    recordAlert(event.symbol);
    console.log(`[TELEGRAM] Alert sent for ${event.symbol}`);
  } catch (err) {
    console.error(`[TELEGRAM] Exception:`, err);
  }
}

// Subscribe to all signal events
signalEvents.subscribe(handleSignalEvent);

export function unsubscribeTelegram(): void {
  // Clean up on shutdown if needed
}

export async function sendTestMessage(): Promise<{ ok: boolean; error?: string }> {
  if (!BOT_TOKEN || !CHAT_ID) {
    return { ok: false, error: "TELEGRAM_BOT_TOKEN or TELEGRAM_CHAT_ID not set" };
  }

  try {
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
  } catch (err) {
    return { ok: false, error: String(err) };
  }
}
