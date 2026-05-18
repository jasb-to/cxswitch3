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
        // Alert layer is DUMB TRANSPORT only — no signal validation here.
        // Execution layer is the single source of truth.
        // Check cooldown
        // STEP 2 FIX: Pass signalTransitionId for granular dedupe
        if (await canSendAlert(job.symbol, job.mode, job.direction, job.signalTransitionId)) {
          // CRITICAL FIX: MUST await sendAlert - fire-and-forget async bug caused silent failures
          // Without await, the function returns before Telegram delivery completes
          try {
            await sendAlert(job);
            console.log(`[ALERT_WORKER] Telegram sent for ${job.symbol} ${job.mode} (${job.signalState})`);
          } catch (err) {
            console.error(`[ALERT_WORKER] Failed to send ${job.symbol}:`, err);
            // Re-throw so the caller knows delivery failed
            throw err;
          }
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
