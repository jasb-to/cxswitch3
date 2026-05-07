/**
 * Signal Event → Telegram Consumer (v3.0.0)
 * 
 * Converts SignalEvent to Telegram alerts.
 * Receives the same event stream as Supabase, eliminating duplicate logic.
 */

import { signalEventStream, SignalEvent } from "./signal-event-contract";
import { sendSignalAlert, sendTradeCloseAlert } from "./telegram";

/**
 * Handle SIGNAL_EMITTED events — send entry alert
 */
async function handleSignalEmittedAlert(event: SignalEvent) {
  const { symbol, direction, entry_price, stop_loss, take_profit, confidence } = event.payload;

  console.log(`[TELEGRAM CONSUMER] Sending ENTRY alert for ${symbol} ${direction}`);

  // Use sendSignalAlert with the signal data
  await sendSignalAlert({
    id: undefined,
    symbol,
    direction: direction as any,
    state: "EARLY_OPEN",
    entry_price,
    stop_loss,
    take_profit,
    confidence,
    breakout_level: entry_price,
  });
}

/**
 * Handle SIGNAL_CONFIRMED events — send confirmation alert
 */
async function handleSignalConfirmedAlert(event: SignalEvent) {
  const { symbol, direction, entry_price, stop_loss, take_profit, confidence } = event.payload;

  console.log(`[TELEGRAM CONSUMER] Sending CONFIRMED alert for ${symbol} ${direction}`);

  // Send confirmed signal
  await sendSignalAlert({
    id: undefined,
    symbol,
    direction: direction as any,
    state: "CONFIRMED",
    entry_price,
    stop_loss,
    take_profit,
    confidence,
    breakout_level: entry_price,
  });
}

/**
 * Handle exit events — send close alert
 */
async function handleSignalExitAlert(event: SignalEvent) {
  const { symbol, direction, entry_price, stop_loss, take_profit } = event.payload;
  const outcome = event.metadata?.outcome || "UNKNOWN";

  console.log(`[TELEGRAM CONSUMER] Sending EXIT alert for ${symbol} ${direction} (${outcome})`);

  const exitPrice = outcome === "TP" ? take_profit : stop_loss;

  // Create a Signal object for sendTradeCloseAlert
  await sendTradeCloseAlert({
    id: undefined,
    symbol,
    direction: direction as any,
    state: "END",
    entry_price,
    stop_loss,
    take_profit,
    confidence: 0,
    breakout_level: entry_price,
    outcome: outcome as any,
    pnl: event.metadata?.pnl,
  });
}

/**
 * Initialize Telegram event consumers
 */
export function initializeTelegramConsumer() {
  signalEventStream.subscribe("SIGNAL_EMITTED", handleSignalEmittedAlert);
  signalEventStream.subscribe("SIGNAL_CONFIRMED", handleSignalConfirmedAlert);
  signalEventStream.subscribe("SIGNAL_TP_HIT", handleSignalExitAlert);
  signalEventStream.subscribe("SIGNAL_SL_HIT", handleSignalExitAlert);
  signalEventStream.subscribe("SIGNAL_EXPIRED", handleSignalExitAlert);
  signalEventStream.subscribe("SIGNAL_MANUAL_EXIT", handleSignalExitAlert);

  console.log("[TELEGRAM CONSUMER] Initialized — listening to signal events");
}
