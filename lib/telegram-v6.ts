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
 * v1 STABILIZATION: Trader-friendly format with all critical fields
 */
export async function sendAlert(setup: any): Promise<void> {
  if (!BOT_TOKEN || !CHAT_ID) {
    console.log(`[TELEGRAM] No credentials, skipping alert`);
    return;
  }

  // Format alert text with all trader-facing information
  const lines: string[] = [];
  
  // Header
  lines.push(`🚨 ACTIVE_${setup.mode} — ${setup.symbol} ${setup.direction}`);
  lines.push("");
  
  // Structure (most important - tells why the trade fires)
  if (setup.structureState) {
    lines.push("Structure:");
    lines.push(setup.structureState);
    lines.push("");
  }
  
  // Market Context
  lines.push("Market Context:");
  lines.push(`4H: ${setup.htf4hTrend || "N/A"}`);
  lines.push(`15M: ${setup.execution15mState || "N/A"}`);
  lines.push("");
  
  // Entry Zone
  if (setup.entryZone) {
    lines.push("Entry Zone:");
    lines.push(`${setup.entryZone.min.toFixed(2)} - ${setup.entryZone.max.toFixed(2)}`);
  } else if (setup.price) {
    lines.push("Entry Price:");
    lines.push(setup.price.toFixed(2));
  }
  lines.push("");
  
  // Targets
  if (setup.momentum?.targetPrices) {
    const tp = setup.momentum.targetPrices;
    lines.push("Targets:");
    lines.push(`TP1: ${tp.tp1?.toFixed(2) || "N/A"}`);
    lines.push(`TP2: ${tp.tp2?.toFixed(2) || "N/A"}`);
    lines.push("");
  }
  
  // Risk
  if (setup.momentum?.targetPrices) {
    const tp = setup.momentum.targetPrices;
    lines.push("Risk:");
    lines.push(`SL: ${tp.sl?.toFixed(2) || "N/A"}`);
    if (setup.riskReward) {
      lines.push(`R:R: ${setup.riskReward.toFixed(2)}`);
    }
    lines.push("");
  }
  
  // Confidence
  if (setup.score !== undefined) {
    lines.push("Confidence:");
    lines.push(`${setup.score.toFixed(1)}%`);
    lines.push("");
  }
  
  // Impulse State
  if (setup.impulseState) {
    lines.push("Impulse:");
    lines.push(setup.impulseState);
    lines.push("");
  }
  
  // Execution Notes
  if (setup.executionNotes) {
    lines.push("Execution Notes:");
    lines.push(setup.executionNotes);
  }

  const text = lines.join("\n");

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
