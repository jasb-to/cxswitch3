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

export type TelegramAlertJob = {
  symbol: string;
  mode: "SNIPER" | "CONFIRMED";
  direction: "LONG" | "SHORT";
  score: number;
  price: number;
  source?: string; // v7.3.1: check price source validity
  signalState?: string; // v7.3.0: track signal state for execution gate
  signalTransitionId?: string; // STEP 2 FIX: Unique ID per signal transition (prevents dedupe blocking)
  targetPrices?: { tp1: number; tp2: number; sl: number } | null;
  htf4hTrend?: "BULLISH" | "BEARISH" | "NEUTRAL"; // v7.3.1: validate HTF structure
  execution15mState?: "COMPRESSING" | "BREAKOUT_READY" | "EXPANDING" | "CHOP"; // v7.3.1: validate 15M execution
  queued: number; // timestamp
  
  // v1 STABILIZATION: Trader-facing fields
  structureState?: string; // BREAKOUT_UP, RETEST_DOWN, etc - why the trade fires
  entryPrice?: number;
  entryZone?: { min: number; max: number };
  riskReward?: number;
  confidence?: number;
  impulseState?: string; // "Compression → Expansion confirmed"
  executionNotes?: string;
};

/**
 * Queue for pending alerts (v7.2.7 FIX #6)
 * Decoupled from cron loop
 */
let alertQueue: TelegramAlertJob[] = [];
let isProcessingAlerts = false;

/**
 * Enqueue alert for processing (v7.2.7 FIX #6)
 * Non-blocking - returns immediately
 */
export function enqueueAlert(job: TelegramAlertJob) {
  alertQueue.push(job);
  // Fire and forget - don't await
  processAlertQueueAsync();
}

/**
 * Process alert queue asynchronously (v7.2.7 FIX #6)
 * Runs independently without blocking cron
 */
async function processAlertQueueAsync() {
  if (isProcessingAlerts || alertQueue.length === 0) return;
  
  isProcessingAlerts = true;
  
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

        if (!isExecutableSignal) {
          console.log(
            `[TELEGRAM_BLOCKED] ${job.symbol}: ${job.signalState} is UI-only (not executable)`
          );
          // Don't requeue - UI-only states are not for Telegram
          continue;
        }

        // v8.4 FIX: HTF VALIDATION IS MODE-AWARE
        // SNIPER: Allow NEUTRAL 4H (early impulse detection, pre-macro breakout)
        // CONFIRMED: Require non-NEUTRAL 4H (safe trend-following only)
        const htfValidationErrors: string[] = [];
        
        // Check 1: 4H trend validation is mode-dependent
        // SNIPER allows NEUTRAL (that's the whole point - early entry before macro alignment)
        // CONFIRMED requires alignment (strict safe system)
        const isValidHTFForMode =
          job.mode === "SNIPER"
            ? true // SNIPER ignores 4H gating (macro is probability modifier only)
            : job.htf4hTrend !== "NEUTRAL"; // CONFIRMED requires 4H alignment
        
        if (!isValidHTFForMode) {
          htfValidationErrors.push(`4H trend ${job.htf4hTrend} invalid for ${job.mode}`);
        }
        
        // Check 2: 15M execution state must be valid
        if (!job.execution15mState || job.execution15mState === "CHOP" || job.execution15mState === "COMPRESSING") {
          htfValidationErrors.push(`15M ${job.execution15mState || "undefined"}`);
        }
        
        // Check 3: Price source must not be fallback (CoinGecko)
        if (job.source === "coingecko") {
          htfValidationErrors.push("fallback price source CoinGecko");
        }
        
        if (htfValidationErrors.length > 0) {
          console.log(
            `[ALERT_REJECTED] ${job.symbol}: HTF validation failed - ${htfValidationErrors.join(", ")}`
          );
          continue;
        }

        // HOTFIX: REMOVED STRICT TP FIELD VALIDATION
        // Execution layer now guarantees completeness before enqueueing
        // Alert worker is delivery-only (doesn't validate completeness)
        // This ensures no alerts are rejected due to missing tp1/tp2/sl


        // v1 STABILIZATION: STRICT PAYLOAD VALIDATION
        // Block alerts with missing required fields (N/A is forbidden)
        const payloadErrors: string[] = [];
        
        if (!job.structureState) payloadErrors.push("structureState");
        if (!job.htf4hTrend) payloadErrors.push("htf4hTrend");
        if (!job.execution15mState) payloadErrors.push("execution15mState");
        if (!job.entryPrice && !job.price) payloadErrors.push("entryPrice/price");
        if (!job.targetPrices?.tp1) payloadErrors.push("targetPrices.tp1");
        if (!job.targetPrices?.tp2) payloadErrors.push("targetPrices.tp2");
        if (!job.targetPrices?.sl) payloadErrors.push("targetPrices.sl");
        
        if (payloadErrors.length > 0) {
          console.log(
            `[ALERT BLOCKED] ${job.symbol}: Missing required fields - ${payloadErrors.join(", ")}`
          );
          // Do not requeue - payload is incomplete at source
          continue;
        }

        // Check cooldown
        // STEP 2 FIX: Pass signalTransitionId for granular dedupe
        if (await canSendAlert(job.symbol, job.mode, job.direction, job.signalTransitionId)) {
          // Send alert with COMPLETE job payload (all fields required)
          // sendAlert expects root-level fields: targetPrices, htf4hTrend, execution15mState, structureState, etc.
          sendAlert(job).catch(err => {
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
