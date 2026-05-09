/**
 * v7.2.7 FIX #6 — TELEGRAM ALERT WORKER
 * 
 * Decoupled from cron/UI loop
 * Runs as independent async task
 * Does NOT block dashboard updates
 */

import { sendAlert, canSendAlert } from "./telegram-v6";

export type TelegramAlertJob = {
  symbol: string;
  mode: "SNIPER" | "CONFIRMED";
  direction: "LONG" | "SHORT";
  score: number;
  price: number;
  queued: number; // timestamp
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
        // Check cooldown
        if (await canSendAlert(job.symbol, job.mode, job.direction)) {
          // Send alert (async, don't await in tight loop)
          sendAlert({
            symbol: job.symbol,
            mode: job.mode,
            direction: job.direction,
            score: job.confidence,
            reason: `${job.mode} ${job.direction}`,
            price: job.price,
            momentum: {},
          }).catch(err => {
            console.log(`[ALERT_WORKER] Failed to send ${job.symbol}:`, err);
          });
          
          console.log(`[ALERT_WORKER] Queued ${job.symbol} ${job.mode}`);
        } else {
          console.log(`[ALERT_WORKER] Cooldown active for ${job.symbol}`);
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
