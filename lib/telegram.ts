import { supabase } from "@/lib/supabase-client";
import type { Signal } from "./strategy";
import { calculateRiskReward } from "./risk-utils";

const BOT_TOKEN = process.env.TELEGRAM_BOT_TOKEN;
const CHAT_ID = process.env.TELEGRAM_CHAT_ID;

/**
 * Check if we should send an alert using Supabase persistence.
 * Never alert on END, only once per signal + state combination.
 */
export async function shouldSendAlert(signal_id: number, symbol: string, newState: string): Promise<boolean> {
  if (newState === "END") return false;

  // Defensive: require all parameters
  if (!signal_id || !symbol || !newState) {
    console.log(`[TELEGRAM] Invalid query skipped — signal_id=${signal_id} symbol=${symbol} state=${newState}`);
    return true;
  }

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
      .limit(1)
      .maybeSingle();

    if (error) {
      console.error(`[shouldSendAlert] Query error for signal ${signal_id}:`, error.message);
      return true;
    }

    const shouldSend = !data;
    if (!shouldSend) {
      console.log(`[TELEGRAM] Duplicate alert prevented — signal_id=${signal_id} symbol=${symbol} state=${newState} (last sent: ${data.sent_at})`);
    }
    
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
 * Send a signal alert — simple breakout momentum format
 */
export async function sendSignalAlert(signal: Signal): Promise<void> {
  if (!BOT_TOKEN || !CHAT_ID) return;

  const emoji = signal.state === "CONFIRMED" ? "🟢" : "🟡";
  const reason = signal.state === "EARLY_OPEN" 
    ? "Breakout with early momentum. Awaiting 15m confirmation."
    : "Breakout confirmed with sustained momentum across recent closes.";

  const text =
    `${emoji} ${signal.symbol} — ${signal.direction} (${signal.state})\n` +
    `\n` +
    `Entry:       $${fmt(signal.entry_price)}\n` +
    `Stop Loss:   $${fmt(signal.stop_loss)}\n` +
    `Take Profit: $${fmt(signal.take_profit)}\n` +
    `\n` +
    `Confidence: ${signal.confidence}%\n` +
    `\n` +
    `Reason:\n` +
    `${reason}`;

  await fetch(`https://api.telegram.org/bot${BOT_TOKEN}/sendMessage`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ chat_id: CHAT_ID, text }),
  });

  // Track alert in Supabase with signal_id for proper deduplication
  if (supabase && signal.id && signal.symbol && signal.state) {
    try {
      const { data, error } = await supabase
        .from("telegram_alerts")
        .insert({
          signal_id: signal.id,
          symbol: signal.symbol,
          state: signal.state,
        })
        .select()
        .limit(1)
        .maybeSingle();

      if (error) {
        // 409 conflict = duplicate (expected) — treat as INFO not ERROR
        if (error.code === "23505" || error.message?.includes("duplicate")) {
          console.log(`[TELEGRAM] Duplicate alert prevented — signal_id=${signal.id}`);
        } else {
          console.error(`[sendSignalAlert] Insert failed for signal ${signal.id}:`, error.message);
        }
      } else if (data) {
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
