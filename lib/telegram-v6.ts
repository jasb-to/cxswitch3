/**
 * TELEGRAM ALERTS v6 - Alert sending + cooldown only
 * 
 * Cooldown rule: 30 minutes per (symbol + mode + direction)
 * Alert table: tracks sent alerts for cooldown
 */

import { supabase } from "@/lib/supabase-client";
import type { Setup } from "./strategy-v6";

const BOT_TOKEN = process.env.TELEGRAM_BOT_TOKEN;
const CHAT_ID = process.env.TELEGRAM_CHAT_ID;
const COOLDOWN_MS = 30 * 60 * 1000; // 30 minutes

/**
 * Check if we can send alert for this setup
 * Cooldown: 30 minutes per (symbol + mode + direction)
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
      console.log(`[TELEGRAM] Cooldown check error: ${error.message}`);
      return true; // Allow if DB is down
    }

    return !data; // If no recent alert, can send
  } catch (err) {
    console.log(`[TELEGRAM] Cooldown error: ${err instanceof Error ? err.message : String(err)}`);
    return true;
  }
}

/**
 * Send alert to Telegram
 */
export async function sendAlert(setup: Setup): Promise<void> {
  if (!BOT_TOKEN || !CHAT_ID) {
    console.log(`[TELEGRAM] No credentials, skipping alert`);
    return;
  }

  const text = `${setup.mode} ${setup.direction} ${setup.symbol}\nScore: ${setup.score}`;

  try {
    const response = await fetch(`https://api.telegram.org/bot${BOT_TOKEN}/sendMessage`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ chat_id: CHAT_ID, text }),
    });

    if (!response.ok) {
      throw new Error(`HTTP ${response.status}`);
    }

    // Store alert in database for cooldown
    if (supabase) {
      await supabase.from("alerts_sent").insert([{
        symbol: setup.symbol,
        mode: setup.mode,
        direction: setup.direction,
        timestamp: new Date().toISOString(),
      }]);
    }
  } catch (err) {
    throw new Error(`Failed to send: ${err instanceof Error ? err.message : String(err)}`);
  }
}
