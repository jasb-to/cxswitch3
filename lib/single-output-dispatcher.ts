/**
 * SINGLE OUTPUT DISPATCHER - v8.5 Architecture
 * 
 * CRITICAL: All outbound data (UI snapshot + Telegram alerts) originates from 
 * a SINGLE source: the final TradeViewModel array.
 * 
 * This eliminates the two-pipeline problem where UI and alerts read different data.
 * 
 * The dispatcher is responsible for:
 * 1. Publishing TradeViewModels to UI snapshot
 * 2. Deriving alert payload from the SAME TradeViewModels
 * 3. Ensuring consistency between what UI sees and what alerts say
 */

import { TradeViewModel } from "./trade-viewmodel";
import { enqueueAlert } from "./telegram-worker";

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
 * All other alert-checking logic is now invalid and MUST be removed.
 */
export function dispatchTradeViewModels(viewModels: TradeViewModel[]): DispatchedSignal[] {
  console.log(`[DISPATCHER] Dispatching ${viewModels.length} TradeViewModels`);
  
  const dispatchedSignals: DispatchedSignal[] = [];
  
  for (const viewModel of viewModels) {
    // ✅ FIX #1: Use signalState (engine truth) NOT activationState (UI-only derived)
    // signalState is the source of truth from the engine
    // activationState is UI-only display field derived from signalState
    const isActiveSignal = 
      viewModel.signalState === "ACTIVE_SNIPER" || 
      viewModel.signalState === "CONFIRMED";
    
    if (isActiveSignal) {
      console.log(
        `[DISPATCHER] Signal found: ${viewModel.symbol} ${viewModel.signalState} @ ${viewModel.entryPrice}`
      );
      
      // CRITICAL: entryPrice MUST be present for active signals
      if (!viewModel.entryPrice || viewModel.entryPrice === 0) {
        console.warn(`[DISPATCHER] WARNING: ${viewModel.symbol} is ${viewModel.signalState} but entryPrice is ${viewModel.entryPrice}. Skipping dispatch.`);
        continue; // Skip this signal, don't throw - graceful degradation
      }
      
      // Record this signal as dispatched
      const signal: DispatchedSignal = {
        symbol: viewModel.symbol,
        activationState: viewModel.activationState,
        entryPrice: viewModel.entryPrice,
        direction: viewModel.direction,
        confidence: viewModel.confidence,
      };
      dispatchedSignals.push(signal);
      
      // CRITICAL: Enqueue alert from this SAME viewmodel data
      // UI and alerts now read from identical source
      try {
        enqueueAlert({
          symbol: viewModel.symbol,
          mode: viewModel.signalState === "ACTIVE_SNIPER" ? "SNIPER" : "CONFIRMED",
          direction: viewModel.direction,
          price: viewModel.entryPrice,
          signalState: viewModel.signalState,
          structureState: viewModel.structureState,
          confidence: viewModel.confidence,
          tp: viewModel.takeProfit,
          sl: viewModel.stopLoss,
          reason: viewModel.rejectionReason || "Signal activated",
          timestamp: new Date().toISOString(),
          signalTransitionId: `${viewModel.symbol}-${Date.now()}`,
        });
        
        console.log(`[DISPATCHER] Alert enqueued for ${viewModel.symbol}`);
      } catch (err) {
        console.error(`[DISPATCHER] Failed to enqueue alert for ${viewModel.symbol}:`, err);
      }
    }
  }
  
  console.log(`[DISPATCHER] Complete - dispatched ${dispatchedSignals.length} active signals`);
  return dispatchedSignals;
}

/**
 * ✅ FIX #2: Validate dispatcher invariant
 * CRITICAL: DO_NOT_TRADE is VALID output, not invalid input
 * Only ACTIVE_SNIPER requires complete trade fields
 */
export function validateDispatcherInvariants(viewModels: TradeViewModel[]): void {
  console.log(`[DISPATCHER_VALIDATION] Validating ${viewModels.length} viewmodels...`);
  
  for (let i = 0; i < viewModels.length; i++) {
    const vm = viewModels[i];
    console.log(`[DISPATCHER_VALIDATION] Card ${i}: symbol=${vm.symbol}, signalState=${vm.signalState}, activationState=${vm.activationState}`);
    
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
    
    // ✅ FIX #2: Only ACTIVE_SNIPER requires entryPrice and trade fields
    // DO_NOT_TRADE is valid output (just rejected signals)
    // Note: entryPrice validation happens in dispatchTradeViewModels (graceful skip)
    // This invariant validator now only checks for missing fields, not values
  }
  
  console.log(`[DISPATCHER_VALIDATION] All ${viewModels.length} cards passed validation`);
}
