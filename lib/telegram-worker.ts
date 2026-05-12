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
 * v7.5.6: Alert state transition tracker
 * Tracks previous signal state per symbol + direction to detect transitions only
 * Key: symbol + direction (e.g., "SOL-SHORT")
 * Value: { prevState, prevIgnition, lastAlertTime }
 */
const alertStateMemory: Map<string, { prevState: string; prevIgnition: number; lastAlertTime: number }> = new Map();

/**
 * Get memory key for alert deduplication
 */
function getAlertMemoryKey(symbol: string, direction: string): string {
  return `${symbol}-${direction}`;
}

/**
 * Enqueue alert for processing (v7.2.7 FIX #6)
 * v7.5.6: Only enqueue on state TRANSITIONS, not persistence
 * Non-blocking - returns immediately
 */
export function enqueueAlert(job: TelegramAlertJob) {
  // v7.5.6: Check if this is a state transition (not persistence)
  const memoryKey = getAlertMemoryKey(job.symbol, job.direction);
  const memory = alertStateMemory.get(memoryKey);
  
  console.log(`[ALERT_ENQUEUE_DEBUG] ${job.symbol} ${job.direction}: signalState=${job.signalState}, mode=${job.mode}, prevState=${memory?.prevState || "none"}, ignition=${job.card.ignitionProbability}`);
  
  // Only enqueue if:
  // 1. No previous state recorded (first time)
  // 2. State changed from previous state
  // 3. Ignition probability band changed (e.g., from BUILDING to ACTIVE_SNIPER)
  const isStateTransition = !memory || memory.prevState !== job.signalState;
  
  if (!isStateTransition) {
    console.log(`[ALERT_DEDUP] ${job.symbol} ${job.direction}: state persists as ${job.signalState} (ignition ${job.card.ignitionProbability}), skipping duplicate alert`);
    // Update memory timestamp but don't enqueue
    alertStateMemory.set(memoryKey, {
      prevState: job.signalState,
      prevIgnition: job.card.ignitionProbability,
      lastAlertTime: memory?.lastAlertTime || 0,
    });
    return;
  }
  
  // State transitioned! Log transition and enqueue alert
  console.log(`[ALERT_TRANSITION] ${job.symbol} ${job.direction}: ${memory?.prevState || "NONE"} → ${job.signalState} (ignition ${job.card.ignitionProbability}), queueing alert`);
  
  // Update memory with new state
  alertStateMemory.set(memoryKey, {
    prevState: job.signalState,
    prevIgnition: job.card.ignitionProbability,
    lastAlertTime: Date.now(),
  });
  
  // Enqueue for processing
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
