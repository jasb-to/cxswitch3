import { supabase } from "@/lib/supabase-client";
import { fetchCandles, type Candle } from "./kraken";
import { calculateStopLoss, calculateTakeProfit, calculateRiskReward, calculateVolatility } from "./risk-utils";
import { sendTradeCloseAlert } from "./telegram";
import {
  validateSignalPayload,
  logSignalGenerated,
  logPayloadSerialized,
  logValidationPassed,
  logInsertAttempted,
  logInsertSuccess,
  logValidationFailed,
  logInsertFailed,
  logDbVerified,
  type SignalInsert,
  type ValidationResult,
} from "./signal-serializer";
import { ACTIVE_SIGNAL_STATES, TERMINAL_SIGNAL_STATES } from "./signal-states";
import { logStateTransition } from "./signal-state-transition";
import { logTrace, createTrace, type SignalTrace } from "./signal-trace";
import { scanSignalHealth } from "./signal-health";

export type SignalDirection = "LONG" | "SHORT";
/**
 * SIGNAL LIFECYCLE STATE MODEL (v2.9.0+)
 * ─────────────────────────────────────────────────────────────────
 * EARLY_OPEN: Signal entry triggered by probability model. Persists until
 *             explicitly closed (no auto-expiry). Queryable in all read paths.
 *             This is the primary active state for new signals.
 * CONFIRMED:  Signal entry confirmed after retest. Persists until closed.
 *             Treated identically to EARLY_OPEN in active queries.
 * END:        Signal closed (manual end, TP hit, SL hit, or expired).
 *             Excluded from active queries. Persists for history.
 *
 * ALL QUERIES INCLUDE: .in("state", ["EARLY_OPEN", "CONFIRMED"])
 * NO FILTERING that excludes EARLY_OPEN based on time, staleness, or assumptions.
 * NO LEGACY STATES: "EARLY", "EARLY-OPEN", or other variants must not exist.
 * ─────────────────────────────────────────────────────────────────
 */
export type SignalState = "EARLY_OPEN" | "CONFIRMED" | "END";
export type SignalOutcome = "TP" | "SL" | "EXPIRED" | "MANUAL";

/**
 * Safe signal insert wrapper (v2.7.1)
 * Full deterministic lifecycle tracing with fail-fast validation and insert confirmation invariants.
 * NO SILENT FAILURES — all rejection paths are logged and traced.
 */
async function safeInsertSignal(payload: SignalInsert, trace: SignalTrace) {
  try {
    // Stage 1: Signal generation (already logged in caller)
    logPayloadSerialized(payload);

    // Stage 2: Strict validation with fail-fast
    const validation: ValidationResult = validateSignalPayload(payload);
    if (!validation.valid) {
      trace.decision = "FAILED_INSERT";
      trace.reasons.push(`Validation failed: ${validation.errors.join("; ")}`);
      trace.dbResult = { success: false, error: `Validation errors: ${validation.errors.join("; ")}` };
      logValidationFailed(validation.errors.join("; "), payload);
      logTrace(trace);
      return null;
    }

    logValidationPassed(payload.symbol);

    // Stage 3: Attempt insert
    logInsertAttempted(payload.symbol);

    const { data: inserted, error: insertErr } = await supabase
      .from("signals")
      .insert([payload])
      .select()
      .single();

    // INSERT CONFIRMATION INVARIANT: must return persisted signal
    if (insertErr) {
      trace.decision = "FAILED_INSERT";
      trace.reasons.push(`Insert failed: ${insertErr.message}`);
      trace.dbResult = { success: false, error: insertErr.message };
      logInsertFailed(insertErr.message, payload);
      logTrace(trace);
      throw new Error(`[SIGNAL PIPELINE] Insert failed: ${insertErr.message}`);
    }

    if (!inserted || !inserted.id) {
      trace.decision = "FAILED_INSERT";
      trace.reasons.push("Insert returned no persisted signal");
      trace.dbResult = { success: false, error: "No signal returned from database" };
      logInsertFailed("No signal returned", payload);
      logTrace(trace);
      throw new Error("[SIGNAL PIPELINE] Insert succeeded but returned no signal ID");
    }

    // Stage 4: Log success
    logInsertSuccess(payload.symbol, inserted.id);

    // Stage 5: DB verification — confirm signal is queryable immediately
    const { data: verify, error: verifyErr } = await supabase
      .from("signals")
      .select("id,state,symbol")
      .eq("id", inserted.id)
      .single();

    if (verifyErr || !verify) {
      console.error("[SIGNAL PIPELINE] DB VERIFICATION FAILED:", verifyErr?.message);
      throw new Error(`[SIGNAL PIPELINE] Verification failed: signal not readable immediately after insert`);
    }

    logDbVerified(payload.symbol, inserted.id, verify.state);

    // Success — trace is updated
    trace.decision = "TRIGGERED";
    trace.dbResult = { success: true, signalId: inserted.id };
    logTrace(trace);

    return inserted;
  } catch (err) {
    const reason = err instanceof Error ? err.message : String(err);
    console.error("[SIGNAL PIPELINE CRASH]", reason);
    trace.decision = "FAILED_INSERT";
    trace.reasons.push(`Exception: ${reason}`);
    trace.dbResult = { success: false, error: reason };
    logTrace(trace);
    // Re-throw for upstream handling (no silent suppression)
    throw err;
  }
}

/**
 * Calculate ADX (Average Directional Index) for trend strength.
 * ADX > 25 = strong trend, ADX < 20 = weak trend/ranging
 * Returns value 0-100.
 */
function calculateADX(candles: Candle[]): number {
  if (candles.length < 14) return 0; // Need at least 14 candles for ADX

  // Calculate +DM, -DM, TR over last 14 periods
  let plusDM = 0, minusDM = 0, tr = 0;

  for (let i = 1; i < Math.min(candles.length, 14); i++) {
    const curr = candles[i];
    const prev = candles[i - 1];

    // True Range
    const hl = curr.high - curr.low;
    const hc = Math.abs(curr.high - prev.close);
    const lc = Math.abs(curr.low - prev.close);
    tr += Math.max(hl, hc, lc);

    // Directional Movement
    const upMove = curr.high - prev.high;
    const downMove = prev.low - curr.low;

    if (upMove > 0 && upMove > downMove) {
      plusDM += upMove;
    } else if (downMove > 0 && downMove > upMove) {
      minusDM += downMove;
    }
  }

  const atr = tr / 14;
  const plusDI = atr > 0 ? (plusDM / atr) * 100 : 0;
  const minusDI = atr > 0 ? (minusDM / atr) * 100 : 0;

  const di = Math.abs(plusDI - minusDI) / (plusDI + minusDI || 1);
  const adx = Math.min(100, di * 100); // Simplified ADX

  return Math.round(adx * 10) / 10;
}

/**
 * Calculate Exponential Moving Average (EMA).
 * Used for trend direction and timing.
 */
function calculateEMA(candles: Candle[], period: number): number {
  if (candles.length < period) return 0;

  const k = 2 / (period + 1);
  let ema = candles[0].close;

  for (let i = 1; i < candles.length; i++) {
    ema = candles[i].close * k + ema * (1 - k);
  }

  return ema;
}

/**
 * Calculate RSI (Relative Strength Index) for momentum direction.
 * RSI > 50 = bullish, RSI < 50 = bearish
 * Used for timing, not gating.
 */
function calculateRSI(candles: Candle[], period: number = 14): number {
  if (candles.length < period + 1) return 50;

  let gains = 0, losses = 0;

  for (let i = 1; i <= period; i++) {
    const change = candles[i].close - candles[i - 1].close;
    if (change > 0) gains += change;
    else losses += Math.abs(change);
  }

  const avgGain = gains / period;
  const avgLoss = losses / period;
  const rs = avgLoss === 0 ? 100 : avgGain / avgLoss;
  const rsi = 100 - 100 / (1 + rs);

  return Math.round(rsi * 10) / 10;
}

/**
 * Check if EMA8 is curling toward or beginning to cross EMA21.
 * Returns { curlingUp: boolean, curlingDown: boolean, gap: number }
 */
function checkEMACurling(
  candles4h: Candle[],
  candles15m: Candle[]
): { curlingUp: boolean; curlingDown: boolean; gap: number } {
  if (candles4h.length < 2 || candles15m.length < 2) {
    return { curlingUp: false, curlingDown: false, gap: 0 };
  }

  const ema8 = calculateEMA(candles15m, 8);
  const ema21 = calculateEMA(candles15m, 21);
  const gap = ema8 - ema21;

  // Check if gap is narrowing (curling) or crossed
  const prevEma8 = calculateEMA(candles15m.slice(0, -1), 8);
  const prevEma21 = calculateEMA(candles15m.slice(0, -1), 21);
  const prevGap = prevEma8 - prevEma21;

  const curlingUp = gap > prevGap && ema8 >= ema21; // Gap closing from below or already above
  const curlingDown = gap < prevGap && ema8 <= ema21; // Gap closing from above or already below

  return { curlingUp, curlingDown, gap };
}

/**
 * Check if RSI has directional slope (not flat).
 * Returns { slopeUp: boolean, slopeDown: boolean, slope: number }
 */
function checkRSISlope(candles: Candle[], timeframe: "15m" | "5m" = "15m"): {
  slopeUp: boolean;
  slopeDown: boolean;
  slope: number;
} {
  if (candles.length < 3) {
    return { slopeUp: false, slopeDown: false, slope: 0 };
  }

  const period = timeframe === "15m" ? 14 : 14;
  const currentRSI = calculateRSI(candles, period);
  const prevRSI = calculateRSI(candles.slice(0, -1), period);
  const slope = currentRSI - prevRSI;

  const slopeUp = slope > 1; // RSI rising
  const slopeDown = slope < -1; // RSI falling

  return { slopeUp, slopeDown, slope };
}

/**
 * Calculate confidence score for a signal based on market structure, trend strength, and momentum.
 * Starts at base 70, applies adjustments, capped between 60-95.
 * Non-gating: always returns a confidence score, never prevents signal creation.
 */
function calculateConfidence(
  direction: "LONG" | "SHORT",
  adx: number | undefined,
  candles4h: Candle[],
  hasStrongMomentum: boolean,
  timingIndicators?: {
    emaCurling?: { curlingUp: boolean; curlingDown: boolean };
    rsi15m?: number;
    rsiSlope15m?: { slopeUp: boolean; slopeDown: boolean };
    rsiSlope5m?: { slopeUp: boolean; slopeDown: boolean };
  }
): { confidence: number; breakdown: string } {
  let confidence = 70;
  const adjustments: string[] = [];

  // 1. MARKET STRUCTURE BIAS
  if (candles4h.length >= 4) {
    // Get last 4 candles to identify structure
    const curr = candles4h[candles4h.length - 1];
    const prev = candles4h[candles4h.length - 2];
    const prevprev = candles4h[candles4h.length - 3];
    const prevprevprev = candles4h[candles4h.length - 4];

    // Current swing high/low vs previous
    const currSwingHigh = Math.max(curr.high, prev.high);
    const currSwingLow = Math.min(curr.low, prev.low);
    const prevSwingHigh = Math.max(prevprev.high, prevprevprev.high);
    const prevSwingLow = Math.min(prevprev.low, prevprevprev.low);

    // Determine structure
    const isBullishStructure = currSwingHigh > prevSwingHigh && currSwingLow > prevSwingLow;
    const isBearishStructure = currSwingHigh < prevSwingHigh && currSwingLow < prevSwingLow;

    if (isBullishStructure) {
      if (direction === "LONG") {
        confidence += 10;
        adjustments.push("bullish structure + LONG");
      } else {
        confidence -= 5;
        adjustments.push("bullish structure - SHORT");
      }
    } else if (isBearishStructure) {
      if (direction === "SHORT") {
        confidence += 10;
        adjustments.push("bearish structure + SHORT");
      } else {
        confidence -= 5;
        adjustments.push("bearish structure - LONG");
      }
    }
  }

  // 2. ADX TREND STRENGTH MODIFIER
  if (adx !== undefined) {
    if (adx > 25) {
      confidence += 5;
      adjustments.push(`strong trend (ADX ${adx.toFixed(1)})`);
    } else if (adx < 20) {
      confidence -= 5;
      adjustments.push(`weak trend (ADX ${adx.toFixed(1)})`);
    }
  }

  // 3. EMA CURLING TIMING BONUS (non-gating)
  if (timingIndicators?.emaCurling) {
    if (direction === "LONG" && timingIndicators.emaCurling.curlingUp) {
      confidence += 3;
      adjustments.push("EMA8 curling up");
    } else if (direction === "SHORT" && timingIndicators.emaCurling.curlingDown) {
      confidence += 3;
      adjustments.push("EMA8 curling down");
    }
  }

  // 4. RSI SLOPE TIMING BONUS (non-gating)
  if (timingIndicators?.rsiSlope15m) {
    if (direction === "LONG" && timingIndicators.rsiSlope15m.slopeUp) {
      confidence += 2;
      adjustments.push("RSI15m sloping up");
    } else if (direction === "SHORT" && timingIndicators.rsiSlope15m.slopeDown) {
      confidence += 2;
      adjustments.push("RSI15m sloping down");
    }
  }

  // 5. 5M IMPULSE TIMING BONUS (non-gating)
  if (timingIndicators?.rsiSlope5m) {
    if (direction === "LONG" && timingIndicators.rsiSlope5m.slopeUp) {
      confidence += 2;
      adjustments.push("5M impulse forming");
    } else if (direction === "SHORT" && timingIndicators.rsiSlope5m.slopeDown) {
      confidence += 2;
      adjustments.push("5M impulse forming");
    }
  }

  // 6. MOMENTUM BOOSTER
  if (hasStrongMomentum) {
    confidence += 5;
    adjustments.push("momentum confirmed");
  }

  // 4. CAP CONFIDENCE BETWEEN 60-95
  confidence = Math.max(60, Math.min(95, confidence));

  const breakdown = `[base:70 ${adjustments.map(a => `${a}`).join(" | ")}] = ${confidence}`;

  return { confidence, breakdown };
}


export interface Signal {
  id?: number;
  symbol: string;
  direction: SignalDirection;
  state: SignalState;
  entry_price: number;
  stop_loss: number;
  take_profit: number;
  confidence: number;
  breakout_level: number;
  pnl?: number | null;
  outcome?: SignalOutcome | null;
  alert_sent?: boolean;
  last_checked_candle?: number | null;
  created_at?: string;
  updated_at?: string;
}

export interface MarketContext {
  symbol: string;
  price: number;
  swingHigh: number | null;
  swingLow: number | null;
  distanceToHigh: number | null;
  distanceToLow: number | null;
  setup: "LONG_SETUP" | "SHORT_SETUP" | "NO_SETUP" | "ERROR";
  setupText: string;
  error?: boolean;
  trendlines?: number;
  volatility?: number;
  volatilityThreshold?: number;
  dataSource?: "KRAKEN" | "COINGECKO" | "CACHE";
  dataSourceTime?: number;
  adx?: number;
  candles4h?: Candle[];
  candles15m?: Candle[];
  candles5m?: Candle[];
  // Timing indicators
  ema8?: number; // 8 EMA on 15M
  ema21?: number; // 21 EMA on 15M
  emaCurling?: { curlingUp: boolean; curlingDown: boolean; gap: number };
  rsi15m?: number; // RSI on 15M
  rsi5m?: number; // RSI on 5M
  rsiSlope15m?: { slopeUp: boolean; slopeDown: boolean; slope: number };
  rsiSlope5m?: { slopeUp: boolean; slopeDown: boolean; slope: number };
}

// ─── Cleanup expired signals ─────────────────────────────────────────────────

export async function cleanupExpiredSignals(): Promise<{ expired: number; logs: string[] }> {
  const logs: string[] = [];
  let expiredCount = 0;

  if (!supabase) {
    logs.push("[CLEANUP] Supabase not connected");
    return { expired: expiredCount, logs };
  }

  try {
    // Find EARLY signals that haven't been confirmed in 12 candles (~1 hour on 4H)
    const { data: earlySignals, error: fetchErr } = await supabase
      .from("signals")
      .select("*")
      .eq("state", "EARLY_OPEN")
      .order("created_at", { ascending: false });

    if (fetchErr) {
      logs.push(`[CLEANUP] Query error: ${fetchErr.message}`);
      return { expired: expiredCount, logs };
    }

    for (const signal of earlySignals ?? []) {
      const ageMs = Date.now() - new Date(signal.created_at).getTime();
      const ageCandles = Math.floor(ageMs / (4 * 60 * 60 * 1000)); // 4H candles

      // Expire if >12 candles old without confirmation
      if (ageCandles > 12) {
        await updateSignalState(signal.id, "END", { outcome: "EXPIRED" });
        logs.push(`[CLEANUP] Expired ${signal.symbol} ${signal.direction} signal — ${ageCandles} candles old, never confirmed`);
        expiredCount++;
      }
    }

    if (expiredCount > 0) {
      logs.push(`[CLEANUP] Cleaned up ${expiredCount} expired signals`);
    }
  } catch (err) {
    logs.push(`[CLEANUP] Error: ${err}`);
  }

  return { expired: expiredCount, logs };
}

// ─── Generate signals with risk-reward filtering ────────────────────────────


function swingHighs(candles: Candle[]): number[] {
  const highs: number[] = [];
  for (let i = 1; i < candles.length - 1; i++) {
    if (candles[i].high > candles[i - 1].high && candles[i].high > candles[i + 1].high) {
      highs.push(candles[i].high);
    }
  }
  return highs;
}

function swingLows(candles: Candle[]): number[] {
  const lows: number[] = [];
  for (let i = 1; i < candles.length - 1; i++) {
    if (candles[i].low < candles[i - 1].low && candles[i].low < candles[i + 1].low) {
      lows.push(candles[i].low);
    }
  }
  return lows;
}

// ─── Signal generation from market data ──────────────────────────────────────

export async function generateSignals(): Promise<{ signals: Signal[]; logs: string[] }> {
  const logs: string[] = [];
  const signals: Signal[] = [];

  if (!supabase) {
    logs.push("[SUPABASE] Not connected — skipping signal generation");
    return { signals, logs };
  }

  try {
    // Fetch all active (non-ended) signals once upfront
    const { data: activeRows, error: fetchError } = await supabase
      .from("signals")
      .select("*")
      .in("state", ACTIVE_SIGNAL_STATES);

    if (fetchError) {
      logs.push(`[SUPABASE] Query error: ${fetchError.message}`);
      return { signals, logs };
    }

    // DEBUG INVARIANT: Verify state filter is working correctly
    if (activeRows && activeRows.length === 0) {
      // Count all signals to detect potential filtering loss
      const { count, error: countErr } = await supabase
        .from("signals")
        .select("*", { count: "exact", head: true });
      
      if (!countErr && count && count > 0) {
        console.warn(`[GENERATEIGNALS INVARIANT] Database has ${count} total signals but active query returned 0. Possible state leakage.`);
      }
    }

    // Fetch recently ended signals (last 4 hours) to implement cooldown
    const fourHoursAgo = new Date(Date.now() - 4 * 60 * 60 * 1000).toISOString();
    const { data: recentEnded, error: recentError } = await supabase
      .from("signals")
      .select("*")
      .in("state", TERMINAL_SIGNAL_STATES)
      .gte("updated_at", fourHoursAgo)
      .in("outcome", ["MANUAL", "EXPIRED"]);

    if (recentError) {
      logs.push(`[SUPABASE] Error fetching recently ended signals: ${recentError.message}`);
    }

    // Fetch recent telegram alerts to prevent spam (last 2 hours)
    const twoHoursAgo = new Date(Date.now() - 2 * 60 * 60 * 1000).toISOString();
    const { data: recentAlerts, error: alertError } = await supabase
      .from("telegram_alerts")
      .select("signal_id, symbol, state, sent_at")
      .gte("sent_at", twoHoursAgo);

    if (alertError) {
      logs.push(`[SUPABASE] Error fetching recent alerts: ${alertError.message}`);
    }

    // Safe duplicate check: only block if symbol has an active (non-END) signal
    const activeBySymbol = new Map<string, Signal>(
      (activeRows ?? []).map((s: Signal) => [s.symbol, s])
    );

    // Map of symbol+direction+breakout_level combos on cooldown (fired in last 4h)
    const cooldownKey = (symbol: string, direction: string, level: number) => 
      `${symbol}:${direction}:${level.toFixed(2)}`;
    
    const cooldownSet = new Set<string>(
      (recentEnded ?? []).map((s: Signal) => cooldownKey(s.symbol, s.direction, s.breakout_level))
    );

    // Track breakout events to prevent duplicate signals from same breakout
    // Track symbols with recent alerts to prevent duplicate notifications
    const recentAlertSymbols = new Set<string>(
      (recentAlerts ?? [])
        .filter((a: any) => a.state === "EARLY_OPEN")
        .map((a: any) => a.symbol)
    );

    for (const base of ["BTC", "ETH", "SOL"]) {
      try {
        const market = await getMarketContext(base);

        if (market.error) {
          logs.push(`[${base}] Market data error — skipping`);
          continue;
        }

        const { symbol, price, swingHigh, swingLow, setup, candles4h: marketCandles, volatilityThreshold } = market;
        logs.push(`[${base}] $${price.toFixed(2)} — ${setup} — ${market.setupText}`);

        // Guard: skip if candles unavailable or insufficient
        if (!marketCandles || marketCandles.length < 2) {
          logs.push(`[${base}] Skipped — insufficient candle data (${marketCandles?.length ?? 0} candles)`);
          continue;
        }

        const candles4h = marketCandles;
        const volatilityThresholdValue = volatilityThreshold ?? 0.005;

        // Check if an active signal exists and if it should be expired
        let existing = activeBySymbol.get(symbol);
        if (existing) {
          // For LONG: expire if price drops BELOW the breakout level
          // For SHORT: expire if price rises ABOVE the breakout level
          const shouldExpire = 
            existing.direction === "LONG" 
              ? price < existing.breakout_level
              : price > existing.breakout_level;

          if (shouldExpire) {
            await updateSignalState(existing.id!, "END", { outcome: "EXPIRED" });
            logs.push(`[${base}] Expired ${existing.direction} signal — price ${existing.direction === "LONG" ? "dropped below" : "rose above"} breakout level $${existing.breakout_level.toFixed(2)}`);
            // Clear the existing signal so we can create a new opposite-direction one
            existing = undefined;
          } else {
            // Signal still valid — don't auto-expire EARLY_OPEN
            // EARLY_OPEN signals persist until explicitly closed via TP/SL/manual END
            logs.push(`[${base}] Active signal exists (${existing.state}) — skipping creation`);
            signals.push(existing);
            continue; // IMPORTANT: Skip to next symbol
          }
        }

        // FIX: Check for recent alert spam — don't fire if alert sent in last 2 hours
        if (recentAlertSymbols.has(symbol)) {
          logs.push(`[${base}] Alert already sent in last 2h — skipping to prevent spam`);
          continue;
        }

        // PRE-BREAKOUT EXPANSION DETECTION: Trigger EARLY_OPEN on momentum buildup
        // This catches entries BEFORE full breakout confirmation occurs
        const candles15m = market.candles15m ?? [];
        const candles5m = market.candles5m ?? [];
        
        if (candles15m.length >= 3 && candles5m.length >= 3) {
          // Check for bullish expansion pressure on 15M (approaching resistance, expanding candles)
          const bullishExpansionPressure = (() => {
            const recent15m = candles15m.slice(-3);
            const closes = recent15m.map(c => c.close);
            const highs = recent15m.map(c => c.high);
            const opens = recent15m.map(c => c.open);
            const bodies = recent15m.map((c, i) => Math.abs(c.close - c.open));
            
            // Three conditions:
            // 1. Closes consistently rising or holding elevated
            // 2. Candle bodies expanding (momentum acceleration)
            // 3. Wicks showing resistance testing
            const closesRising = closes[1] >= closes[0] && closes[2] >= closes[1];
            const bodiesExpanding = bodies[1] > bodies[0] && bodies[2] > bodies[1];
            const wicksRising = highs[1] > highs[0] && highs[2] > highs[1];
            
            return closesRising && bodiesExpanding && wicksRising;
          })();

          // Check for bearish expansion pressure on 15M (approaching support, expanding candles down)
          const bearishExpansionPressure = (() => {
            const recent15m = candles15m.slice(-3);
            const closes = recent15m.map(c => c.close);
            const lows = recent15m.map(c => c.low);
            const opens = recent15m.map(c => c.open);
            const bodies = recent15m.map((c, i) => Math.abs(c.close - c.open));
            
            const closesFalling = closes[1] <= closes[0] && closes[2] <= closes[1];
            const bodiesExpanding = bodies[1] > bodies[0] && bodies[2] > bodies[1];
            const wicksFalling = lows[1] < lows[0] && lows[2] < lows[1];
            
            return closesFalling && bodiesExpanding && wicksFalling;
          })();

          // Check 5M momentum confirmation (RSI slope or EMA curl acceleration)
          const has5mMomentum = (() => {
            const rsiSlope = market.rsiSlope5m;
            const emaCurl = market.emaCurling;
            
            return (rsiSlope?.slopeUp || emaCurl?.curlingUp) || (rsiSlope?.slopeDown || emaCurl?.curlingDown);
          })();

          // EARLY_OPEN trigger: Structure + expansion pressure + 5M confirmation
          const hasDirectionalBias = market.setup === "LONG_SETUP" || market.setup === "SHORT_SETUP";
          const shouldTriggerEarlyLong = bullishExpansionPressure && has5mMomentum && market.setup === "LONG_SETUP";
          const shouldTriggerEarlyShort = bearishExpansionPressure && has5mMomentum && market.setup === "SHORT_SETUP";

          if ((shouldTriggerEarlyLong || shouldTriggerEarlyShort) && !existing) {
            const direction = shouldTriggerEarlyLong ? "LONG" : "SHORT";
            const breakoutLevel = shouldTriggerEarlyLong ? (market.swingHigh ?? price) : (market.swingLow ?? price);
            const currentCandle = candles4h[candles4h.length - 1];
            const prevCandle = candles4h.length > 1 ? candles4h[candles4h.length - 2] : null;
            const prevClosed = prevCandle?.close ?? 0;
            
            // Check expansion minimum
            const breakoutMove = direction === "LONG" 
              ? ((price - breakoutLevel) / breakoutLevel)
              : ((breakoutLevel - price) / breakoutLevel);
            
            const minExpansion = 
              symbolBase === "BTC" ? 0.0025 :
              symbolBase === "ETH" ? 0.002 :
              symbolBase === "SOL" ? 0.0035 :
              0.002;

            if (breakoutMove >= minExpansion) {
              const sl = direction === "LONG"
                ? calculateStopLoss(price, market.swingLow, direction)
                : calculateStopLoss(price, market.swingHigh, direction);
              const tp = direction === "LONG"
                ? calculateTakeProfit(price, sl, direction)
                : calculateTakeProfit(price, sl, direction);
              const rr = direction === "LONG"
                ? calculateRiskReward(price, tp, sl, direction)
                : calculateRiskReward(price, tp, sl, direction);

              if (rr >= 1.5) {
                // Confidence boosted by early detection
                const { confidence, breakdown } = calculateConfidence(
                  direction,
                  market.adx,
                  candles4h,
                  breakoutMove > 0.005,
                  {
                    emaCurling: market.emaCurling,
                    rsi15m: market.rsi15m,
                    rsiSlope15m: market.rsiSlope15m,
                    rsiSlope5m: market.rsiSlope5m,
                  }
                );
                const boostedConfidence = Math.min(95, confidence + 5);

                const newSignal: SignalInsert = {
                  symbol,
                  state: "EARLY_OPEN",
                  direction: direction as SignalDirection,
                  entry_price: price,
                  stop_loss: sl,
                  take_profit: tp,
                  confidence: boostedConfidence,
                  breakout_level: breakoutLevel,
                };

                // Create trace for this insertion attempt
                const earlyExpansionTrace = createTrace(symbol);
                earlyExpansionTrace.direction = direction as SignalDirection;
                earlyExpansionTrace.score = { long: 0, short: 0 };
                earlyExpansionTrace.reasons.push("Early expansion signal ready for insertion");

                try {
                  const inserted = await safeInsertSignal(newSignal, earlyExpansionTrace);
                  logs.push(`[${base}] ✓ ENTRY OPENED (${direction} | EARLY EXPANSION | conf: ${boostedConfidence} ${breakdown}) at $${price.toFixed(2)} | SL $${sl.toFixed(2)} | TP $${tp.toFixed(2)} | RR ${rr.toFixed(2)}`);
                  signals.push(inserted);
                  recentAlertSymbols.add(symbol);
                  continue; // Skip to next symbol since we already created a signal
                } catch (err) {
                  logs.push(`[${base}] Insert ${direction} early expansion failed — ${err instanceof Error ? err.message : "unknown error"}`);
                }
              }
            }
          }
        }

        // EARLY_OPEN: triggered purely by probability scoring model (v2.6.1)
        // No breakout event validation, no freshness checks, no minimum expansion gates.
        // Displacement is a confidence bonus only — never a prerequisite.
        if (setup === "LONG_SETUP" || setup === "SHORT_SETUP") {
          const direction = setup === "LONG_SETUP" ? "LONG" : "SHORT";
          const breakoutLevel = direction === "LONG" ? (swingHigh ?? price) : (swingLow ?? price);
          const currentCandle = candles4h[candles4h.length - 1];

          // Block opposite-direction conflict only
          if (existing && existing.direction !== direction) {
            logs.push(`[${base}] ${direction} skipped — active ${existing.direction} signal exists`);
            continue;
          }

          // 4-hour cooldown: prevent re-entry at same level
          const key = cooldownKey(symbol, direction, breakoutLevel);
          if (cooldownSet.has(key)) {
            logs.push(`[${base}] ${direction} on cooldown — fired within last 4h at $${breakoutLevel.toFixed(2)}`);
            continue;
          }

          const sl = direction === "LONG"
            ? calculateStopLoss(price, swingLow, "LONG")
            : calculateStopLoss(price, swingHigh, "SHORT");
          const tp = calculateTakeProfit(price, sl, direction as SignalDirection);
          const rr = calculateRiskReward(price, tp, sl, direction as SignalDirection);

          // RR quality filter — still enforced
          if (rr < 1.5) {
            logs.push(`[${base}] ${direction} skipped — RR ${rr.toFixed(2)} < 1.5`);
            continue;
          }

          // Displacement check — confidence bonus only, not a gate
          const hasDisplacement = market.displacementAnalysis?.triggered &&
            market.displacementAnalysis?.direction === direction;
          const breakoutMove = hasDisplacement ? market.displacementAnalysis!.breakExpansion : 0;

          const { confidence, breakdown } = calculateConfidence(
            direction as SignalDirection,
            market.adx,
            candles4h,
            breakoutMove > 0.005,
            {
              emaCurling: market.emaCurling,
              rsi15m: market.rsi15m,
              rsiSlope15m: market.rsiSlope15m,
              rsiSlope5m: market.rsiSlope5m,
            }
          );

          const newSignal: SignalInsert = {
            symbol,
            state: "EARLY_OPEN",
            direction: direction as SignalDirection,
            entry_price: price,
            stop_loss: sl,
            take_profit: tp,
            confidence,
            breakout_level: breakoutLevel,
          };

          // Create trace for this insertion attempt
          const insertTrace = createTrace(symbol);
          insertTrace.direction = direction as SignalDirection;
          insertTrace.entryPrice = price;
          insertTrace.stopLoss = sl;
          insertTrace.takeProfit = tp;
          insertTrace.riskReward = rr;
          insertTrace.score = market.probabilityScore || { long: 0, short: 0 };
          insertTrace.reasons.push("Signal ready for insertion");

          try {
            const inserted = await safeInsertSignal(newSignal, insertTrace);
            const scoreStr = market.probabilityScore
              ? `score: ${direction === "LONG" ? market.probabilityScore.longScore : market.probabilityScore.shortScore}`
              : "";
            logs.push(`[${base}] ✓ EARLY_OPEN triggered via probability model (${scoreStr}) | ${direction} | conf: ${confidence} ${breakdown} | $${price.toFixed(2)} | SL $${sl.toFixed(2)} | TP $${tp.toFixed(2)} | RR ${rr.toFixed(2)}`);
            signals.push(inserted);
            recentAlertSymbols.add(symbol);
          } catch (err) {
            logs.push(`[${base}] Insert ${direction} failed — ${err instanceof Error ? err.message : "unknown error"}`);
          }
        } else {
          logs.push(`[${base}] Score below trigger threshold — no EARLY_OPEN`);
        }
      } catch (err) {
        logs.push(`[${base}] Error: ${err instanceof Error ? err.message : String(err)}`);
      }
    }
  } catch (err) {
    logs.push(`[GENERATE_SIGNALS] Error: ${err instanceof Error ? err.message : String(err)}`);
  }

  return { signals, logs };
}

// ─── Update signal state in Supabase ────────────────────────────────────────

export async function updateSignalState(
  id: number,
  state: SignalState,
  extra?: Partial<Signal>
): Promise<boolean> {
  if (!supabase) return false;

  const { error } = await supabase
    .from("signals")
    .update({ state, updated_at: new Date().toISOString(), ...extra })
    .eq("id", id);

  if (error) {
    console.error(`[updateSignalState] Failed to update signal ${id}:`, error.message);
    return false;
  }
  return true;
}

// ─── Manage open positions: check TP/SL, promote EARLY → CONFIRMED, expire ──

export async function managePositions(): Promise<{ logs: string[]; confirmed: Signal[] }> {
  const logs: string[] = [];
  const confirmed: Signal[] = []; // newly CONFIRMED this run — for Telegram alerts

  if (!supabase) {
    logs.push("[POSITIONS] Supabase not connected");
    return { logs, confirmed };
  }

  try {
    const { data: openSignals, error } = await supabase
      .from("signals")
      .select("*")
      .in("state", ["EARLY_OPEN", "CONFIRMED"]);

    if (error) {
      logs.push(`[POSITIONS] Query error: ${error.message}`);
      return { logs, confirmed };
    }

    if (!openSignals?.length) {
      logs.push("[POSITIONS] No open positions");
      return { logs, confirmed };
    }

    const SLIPPAGE = 0.001; // 0.1% slippage on fills

    for (const signal of openSignals as Signal[]) {
      const base = signal.symbol.replace("/USD", "");
      try {
        const candles = await fetchCandles(base, 15, 20);
        if (!candles.length) {
          logs.push(`[${base}] No 15m candles`);
          continue;
        }

        const latest = candles[candles.length - 1];
        const candleTs = latest.time; // Unix seconds — unique per candle, used as dedup key

        // FIX 4: Skip if we already processed this exact candle
        if (signal.last_checked_candle === candleTs) {
          logs.push(`[${base}] Candle ${candleTs} already processed — skipping`);
          continue;
        }

        const { entry_price, stop_loss, take_profit, direction, state, id } = signal;

        logs.push(`[${base}] ${state} ${direction} — close $${latest.close.toFixed(2)} H $${latest.high.toFixed(2)} L $${latest.low.toFixed(2)} | TP $${take_profit.toFixed(2)} SL $${stop_loss.toFixed(2)}`);

        // Use candle HIGH/LOW so we never miss a fill between cron intervals
        const tpHitLong  = direction === "LONG"  && latest.high  >= take_profit;
        const tpHitShort = direction === "SHORT" && latest.low   <= take_profit;
        const slHitLong  = direction === "LONG"  && latest.low   <= stop_loss;
        const slHitShort = direction === "SHORT" && latest.high  >= stop_loss;

        if (tpHitLong || tpHitShort) {
          // Direction-aware exit with 0.1% slippage
          const exitPrice = direction === "LONG"
            ? take_profit * (1 - SLIPPAGE)
            : take_profit * (1 + SLIPPAGE);
          const pnl = direction === "LONG"
            ? exitPrice - entry_price
            : entry_price - exitPrice;
          const closeSignal = { ...signal, outcome: "TP" as SignalOutcome, pnl };
          await updateSignalState(id!, "END", { outcome: "TP", pnl });
          // Improvement 3: Send TP close alert
          await sendTradeCloseAlert(closeSignal, exitPrice);
          logs.push(`[${base}] TP HIT — exit $${exitPrice.toFixed(2)} PNL $${pnl.toFixed(2)}`);
          continue;
        }

        if (slHitLong || slHitShort) {
          // Direction-aware exit with 0.1% slippage
          const exitPrice = direction === "LONG"
            ? stop_loss * (1 - SLIPPAGE)
            : stop_loss * (1 + SLIPPAGE);
          const pnl = direction === "LONG"
            ? exitPrice - entry_price
            : entry_price - exitPrice;
          const closeSignal = { ...signal, outcome: "SL" as SignalOutcome, pnl };
          await updateSignalState(id!, "END", { outcome: "SL", pnl });
          // Improvement 3: Send SL close alert
          await sendTradeCloseAlert(closeSignal, exitPrice);
          logs.push(`[${base}] SL HIT — exit $${exitPrice.toFixed(2)} PNL $${pnl.toFixed(2)}`);
          continue;
        }

        // Improvement 2: CONFIRMED = retest add-on entry (strict retest structure)
        if (state === "EARLY_OPEN") {
          const recent = candles.slice(-6);
          const closes = recent.map((c) => c.close);
          const highs = recent.map((c) => c.high);
          const lows = recent.map((c) => c.low);
          const lastClose = closes[closes.length - 1];
          const prevClose = closes[closes.length - 2];
          const prev2Close = closes[closes.length - 3];

          // RETEST DETECTION: Did price return toward breakout level after initial impulse?
          // For LONG: price pulled back to within 0.5% of breakout level, then resumed up
          // For SHORT: price pulled back to within 0.5% of breakout level, then resumed down
          const retestTolerance = signal.breakout_level * 0.005; // 0.5% tolerance

          let hasRetestStructure = false;
          let retestDetails = "";

          if (direction === "LONG") {
            // Check if price dipped back into retest zone (within 0.5% of breakout) but held
            const retestZoneMin = signal.breakout_level * 0.995;
            const retestZoneMax = signal.breakout_level * 1.005;
            
            // Look for: previous closes in retest zone, current close resuming higher
            const prevInRetest = prevClose >= retestZoneMin && prevClose <= retestZoneMax;
            const currAboveRetest = lastClose > retestZoneMax;
            const breakoutHeld = Math.min(...lows.slice(-3)) >= signal.breakout_level * 0.99; // No clean reclaim

            hasRetestStructure = prevInRetest && currAboveRetest && breakoutHeld;
            retestDetails = `retest zone: [${retestZoneMin.toFixed(2)}-${retestZoneMax.toFixed(2)}], prev: ${prevClose.toFixed(2)}, curr: ${lastClose.toFixed(2)}, held: ${breakoutHeld}`;
          } else if (direction === "SHORT") {
            // Check if price rallied back into retest zone (within 0.5% of breakout) but held
            const retestZoneMax = signal.breakout_level * 1.005;
            const retestZoneMin = signal.breakout_level * 0.995;
            
            // Look for: previous closes in retest zone, current close resuming lower
            const prevInRetest = prevClose <= retestZoneMax && prevClose >= retestZoneMin;
            const currBelowRetest = lastClose < retestZoneMin;
            const breakoutHeld = Math.max(...highs.slice(-3)) <= signal.breakout_level * 1.01; // No clean reclaim

            hasRetestStructure = prevInRetest && currBelowRetest && breakoutHeld;
            retestDetails = `retest zone: [${retestZoneMin.toFixed(2)}-${retestZoneMax.toFixed(2)}], prev: ${prevClose.toFixed(2)}, curr: ${lastClose.toFixed(2)}, held: ${breakoutHeld}`;
          }

          logs.push(
            `[${base}] EARLY_OPEN retest check: ` +
            `hasRetestStructure=${hasRetestStructure} (${retestDetails})`
          );

          // CONFIRMED only on valid retest structure (not immediate continuation)
          if (hasRetestStructure) {
            const newConfidence = Math.min(95, signal.confidence + 12);
            await updateSignalState(id!, "CONFIRMED", {
              confidence: newConfidence,
              last_checked_candle: candleTs,
            });
            logs.push(`[${base}] ✓ CONFIRMED – RETEST HELD, ADDING TO POSITION (confidence: ${newConfidence}%)`);
            confirmed.push({ ...signal, state: "CONFIRMED", confidence: newConfidence });
          } else {
            await updateSignalState(id!, "EARLY_OPEN", { last_checked_candle: candleTs });
            logs.push(`[${base}] EARLY_OPEN — no retest structure yet`);
          }
        } else if (state === "CONFIRMED") {
          // CONFIRMED: position scaling active — only check TP/SL
          await updateSignalState(id!, "CONFIRMED", { last_checked_candle: candleTs });
          logs.push(`[${base}] CONFIRMED — position active (retest add-on entered)`);
        }
      } catch (err) {
        logs.push(`[${base}] ✗ Error during position management: ${err instanceof Error ? err.message : String(err)} — skipping this signal`);
        // Continue to next signal instead of crashing
        continue;
      }
    }
  } catch (err) {
    logs.push(`[POSITIONS] Outer error: ${err instanceof Error ? err.message : String(err)}`);
  }

  return { logs, confirmed };
}

// ─── Get all signals from Supabase ──────────────────────────────────────────

export async function getAllSignals(): Promise<Signal[]> {
  if (!supabase) {
    console.warn("[getAllSignals] Supabase not connected");
    return [];
  }

  try {
    // Explicitly select only active states (EARLY_OPEN, CONFIRMED) to exclude END signals
    const { data, error } = await supabase
      .from("signals")
      .select("*")
      .in("state", ["EARLY_OPEN", "CONFIRMED"])
      .order("created_at", { ascending: false });

    if (error) {
      console.error("[getAllSignals] Query error:", error);
      return [];
    }

    // DEBUG INVARIANT: Verify no hidden filtering removed EARLY_OPEN signals
    if (data && data.length === 0) {
      // Check if database has ANY signals at all
      const { data: allSignals, error: countErr } = await supabase
        .from("signals")
        .select("*", { count: "exact", head: true });
      
      if (!countErr && allSignals && allSignals.length > 0) {
        console.warn("[getAllSignals INVARIANT] Database has signals but query returned 0. This indicates filtering loss.");
        // Return all active signals including any that might have been filtered
        const { data: unfilteredData } = await supabase
          .from("signals")
          .select("*")
          .neq("state", "END")
          .order("created_at", { ascending: false });
        console.log("[getAllSignals RECOVERY] Returning unfiltered active signals:", unfilteredData?.length ?? 0);
        return unfilteredData ?? [];
      }
    }

    console.log("[getAllSignals] Returned", data?.length ?? 0, "active signals:", data?.map(s => ({ id: s.id, symbol: s.symbol, direction: s.direction, state: s.state })));

    return data ?? [];
  } catch (err) {
    console.error("[getAllSignals] Error:", err);
    return [];
  }
}

// ─── Find local pivots (highs and lows) ───────────────────────────────────────

function findPivots(candles: Candle[], lookback: number = 2): { highs: Candle[]; lows: Candle[] } {
  const highs: Candle[] = [];
  const lows: Candle[] = [];

  for (let i = lookback; i < candles.length - lookback; i++) {
    const c = candles[i];
    if (c.high > candles[i - 1].high && c.high > candles[i + 1].high) {
      highs.push(c);
    }
    if (c.low < candles[i - 1].low && c.low < candles[i + 1].low) {
      lows.push(c);
    }
  }
  return { highs, lows };
}

/**
 * Detect market structure progression using pivot sequencing.
 * Returns directional structure with bias score for mixed pivot sequences.
 * Mixed pivots (e.g. HH but not HL) produce a weighted bias instead of NO_STRUCTURE.
 */
function detectStructure(
  pivotHighs: Candle[],
  pivotLows: Candle[]
): {
  structure: "BULLISH" | "BEARISH" | "NO_STRUCTURE";
  latestHigh: Candle | null;
  latestLow: Candle | null;
  priorHigh: Candle | null;
  priorLow: Candle | null;
  structureText: string;
  bullishBias: number; // 0-40: structural contribution to LONG score
  bearishBias: number; // 0-40: structural contribution to SHORT score
} {
  if (pivotHighs.length < 2 || pivotLows.length < 2) {
    return {
      structure: "NO_STRUCTURE",
      latestHigh: null,
      latestLow: null,
      priorHigh: null,
      priorLow: null,
      structureText: "Insufficient pivots for structure detection",
      bullishBias: 0,
      bearishBias: 0,
    };
  }

  const latestHigh = pivotHighs[pivotHighs.length - 1];
  const priorHigh = pivotHighs[pivotHighs.length - 2];
  const latestLow = pivotLows[pivotLows.length - 1];
  const priorLow = pivotLows[pivotLows.length - 2];

  const hasHigherHigh = latestHigh.high > priorHigh.high;
  const hasHigherLow = latestLow.low > priorLow.low;
  const hasLowerHigh = latestHigh.high < priorHigh.high;
  const hasLowerLow = latestLow.low < priorLow.low;

  // Each pivot condition contributes 20 points (full structure = 40)
  const bullishBias = (hasHigherHigh ? 20 : 0) + (hasHigherLow ? 20 : 0);
  const bearishBias = (hasLowerHigh ? 20 : 0) + (hasLowerLow ? 20 : 0);

  const isBullish = hasHigherHigh && hasHigherLow;
  const isBearish = hasLowerHigh && hasLowerLow;

  if (isBullish) {
    return {
      structure: "BULLISH",
      latestHigh,
      latestLow,
      priorHigh,
      priorLow,
      structureText: `HH (${latestHigh.high.toFixed(0)} > ${priorHigh.high.toFixed(0)}) + HL (${latestLow.low.toFixed(0)} > ${priorLow.low.toFixed(0)})`,
      bullishBias: 40,
      bearishBias: 0,
    };
  } else if (isBearish) {
    return {
      structure: "BEARISH",
      latestHigh,
      latestLow,
      priorHigh,
      priorLow,
      structureText: `LL (${latestLow.low.toFixed(0)} < ${priorLow.low.toFixed(0)}) + LH (${latestHigh.high.toFixed(0)} < ${priorHigh.high.toFixed(0)})`,
      bullishBias: 0,
      bearishBias: 40,
    };
  }

  // Mixed pivots — return weighted bias instead of hard NO_STRUCTURE
  const dominantBias = bullishBias > bearishBias ? "BULLISH" : bearishBias > bullishBias ? "BEARISH" : "NO_STRUCTURE";
  const mixedParts = [];
  if (hasHigherHigh) mixedParts.push(`HH(+)`);
  if (hasHigherLow) mixedParts.push(`HL(+)`);
  if (hasLowerHigh) mixedParts.push(`LH(-)`);
  if (hasLowerLow) mixedParts.push(`LL(-)`);

  return {
    structure: dominantBias,
    latestHigh,
    latestLow,
    priorHigh,
    priorLow,
    structureText: `Mixed pivots [${mixedParts.join(", ")}] → ${dominantBias} bias (${Math.max(bullishBias, bearishBias)}/40)`,
    bullishBias,
    bearishBias,
  };
}

/**
 * Detect structural displacement: has price broken latest swing pivot with expansion?
 */
function detectDisplacement(
  price: number,
  structure: "BULLISH" | "BEARISH" | "NO_STRUCTURE",
  latestHigh: Candle | null,
  latestLow: Candle | null,
  expansionThreshold: number = 0.005 // 0.5% default
): {
  triggered: boolean;
  direction: "LONG" | "SHORT" | null;
  pivotBreak: number;
  breakExpansion: number;
  text: string;
} {
  if (structure === "BULLISH" && latestHigh) {
    // LONG: Price breaks above latest pivot high with expansion
    const breakAbove = price > latestHigh.high;
    const expansion = (price - latestHigh.high) / latestHigh.high;
    const hasExpansion = expansion >= expansionThreshold;

    if (breakAbove && hasExpansion) {
      return {
        triggered: true,
        direction: "LONG",
        pivotBreak: latestHigh.high,
        breakExpansion: expansion,
        text: `Bullish displacement: price ${price.toFixed(2)} broke pivot high ${latestHigh.high.toFixed(2)} (+${(expansion * 100).toFixed(2)}%)`,
      };
    }
    return {
      triggered: false,
      direction: null,
      pivotBreak: latestHigh.high,
      breakExpansion: expansion,
      text: `Bullish structure but no displacement (expansion: ${(expansion * 100).toFixed(2)}%, need ${(expansionThreshold * 100).toFixed(2)}%)`,
    };
  } else if (structure === "BEARISH" && latestLow) {
    // SHORT: Price breaks below latest pivot low with expansion
    const breakBelow = price < latestLow.low;
    const expansion = (latestLow.low - price) / latestLow.low;
    const hasExpansion = expansion >= expansionThreshold;

    if (breakBelow && hasExpansion) {
      return {
        triggered: true,
        direction: "SHORT",
        pivotBreak: latestLow.low,
        breakExpansion: expansion,
        text: `Bearish displacement: price ${price.toFixed(2)} broke pivot low ${latestLow.low.toFixed(2)} (-${(expansion * 100).toFixed(2)}%)`,
      };
    }
    return {
      triggered: false,
      direction: null,
      pivotBreak: latestLow.low,
      breakExpansion: expansion,
      text: `Bearish structure but no displacement (expansion: ${(expansion * 100).toFixed(2)}%, need ${(expansionThreshold * 100).toFixed(2)}%)`,
    };
  }

  return {
    triggered: false,
    direction: null,
    pivotBreak: 0,
    breakExpansion: 0,
    text: "No structure detected for displacement",
  };
}

// ─── Market context with dynamic market structure ───────────────────────────────


// Price cache for fallback when API fails
const priceCache = new Map<string, { price: number; timestamp: number }>();

export async function getMarketContext(symbolBase: string): Promise<MarketContext> {
  const symbol = `${symbolBase}/USD`;
  let dataSource: "KRAKEN" | "COINGECKO" | "CACHE" = "KRAKEN";
  let dataSourceTime = Date.now();
  
  try {
    let candles4h: Candle[] = [];
    let candles15m: Candle[] = [];
    let candles5m: Candle[] = [];
    
    // Fetch candles with dedicated error handling
    try {
      console.log(`[${symbolBase}] Fetching 4H candles...`);
      const result = await fetchCandles(symbolBase, 240, 100);
      candles4h = result.candles;
      dataSource = result.source;
      dataSourceTime = result.timestamp;
      console.log(`[${symbolBase}] ✓ Got ${candles4h.length} 4H candles from ${dataSource}`);

      // Fetch 15M candles for EMA/RSI timing
      console.log(`[${symbolBase}] Fetching 15M candles...`);
      const result15m = await fetchCandles(symbolBase, 15, 50);
      candles15m = result15m.candles;
      console.log(`[${symbolBase}] ✓ Got ${candles15m.length} 15M candles from ${result15m.source}`);

      // Fetch 5M candles for momentum confirmation
      console.log(`[${symbolBase}] Fetching 5M candles...`);
      const result5m = await fetchCandles(symbolBase, 5, 50);
      candles5m = result5m.candles;
      console.log(`[${symbolBase}] ✓ Got ${candles5m.length} 5M candles from ${result5m.source}`);
    } catch (err) {
      console.error(`[${symbolBase}] ✗ Candle fetch failed:`, err instanceof Error ? err.message : String(err));
      console.error(`[${symbolBase}] Error details:`, err);
      
      // FALLBACK: Use cached price if available (within 1 hour)
      const cached = priceCache.get(symbol);
      const now = Date.now();
      if (cached && (now - cached.timestamp) < 3600000) {
        console.log(`[${symbolBase}] Using cached price: $${cached.price.toFixed(2)}`);
        return {
          symbol,
          price: cached.price,
          swingHigh: null,
          swingLow: null,
          distanceToHigh: null,
          distanceToLow: null,
          setup: "NO_SETUP",
          setupText: "API unavailable — using cached data",
          error: false,
          trendlines: 0,
          dataSource: "CACHE",
          dataSourceTime: cached.timestamp,
          candles4h: [],
          candles15m: [],
          candles5m: [],
          adx: undefined,
          ema8: undefined,
          ema21: undefined,
          emaCurling: undefined,
          rsi15m: undefined,
          rsi5m: undefined,
          rsiSlope15m: undefined,
          rsiSlope5m: undefined,
          volatility: 1.0,
          volatilityThreshold: 0.005,
        };
      }

      // No cache available — return zero price but don't mark as error
      console.log(`[${symbolBase}] No cached data available`);
      return {
        symbol,
        price: 0,
        swingHigh: null,
        swingLow: null,
        distanceToHigh: null,
        distanceToLow: null,
        setup: "NO_SETUP",
        setupText: "Data loading...",
        error: false,
        trendlines: 0,
        candles4h: [],
        candles15m: [],
        candles5m: [],
        adx: undefined,
        ema8: undefined,
        ema21: undefined,
        emaCurling: undefined,
        rsi15m: undefined,
        rsi5m: undefined,
        rsiSlope15m: undefined,
        rsiSlope5m: undefined,
        volatility: 1.0,
        volatilityThreshold: 0.005,
      };
    }
      
    if (!candles4h.length) {
      console.error(`[${symbolBase}] ✗ No 4H candle data after fetch attempt`);
      return {
        symbol,
        price: 0,
        swingHigh: null,
        swingLow: null,
        distanceToHigh: null,
        distanceToLow: null,
        setup: "NO_SETUP",
        setupText: "No candle data available",
        error: false,
        trendlines: 0,
        candles4h: [],
        candles15m: [],
        candles5m: [],
        adx: undefined,
        ema8: undefined,
        ema21: undefined,
        emaCurling: undefined,
        rsi15m: undefined,
        rsi5m: undefined,
        rsiSlope15m: undefined,
        rsiSlope5m: undefined,
        volatility: 1.0,
        volatilityThreshold: 0.005,
      };
    }

    const price = candles4h[candles4h.length - 1].close;
    
    // Cache the price for fallback use
    priceCache.set(symbol, { price, timestamp: Date.now() });

    // VOLATILITY CALCULATION: Measure recent price movement to calibrate expansion thresholds
    let volatility = 1.0; // Baseline default if calculation fails
    let volatilityThreshold = 0.005; // Default 0.5% threshold

    try {
      if (candles4h.length >= 20) {
        // Calculate average true range over last 20 candles
        const recentCandles = candles4h.slice(-20);
        const trueRanges = recentCandles.map((c, i) => {
          if (i === 0) return c.high - c.low;
          const prevClose = recentCandles[i - 1].close;
          return Math.max(
            c.high - c.low,
            Math.abs(c.high - prevClose),
            Math.abs(c.low - prevClose)
          );
        });
        
        const atr = trueRanges.reduce((a, b) => a + b, 0) / trueRanges.length;
        volatility = (atr / price) * 100; // ATR as % of price
        
        // Calibrate threshold based on volatility
        // Low vol (< 1%): 0.35% threshold
        // Medium vol (1-2%): 0.50% threshold  
        // High vol (> 2%): 0.75% threshold
        if (volatility < 1) {
          volatilityThreshold = 0.0035;
        } else if (volatility < 2) {
          volatilityThreshold = 0.005;
        } else {
          volatilityThreshold = 0.0075;
        }
        
        console.log(`[${symbolBase}] Volatility: ${volatility.toFixed(2)}% | Threshold: ${(volatilityThreshold * 100).toFixed(2)}%`);
      } else {
        console.log(`[${symbolBase}] Insufficient candles for volatility calc (${candles4h.length} < 20), using defaults`);
      }
    } catch (volErr) {
      console.warn(`[${symbolBase}] Volatility calculation failed, using defaults:`, volErr instanceof Error ? volErr.message : String(volErr));
      volatility = 1.0;
      volatilityThreshold = 0.005;
    }

    // NEW: Dynamic market structure analysis using pivots
    const { highs: pivotHighs, lows: pivotLows } = findPivots(candles4h, 2);
    
    // Detect structure progression (HH+HL or LL+LH)
    const structureAnalysis = detectStructure(pivotHighs, pivotLows);
    
    // Detect if price has broken the latest pivot with expansion (structural displacement)
    const displacementAnalysis = detectDisplacement(
      price,
      structureAnalysis.structure,
      structureAnalysis.latestHigh,
      structureAnalysis.latestLow,
      0.0035 // 0.35% expansion threshold
    );

    // If no structure detected, return NO_SETUP
    if (structureAnalysis.structure === "NO_STRUCTURE") {
      const adx = calculateADX(candles4h);
      const ema8 = calculateEMA(candles15m, 8);
      const ema21 = calculateEMA(candles15m, 21);
      const emaCurling = checkEMACurling(candles4h, candles15m);
      const rsi15m = calculateRSI(candles15m, 14);
      const rsi5m = calculateRSI(candles5m, 14);
      const rsiSlope15m = checkRSISlope(candles15m, "15m");
      const rsiSlope5m = checkRSISlope(candles5m, "5m");

      return {
        symbol,
        price,
        swingHigh: null,
        swingLow: null,
        distanceToHigh: null,
        distanceToLow: null,
        setup: "NO_SETUP",
        setupText: structureAnalysis.structureText,
        error: false,
        trendlines: 0,
        dataSource,
        dataSourceTime,
        adx,
        candles4h,
        candles15m,
        candles5m,
        ema8,
        ema21,
        emaCurling,
        rsi15m,
        rsi5m,
        rsiSlope15m,
        rsiSlope5m,
        volatility,
        volatilityThreshold,
      };
    }

    // Log structure analysis
    console.log(`[${symbolBase}] Structure: ${structureAnalysis.structureText}`);
    console.log(`[${symbolBase}] Displacement: ${displacementAnalysis.text}`);

    // Use latest pivot levels as swing reference points
    const swingHigh = structureAnalysis.latestHigh?.high ?? null;
    const swingLow = structureAnalysis.latestLow?.low ?? null;

    let distanceToHigh: number | null = null;
    let distanceToLow: number | null = null;

    if (swingHigh) {
      distanceToHigh = ((swingHigh - price) / price) * 100;
    }
    if (swingLow) {
      distanceToLow = ((price - swingLow) / price) * 100;
    }

    // Calculate timing indicators
    const ema8 = calculateEMA(candles15m, 8);
    const ema21 = calculateEMA(candles15m, 21);
    const emaCurling = checkEMACurling(candles4h, candles15m);
    const rsi15m = calculateRSI(candles15m, 14);
    const rsi5m = calculateRSI(candles5m, 14);
    const rsiSlope15m = checkRSISlope(candles15m, "15m");
    const rsiSlope5m = checkRSISlope(candles5m, "5m");

    // Calculate ADX
    const adx = calculateADX(candles4h);

    // V2.6.0: WEIGHTED PROBABILITY SCORING MODEL
    // No hard boolean gates — stack evidence to justify early participation.
    // Displacement is a confidence bonus only, never a requirement.

    // --- LONG SCORE ---
    let longScore = 0;
    const longBreakdown: string[] = [];

    // Structure bias (0-40pts)
    if (structureAnalysis.bullishBias > 0) {
      longScore += structureAnalysis.bullishBias;
      longBreakdown.push(`Structure: +${structureAnalysis.bullishBias}`);
    }

    // EMA alignment (0-20pts)
    if (ema8 && ema21 && ema8 > ema21) {
      longScore += 20;
      longBreakdown.push("EMA8>EMA21: +20");
    }

    // EMA curling (0-15pts)
    if (emaCurling?.curlingUp) {
      longScore += 15;
      longBreakdown.push("EMA curl up: +15");
    }

    // RSI slope (0-15pts)
    if (rsiSlope15m?.slopeUp) {
      longScore += 15;
      longBreakdown.push("RSI slope+: +15");
    }

    // 5M bullish continuation (0-20pts)
    const has5mBullish = candles5m.length >= 3 &&
      candles5m[candles5m.length - 1].close > candles5m[candles5m.length - 2].close &&
      candles5m[candles5m.length - 2].close > candles5m[candles5m.length - 3].close;
    if (has5mBullish) {
      longScore += 20;
      longBreakdown.push("5M continuation: +20");
    }

    // Displacement is confidence bonus only — does NOT gate the score
    const hasLongDisplacement = displacementAnalysis.triggered && displacementAnalysis.direction === "LONG";
    if (hasLongDisplacement) {
      longBreakdown.push("Displacement: +20 conf bonus");
    }

    // --- SHORT SCORE ---
    let shortScore = 0;
    const shortBreakdown: string[] = [];

    // Structure bias (0-40pts)
    if (structureAnalysis.bearishBias > 0) {
      shortScore += structureAnalysis.bearishBias;
      shortBreakdown.push(`Structure: +${structureAnalysis.bearishBias}`);
    }

    // EMA alignment (0-20pts)
    if (ema8 && ema21 && ema8 < ema21) {
      shortScore += 20;
      shortBreakdown.push("EMA8<EMA21: +20");
    }

    // EMA curling (0-15pts)
    if (emaCurling?.curlingDown) {
      shortScore += 15;
      shortBreakdown.push("EMA curl down: +15");
    }

    // RSI slope (0-15pts)
    if (rsiSlope15m?.slopeDown) {
      shortScore += 15;
      shortBreakdown.push("RSI slope-: +15");
    }

    // 5M bearish continuation (0-20pts)
    const has5mBearish = candles5m.length >= 3 &&
      candles5m[candles5m.length - 1].close < candles5m[candles5m.length - 2].close &&
      candles5m[candles5m.length - 2].close < candles5m[candles5m.length - 3].close;
    if (has5mBearish) {
      shortScore += 20;
      shortBreakdown.push("5M continuation: +20");
    }

    // Displacement is confidence bonus only
    const hasShortDisplacement = displacementAnalysis.triggered && displacementAnalysis.direction === "SHORT";
    if (hasShortDisplacement) {
      shortBreakdown.push("Displacement: +20 conf bonus");
    }

    console.log(`[${symbolBase}] LONG score: ${longScore} [${longBreakdown.join(", ")}]`);
    console.log(`[${symbolBase}] SHORT score: ${shortScore} [${shortBreakdown.join(", ")}]`);

    // --- CREATE TRACE FOR THIS DECISION ---
    const trace = createTrace(symbol);
    trace.score = { long: longScore, short: shortScore };
    trace.breakdown = {
      structure: structureAnalysis.structure,
      longDisplacement: hasLongDisplacement,
      shortDisplacement: hasShortDisplacement,
    };

    // --- SETUP DECISION: score >= 60 triggers EARLY_OPEN ---
    const TRIGGER_THRESHOLD = 60;

    let setup: "LONG_SETUP" | "SHORT_SETUP" | "NO_SETUP" | "ERROR" = "NO_SETUP";
    let setupText = "";

    if (longScore >= TRIGGER_THRESHOLD && longScore > shortScore) {
      setup = "LONG_SETUP";
      trace.direction = "LONG";
      const trigger = hasLongDisplacement
        ? `BREAKOUT at $${displacementAnalysis.pivotBreak?.toFixed(0)} (+${(displacementAnalysis.breakExpansion * 100).toFixed(2)}%)`
        : `momentum initiation score ${longScore}`;
      setupText = `${structureAnalysis.structureText} — ${trigger}`;
      trace.reasons.push(`Score ${longScore} >= ${TRIGGER_THRESHOLD}`, "LONG > SHORT");
      console.log(`[${symbolBase}] TOTAL LONG SCORE: ${longScore} → EARLY_OPEN`);
    } else if (shortScore >= TRIGGER_THRESHOLD && shortScore > longScore) {
      setup = "SHORT_SETUP";
      trace.direction = "SHORT";
      const trigger = hasShortDisplacement
        ? `BREAKOUT at $${displacementAnalysis.pivotBreak?.toFixed(0)} (-${(displacementAnalysis.breakExpansion * 100).toFixed(2)}%)`
        : `momentum initiation score ${shortScore}`;
      setupText = `${structureAnalysis.structureText} — ${trigger}`;
      trace.reasons.push(`Score ${shortScore} >= ${TRIGGER_THRESHOLD}`, "SHORT > LONG");
      console.log(`[${symbolBase}] TOTAL SHORT SCORE: ${shortScore} → EARLY_OPEN`);
    } else {
      trace.decision = "NO_SIGNAL";
      const best = longScore > shortScore ? `LONG ${longScore}` : shortScore > longScore ? `SHORT ${shortScore}` : `LONG ${longScore} / SHORT ${shortScore}`;
      setupText = `${structureAnalysis.structureText} — score below threshold (${best} < ${TRIGGER_THRESHOLD})`;
      trace.reasons.push(`Score below threshold (best: ${best}, need: ${TRIGGER_THRESHOLD})`);
      logTrace(trace);
      console.log(`[${symbolBase}] Score below threshold — ${best} pts, need ${TRIGGER_THRESHOLD}`);
    }

    const trendlineCount = (swingHigh ? 1 : 0) + (swingLow ? 1 : 0);

    return {
      symbol,
      price,
      swingHigh,
      swingLow,
      distanceToHigh,
      distanceToLow,
      setup,
      setupText,
      trendlines: trendlineCount,
      volatility,
      volatilityThreshold,
      dataSource,
      dataSourceTime,
      adx,
      candles4h,
      candles15m,
      candles5m,
      ema8,
      ema21,
      emaCurling,
      rsi15m,
      rsi5m,
      rsiSlope15m,
      rsiSlope5m,
      displacementAnalysis,
      probabilityScore: { longScore, shortScore },
    };
  } catch (err) {
    console.error(`[${symbolBase}] ✗ Unexpected error in getMarketContext:`, err instanceof Error ? err.message : String(err));
    return {
      symbol,
      price: 0,
      swingHigh: null,
      swingLow: null,
      distanceToHigh: null,
      distanceToLow: null,
      setup: "NO_SETUP",
      setupText: "Unexpected error — retrying next cycle",
      error: false,
      trendlines: 0,
      dataSource: "KRAKEN",
      dataSourceTime: Date.now(),
      candles4h: [],
      candles15m: [],
      candles5m: [],
      adx: undefined,
      ema8: undefined,
      ema21: undefined,
      emaCurling: undefined,
      rsi15m: undefined,
      rsi5m: undefined,
      rsiSlope15m: undefined,
      rsiSlope5m: undefined,
      volatility: 1.0,
      volatilityThreshold: 0.005,
      displacementAnalysis: undefined,
      probabilityScore: undefined,
    };
  }
}
