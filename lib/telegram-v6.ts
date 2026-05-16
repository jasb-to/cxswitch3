/**
 * TELEGRAM ALERTS v6 - Alert sending + cooldown only
 * 
 * Cooldown rule: 30 minutes per (symbol + mode + direction)
 * Alert table: tracks sent alerts for cooldown
 */

import { supabase } from "@/lib/supabase-client";
import type { SymbolCardState } from "./strategy-v21";

const BOT_TOKEN = process.env.TELEGRAM_BOT_TOKEN;
const CHAT_ID = process.env.TELEGRAM_CHAT_ID;
const COOLDOWN_MS = 30 * 60 * 1000; // 30 minutes

// v9.1.1: Log credentials status on initialization
if (!BOT_TOKEN || !CHAT_ID) {
  console.warn(`[TELEGRAM_INIT] WARNING - Telegram credentials not loaded: BOT_TOKEN=${BOT_TOKEN ? "loaded" : "MISSING"}, CHAT_ID=${CHAT_ID ? "loaded" : "MISSING"}`);
} else {
  console.log(`[TELEGRAM_INIT] Credentials loaded - ready to send alerts`);
}

/**
 * Format number with consistent decimals
 */
function fmt(n: number | null | undefined): string {
  if (n == null) return "—";
  return n.toLocaleString("en-US", { minimumFractionDigits: 2, maximumFractionDigits: 2 });
}

/**
 * Check if we can send alert for this setup
 * Cooldown: 30 minutes per (symbol + mode + direction)
 * v21.3.0: STRICT schema validation - REJECT if table missing (prevents alert spam)
 */
export async function canSendAlert(symbol: string, mode: "SNIPER" | "CONFIRMED", direction: "LONG" | "SHORT"): Promise<boolean> {
  if (!supabase) return true;

  try {
    const now = new Date();
    const cooldownEnd = new Date(now.getTime() - COOLDOWN_MS);

    const { data, error } = await supabase
      .from("alerts_sent")
      .select("timestamp")
      .eq("symbol", symbol)
      .eq("mode", mode)
      .eq("direction", direction)
      .gte("timestamp", cooldownEnd.toISOString())
      .limit(1)
      .maybeSingle();

    if (error) {
      // v21.3.0 CRITICAL: If schema missing, REJECT alert (don't allow)
      // This prevents undeduped spam when migration hasn't run
      if (error.message.includes("alerts_sent") || error.message.includes("does not exist")) {
        console.log(`[TELEGRAM] CRITICAL: alerts_sent table missing - rejecting alert to prevent spam. Run Supabase migration.`);
        return false; // REJECT - prevent undeduped alerts
      }
      console.log(`[TELEGRAM] Cooldown check error: ${error.message}`);
      return true; // Allow if other DB error (be lenient)
    }

    return !data; // If no recent alert, can send
  } catch (err) {
    console.log(`[TELEGRAM] Cooldown error: ${err instanceof Error ? err.message : String(err)}`);
    return true;
  }
}

/**
 * v7.5.5: Send full execution alert to Telegram with complete card context
 * No truncated payloads — includes entry zone, TP/SL, market bias, and execution context
 */
export async function sendAlert(card: SymbolCardState): Promise<void> {
  if (!BOT_TOKEN || !CHAT_ID) {
    console.log(`[TELEGRAM] No credentials, skipping alert`);
    return;
  }

  // Emoji for signal type
  const emoji = card.mode === "CONFIRMED" ? "🟢" : "🟡";
  const directionEmoji = card.direction === "LONG" ? "📈" : "📉";
  
  // Market bias line
  const bias4H = card.htf4hTrend === "BULLISH" ? "🔵" : card.htf4hTrend === "BEARISH" ? "🔴" : "⚫";
  const bias15M = card.execution15mState === "EXPANDING" ? "🟢" : card.execution15mState === "BREAKOUT_READY" ? "🟡" : "⚪";
  
  // Format prices
  const entry = fmt(card.price);
  const tp1 = fmt(card.targetPrices?.tp1);
  const tp2 = fmt(card.targetPrices?.tp2);
  const sl = fmt(card.targetPrices?.sl);
  const rr = card.riskReward ? card.riskReward.toFixed(2) : "—";
  
  // Format ignition and confidence with proper rounding
  const ignitionRounded = Math.ceil(card.ignitionProbability);
  const confidencePercent = Math.ceil(card.confidence);
  
  // Build full message with all context
  const text =
    `${emoji} ${card.mode} — ${directionEmoji} ${card.direction} ${card.symbol}\n` +
    `\n` +
    `Confidence: ${confidencePercent}% | Ignition: ${ignitionRounded}%\n` +
    `\n` +
    `📊 BIAS: ${bias4H} 4H | ${bias15M} 15M (${card.execution15mState})\n` +
    `\n` +
    `💰 ENTRY: $${entry}\n` +
    `🎯 TP1: $${tp1}\n` +
    `🎯 TP2: $${tp2}\n` +
    `🛑 SL: $${sl}\n` +
    `\n` +
    `📈 R:R: ${rr}:1\n` +
    `\n` +
    `State: ${card.signalState}`;

  try {
    const response = await fetch(`https://api.telegram.org/bot${BOT_TOKEN}/sendMessage`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ chat_id: CHAT_ID, text }),
    });

    console.log(`[TELEGRAM_DISPATCH] Sending ${card.symbol} ${card.direction} (score=${card.confidence})`);

    if (!response.ok) {
      const errorBody = await response.text();
      console.error(`[TELEGRAM_ERROR] HTTP ${response.status} - ${errorBody}`);
      throw new Error(`HTTP ${response.status}: ${errorBody}`);
    }

    console.log(`[TELEGRAM_SENT] ${card.symbol} ${card.direction} successfully sent to Telegram`);

    // Store alert in database for cooldown
    if (supabase) {
      await supabase.from("alerts_sent").insert([{
        symbol: card.symbol,
        mode: card.mode,
        direction: card.direction,
        timestamp: new Date().toISOString(),
      }]);
    }
  } catch (err) {
    console.error(`[TELEGRAM_ERROR] Failed to send ${card.symbol}: ${err instanceof Error ? err.message : String(err)}`);
    throw new Error(`Failed to send: ${err instanceof Error ? err.message : String(err)}`);
  }
}
