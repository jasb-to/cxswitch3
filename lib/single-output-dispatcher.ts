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
    // Check if this viewmodel represents a tradeable signal
    const isActiveSignal = 
      viewModel.activationState === "ACTIVE_SNIPER" || 
      viewModel.activationState === "CONFIRMED";
    
    if (isActiveSignal) {
      console.log(
        `[DISPATCHER] Signal found: ${viewModel.symbol} ${viewModel.activationState} @ ${viewModel.entryPrice}`
      );
      
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
          mode: viewModel.activationState === "ACTIVE_SNIPER" ? "SNIPER" : "CONFIRMED",
          direction: viewModel.direction,
          price: viewModel.entryPrice,
          signalState: viewModel.activationState,
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
 * Validate dispatcher invariant: all viewmodels have required fields
 * CRITICAL FIX: Do NOT require entryPrice for DO_NOT_TRADE cards
 * DO_NOT_TRADE cards are valid - they just represent rejected signals
 */
export function validateDispatcherInvariants(viewModels: TradeViewModel[]): void {
  for (const vm of viewModels) {
    // All cards must have these basic fields
    if (!vm.symbol) {
      throw new Error(`[DISPATCHER_INVARIANT] Missing symbol in TradeViewModel`);
    }
    if (!vm.activationState) {
      throw new Error(`[DISPATCHER_INVARIANT] Missing activationState for ${vm.symbol}`);
    }
    if (typeof vm.confidence !== "number") {
      throw new Error(`[DISPATCHER_INVARIANT] Missing/invalid confidence for ${vm.symbol}`);
    }
    
    // CRITICAL: Only ACTIVE_SNIPER and CONFIRMED require entryPrice
    // DO_NOT_TRADE cards don't need entryPrice (they're rejected signals)
    if ((vm.activationState === "ACTIVE_SNIPER" || vm.activationState === "CONFIRMED") && 
        typeof vm.entryPrice !== "number") {
      throw new Error(
        `[DISPATCHER_INVARIANT] ${vm.symbol} is ${vm.activationState} but missing entryPrice`
      );
    }
  }
}
