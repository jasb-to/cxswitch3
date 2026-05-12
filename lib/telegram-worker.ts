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
import type { SymbolCardState } from "./strategy-v6";

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
 * 1. State is SNIPER or CONFIRMED (signal engine decision)
 * 2. cycleId has NOT been alerted before (Telegram anti-spam)
 * 
 * This is dumb + safe: signal engine controls state, Telegram only dedupes
 */
function shouldSendAlert(symbol: string, state: string, cycleId: string): boolean {
  // Rule 1: Only SNIPER and CONFIRMED states can alert
  if (state !== "SNIPER" && state !== "CONFIRMED") {
    return false;
  }
  
  // Rule 2: Check if this cycleId was already alerted for this symbol
  const lastCycle = lastAlertedCycle.get(symbol);
  if (lastCycle === cycleId) {
    // Same cycleId = already alerted, skip
    return false;
  }
  
  // NEW CYCLE or FIRST TIME - update memory and return true
  lastAlertedCycle.set(symbol, cycleId);
  return true;
}

/**
 * v12.0.0: Simplified enqueueAlert
 * 
 * Signal engine -> Telegram layer:
 * - Telegram doesn't care about state transitions
 * - Telegram doesn't care about score/HTF/LTF/isExecutable
 * - Telegram ONLY cares: state + cycleId
 */
export function enqueueAlert(job: TelegramAlertJob) {
  const state = job.signalState as "BUILDING" | "SNIPER" | "CONFIRMED";
  const cycleId = job.card.cycleId;
  
  console.log(`[TELEGRAM_CHECK] ${job.symbol}: state=${state} cycleId=${cycleId} lastCycle=${lastAlertedCycle.get(job.symbol) || "none"}`);
  
  if (!shouldSendAlert(job.symbol, state, cycleId)) {
    console.log(`[TELEGRAM_SKIP] ${job.symbol}: state=${state} (blocked by dedupe or non-alertable state)`);
    return;
  }
  
  // SEND ALERT
  console.log(`[TELEGRAM_SEND] ${job.symbol}: state=${state} cycleId=${cycleId}`);
  alertQueue.push(job);
  processAlertQueueAsync();
}

/**
 * Process alert queue asynchronously (v7.2.7 FIX #6)
 * Runs independently without blocking cron
 */
async function processAlertQueueAsync() {
  if (isProcessingAlerts || alertQueue.length === 0) return;
  
  isProcessingAlerts = true;
  console.log(`[TELEGRAM_PROCESSOR_START] Processing ${alertQueue.length} queued alerts`);
  
  try {
    while (alertQueue.length > 0) {
      const job = alertQueue.shift();
      if (!job) break;

      try {
        // v7.3.1 FIX #1: HARD TELEGRAM EXECUTION GATE
        // ONLY send for ACTIVE_SNIPER or ACTIVE_CONFIRMED
        // Never send for setup phases (SNIPER_IMMINENT, SNIPER_READY, CONFIRMED_READY, BUILDING)
        const isExecutableSignal =
          job.signalState === "ACTIVE_SNIPER" ||
          job.signalState === "ACTIVE_CONFIRMED";
        
        console.log(`[ALERT_PROCESSING] ${job.symbol} ${job.direction}: signalState=${job.signalState}, mode=${job.mode}, isExecutable=${isExecutableSignal}, card.signalState=${job.card.signalState}`);

        if (!isExecutableSignal) {
          console.log(
            `[TELEGRAM_BLOCKED] ${job.symbol}: ${job.signalState} is UI-only (not executable)`
          );
          // Don't requeue - UI-only states are not for Telegram
          continue;
        }

        // v7.4.0 FIX #3: DIFFERENTIATE HTF VALIDATION BY SIGNAL TYPE
        // SNIPER: No 4H requirement (uses 1H only), looser HTF checks
        // CONFIRMED: Strict 4H requirement (caught by signal state, but double-check)
        const htfValidationErrors: string[] = [];
        
        if (job.mode === "CONFIRMED") {
          // CONFIRMED must have valid 4H trend (v7.4.0: strict requirement)
          if (!job.htf4hTrend || job.htf4hTrend === "NEUTRAL") {
            htfValidationErrors.push("4H trend NEUTRAL (CONFIRMED requires 4H)");
          }
        }
        // v7.4.0: SNIPER no longer checks 4H, only 15M execution state
        
        // Check: 15M execution state must be valid (for both SNIPER and CONFIRMED)
        if (!job.execution15mState || job.execution15mState === "CHOP" || job.execution15mState === "COMPRESSING") {
          htfValidationErrors.push(`15M ${job.execution15mState || "undefined"}`);
        }
        
        // Check: Price source must not be fallback (CoinGecko)
        if (job.source === "coingecko") {
          htfValidationErrors.push("fallback price source CoinGecko");
        }
        
        if (htfValidationErrors.length > 0) {
          console.log(
            `[ALERT_REJECTED] ${job.symbol}: HTF validation failed - ${htfValidationErrors.join(", ")}`
          );
          continue;
        }

        // v7.3.1 FIX #2: BLOCK INVALID PAYLOADS
        // Validate completeness before Telegram formatting
        if (
          job.score == null ||
          Number.isNaN(job.score) ||
          !job.price ||
          !job.targetPrices?.tp1 ||
          !job.targetPrices?.tp2 ||
          !job.targetPrices?.sl
        ) {
          console.log(
            `[ALERT_REJECTED] ${job.symbol}: incomplete execution payload (score=${job.score}, price=${job.price}, tp1=${job.targetPrices?.tp1})`
          );
          // Don't requeue - malformed payload should not retry
          continue;
        }

        // Check cooldown
        if (await canSendAlert(job.symbol, job.mode, job.direction)) {
          // v7.5.5: Pass full card object to sendAlert for complete formatting
          sendAlert(job.card).catch(err => {
            console.log(`[ALERT_WORKER] Failed to send ${job.symbol}:`, err);
          });
          
          console.log(`[ALERT_WORKER] Telegram sent for ${job.symbol} ${job.mode} (${job.signalState})`);
        } else {
          console.log(`[ALERT_WORKER] Cooldown active for ${job.symbol} - requeuing`);
          // Requeue if cooldown active
          alertQueue.push(job);
          break; // Stop processing, retry later
        }
      } catch (err) {
        console.error(`[ALERT_WORKER] Error processing ${job.symbol}:`, err);
      }
      
      // Small delay between alerts (don't hammer Telegram)
      await new Promise(r => setTimeout(r, 100));
    }
  } finally {
    isProcessingAlerts = false;
    console.log(`[TELEGRAM_PROCESSOR_END] Queue processing complete - ${alertQueue.length} alerts remaining`);
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
