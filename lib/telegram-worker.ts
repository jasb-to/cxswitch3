/**
 * v7.2.7 FIX #6 — TELEGRAM ALERT WORKER (updated for v7.3.0)
 * 
 * Decoupled from cron/UI loop
 * Runs as independent async task
 * Does NOT block dashboard updates
 * 
 * v7.3.0 FIX #1 & #2: Hard execution gate + payload validation
 */

import { sendAlert, canSendAlert } from "./telegram-v6";
import type { SymbolCardState } from "./strategy-v21";

export type TelegramAlertJob = {
  // v7.5.5: Full enriched card object for complete Telegram payloads
  card: SymbolCardState;
  
  // Legacy minimal fields (deprecated, kept for backward compat)
  symbol: string;
  mode: "SNIPER" | "CONFIRMED";
  direction: "LONG" | "SHORT";
  score: number;
  price: number;
  source?: string;
  signalState?: string;
  targetPrices?: { tp1: number; tp2: number; sl: number } | null;
  htf4hTrend?: "BULLISH" | "BEARISH" | "NEUTRAL";
  execution15mState?: "COMPRESSING" | "BREAKOUT_READY" | "EXPANDING" | "CHOP";
  queued: number;
};

/**
 * Queue for pending alerts (v7.2.7 FIX #6)
 * Decoupled from cron loop
 */
let alertQueue: TelegramAlertJob[] = [];
let isProcessingAlerts = false;

/**
 * v12.0.0 LEAN TELEGRAM + CYCLE FIX
 * 
 * Problem: Spam (SNIPER persists across cron ticks) + Missing alerts (cycleId removed)
 * 
 * Solution: Use cycleId for Telegram dedupe ONLY
 * - If state === SNIPER/CONFIRMED AND cycleId hasn't been alerted, send alert
 * - Update memory ONLY after successful send
 * - NO state transitions, NO re-alert logic, NO isExecutable gating
 * 
 * Key: symbol → cycleId (what was already alerted for this symbol)
 */
const lastAlertedCycle: Map<string, string> = new Map();

/**
 * v12.0.0: shouldSendAlert - LEAN cycle-based dedup
 * 
 * Return true ONLY if:
 * 1. State is ACTIVE_SNIPER or ACTIVE_CONFIRMED (signal engine decision)
 * 2. cycleId has NOT been alerted before (Telegram anti-spam)
 * 
 * This is dumb + safe: signal engine controls state, Telegram only dedupes
 */
function shouldSendAlert(symbol: string, state: string, cycleId: string): boolean {
  // Rule 1: Only ACTIVE_SNIPER and ACTIVE_CONFIRMED states can alert
  // v16.2.1 FIX: State values are "ACTIVE_SNIPER" and "ACTIVE_CONFIRMED", NOT "SNIPER" and "CONFIRMED"
  if (state !== "ACTIVE_SNIPER" && state !== "ACTIVE_CONFIRMED") {
    console.log(`[TELEGRAM_CHECK_DETAIL] ${symbol}: state="${state}" is not alertable (only ACTIVE_SNIPER/ACTIVE_CONFIRMED)`);
    return false;
  }
  
  // Rule 2: Check if this cycleId was already alerted for this symbol
  const lastCycle = lastAlertedCycle.get(symbol);
  if (lastCycle === cycleId) {
    // Same cycleId = already alerted, skip
    console.log(`[TELEGRAM_CHECK_DETAIL] ${symbol}: cycleId="${cycleId}" already alerted in previous cycle`);
    return false;
  }
  
  // NEW CYCLE or FIRST TIME - update memory and return true
  lastAlertedCycle.set(symbol, cycleId);
  console.log(`[TELEGRAM_CHECK_DETAIL] ${symbol}: NEW cycleId="${cycleId}" - will alert`);
  return true;
}

/**
 * v12.0.0: Simplified enqueueAlert
 * 
 * Signal engine -> Telegram layer:
 * - Telegram doesn't care about state transitions
 * - Telegram doesn't care about score/HTF/LTF/isExecutable
 * - Telegram ONLY cares: state + cycleId
 * 
 * v21.2.1 FIX: Validate setup completeness before enqueuing
 */
export function enqueueAlert(job: TelegramAlertJob) {
  const state = job.signalState as "NONE" | "BUILDING" | "ACTIVE_SNIPER" | "ACTIVE_CONFIRMED";
  const cycleId = job.card.cycleId;
  
  console.log(`[TELEGRAM_GATE] ${job.symbol}: state=${state} cycleId=${cycleId} lastCycle=${lastAlertedCycle.get(job.symbol) || "none"}`);
  
  // v21.2.1 FIX: Verify setup has required fields BEFORE dedup check
  const gateErrors: string[] = [];
  if (!job.card.mode) gateErrors.push("missing mode");
  if (!job.card.confidence) gateErrors.push("missing confidence");
  if (!job.targetPrices) gateErrors.push("missing targetPrices");
  if (!job.price || job.price <= 0) gateErrors.push(`invalid price=${job.price}`);
  
  if (gateErrors.length > 0) {
    console.log(`[TELEGRAM_GATE_REJECTED] ${job.symbol}: ${gateErrors.join(" | ")} - NOT enqueued`);
    return;
  }
  
  if (!shouldSendAlert(job.symbol, state, cycleId)) {
    console.log(`[TELEGRAM_GATE_SKIP] ${job.symbol}: state=${state} (blocked by dedupe or non-alertable state)`);
    return;
  }
  
  // GATE PASSED - ENQUEUE
  console.log(`[TELEGRAM_GATE_PASS] ${job.symbol}: state=${state} cycleId=${cycleId} - ENQUEUED for telegram send`);
  alertQueue.push(job);
  processAlertQueueAsync();
}

/**
 * Process alert queue asynchronously (v7.2.7 FIX #6)
 * Runs independently without blocking cron
 * 
 * v21.2.1 FIX: IMMUTABLE ITERATION to prevent symbol loss
 * - Don't use shift() which destroys queue on error
 * - Use index tracking to safely remove only processed alerts
 * - ETH no longer blocked if BTC fails
 */
async function processAlertQueueAsync() {
  if (isProcessingAlerts || alertQueue.length === 0) return;
  
  isProcessingAlerts = true;
  const queueLength = alertQueue.length;
  console.log(`[TELEGRAM_PROCESSOR_START] Processing ${queueLength} queued alerts`);
  
  let processedCount = 0;
  let index = 0;
  
  try {
    // v21.2.1 FIX: Safe iteration - don't use destructive shift()
    while (index < alertQueue.length) {
      const job = alertQueue[index];
      if (!job) {
        index++;
        continue;
      }

      try {
        // v13.0.0: TELEGRAM EXECUTION FIX - REMOVE EXECUTION GATING
        // Telegram is ONLY a notification layer
        // State filtering already done in shouldSendAlert()
        // Proceed directly to validation
        
        console.log(`[ALERT_PROCESSING] ${job.symbol} ${job.direction}: signalState=${job.signalState} cycleId=${job.card.cycleId}`);
        // v13.0.0: MINIMAL PAYLOAD VALIDATION (no execution-specific checks)
        // Just verify we have complete price/target data for formatting
        const validationErrors: string[] = [];
        
        // Check: Price must be valid
        if (!job.price || job.price <= 0) {
          validationErrors.push(`invalid price=${job.price}`);
        }
        
        // Check: Must have target prices for ACTIVE_SNIPER
        if (job.signalState === "ACTIVE_SNIPER" || job.signalState === "ACTIVE_CONFIRMED") {
          if (!job.targetPrices) {
            validationErrors.push(`missing targetPrices object (entire object null)`);
          } else {
            if (!job.targetPrices.tp1) validationErrors.push(`missing TP1=${job.targetPrices.tp1}`);
            if (!job.targetPrices.sl) validationErrors.push(`missing SL=${job.targetPrices.sl}`);
          }
        }
        
        if (validationErrors.length > 0) {
          console.log(
            `[ALERT_VALIDATION_ERROR] ${job.symbol}: ${validationErrors.join(" | ")} - skipping alert`
          );
          // v17.6.0: Skip only if critical price/target data is missing
          index++; // Move to next alert even if this one fails
          continue;
        }

        // Check cooldown
        if (await canSendAlert(job.symbol, job.mode, job.direction)) {
          // v7.5.5: Pass full card object to sendAlert for complete formatting
          try {
            await sendAlert(job.card);
            console.log(`[ALERT_WORKER_SUCCESS] Telegram sent for ${job.symbol} ${job.mode} (${job.signalState})`);
            // Mark for removal after successful send
            alertQueue.splice(index, 1);
            // Don't increment index - next alert now at this position
            processedCount++;
          } catch (sendErr) {
            console.error(`[ALERT_WORKER_ERROR] Failed to send ${job.symbol}:`, sendErr);
            index++; // Move to next even if send fails
          }
        } else {
          console.log(`[ALERT_WORKER_COOLDOWN] ${job.symbol} - cooldown active, requeuing for next batch`);
          // Leave in queue, move to next alert
          index++;
        }
      } catch (err) {
        console.error(`[ALERT_WORKER_EXCEPTION] Error processing ${job.symbol}:`, err);
        index++; // Move to next alert on exception
      }
      
      // Small delay between alerts (don't hammer Telegram)
      await new Promise(r => setTimeout(r, 100));
    }
  } finally {
    isProcessingAlerts = false;
    console.log(`[TELEGRAM_PROCESSOR_END] Processed ${processedCount}/${queueLength} alerts - ${alertQueue.length} remaining in queue`);
  }
}

/**
 * Get queue stats (debugging)
 */
export function getAlertQueueStats() {
  return {
    queued: alertQueue.length,
    processing: isProcessingAlerts,
  };
}
