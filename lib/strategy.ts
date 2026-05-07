import { supabase } from "@/lib/supabase-client";
import { fetchCandles, type Candle } from "./kraken";
import { calculateStopLoss, calculateTakeProfit, calculateRiskReward, calculateVolatility } from "./risk-utils";
import { sendTradeCloseAlert } from "./telegram";

export type SignalDirection = "LONG" | "SHORT";
export type SignalState = "EARLY_OPEN" | "CONFIRMED" | "END";
export type SignalOutcome = "TP" | "SL" | "EXPIRED" | "MANUAL";

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
  breakout_candle_time?: number; // Unix timestamp of candle when breakout occurred
  prev_candle_close?: number; // Close price of candle BEFORE breakout (for validation)
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
      .eq("state", "EARLY")
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
      .in("state", ["EARLY_OPEN", "CONFIRMED"]);

    if (fetchError) {
      logs.push(`[SUPABASE] Query error: ${fetchError.message}`);
      return { signals, logs };
    }

    // Fetch recently ended signals (last 4 hours) to implement cooldown
    const fourHoursAgo = new Date(Date.now() - 4 * 60 * 60 * 1000).toISOString();
    const { data: recentEnded, error: recentError } = await supabase
      .from("signals")
      .select("*")
      .eq("state", "END")
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
    // Key: symbol + direction + breakout_level, Value: breakout_candle_time
    const breakoutEventMap = new Map<string, number>(
      (activeRows ?? [])
        .filter((s: Signal) => s.direction && s.breakout_level && s.breakout_candle_time)
        .map((s: Signal) => [
          `${s.symbol}:${s.direction}:${s.breakout_level.toFixed(2)}`,
          s.breakout_candle_time!
        ])
    );

    // Track symbols with recent alerts to prevent duplicate notifications
    const recentAlertSymbols = new Set<string>(
      (recentAlerts ?? [])
        .filter((a: any) => a.state === "EARLY")
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
            // Signal still valid, check staleness
            const ageMs = Date.now() - new Date(existing.created_at!).getTime();
            const isStaleEarly = existing.state === "EARLY" && ageMs > 60 * 60 * 1000;

            if (isStaleEarly) {
              await updateSignalState(existing.id!, "END", { outcome: "EXPIRED" });
              logs.push(`[${base}] Expired stale EARLY signal (${Math.round(ageMs / 60000)}m old) — allowing new signal`);
              existing = undefined;
            } else {
              logs.push(`[${base}] Active signal exists (${existing.state}) — skipping creation`);
              signals.push(existing);
              continue; // IMPORTANT: Skip to next symbol
            }
          }
        }

        // FIX: Check for recent alert spam — don't fire if alert sent in last 2 hours
        if (recentAlertSymbols.has(symbol)) {
          logs.push(`[${base}] Alert already sent in last 2h — skipping to prevent spam`);
          continue;
        }

        // LONG: price broke above a 3-touch resistance level (EVENT-BASED)
        if (setup === "LONG_SETUP") {
          const breakoutLevel = swingHigh ?? price;
          const currentCandle = candles4h[candles4h.length - 1];
          const prevCandle = candles4h.length > 1 ? candles4h[candles4h.length - 2] : null;
          
          // EVENT DETECTION: Previous candle was at/below breakout level, current candle closed above
          const prevClosed = prevCandle?.close ?? 0;
          const currClosed = currentCandle.close;
          
          // Check if this is a fresh breakout event (not stale)
          const breakoutOccurred = prevClosed <= breakoutLevel && currClosed > breakoutLevel * (1 + volatilityThresholdValue);
          
          if (!breakoutOccurred) {
            logs.push(`[${base}] LONG skipped — not a fresh breakout event (prev: $${prevClosed.toFixed(2)}, curr: $${currClosed.toFixed(2)}, level: $${breakoutLevel.toFixed(2)})`);
            continue;
          }

          // FRESHNESS CHECK: Don't fire if breakout happened too long ago
          const breakoutCandleAge = candles4h.length - 1;
          if (breakoutCandleAge > 10) {
            logs.push(`[${base}] LONG skipped — breakout is stale (${breakoutCandleAge} candles old, max 10)`);
            continue;
          }

          // MINIMUM EXPANSION CHECK: Require asset-specific minimum move from breakout level
          const breakoutMove = ((currClosed - breakoutLevel) / breakoutLevel);
          const minExpansion = 
            symbolBase === "BTC" ? 0.0035 :
            symbolBase === "ETH" ? 0.003 :
            symbolBase === "SOL" ? 0.0045 :
            0.003;
          const minExpansionPercent = minExpansion * 100;
          if (breakoutMove < minExpansion) {
            logs.push(`[${base}] ✗ LONG skipped — breakout too weak (${(breakoutMove * 100).toFixed(2)}%, need ${minExpansionPercent.toFixed(2)}%)`);
            continue;
          }

          // DUPLICATE PREVENTION: Check if same breakout event already created a signal
          const eventKey = `${symbol}:LONG:${breakoutLevel.toFixed(2)}`;
          const existingBreakoutTime = breakoutEventMap.get(eventKey);
          if (existingBreakoutTime && currentCandle.time === existingBreakoutTime) {
            logs.push(`[${base}] LONG skipped — signal already exists for this breakout event at candle time ${currentCandle.time}`);
            continue;
          }

          // Check cooldown: don't fire same setup twice within 4 hours
          const key = cooldownKey(symbol, "LONG", breakoutLevel);
          if (cooldownSet.has(key)) {
            logs.push(`[${base}] LONG on cooldown — fired within last 4h at $${breakoutLevel.toFixed(2)}`);
            continue;
          }

          // If there's an active signal in the opposite direction, don't create another
          if (existing && existing.direction === "SHORT") {
            logs.push(`[${base}] LONG skipped — active SHORT signal exists`);
            continue;
          }

          const sl = calculateStopLoss(price, swingLow, "LONG");
          const tp = calculateTakeProfit(price, sl, "LONG");
          const rr = calculateRiskReward(price, tp, sl, "LONG");

          // Filter low-quality trades (RR < 1.5)
          if (rr < 1.5) {
            logs.push(`[${base}] LONG skipped — RR ${rr.toFixed(2)} < 1.5 threshold`);
            continue;
          }

          // Calculate confidence score with timing indicator bonuses (non-gating)
          const { confidence, breakdown } = calculateConfidence(
            "LONG",
            market.adx,
            candles4h,
            breakoutMove > 0.005, // Momentum booster if strong move
            {
              emaCurling: market.emaCurling,
              rsi15m: market.rsi15m,
              rsiSlope15m: market.rsiSlope15m,
              rsiSlope5m: market.rsiSlope5m,
            }
          );

          const newSignal = {
            symbol,
            state: "EARLY_OPEN" as SignalState,
            direction: "LONG" as SignalDirection,
            entry_price: price,
            stop_loss: sl,
            take_profit: tp,
            confidence,
            breakout_level: breakoutLevel,
            breakout_candle_time: currentCandle.time,
            prev_candle_close: prevClosed,
          };

          const { data: inserted, error: insertErr } = await supabase
            .from("signals")
            .insert([newSignal])
            .select()
            .single();

          if (insertErr) {
            logs.push(`[${base}] Insert LONG failed: ${insertErr.message}`);
          } else {
            logs.push(`[${base}] ✓ ENTRY OPENED (LONG | conf: ${confidence} ${breakdown}) (breakout: ${(breakoutMove * 100).toFixed(2)}%) at $${price.toFixed(2)} | SL $${sl.toFixed(2)} | TP $${tp.toFixed(2)} | RR ${rr.toFixed(2)}`);
            signals.push(inserted);
            recentAlertSymbols.add(symbol);
          }

        // SHORT: price broke below a 3-touch support level (EVENT-BASED)
        } else if (setup === "SHORT_SETUP") {
          const breakoutLevel = swingLow ?? price;
          const currentCandle = candles4h[candles4h.length - 1];
          const prevCandle = candles4h.length > 1 ? candles4h[candles4h.length - 2] : null;
          
          // EVENT DETECTION: Previous candle was at/above breakout level, current candle closed below
          const prevClosed = prevCandle?.close ?? 0;
          const currClosed = currentCandle.close;
          
          // Check if this is a fresh breakout event (not stale)
          const breakoutOccurred = prevClosed >= breakoutLevel && currClosed < breakoutLevel * (1 - volatilityThresholdValue);
          
          if (!breakoutOccurred) {
            logs.push(`[${base}] SHORT skipped — not a fresh breakout event (prev: $${prevClosed.toFixed(2)}, curr: $${currClosed.toFixed(2)}, level: $${breakoutLevel.toFixed(2)})`);
            continue;
          }

          // FRESHNESS CHECK: Don't fire if breakout happened too long ago
          const breakoutCandleAge = candles4h.length - 1;
          if (breakoutCandleAge > 10) {
            logs.push(`[${base}] SHORT skipped — breakout is stale (${breakoutCandleAge} candles old, max 10)`);
            continue;
          }

          // MINIMUM EXPANSION CHECK: Require asset-specific minimum move from breakout level
          const breakoutMove = ((breakoutLevel - currClosed) / breakoutLevel);
          const minExpansion = 
            symbolBase === "BTC" ? 0.0035 :
            symbolBase === "ETH" ? 0.003 :
            symbolBase === "SOL" ? 0.0045 :
            0.003;
          const minExpansionPercent = minExpansion * 100;
          if (breakoutMove < minExpansion) {
            logs.push(`[${base}] ✗ SHORT skipped — breakout too weak (${(breakoutMove * 100).toFixed(2)}%, need ${minExpansionPercent.toFixed(2)}%)`);
            continue;
          }

          // DUPLICATE PREVENTION: Check if same breakout event already created a signal
          const eventKey = `${symbol}:SHORT:${breakoutLevel.toFixed(2)}`;
          const existingBreakoutTime = breakoutEventMap.get(eventKey);
          if (existingBreakoutTime && currentCandle.time === existingBreakoutTime) {
            logs.push(`[${base}] SHORT skipped — signal already exists for this breakout event at candle time ${currentCandle.time}`);
            continue;
          }
          
          // Check cooldown: don't fire same setup twice within 4 hours
          const key = cooldownKey(symbol, "SHORT", breakoutLevel);
          if (cooldownSet.has(key)) {
            logs.push(`[${base}] SHORT on cooldown — fired within last 4h at $${breakoutLevel.toFixed(2)}`);
            continue;
          }

          // If there's an active signal in the opposite direction, don't create another
          if (existing && existing.direction === "LONG") {
            logs.push(`[${base}] SHORT skipped — active LONG signal exists`);
            continue;
          }

          const sl = calculateStopLoss(price, swingHigh, "SHORT");
          const tp = calculateTakeProfit(price, sl, "SHORT");
          const rr = calculateRiskReward(price, tp, sl, "SHORT");

          // Filter low-quality trades (RR < 1.5)
          if (rr < 1.5) {
            logs.push(`[${base}] SHORT skipped — RR ${rr.toFixed(2)} < 1.5 threshold`);
            continue;
          }

          // Calculate confidence score with timing indicator bonuses (non-gating)
          const { confidence, breakdown } = calculateConfidence(
            "SHORT",
            market.adx,
            candles4h,
            breakoutMove > 0.005, // Momentum booster if strong move
            {
              emaCurling: market.emaCurling,
              rsi15m: market.rsi15m,
              rsiSlope15m: market.rsiSlope15m,
              rsiSlope5m: market.rsiSlope5m,
            }
          );

          const newSignal = {
            symbol,
            state: "EARLY_OPEN" as SignalState,
            direction: "SHORT" as SignalDirection,
            entry_price: price,
            stop_loss: sl,
            take_profit: tp,
            confidence,
            breakout_level: breakoutLevel,
            breakout_candle_time: currentCandle.time,
            prev_candle_close: prevClosed,
          };

          const { data: inserted, error: insertErr } = await supabase
            .from("signals")
            .insert([newSignal])
            .select()
            .single();

          if (insertErr) {
            logs.push(`[${base}] Insert SHORT failed: ${insertErr.message}`);
          } else {
            logs.push(`[${base}] ✓ ENTRY OPENED (SHORT | conf: ${confidence} ${breakdown}) (breakout: ${(breakoutMove * 100).toFixed(2)}%) at $${price.toFixed(2)} | SL $${sl.toFixed(2)} | TP $${tp.toFixed(2)} | RR ${rr.toFixed(2)}`);
            signals.push(inserted);
            recentAlertSymbols.add(symbol);
          }
        } else {
          logs.push(`[${base}] No setup — waiting`);
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
    // Explicitly select only active states (EARLY, CONFIRMED) to exclude END signals
    const { data, error } = await supabase
      .from("signals")
      .select("*")
      .in("state", ["EARLY", "CONFIRMED"])
      .order("created_at", { ascending: false });

    if (error) {
      console.error("[getAllSignals] Query error:", error);
      return [];
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
 * Returns bullish HH+HL, bearish LL+LH, or NO_STRUCTURE.
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
} {
  if (pivotHighs.length < 2 || pivotLows.length < 2) {
    return {
      structure: "NO_STRUCTURE",
      latestHigh: null,
      latestLow: null,
      priorHigh: null,
      priorLow: null,
      structureText: "Insufficient pivots for structure detection",
    };
  }

  const latestHigh = pivotHighs[pivotHighs.length - 1];
  const priorHigh = pivotHighs[pivotHighs.length - 2];
  const latestLow = pivotLows[pivotLows.length - 1];
  const priorLow = pivotLows[pivotLows.length - 2];

  // Bullish: Higher High + Higher Low
  const hasHigherHigh = latestHigh.high > priorHigh.high;
  const hasHigherLow = latestLow.low > priorLow.low;
  const isBullish = hasHigherHigh && hasHigherLow;

  // Bearish: Lower High + Lower Low
  const hasLowerHigh = latestHigh.high < priorHigh.high;
  const hasLowerLow = latestLow.low < priorLow.low;
  const isBearish = hasLowerHigh && hasLowerLow;

  if (isBullish) {
    return {
      structure: "BULLISH",
      latestHigh,
      latestLow,
      priorHigh,
      priorLow,
      structureText: `HH (${latestHigh.high.toFixed(0)} > ${priorHigh.high.toFixed(0)}) + HL (${latestLow.low.toFixed(0)} > ${priorLow.low.toFixed(0)})`,
    };
  } else if (isBearish) {
    return {
      structure: "BEARISH",
      latestHigh,
      latestLow,
      priorHigh,
      priorLow,
      structureText: `LL (${latestLow.low.toFixed(0)} < ${priorLow.low.toFixed(0)}) + LH (${latestHigh.high.toFixed(0)} < ${priorHigh.high.toFixed(0)})`,
    };
  }

  return {
    structure: "NO_STRUCTURE",
    latestHigh,
    latestLow,
    priorHigh,
    priorLow,
    structureText: "Structure indeterminate (mixed HH/LL or HL/LH)",
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
      const result = await fetchCandles(symbolBase, 240, 100);
      candles4h = result.candles;
      dataSource = result.source;
      dataSourceTime = result.timestamp;

      // Fetch 15M candles for EMA/RSI timing
      const result15m = await fetchCandles(symbolBase, 15, 50);
      candles15m = result15m.candles;

      // Fetch 5M candles for early impulse detection
      const result5m = await fetchCandles(symbolBase, 5, 20);
      candles5m = result5m.candles;
    } catch (err) {
      console.error(`[${symbolBase}] ✗ Candle fetch failed:`, err instanceof Error ? err.message : String(err));
      
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
      };
    }

    if (!candles4h.length) {
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
      };
    }

    const price = candles4h[candles4h.length - 1].close;
    
    // Cache the price for fallback use
    priceCache.set(symbol, { price, timestamp: Date.now() });

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

    let setup: "LONG_SETUP" | "SHORT_SETUP" | "NO_SETUP" | "ERROR" = "NO_SETUP";
    let setupText = "Waiting for structural displacement";

    // LONG_SETUP: Bullish structure + price breaks latest pivot high
    if (structureAnalysis.structure === "BULLISH" && displacementAnalysis.triggered && displacementAnalysis.direction === "LONG") {
      setup = "LONG_SETUP";
      setupText = `${structureAnalysis.structureText} — BREAKOUT at $${displacementAnalysis.pivotBreak.toFixed(0)} (+${(displacementAnalysis.breakExpansion * 100).toFixed(2)}%)`;
    } 
    // SHORT_SETUP: Bearish structure + price breaks latest pivot low
    else if (structureAnalysis.structure === "BEARISH" && displacementAnalysis.triggered && displacementAnalysis.direction === "SHORT") {
      setup = "SHORT_SETUP";
      setupText = `${structureAnalysis.structureText} — BREAKOUT at $${displacementAnalysis.pivotBreak.toFixed(0)} (-${(displacementAnalysis.breakExpansion * 100).toFixed(2)}%)`;
    } else {
      setupText = `${structureAnalysis.structureText} — ${displacementAnalysis.text}`;
    }

    const trendlineCount = (swingHigh ? 1 : 0) + (swingLow ? 1 : 0);

    
    // Calculate ADX to filter weak breakouts
    const adx = calculateADX(candles4h);

    // Calculate timing indicators for trend initiation
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
    };
  }
}
