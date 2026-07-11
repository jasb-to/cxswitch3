// lib/strategy.ts — v31.3 "Trend-Aware Exits"
// ============================================================
// FIX: Stoch exits now respect trend strength and minimum hold time.
// Philosophy: Structure breaks kill trades, not oscillators in trends.

// ------------------------------------------------------------------
// NEW: Trend strength helper for exit decisions
// ------------------------------------------------------------------

interface TrendStrength {
  adx: number;
  emaAligned: boolean;
  priceAboveEMA50: boolean;
  priceAboveEMA200: boolean;
  isStrong: boolean;
}

function assessTrendStrength(candles4h: Candle[], direction: "LONG" | "SHORT", currentPrice: number): TrendStrength {
  const closes = candles4h.map(c => c.close);
  const ema50 = ema(closes, 50);
  const ema200 = ema(closes, 200);
  const adxVal = adx(candles4h) ?? 0;

  const ema50Last = ema50[ema50.length - 1];
  const ema200Last = ema200[ema200.length - 1];

  const priceAboveEMA50 = currentPrice > ema50Last;
  const priceAboveEMA200 = currentPrice > ema200Last;

  const emaAligned = direction === "LONG"
    ? priceAboveEMA50 && priceAboveEMA200
    : !priceAboveEMA50 && !priceAboveEMA200;

  return {
    adx: adxVal,
    emaAligned,
    priceAboveEMA50,
    priceAboveEMA200,
    isStrong: adxVal > 25 && emaAligned,
  };
}

// ------------------------------------------------------------------
// NEW: Minimum hold time guard
// ------------------------------------------------------------------

const MIN_HOLD_MINUTES = 30; // Don't allow non-SL/TP exits before this

function getTradeAgeMinutes(signal: Signal, now: number = Date.now()): number {
  return (now - signal.timestamp) / 60000;
}

// ------------------------------------------------------------------
// REWRITTEN: shouldHold — Trend-aware exits
// ------------------------------------------------------------------

export function shouldHold(
  signal: Signal,
  candles4h: Candle[],
  currentPrice: number,
  candles1h?: Candle[],
  now?: number
): HoldResult {
  const timeNow = now || Date.now();
  const tradeAgeMin = getTradeAgeMinutes(signal, timeNow);

  // Build 1D candles from 4H for regime flip detection
  const candles1d = aggregateTo1D(candles4h);

  // ================================================================
  // 1. HARD STOPS — Always respected, no minimum hold time
  // ================================================================
  const validity = isSignalStillValid(signal, currentPrice, timeNow);
  if (!validity.valid) {
    return { shouldHold: false, reason: validity.reason };
  }

  // ================================================================
  // 2. REGIME FLIP — Exit if 1D trend reverses STRONGLY against us
  // ================================================================
  if (candles1d && candles1d.length >= 25) {
    const currentTrend = trend1D(candles1d);
    if (currentTrend.direction && currentTrend.direction !== signal.direction) {
      if (currentTrend.strength === "STRONG") {
        return { shouldHold: false, reason: "regime_flip_strong" };
      }
      // MEDIUM flip: only exit if we're underwater
      if (currentTrend.strength === "MEDIUM") {
        const pnl = signal.direction === "LONG"
          ? (currentPrice - signal.entry) / signal.entry
          : (signal.entry - currentPrice) / signal.entry;
        if (pnl < 0) {
          return { shouldHold: false, reason: "regime_flip_underwater" };
        }
      }
    }
  }

  // ================================================================
  // 3. STRUCTURE BREAK — 4H trendline / EMA breach (higher priority than stoch)
  // ================================================================
  const trendStrength = assessTrendStrength(candles4h, signal.direction, currentPrice);

  // 4H EMA50 breach — structure broken
  const closes4h = candles4h.map(c => c.close);
  const ema50_4h = ema(closes4h, 50);
  const ema50Last = ema50_4h[ema50_4h.length - 1];

  if (signal.direction === "LONG" && currentPrice < ema50Last * 0.995) {
    return { shouldHold: false, reason: "4h_ema50_breach" };
  }
  if (signal.direction === "SHORT" && currentPrice > ema50Last * 1.005) {
    return { shouldHold: false, reason: "4h_ema50_breach" };
  }

  // Trendline breach check
  const trendline = getTrendline(signal.pair, candles4h, signal.direction);
  if (trendline) {
    const tlPrice = trendline.price;
    if (signal.direction === "LONG" && currentPrice < tlPrice * 0.99) {
      return { shouldHold: false, reason: "trendline_breach" };
    }
    if (signal.direction === "SHORT" && currentPrice > tlPrice * 1.01) {
      return { shouldHold: false, reason: "trendline_breach" };
    }
  }

  // ================================================================
  // 4. MINIMUM HOLD TIME — Block early momentum exits
  // ================================================================
  if (tradeAgeMin < MIN_HOLD_MINUTES) {
    // Only allow hard stops (already checked above). Everything else waits.
    if (DEBUG) {
      console.log(`[SHOULDHOLD] ${signal.pair} Trade ${tradeAgeMin.toFixed(1)}min old — blocking early exit`);
    }
    // Still check for catastrophic moves (beyond 2x ATR)
    const atrVal = atr(candles4h, 14);
    const maxAdverseMove = signal.direction === "LONG"
      ? (signal.entry - currentPrice) / signal.entry
      : (currentPrice - signal.entry) / signal.entry;
    if (maxAdverseMove > 0.02) { // 2% adverse move = emergency exit
      return { shouldHold: false, reason: "emergency_stop" };
    }
    return { shouldHold: true, reason: "min_hold_time" };
  }

  // ================================================================
  // 5. PROFIT LOCK / TRAILING STOP — Let trade manager do its job
  // ================================================================
  // If we're in profit and profit lock is active, only respect trailing stop
  const pnl = signal.direction === "LONG"
    ? (currentPrice - signal.entry) / signal.entry
    : (signal.entry - currentPrice) / signal.entry;

  if (pnl > 0.02 && signal.lockedStop) {
    // We're in profit zone with a locked stop — only exit on trailing stop hit
    const hitLockedStop = signal.direction === "LONG"
      ? currentPrice <= signal.lockedStop
      : currentPrice >= signal.lockedStop;
    if (hitLockedStop) {
      return { shouldHold: false, reason: "trailing_stop" };
    }
    return { shouldHold: true, reason: "profit_lock_active" };
  }

  // ================================================================
  // 6. STOCHASTIC EXITS — ONLY in weak trends or with RSI confirmation
  // ================================================================
  // In STRONG trends (ADX > 25), stochastics can stay extreme for hours.
  // Only use stoch exits when:
  //   a) ADX < 25 (weak trend), OR
  //   b) RSI confirms overbought/oversold, OR
  //   c) We're in profit and protecting gains

  if (candles1h && candles1h.length >= 30) {
    const stoch1h = stochRsi(candles1h.map(c => c.close));
    const rsi1h = wilderRsi(candles1h.map(c => c.close)) ?? 50;

    // --- LONG exits ---
    if (signal.direction === "LONG") {
      // Weak trend + stoch cross down from overbought
      if (!trendStrength.isStrong && stoch1h.k > 75 && stoch1h.k < stoch1h.d) {
        return { shouldHold: false, reason: "1h_stoch_exhaustion_weak_trend" };
      }
      // Strong trend but RSI > 70 AND stoch cross down = genuine exhaustion
      if (trendStrength.isStrong && rsi1h > 70 && stoch1h.k > 80 && stoch1h.k < stoch1h.d) {
        return { shouldHold: false, reason: "1h_stoch_exhaustion_confirmed" };
      }
      // Extreme stoch against us (only if not in strong trend)
      if (!trendStrength.isStrong && stoch1h.k < 15) {
        return { shouldHold: false, reason: "1h_stoch_extreme" };
      }
    }

    // --- SHORT exits ---
    if (signal.direction === "SHORT") {
      if (!trendStrength.isStrong && stoch1h.k < 25 && stoch1h.k > stoch1h.d) {
        return { shouldHold: false, reason: "1h_stoch_exhaustion_weak_trend" };
      }
      if (trendStrength.isStrong && rsi1h < 30 && stoch1h.k < 20 && stoch1h.k > stoch1h.d) {
        return { shouldHold: false, reason: "1h_stoch_exhaustion_confirmed" };
      }
      if (!trendStrength.isStrong && stoch1h.k > 85) {
        return { shouldHold: false, reason: "1h_stoch_extreme" };
      }
    }
  }

  // ================================================================
  // 7. 4H STOCH — Secondary, only in weak trends
  // ================================================================
  if (candles4h.length >= 30) {
    const stoch4h = stochRsi(candles4h.map(c => c.close));
    if (!trendStrength.isStrong) {
      if (signal.direction === "LONG" && stoch4h.k > 85 && stoch4h.k < stoch4h.d) {
        return { shouldHold: false, reason: "4h_stoch_exhaustion_weak_trend" };
      }
      if (signal.direction === "SHORT" && stoch4h.k < 15 && stoch4h.k > stoch4h.d) {
        return { shouldHold: false, reason: "4h_stoch_exhaustion_weak_trend" };
      }
    }
  }

  // ================================================================
  // 8. DEFAULT: HOLD
  // ================================================================
  return { shouldHold: true, reason: trendStrength.isStrong ? "strong_trend_intact" : "active" };
}
