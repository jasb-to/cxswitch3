/**
 * Signal Event → Supabase Consumer (v3.0.0)
 * 
 * Converts SignalEvent to database operations.
 * Supabase schema is ONLY touched through this consumer.
 * Zero coupling between strategy logic and DB schema.
 */

import { supabase } from "@/lib/supabase-client";
import { signalEventStream, SignalEvent, SignalEventType } from "./signal-event-contract";
import type { SignalState, SignalOutcome } from "./strategy";

/**
 * Maps event type to database state transition
 */
function getSignalState(eventType: SignalEventType): SignalState | null {
  switch (eventType) {
    case "SIGNAL_EMITTED":
      return "EARLY_OPEN";
    case "SIGNAL_CONFIRMED":
      return "CONFIRMED";
    case "SIGNAL_TP_HIT":
    case "SIGNAL_SL_HIT":
    case "SIGNAL_EXPIRED":
    case "SIGNAL_MANUAL_EXIT":
      return "END";
    default:
      return null;
  }
}

/**
 * Maps event type to outcome reason
 */
function getOutcome(eventType: SignalEventType): SignalOutcome | null {
  switch (eventType) {
    case "SIGNAL_TP_HIT":
      return "TP";
    case "SIGNAL_SL_HIT":
      return "SL";
    case "SIGNAL_EXPIRED":
      return "EXPIRED";
    case "SIGNAL_MANUAL_EXIT":
      return "MANUAL";
    default:
      return null;
  }
}

/**
 * Handle SIGNAL_EMITTED events — create new signal in DB
 */
async function handleSignalEmitted(event: SignalEvent) {
  console.log(`[SUPABASE CONSUMER] SIGNAL_EMITTED for ${event.payload.symbol} ${event.payload.direction} @ ${event.payload.entry_price}`);

  const { symbol, direction, entry_price, stop_loss, take_profit, confidence, breakout_level } = event.payload;

  const { data: inserted, error: insertErr } = await supabase
    .from("signals")
    .insert([
      {
        symbol,
        direction,
        state: "EARLY_OPEN",
        entry_price,
        stop_loss,
        take_profit,
        confidence,
        breakout_level,
      },
    ])
    .select()
    .single();

  if (insertErr) {
    console.error(`[SUPABASE CONSUMER ERROR] Insert failed: ${insertErr.message}`);
    throw insertErr;
  }

  console.log(`[SUPABASE CONSUMER] ✓ Signal ${inserted.id} created`);
}

/**
 * Handle SIGNAL_CONFIRMED events — upgrade signal state
 */
async function handleSignalConfirmed(event: SignalEvent) {
  console.log(`[SUPABASE CONSUMER] SIGNAL_CONFIRMED for ${event.payload.symbol}`);

  const { symbol, direction } = event.payload;

  // Find the existing EARLY_OPEN signal
  const { data: existing, error: queryErr } = await supabase
    .from("signals")
    .select("*")
    .eq("symbol", symbol)
    .eq("direction", direction)
    .eq("state", "EARLY_OPEN")
    .order("created_at", { ascending: false })
    .limit(1)
    .single();

  if (queryErr || !existing) {
    console.error(`[SUPABASE CONSUMER ERROR] No EARLY_OPEN signal found for ${symbol} ${direction}`);
    throw new Error("No active signal to confirm");
  }

  // Update to CONFIRMED
  const { error: updateErr } = await supabase
    .from("signals")
    .update({ state: "CONFIRMED" })
    .eq("id", existing.id);

  if (updateErr) {
    console.error(`[SUPABASE CONSUMER ERROR] Update to CONFIRMED failed: ${updateErr.message}`);
    throw updateErr;
  }

  console.log(`[SUPABASE CONSUMER] ✓ Signal ${existing.id} confirmed`);
}

/**
 * Handle exit events (TP/SL/EXPIRED/MANUAL) — close signal
 */
async function handleSignalExit(event: SignalEvent) {
  const outcome = getOutcome(event.type);
  console.log(`[SUPABASE CONSUMER] SIGNAL_${event.type} for ${event.payload.symbol} (${outcome})`);

  const { symbol, direction } = event.payload;

  // Find the active signal (EARLY_OPEN or CONFIRMED)
  const { data: existing, error: queryErr } = await supabase
    .from("signals")
    .select("*")
    .eq("symbol", symbol)
    .eq("direction", direction)
    .in("state", ["EARLY_OPEN", "CONFIRMED"])
    .order("created_at", { ascending: false })
    .limit(1)
    .single();

  if (queryErr || !existing) {
    console.error(`[SUPABASE CONSUMER ERROR] No active signal found for ${symbol} ${direction}`);
    throw new Error("No active signal to exit");
  }

  // Calculate PNL if exit happened
  let pnl: number | null = null;
  if (event.metadata?.pnl !== undefined) {
    pnl = event.metadata.pnl;
  } else if (event.type === "SIGNAL_TP_HIT" || event.type === "SIGNAL_SL_HIT") {
    // Calculate from structure if not provided
    const riskAmount = existing.entry_price - existing.stop_loss;
    if (event.type === "SIGNAL_TP_HIT") {
      pnl = existing.entry_price > existing.stop_loss
        ? (existing.take_profit - existing.entry_price) * 100 / existing.entry_price
        : (existing.entry_price - existing.take_profit) * 100 / existing.entry_price;
    } else {
      pnl = existing.direction === "LONG"
        ? -Math.abs(riskAmount) * 100 / existing.entry_price
        : Math.abs(riskAmount) * 100 / existing.entry_price;
    }
  }

  // Update signal with exit data
  const { error: updateErr } = await supabase
    .from("signals")
    .update({
      state: "END",
      outcome,
      pnl,
      updated_at: new Date().toISOString(),
    })
    .eq("id", existing.id);

  if (updateErr) {
    console.error(`[SUPABASE CONSUMER ERROR] Exit update failed: ${updateErr.message}`);
    throw updateErr;
  }

  console.log(`[SUPABASE CONSUMER] ✓ Signal ${existing.id} exited (${outcome}) | PNL: ${pnl?.toFixed(2)}%`);
}

/**
 * Initialize event consumers
 * Subscribe to all event types and persist to database
 */
export function initializeSupabaseConsumer() {
  signalEventStream.subscribe("SIGNAL_EMITTED", handleSignalEmitted);
  signalEventStream.subscribe("SIGNAL_CONFIRMED", handleSignalConfirmed);
  signalEventStream.subscribe("SIGNAL_TP_HIT", handleSignalExit);
  signalEventStream.subscribe("SIGNAL_SL_HIT", handleSignalExit);
  signalEventStream.subscribe("SIGNAL_EXPIRED", handleSignalExit);
  signalEventStream.subscribe("SIGNAL_MANUAL_EXIT", handleSignalExit);

  console.log("[SUPABASE CONSUMER] Initialized — listening to signal events");
}
