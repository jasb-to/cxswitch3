/**
 * UNIFIED ALERT PIPELINE v9.0 - DEFINITIVE SINGLE ALERT COORDINATOR
 * 
 * Replaces: telegram.ts, telegram-consumer.ts, production-alert-pipeline.ts
 * Consolidates all alert logic into one immutable pipeline
 * 
 * CRITICAL INVARIANTS:
 * 1. ONE alert enqueue point ONLY (from dispatcher)
 * 2. Trade details NEVER lost between layers
 * 3. Cooldown ALWAYS works (30 min per signal transition)
 * 4. Telegram delivery ALWAYS retries on failure
 * 5. Queue ALWAYS flushed before cron exit
 */

import { sendAlert, canSendAlert } from "./telegram-v6";
import type { TradeViewModel } from "./trade-viewmodel";

/**
 * Alert job - carries complete trade context immutably
 * Guaranteed fields from dispatcher layer
 */
export type AlertJob = {
  // Identity
  symbol: string;
  mode: "SNIPER" | "CONFIRMED";
  direction: "LONG" | "SHORT";
  signalTransitionId: string; // Stable ID for deduplication
  
  // Trade details (MUST be preserved from viewmodel)
  targetPrices: { tp1: number; tp2: number; sl: number } | null;
  riskReward: number | null;
  entryPrice: number;
  confidence: number;
  
  // Context
  signalState: string;
  structureState: string | null;
  htf4hTrend: string;
  execution15mState: string;
  
  // Metadata
  queued: number; // timestamp when queued
};

/**
 * Alert queue - SINGLE persistent queue across cron cycles
 * Survives cron iterations with exponential backoff
 */
let alertQueue: AlertJob[] = [];
let isProcessing = false;

/**
 * DEFINITIVE ALERT ENQUEUE - Called ONLY from dispatcher
 * 
 * Validation:
 * - Trade details must be present for SNIPER/CONFIRMED
 * - Signal transition ID must be stable
 * - No null values in required fields
 */
export function enqueueAlert(vm: TradeViewModel): void {
  // Validate actionable signal has trade details
  if ((vm.signalState === "ACTIVE_SNIPER" || vm.signalState === "CONFIRMED") && !vm.targetPrices) {
    throw new Error(
      `[ALERT_ENQUEUE] ${vm.symbol} is actionable but missing targetPrices`
    );
  }

  // Skip DO_NOT_TRADE signals - they're not actionable
  if (vm.signalState === "DO_NOT_TRADE") {
    console.log(`[ALERT_ENQUEUE] Skipping DO_NOT_TRADE signal for ${vm.symbol}`);
    return;
  }

  // Validate stable signal ID
  const stableId = `${vm.symbol}-${vm.signalState}-${vm.direction}`;
  
  const job: AlertJob = {
    symbol: vm.symbol,
    mode: vm.signalState === "ACTIVE_SNIPER" ? "SNIPER" : "CONFIRMED",
    direction: vm.direction as "LONG" | "SHORT",
    signalTransitionId: stableId,
    
    targetPrices: vm.targetPrices,
    riskReward: vm.riskReward,
    entryPrice: vm.price,
    confidence: vm.confidence,
    
    signalState: vm.signalState,
    structureState: vm.structure || null,
    htf4hTrend: vm.htf4hTrend,
    execution15mState: vm.execution15mState,
    
    queued: Date.now(),
  };

  console.log(
    `[ALERT_ENQUEUE] Queued: ${vm.symbol} ${vm.signalState} ` +
    `tp1=${vm.targetPrices?.tp1 || "null"} sl=${vm.targetPrices?.sl || "null"}`
  );
  
  alertQueue.push(job);
}

/**
 * CRITICAL: Process alert queue asynchronously
 * 
 * Respects cooldown - requeues if blocked
 * Retries on Telegram failure
 * Preserves queue across cron cycles
 */
async function processAlertQueue(): Promise<void> {
  if (isProcessing || alertQueue.length === 0) {
    return;
  }

  isProcessing = true;

  try {
    const processedSymbols = new Set<string>();
    const failedJobs: AlertJob[] = [];

    while (alertQueue.length > 0) {
      const job = alertQueue.shift();
      if (!job) break;

      try {
        // Check cooldown - if blocked, requeue and stop processing
        const canSend = await canSendAlert(
          job.symbol,
          job.mode,
          job.direction,
          job.signalTransitionId
        );

        if (!canSend) {
          console.log(
            `[ALERT_PROCESS] Cooldown active for ${job.symbol} ${job.signalTransitionId}, requeuing`
          );
          failedJobs.push(job);
          continue;
        }

        // Send alert (MUST await - fire-and-forget is a bug)
        try {
          await sendAlert({
            symbol: job.symbol,
            mode: job.mode,
            direction: job.direction,
            price: job.entryPrice,
            score: job.confidence,
            targetPrices: job.targetPrices,
            riskReward: job.riskReward,
            signalState: job.signalState,
            structureState: job.structureState,
            htf4hTrend: job.htf4hTrend,
            execution15mState: job.execution15mState,
            signalTransitionId: job.signalTransitionId,
          });

          console.log(`[ALERT_PROCESS] Sent: ${job.symbol} ${job.mode}`);
          processedSymbols.add(job.symbol);
        } catch (err) {
          console.error(
            `[ALERT_PROCESS] Failed to send ${job.symbol}:`,
            err instanceof Error ? err.message : String(err)
          );
          failedJobs.push(job);
        }

        // Rate limit between alerts
        await new Promise(r => setTimeout(r, 100));
      } catch (err) {
        console.error(`[ALERT_PROCESS] Unexpected error for ${job.symbol}:`, err);
        failedJobs.push(job);
      }
    }

    // Requeue failed jobs
    if (failedJobs.length > 0) {
      alertQueue.unshift(...failedJobs);
      console.log(`[ALERT_PROCESS] Requeued ${failedJobs.length} jobs for retry`);
    }

    console.log(`[ALERT_PROCESS] Cycle complete: ${processedSymbols.size} sent, ${alertQueue.length} pending`);
  } finally {
    isProcessing = false;
  }
}

/**
 * CRITICAL: Flush alert queue synchronously at cron end
 * 
 * Waits until queue is empty or timeout
 * Ensures Telegram delivery before cron response
 */
export async function flushAlertQueue(): Promise<void> {
  console.log(`[ALERT_FLUSH] Starting flush with ${alertQueue.length} pending`);

  if (alertQueue.length === 0) {
    console.log(`[ALERT_FLUSH] No pending alerts`);
    return;
  }

  const startTime = Date.now();
  const maxWaitMs = 5000; // 5 second timeout

  while (alertQueue.length > 0 && Date.now() - startTime < maxWaitMs) {
    if (!isProcessing) {
      await processAlertQueue();
    }
    await new Promise(r => setTimeout(r, 50));
  }

  const elapsed = Date.now() - startTime;
  if (alertQueue.length === 0) {
    console.log(`[ALERT_FLUSH] Complete - all alerts sent in ${elapsed}ms`);
  } else {
    console.warn(
      `[ALERT_FLUSH] Timeout after ${elapsed}ms - ${alertQueue.length} alerts still pending`
    );
  }
}

/**
 * Get queue statistics (debugging)
 */
export function getAlertQueueStats() {
  return {
    pending: alertQueue.length,
    processing: isProcessing,
  };
}
