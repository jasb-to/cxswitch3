import { supabase } from "@/lib/supabase-client";
import type { Signal } from "./strategy";

const BOT_TOKEN = process.env.TELEGRAM_BOT_TOKEN;
const CHAT_ID = process.env.TELEGRAM_CHAT_ID;

/**
 * Check if we should send an alert using Supabase persistence.
 * Never alert on END, only once per state transition.
 */
export async function shouldSendAlert(symbol: string, newState: string): Promise<boolean> {
  if (newState === "END") return false;

  // Check if we've already sent this state for this symbol
  const { data } = await supabase
    .from("telegram_alerts")
    .select("id")
    .eq("symbol", symbol)
    .eq("state", newState)
    .order("sent_at", { ascending: false })
    .limit(1);

  return !data || data.length === 0;
}

function fmt(n: number): string {
  return n.toLocaleString("en-US", { minimumFractionDigits: 2, maximumFractionDigits: 2 });
}

/**
 * Send a signal alert and track it in Supabase.
 */
export async function sendSignalAlert(signal: Signal): Promise<void> {
  if (!BOT_TOKEN || !CHAT_ID) return;

  const emoji = signal.state === "CONFIRMED" ? "🟢" : "🟡";
  const text =
    `${emoji} ${signal.symbol} ${signal.direction} ${signal.state}\n` +
    `Entry: $${fmt(signal.entry_price)}\n` +
    `SL: $${fmt(signal.stop_loss)}\n` +
    `TP: $${fmt(signal.take_profit)}\n` +
    `Confidence: ${signal.confidence}%`;

  await fetch(`https://api.telegram.org/bot${BOT_TOKEN}/sendMessage`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ chat_id: CHAT_ID, text }),
  });

  // Track alert in Supabase
  await supabase.from("telegram_alerts").insert({
    symbol: signal.symbol,
    state: signal.state,
  });
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
