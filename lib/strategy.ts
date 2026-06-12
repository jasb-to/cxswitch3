// lib/strategy-v14.ts
// "THE TRAP" — Liquidity Sweep + Structure Reversal
// Goal: 3-5% per trade, daily or every other day
// Indicators: 100% non-lagging (price action only)
// ============================================================

export interface Candle {
  time: number;
  open: number;
  high: number;
  low: number;
  close: number;
  volume: number;
}

export interface Signal {
  pair: string;
  direction: "LONG" | "SHORT";
  entry: number;
  stop: number;
  target: number;
  confidence: number; // 0-100
  type: "SWEEP" | "FVG";
  reason: string;
  timestamp: number;
  expectedMove: number;
}

export interface MarketData {
  pair: string;
  price: number;
  structure4h: "UPTREND" | "DOWNTREND" | "RANGE";
  structure1h: "UPTREND" | "DOWNTREND" | "RANGE";
  roc1h: number;        // Rate of Change (3-period)
  atr1h: number;        // ATR for volatility context
  sweepDetected: boolean;
}

// ============================================================
// 1. SWING POINTS — Pure price action, zero lag
// ============================================================

interface SwingPoint {
  idx: number;
  price: number;
  type: "high" | "low";
}

function swingHighs(candles: Candle[], lookback = 3): SwingPoint[] {
  const highs: SwingPoint[] = [];
  for (let i = lookback; i < candles.length - lookback; i++) {
    const c = candles[i];
    let isHigh = true;
    for (let j = 1; j <= lookback; j++) {
      if (candles[i - j].high >= c.high || candles[i + j].high >= c.high) {
        isHigh = false;
        break;
      }
    }
    if (isHigh) highs.push({ idx: i, price: c.high, type: "high" });
  }
  return highs;
}

function swingLows(candles: Candle[], lookback = 3): SwingPoint[] {
  const lows: SwingPoint[] = [];
  for (let i = lookback; i < candles.length - lookback; i++) {
    const c = candles[i];
    let isLow = true;
    for (let j = 1; j <= lookback; j++) {
      if (candles[i - j].low <= c.low || candles[i + j].low <= c.low) {
        isLow = false;
        break;
      }
    }
    if (isLow) lows.push({ idx: i, price: c.low, type: "low" });
  }
  return lows;
}

// ============================================================
// 2. MARKET STRUCTURE — Non-lagging trend detection
// ============================================================

function getStructure(candles: Candle[]): "UPTREND" | "DOWNTREND" | "RANGE" {
  const highs = swingHighs(candles, 5);
  const lows = swingLows(candles, 5);
  if (highs.length < 2 || lows.length < 2) return "RANGE";

  const recentHighs = highs.slice(-3);
  const recentLows = lows.slice(-3);

  const higherHighs = recentHighs.every((h, i) => i === 0 ? true : h.price > recentHighs[i - 1].price);
  const higherLows = recentLows.every((l, i) => i === 0 ? true : l.price > recentLows[i - 1].price);
  const lowerHighs = recentHighs.every((h, i) => i === 0 ? true : h.price < recentHighs[i - 1].price);
  const lowerLows = recentLows.every((l, i) => i === 0 ? true : l.price < recentLows[i - 1].price);

  if (higherHighs && higherLows) return "UPTREND";
  if (lowerHighs && lowerLows) return "DOWNTREND";

  // Check slope of last 20 candles
  const recent = candles.slice(-20);
  if (recent.length >= 10) {
    const firstHalf = recent.slice(0, 10).reduce((a, c) => a + c.close, 0) / 10;
    const secondHalf = recent.slice(-10).reduce((a, c) => a + c.close, 0) / 10;
    const slope = (secondHalf - firstHalf) / firstHalf;
    if (slope > 0.015) return "UPTREND";
    if (slope < -0.015) return "DOWNTREND";
  }
  return "RANGE";
}

// ============================================================
// 3. LIQUIDITY SWEEP — The core trigger
// ============================================================

interface SweepResult {
  found: boolean;
  direction: "LONG" | "SHORT";
  sweepLevel: number;      // The swing point that was swept
  wickExtreme: number;   // The wick that went beyond it
  rejectionClose: number;  // Where price closed (must be back inside)
  recency: number;        // How many candles ago (0 = current)
}

function detectLiquiditySweep(candles: Candle[]): SweepResult | null {
  const highs = swingHighs(candles, 3);
  const lows = swingLows(candles, 3);
  if (highs.length < 2 || lows.length < 2) return null;

  const current = candles[candles.length - 1];
  const prev = candles[candles.length - 2];

  // LONG sweep: Wick below last swing low, close back above it
  const lastLow = lows[lows.length - 1];
  const prevLow = lows.length >= 2 ? lows[lows.length - 2] : lastLow;

  if (current.low < lastLow.price && current.close > lastLow.price && prev.close > lastLow.price) {
    // Check if this is a genuine sweep (wick went below previous structure)
    const wickDepth = (lastLow.price - current.low) / lastLow.price;
    if (wickDepth > 0.001) { // At least 0.1% wick beyond
      return {
        found: true,
        direction: "LONG",
        sweepLevel: lastLow.price,
        wickExtreme: current.low,
        rejectionClose: current.close,
        recency: 0
      };
    }
  }

  // SHORT sweep: Wick above last swing high, close back below it
  const lastHigh = highs[highs.length - 1];

  if (current.high > lastHigh.price && current.close < lastHigh.price && prev.close < lastHigh.price) {
    const wickDepth = (current.high - lastHigh.price) / lastHigh.price;
    if (wickDepth > 0.001) {
      return {
        found: true,
        direction: "SHORT",
        sweepLevel: lastHigh.price,
        wickExtreme: current.high,
        rejectionClose: current.close,
        recency: 0
      };
    }
  }

  return null;
}

// ============================================================
// 4. CHANGE OF CHARACTER (CHoCH) — Structure confirmation
// ============================================================

interface CHoCHResult {
  found: boolean;
  direction: "LONG" | "SHORT";
  breakLevel: number;
}

function detectCHOCH(candles: Candle[], sweep: SweepResult): CHoCHResult | null {
  const highs = swingHighs(candles, 3);
  const lows = swingLows(candles, 3);
  const current = candles[candles.length - 1];
  const prev = candles[candles.length - 2];

  if (sweep.direction === "LONG") {
    // After a long sweep, we need to break above a recent swing high
    // This confirms the reversal is not just a wick, but structural
    const recentHighs = highs.slice(-3);
    if (recentHighs.length < 2) return null;

    // The break must be above the swing high BEFORE the sweep
    const priorHigh = recentHighs[recentHighs.length - 2]; // High before the last one
    if (current.close > priorHigh.price && prev.close <= priorHigh.price) {
      return { found: true, direction: "LONG", breakLevel: priorHigh.price };
    }
  } else {
    const recentLows = lows.slice(-3);
    if (recentLows.length < 2) return null;

    const priorLow = recentLows[recentLows.length - 2];
    if (current.close < priorLow.price && prev.close >= priorLow.price) {
      return { found: true, direction: "SHORT", breakLevel: priorLow.price };
    }
  }

  return null;
}

// ============================================================
// 5. FAIR VALUE GAP (FVG) — Imbalance entry zones
// ============================================================

interface FVGResult {
  found: boolean;
  direction: "LONG" | "SHORT";
  top: number;
  bottom: number;
  midpoint: number;
}

function detectFVG(candles: Candle[], direction: "LONG" | "SHORT"): FVGResult | null {
  if (candles.length < 3) return null;

  // Look at last 3 candles
  for (let i = candles.length - 3; i >= Math.max(0, candles.length - 8); i--) {
    if (i + 2 >= candles.length) continue;
    const c1 = candles[i];
    const c2 = candles[i + 1];
    const c3 = candles[i + 2];

    if (direction === "LONG") {
      // Bullish FVG: candle 1 high is below candle 3 low (gap up)
      if (c1.high < c3.low) {
        // Must be in an upward move (c3 close > c1 close)
        if (c3.close > c1.close) {
          return {
            found: true,
            direction: "LONG",
            top: c3.low,
            bottom: c1.high,
            midpoint: (c3.low + c1.high) / 2
          };
        }
      }
    } else {
      // Bearish FVG: candle 1 low is above candle 3 high (gap down)
      if (c1.low > c3.high) {
        if (c3.close < c1.close) {
          return {
            found: true,
            direction: "SHORT",
            top: c1.low,
            bottom: c3.high,
            midpoint: (c1.low + c3.high) / 2
          };
        }
      }
    }
  }
  return null;
}

// ============================================================
// 6. RATE OF CHANGE — Minimal-lag momentum
// ============================================================

function calcROC(candles: Candle[], period = 3): number {
  if (candles.length < period + 1) return 0;
  const current = candles[candles.length - 1].close;
  const past = candles[candles.length - 1 - period].close;
  return ((current - past) / past) * 100;
}

// ============================================================
// 7. ATR — Volatility context (not for stops)
// ============================================================

function calcATR(candles: Candle[], period = 14): number {
  if (candles.length < period + 1) return 0;
  let sum = 0;
  for (let i = candles.length - period; i < candles.length; i++) {
    const prev = candles[i - 1], curr = candles[i];
    const tr = Math.max(curr.high - curr.low, Math.abs(curr.high - prev.close), Math.abs(curr.low - prev.close));
    sum += tr;
  }
  return sum / period;
}

// ============================================================
// 8. MAIN SIGNAL GENERATOR
// ============================================================

export function generateSignal(
  pair: string,
  candles1h: Candle[],
  candles4h: Candle[]
): { signal: Signal | null; market: MarketData; debug: string[] } {

  const price = candles1h[candles1h.length - 1].close;
  const structure4h = getStructure(candles4h);
  const structure1h = getStructure(candles1h);
  const roc1h = calcROC(candles1h, 3);
  const atr1h = calcATR(candles1h, 14);
  const debug: string[] = [];

  const market: MarketData = {
    pair, price, structure4h, structure1h, roc1h, atr1h, sweepDetected: false
  };

  if (candles1h.length < 30 || candles4h.length < 30) {
    debug.push("insufficient_candles");
    return { signal: null, market, debug };
  }

  // ─── STEP 1: Detect Liquidity Sweep on 1H ───
  const sweep = detectLiquiditySweep(candles1h);

  if (!sweep) {
    debug.push("no_liquidity_sweep");
  } else {
    market.sweepDetected = true;
    debug.push(`sweep_${sweep.direction.toLowerCase()}_level:${sweep.sweepLevel.toFixed(2)}_wick:${sweep.wickExtreme.toFixed(2)}`);
  }

  // ─── STEP 2: 4H Bias Filter ───
  // We only trade WITH the 4H trend or at clear 4H extremes
  // No counter-trend trading against strong 4H structure

  let bias: "LONG" | "SHORT" | "NONE" = "NONE";

  if (structure4h === "UPTREND") {
    bias = "LONG";
    debug.push("4h_bias_long");
  } else if (structure4h === "DOWNTREND") {
    bias = "SHORT";
    debug.push("4h_bias_short");
  } else {
    // In range, check which side of the range we're on
    const highs4h = swingHighs(candles4h, 5);
    const lows4h = swingLows(candles4h, 5);
    if (highs4h.length >= 2 && lows4h.length >= 2) {
      const rangeHigh = highs4h[highs4h.length - 1].price;
      const rangeLow = lows4h[lows4h.length - 1].price;
      const mid = (rangeHigh + rangeLow) / 2;

      if (price < mid) {
        bias = "LONG"; // Bottom of range = look for longs
        debug.push("4h_range_bottom_bias_long");
      } else {
        bias = "SHORT"; // Top of range = look for shorts
        debug.push("4h_range_top_bias_short");
      }
    }
  }

  // ─── STEP 3: PRIMARY SIGNAL — Sweep + CHoCH ───
  if (sweep && sweep.direction === bias) {
    const choch = detectCHOCH(candles1h, sweep);

    if (choch && choch.found) {
      debug.push(`choch_${choch.direction.toLowerCase()}_break:${choch.breakLevel.toFixed(2)}`);

      // Momentum check: ROC must be turning in our direction
      const momentumOK = sweep.direction === "LONG" ? roc1h > -0.5 : roc1h < 0.5;

      if (!momentumOK) {
        debug.push(`momentum_fail(roc:${roc1h.toFixed(2)})`);
      } else {
        debug.push(`momentum_ok(roc:${roc1h.toFixed(2)})`);

        // Calculate entry, stop, target
        const stopPct = 0.02;  // 2% stop (tighter than v13b)
        const targetPct = 0.04; // 4% target (conservative, hit more often)

        let entry: number, stop: number, target: number;

        if (sweep.direction === "LONG") {
          // Enter at 50% between sweep wick and CHoCH break, or current close
          entry = price;
          stop = Math.min(sweep.wickExtreme * 0.998, entry * (1 - stopPct));
          target = entry * (1 + targetPct);

          // Ensure stop is at least 1.5% away for RR
          const minStop = entry * 0.985;
          if (stop > minStop) stop = minStop;

        } else {
          entry = price;
          stop = Math.max(sweep.wickExtreme * 1.002, entry * (1 + stopPct));
          target = entry * (1 - targetPct);

          const minStop = entry * 1.015;
          if (stop < minStop) stop = minStop;
        }

        const actualStopPct = Math.abs(entry - stop) / entry;
        const actualTargetPct = Math.abs(target - entry) / entry;
        const rr = actualTargetPct / actualStopPct;

        // Confidence scoring
        let confidence = 70;
        if (structure4h === structure1h) confidence += 10; // Timeframe alignment
        if (Math.abs(roc1h) > 0.5) confidence += 10; // Momentum present
        confidence = Math.min(95, confidence);

        const expectedMove = actualTargetPct * 100;

        if (rr >= 1.5 && expectedMove >= 3.0) {
          const signal: Signal = {
            pair,
            direction: sweep.direction,
            entry,
            stop,
            target,
            confidence,
            type: "SWEEP",
            reason: `SWEEP+CHoCH ${sweep.direction} | 4H:${structure4h} 1H:${structure1h} | Sweep:${sweep.sweepLevel.toFixed(2)} Wick:${sweep.wickExtreme.toFixed(2)} | CHoCH:${choch.breakLevel.toFixed(2)} | ROC:${roc1h.toFixed(2)} | Conf:${confidence}`,
            timestamp: Date.now(),
            expectedMove
          };
          debug.push(`SIGNAL_${sweep.direction}_SWEEP+CHoCH_conf:${confidence}_rr:${rr.toFixed(2)}`);
          return { signal, market, debug };
        } else {
          debug.push(`rr_too_low(${rr.toFixed(2)}<1.5)`);
        }
      }
    } else {
      debug.push("no_choch_confirmation");
    }
  }

  // ─── STEP 4: SECONDARY SIGNAL — FVG Retest in Trend ───
  // If no sweep, look for price retesting a 4H FVG in the direction of trend

  if (bias !== "NONE") {
    const fvg4h = detectFVG(candles4h, bias);

    if (fvg4h && fvg4h.found) {
      debug.push(`fvg4h_${bias.toLowerCase()}_top:${fvg4h.top.toFixed(2)}_bottom:${fvg4h.bottom.toFixed(2)}`);

      // Check if current 1H price is inside or near the 4H FVG
      const inFVG = bias === "LONG" 
        ? (price <= fvg4h.top && price >= fvg4h.bottom)
        : (price >= fvg4h.bottom && price <= fvg4h.top);

      const nearFVG = Math.abs(price - fvg4h.midpoint) / price < 0.005; // Within 0.5%

      if (inFVG || nearFVG) {
        debug.push(`price_in_fvg_zone:${inFVG}_near:${nearFVG}`);

        // 1H must show rejection in the FVG zone
        const current1h = candles1h[candles1h.length - 1];
        const rejection = bias === "LONG" 
          ? current1h.close > current1h.open && current1h.low <= fvg4h.top
          : current1h.close < current1h.open && current1h.high >= fvg4h.bottom;

        if (rejection) {
          debug.push("1h_rejection_in_fvg");

          const stopPct = 0.02;
          const targetPct = 0.04;

          let entry = price;
          let stop: number, target: number;

          if (bias === "LONG") {
            stop = Math.min(fvg4h.bottom * 0.998, entry * (1 - stopPct));
            target = entry * (1 + targetPct);
            const minStop = entry * 0.985;
            if (stop > minStop) stop = minStop;
          } else {
            stop = Math.max(fvg4h.top * 1.002, entry * (1 + stopPct));
            target = entry * (1 - targetPct);
            const minStop = entry * 1.015;
            if (stop < minStop) stop = minStop;
          }

          const actualStopPct = Math.abs(entry - stop) / entry;
          const actualTargetPct = Math.abs(target - entry) / entry;
          const rr = actualTargetPct / actualStopPct;

          let confidence = 65;
          if (inFVG) confidence += 10;
          if (structure1h === structure4h) confidence += 10;
          confidence = Math.min(90, confidence);

          const expectedMove = actualTargetPct * 100;

          if (rr >= 1.5 && expectedMove >= 3.0) {
            const signal: Signal = {
              pair,
              direction: bias,
              entry,
              stop,
              target,
              confidence,
              type: "FVG",
              reason: `FVG_RETEST ${bias} | 4H:${structure4h} 1H:${structure1h} | FVG:${fvg4h.bottom.toFixed(2)}-${fvg4h.top.toFixed(2)} | ROC:${roc1h.toFixed(2)} | Conf:${confidence}`,
              timestamp: Date.now(),
              expectedMove
            };
            debug.push(`SIGNAL_${bias}_FVG_conf:${confidence}_rr:${rr.toFixed(2)}`);
            return { signal, market, debug };
          }
        } else {
          debug.push("no_1h_rejection_in_fvg");
        }
      } else {
        debug.push(`price_not_near_fvg(price:${price.toFixed(2)}_mid:${fvg4h.midpoint.toFixed(2)})`);
      }
    } else {
      debug.push(`no_fvg4h_${bias.toLowerCase()}`);
    }
  }

  debug.push("no_signal");
  return { signal: null, market, debug };
}

// ============================================================
// 9. UTILITY: Check if existing signal is still valid
// ============================================================

export function isSignalStillValid(signal: Signal, currentPrice: number): boolean {
  // Signal invalidated if price goes beyond stop
  if (signal.direction === "LONG" && currentPrice < signal.stop * 1.005) return false;
  if (signal.direction === "SHORT" && currentPrice > signal.stop * 0.995) return false;

  // Signal expired after 6 hours (6 candles on 1H)
  const ageHours = (Date.now() - signal.timestamp) / (1000 * 60 * 60);
  if (ageHours > 6) return false;

  return true;
}
