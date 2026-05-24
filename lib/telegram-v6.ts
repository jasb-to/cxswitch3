/**
 * TELEGRAM ALERTS v6 - Alert sending + cooldown only
 * 
 * Cooldown rule: 30 minutes per (symbol + mode + direction)
 * Alert table: tracks sent alerts for cooldown
 * 
 * STEP 1 FIX: Retry wrapper with timeout isolation for reliable delivery
 */

import { supabase } from "@/lib/supabase-client";
import type { Setup } from "./strategy-v6";

const BOT_TOKEN = process.env.TELEGRAM_BOT_TOKEN;
const CHAT_ID = process.env.TELEGRAM_CHAT_ID;
const COOLDOWN_MS = 30 * 60 * 1000; // 30 minutes

/**
 * Hardened Telegram delivery with retry + timeout isolation
 * STEP 1 FIX: Ensures alerts reach Telegram even with transient failures
 */
async function safeTelegramSend(payload: any, retries = 3): Promise<boolean> {
  // Verify credentials are configured
  if (!BOT_TOKEN) {
    console.error(`[TELEGRAM] TELEGRAM_BOT_TOKEN not configured - alerts cannot be sent`);
    return false;
  }
  if (!CHAT_ID) {
    console.error(`[TELEGRAM] TELEGRAM_CHAT_ID not configured - alerts cannot be sent`);
    return false;
  }

  for (let i = 0; i < retries; i++) {
    try {
      const controller = new AbortController();
      // Increased timeout from 5s to 15s for Telegram API reliability
      const timeoutId = setTimeout(() => controller.abort(), 15000);

      console.log(`[TELEGRAM_ATTEMPT] ${i + 1}/${retries} - sending to ${CHAT_ID}...`);

      const res = await fetch(`https://api.telegram.org/bot${BOT_TOKEN}/sendMessage`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(payload),
        signal: controller.signal,
      });

      clearTimeout(timeoutId);

      if (res.ok) {
        console.log(`[TELEGRAM_SENT] Delivery successful on attempt ${i + 1}`);
        return true;
      }

      const statusText = res.statusText || `HTTP ${res.status}`;
      console.log(`[TELEGRAM_RETRY] Attempt ${i + 1} failed: ${statusText}`);
      
      // Try to read error details from Telegram response
      try {
        const errorData = await res.json();
        console.log(`[TELEGRAM_ERROR_DETAIL] ${JSON.stringify(errorData)}`);
      } catch (_) {
        // Ignore if can't parse response
      }
    } catch (err) {
      const errorMsg = err instanceof Error ? err.message : String(err);
      console.log(`[TELEGRAM_RETRY] Attempt ${i + 1} failed: ${errorMsg}`);
      
      // Log if it was an abort error
      if (err instanceof Error && err.name === 'AbortError') {
        console.log(`[TELEGRAM_TIMEOUT] Request timed out after 15s`);
      }
    }

    // Exponential backoff: 1s, 2s, 4s between retries
    if (i < retries - 1) {
      const backoffMs = 1000 * Math.pow(2, i);
      console.log(`[TELEGRAM_BACKOFF] Waiting ${backoffMs}ms before retry...`);
      await new Promise(r => setTimeout(r, backoffMs));
    }
  }

  console.error(`[TELEGRAM_FAILED] Delivery failed after ${retries} attempts`);
  return false;
}


/**
 * Check if we can send alert for this setup
 * STEP 2 FIX: Dedupe key includes signalTransitionId to prevent blocking repeated SNIPER states
 * Old key: symbol + mode + direction (too broad, blocks repeated signals)
 * New key: signalTransitionId (unique per signal transition, allows new signals)
 */
export async function canSendAlert(
  symbol: string,
  mode: "SNIPER" | "CONFIRMED",
  direction: "LONG" | "SHORT",
  signalTransitionId?: string
): Promise<boolean> {
  if (!supabase) return true;

  try {
    const now = new Date();
    const cooldownEnd = new Date(now.getTime() - COOLDOWN_MS);

    // STEP 2 FIX: Use signalTransitionId if available for more granular dedupe
    // Falls back to symbol+mode+direction for backward compatibility
    const dedupeKey = signalTransitionId || `${symbol}-${mode}-${direction}`;

    const { data, error } = await supabase
      .from("alerts_sent")
      .select("timestamp")
      .eq("symbol", symbol)
      .eq("dedupe_key", dedupeKey)
      .gte("timestamp", cooldownEnd.toISOString())
      .limit(1)
      .maybeSingle();

    if (error) {
      console.log(`[TELEGRAM] Cooldown check error: ${error.message}`);
      return true; // Allow if DB is down
    }

    return !data; // If no recent alert with this dedupe key, can send
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
    console.error(`[TELEGRAM] Missing credentials - BOT_TOKEN: ${!!BOT_TOKEN}, CHAT_ID: ${!!CHAT_ID}`);
    throw new Error("Telegram credentials not configured");
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
  
  // Market Context — fields guaranteed by execution layer
  lines.push("Market Context:");
  lines.push(`4H: ${setup.htf4hTrend || "UNKNOWN"}`);
  lines.push(`15M: ${setup.execution15mState || "UNKNOWN"}`);
  lines.push("");
  
  // Entry Price/Zone
  if (setup.entryZone) {
    lines.push("Entry Zone:");
    lines.push(`${setup.entryZone.min.toFixed(2)} - ${setup.entryZone.max.toFixed(2)}`);
  } else if (setup.entryPrice) {
    lines.push("Entry Price:");
    lines.push(setup.entryPrice.toFixed(2));
  } else if (setup.price) {
    lines.push("Entry Price:");
    lines.push(setup.price.toFixed(2));
  }
  lines.push("");
  
  // Targets - use targetPrices directly (not under momentum)
  if (setup.targetPrices) {
    const tp = setup.targetPrices;
    lines.push("Targets:");
    lines.push(`TP1: ${tp.tp1?.toFixed(2) ?? "UNKNOWN"}`);
    lines.push(`TP2: ${tp.tp2?.toFixed(2) ?? "UNKNOWN"}`);
    lines.push("");
  }
  
  // Risk
  if (setup.targetPrices) {
    const tp = setup.targetPrices;
    lines.push("Risk:");
    lines.push(`SL: ${tp.sl?.toFixed(2) ?? "UNKNOWN"}`);
    if (setup.riskReward) {
      lines.push(`R:R: ${setup.riskReward.toFixed(2)}`);
    }
    lines.push("");
  }
  
  // Confidence - use score or confidence field
  if (setup.score !== undefined) {
    lines.push("Confidence:");
    lines.push(`${setup.score.toFixed(1)}%`);
    lines.push("");
  } else if (setup.confidence !== undefined) {
    lines.push("Confidence:");
    lines.push(`${setup.confidence.toFixed(1)}%`);
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

  console.log(`[TELEGRAM] Attempting to send alert for ${setup.symbol} to chat ${CHAT_ID}`);

  // STEP 1 FIX: Use reliable delivery wrapper instead of bare fetch
  const delivered = await safeTelegramSend({
    chat_id: CHAT_ID,
    text,
  });

  if (!delivered) {
    console.error(`[TELEGRAM] Failed to deliver alert for ${setup.symbol} after all retries`);
    throw new Error("Telegram delivery failed after retries");
  }

  console.log(`[TELEGRAM] Alert successfully delivered for ${setup.symbol}`);

  // Store alert in database for cooldown
  // STEP 2 FIX: Store dedupe_key for more granular cooldown checking
  if (supabase) {
    const dedupeKey = setup.signalTransitionId || `${setup.symbol}-${setup.mode}-${setup.direction}`;
    await supabase.from("alerts_sent").insert([{
      symbol: setup.symbol,
      mode: setup.mode,
      direction: setup.direction,
      dedupe_key: dedupeKey,
      timestamp: new Date().toISOString(),
    }]);
  }
}
