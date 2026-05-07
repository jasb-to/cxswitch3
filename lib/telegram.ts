import { supabase } from "@/lib/supabase-client";
import type { Signal, MarketContext } from "./strategy";
import { calculateRiskReward } from "./risk-utils";
import { formatSignalForTelegram, generateTelegramMessage } from "./signal-formatter";

const BOT_TOKEN = process.env.TELEGRAM_BOT_TOKEN;
const CHAT_ID = process.env.TELEGRAM_CHAT_ID;

/**
 * Check if we should send an alert using Supabase persistence.
 * Never alert on END, only once per signal + state combination.
 */
export async function shouldSendAlert(signal_id: number, symbol: string, newState: string): Promise<boolean> {
  if (newState === "END") return false;

  // If Supabase is not connected, always allow alert (no persistence)
  if (!supabase) return true;

  try {
    // Check if we've already sent this state for THIS SPECIFIC SIGNAL
    const { data, error } = await supabase
      .from("telegram_alerts")
      .select("id, sent_at")
      .eq("signal_id", signal_id)
      .eq("symbol", symbol)
      .eq("state", newState)
      .order("sent_at", { ascending: false })
      .limit(1);

    if (error) {
      console.error(`[shouldSendAlert] Query error for signal ${signal_id}:`, error.message);
      return true;
    }

    const shouldSend = !data || data.length === 0;
    console.log(`[shouldSendAlert] signal_id=${signal_id} symbol=${symbol} state=${newState} — already_sent=${!shouldSend}`, data?.[0] ? `(last sent: ${data[0].sent_at})` : "");
    
    return shouldSend;
  } catch (err) {
    console.error(`[shouldSendAlert] Exception for signal ${signal_id}:`, err);
    return true;
  }
}

function fmt(n: number): string {
  return n.toLocaleString("en-US", { minimumFractionDigits: 2, maximumFractionDigits: 2 });
}

/**
 * Send a trade closure alert (TP or SL hit).
 * Only sends if outcome is TP or SL (not EXPIRED).
 */
export async function sendTradeCloseAlert(signal: Signal, exitPrice: number): Promise<void> {
  if (!BOT_TOKEN || !CHAT_ID || !signal.outcome || !["TP", "SL"].includes(signal.outcome)) return;

  const emoji = signal.outcome === "TP" ? "✅" : "❌";
  const outcomeLabel = signal.outcome === "TP" ? "TAKE PROFIT" : "STOP LOSS";
  const pnlColor = (signal.pnl ?? 0) >= 0 ? "+" : "";
  const directionLabel = signal.direction === "LONG" ? "📈 LONG" : "📉 SHORT";

  const text =
    `${emoji} CLOSED — ${outcomeLabel}\n` +
    `\n` +
    `${directionLabel} ${signal.symbol}\n` +
    `\n` +
    `Entry:    $${fmt(signal.entry_price)}\n` +
    `Exit:     $${fmt(exitPrice)}\n` +
    `Stop:     $${fmt(signal.stop_loss)}\n` +
    `\n` +
    `PnL:      ${pnlColor}$${fmt(signal.pnl ?? 0)}\n` +
    `RR:       ${calculateRiskReward(signal.entry_price, signal.take_profit, signal.stop_loss, signal.direction).toFixed(2)}:1`;

  await fetch(`https://api.telegram.org/bot${BOT_TOKEN}/sendMessage`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ chat_id: CHAT_ID, text }),
  });
}

/**
 * Send a signal alert with decision-grade formatting
 * Includes score, grade, breakdown, and actionable context
 */
export async function sendSignalAlert(signal: Signal, context?: MarketContext): Promise<void> {
  if (!BOT_TOKEN || !CHAT_ID) return;

  const formatted = formatSignalForTelegram(signal, context);
  const text = generateTelegramMessage(formatted);

  await fetch(`https://api.telegram.org/bot${BOT_TOKEN}/sendMessage`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ chat_id: CHAT_ID, text }),
  });

  // Track alert in Supabase with signal_id for proper deduplication
  if (supabase && signal.id) {
    try {
      const { data, error } = await supabase
        .from("telegram_alerts")
        .insert({
          signal_id: signal.id,
          symbol: signal.symbol,
          state: signal.state,
        })
        .select();

      if (error) {
        console.error(`[sendSignalAlert] Insert failed for signal ${signal.id}:`, error.message);
      } else {
        console.log(`[sendSignalAlert] Tracked alert for signal ${signal.id} in telegram_alerts`);
      }
    } catch (err) {
      console.error(`[sendSignalAlert] Exception tracking alert for signal ${signal.id}:`, err);
    }
  }
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
