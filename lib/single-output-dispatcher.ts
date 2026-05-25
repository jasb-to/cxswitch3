/**
 * SINGLE OUTPUT DISPATCHER - v8.5 Architecture
 * 
 * CRITICAL: All outbound data (UI snapshot + Telegram alerts) originates from 
 * a SINGLE source: the final TradeViewModel array.
 * 
 * This eliminates the two-pipeline problem where UI and alerts read different data.
 * 
 * TELEGRAM DEDUPLICATION: Use stable signalTransitionId based on symbol+mode+direction.
 * This ensures:
 * - Same signal = same ID = cooldown works
 * - Edge-triggered alerts only (state change = new ID hash)
 * - No spam on cron retries
 */

import { TradeViewModel } from "./trade-viewmodel";
import { enqueueAlert } from "./unified-alert-pipeline";
import { logForensicPoint } from "./forensic-logger";

export interface DispatchedSignal {
  symbol: string;
  activationState: "ACTIVE_SNIPER" | "CONFIRMED" | "DO_NOT_TRADE";
  previousState?: "ACTIVE_SNIPER" | "CONFIRMED" | "DO_NOT_TRADE";
  entryPrice: number;
  direction: "LONG" | "SHORT" | "NEUTRAL";
  confidence: number;
}

/**
 * Dispatch TradeViewModels through single output channel
 * 
 * CRITICAL: This is THE ONLY place where alerts are enqueued.
 * Uses stable signalTransitionId for proper edge-triggered deduplication.
 */
export function dispatchTradeViewModels(viewModels: TradeViewModel[]): DispatchedSignal[] {
  console.log(`[DISPATCHER] Dispatching ${viewModels.length} TradeViewModels`);
  
  const dispatchedSignals: DispatchedSignal[] = [];
  
  for (const viewModel of viewModels) {
    // FORENSIC POINT 1: Log dispatcher input
    logForensicPoint("DISPATCHER_INPUT", viewModel, viewModel.symbol);
    
    // Only dispatch ACTIVE_SNIPER and CONFIRMED (active signals)
    const isActiveSignal = 
      viewModel.signalState === "ACTIVE_SNIPER" || 
      viewModel.signalState === "CONFIRMED";
    
    if (isActiveSignal) {
      console.log(
        `[DISPATCHER] Active signal: ${viewModel.symbol} ${viewModel.signalState} ` +
        `dir=${viewModel.direction} conf=${viewModel.confidence}% ` +
        `entry=${viewModel.targetPrices?.tp1 || viewModel.price || "?"}`
      );
      
      // CRITICAL: Validate all required fields before dispatch
      if (!viewModel.price || viewModel.price === 0) {
        console.warn(`[DISPATCHER] ${viewModel.symbol}: missing price, skipping`);
        continue;
      }
      if (!viewModel.targetPrices || !viewModel.targetPrices.tp1 || !viewModel.targetPrices.sl) {
        console.warn(
          `[DISPATCHER] ${viewModel.symbol}: incomplete trade details ` +
          `tp1=${viewModel.targetPrices?.tp1} sl=${viewModel.targetPrices?.sl}, skipping`
        );
        continue;
      }
      
      // Record signal
      const signal: DispatchedSignal = {
        symbol: viewModel.symbol,
        activationState: viewModel.activationState,
        entryPrice: viewModel.price,
        direction: viewModel.direction,
        confidence: viewModel.confidence,
      };
      dispatchedSignals.push(signal);
      
      // FORENSIC POINT 2: Log dispatcher output (dispatched signal)
      logForensicPoint("DISPATCHER_OUTPUT", signal, signal.symbol);
      
      // Enqueue alert from SAME viewmodel data
      try {
        enqueueAlert(viewModel);
        console.log(`[DISPATCHER] Alert enqueued: ${viewModel.symbol}`);
      } catch (err) {
        console.error(`[DISPATCHER] Failed to enqueue alert for ${viewModel.symbol}:`, err);
      }
    }
  }
  
  console.log(`[DISPATCHER] Complete - dispatched ${dispatchedSignals.length} active signals`);
  return dispatchedSignals;
}

/**
 * Validate dispatcher invariants
 * DO_NOT_TRADE is valid output (rejected signals), not an error
 */
export function validateDispatcherInvariants(viewModels: TradeViewModel[]): void {
  console.log(`[DISPATCHER_VALIDATION] Validating ${viewModels.length} viewmodels...`);
  
  for (let i = 0; i < viewModels.length; i++) {
    const vm = viewModels[i];
    
    // All cards must have these basic fields
    if (!vm.symbol) {
      throw new Error(`[DISPATCHER_INVARIANT] Card ${i} missing symbol`);
    }
    if (!vm.signalState) {
      throw new Error(`[DISPATCHER_INVARIANT] Card ${i} (${vm.symbol}) missing signalState`);
    }
    if (!vm.activationState) {
      throw new Error(`[DISPATCHER_INVARIANT] Card ${i} (${vm.symbol}) missing activationState`);
    }
    
    console.log(
      `[DISPATCHER_VALIDATION] ${vm.symbol}: state=${vm.signalState} ` +
      `has_tp=${!!vm.targetPrices?.tp1} rr=${vm.riskReward}`
    );
  }
  
  console.log(`[DISPATCHER_VALIDATION] All ${viewModels.length} cards passed validation`);
}
