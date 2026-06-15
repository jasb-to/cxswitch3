// lib/strategy.ts — v20.3 "MULTI-SETUP + TARGET HIT DETECTION"
// 4H Trend + 1H Breakout / Pullback / Continuation / Reversal
// Catches grinding trends, continuations, and range extremes
// ============================================================
// v19 FIXES:
// 1. expectedMove threshold lowered per setup type (0.8% for CONTINUATION/PULLBACK)
// 2. CONTINUATION stop logic fixed — use Math.max for LONG, Math.min for SHORT
// 3. Candidate selection scores by confidence + reward, not confidence alone
// 4. getSignalHash guards against ATR≈0 with safeAtr
// 5. ADX calc guards against plusDI + minusDI === 0

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
  confidence: number;
  type: "BREAKOUT" | "PULLBACK" | "CONTINUATION" | "REVERSAL";
  reason: string;
  timestamp: number;
  expectedMove: number;
  adx: number;
  rsi: number;
  stochK: number;
  stochD: number;
  rr: number;
  candles1h?: Candle[];
  candles4h?: Candle[];
}

export interface MarketData {
  pair: string;
  price: number;
  structure: string;
  adx: number;
  rsi: number;
  stochK: number;
  stochD: number;
}

interface SwingPoint {
  idx: number;
  price: number;
  type: "high" | "low";
}

// ─── Helpers ───

function swingHighs(candles: Candle[], lookback = 3): SwingPoint[] {
  const highs: SwingPoint[] = [];
  for (let i = lookback; i < candles.length - lookback; i++) {
    const c = candles[i];
    let isHigh = true;
    for (let j = 1; j <= lookback; j++) {
      if (candles[i - j].high >= c.high || candles[i + j].high >= c.high) {
        isHigh = false; break;
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
        isLow = false; break;
      }
    }
    if (isLow) lows.push({ idx: i, price: c.low, type: "low" });
  }
  return lows;
}

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

  return "RANGE";
}

function calcADX(candles: Candle[], period = 14): { adx: number; slope: number } {
  if (candles.length < period * 2 + 1) return { adx: 0, slope: 0 };
  const tr: number[] = [];
  const plusDM: number[] = [];
  const minusDM: number[] = [];
  for (let i = 1; i < candles.length; i++) {
    const prev = candles[i - 1], curr = candles[i];
    tr.push(Math.max(curr.high - curr.low, Math.abs(curr.high - prev.close), Math.abs(curr.low - prev.close)));
    plusDM.push(curr.high - prev.high > prev.low - curr.low ? Math.max(curr.high - prev.high, 0) : 0);
    minusDM.push(prev.low - curr.low > curr.high - prev.high ? Math.max(prev.low - curr.low, 0) : 0);
  }
  let atr = tr.slice(0, period).reduce((a, b) => a + b, 0);
  let plusDI_sum = plusDM.slice(0, period).reduce((a, b) => a + b, 0);
  let minusDI_sum = minusDM.slice(0, period).reduce((a, b) => a + b, 0);
  let dxValues: number[] = [];
  for (let i = period; i < tr.length; i++) {
    atr = atr - (atr / period) + tr[i];
    plusDI_sum = plusDI_sum - (plusDI_sum / period) + plusDM[i];
    minusDI_sum = minusDI_sum - (minusDI_sum / period) + minusDM[i];
    const plusDI = 100 * (plusDI_sum / atr);
    const minusDI = 100 * (minusDI_sum / atr);
    const denom = plusDI + minusDI;
    const dx = denom === 0 ? 0 : (Math.abs(plusDI - minusDI) / denom) * 100;
    dxValues.push(dx);
  }
  if (dxValues.length < period) return { adx: 0, slope: 0 };
  let adx = dxValues.slice(0, period).reduce((a, b) => a + b, 0) / period;
  const adxHistory: number[] = [adx];
  for (let i = period; i < dxValues.length; i++) {
    adx = ((adx * (period - 1)) + dxValues[i]) / period;
    adxHistory.push(adx);
  }
  // ADX slope: rate of change over last 3 periods for early trend detection
  const slope = adxHistory.length >= 4
    ? (adxHistory[adxHistory.length - 1] - adxHistory[adxHistory.length - 4]) / 3
    : 0;
  return { adx, slope };
}

function calcRSI(candles: Candle[], period = 14): number {
  if (candles.length < period + 1) return 50;
  let gains = 0, losses = 0;
  for (let i = candles.length - period; i < candles.length; i++) {
    const change = candles[i].close - candles[i - 1].close;
    if (change > 0) gains += change; else losses += Math.abs(change);
  }
  const avgGain = gains / period;
  const avgLoss = losses / period;
  if (avgLoss === 0) return 100;
  const rs = avgGain / avgLoss;
  return 100 - (100 / (1 + rs));
}

function calcStochastic(candles: Candle[], kPeriod = 14, dPeriod = 3): { k: number; d: number } {
  if (candles.length < kPeriod + dPeriod) return { k: 50, d: 50 };
  const kValues: number[] = [];
  for (let i = candles.length - kPeriod - dPeriod + 1; i <= candles.length - kPeriod; i++) {
    const slice = candles.slice(i, i + kPeriod);
    const lowest = Math.min(...slice.map(c => c.low));
    const highest = Math.max(...slice.map(c => c.high));
    const current = candles[i + kPeriod - 1].close;
    const k = highest === lowest ? 50 : ((current - lowest) / (highest - lowest)) * 100;
    kValues.push(k);
  }
  const k = kValues[kValues.length - 1];
  const d = kValues.reduce((a, b) => a + b, 0) / kValues.length;
  return { k, d };
}

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

function calcROC(candles: Candle[], period = 3): number {
  if (candles.length < period + 1) return 0;
  const current = candles[candles.length - 1].close;
  const past = candles[candles.length - 1 - period].close;
  return ((current - past) / past) * 100;
}

function avgVolume(candles: Candle[], period = 20): number {
  if (candles.length < period) return 0;
  return candles.slice(-period).reduce((sum, c) => sum + c.volume, 0) / period;
}

// ─── Setup Detection ───
// All setups checked independently, returns best match

interface SetupResult {
  found: boolean;
  type: "BREAKOUT" | "PULLBACK" | "CONTINUATION" | "REVERSAL";
  direction: "LONG" | "SHORT";
  entry: number;
  stop: number;
  target: number;
  confidence: number;
  details: string;
}

interface SetupDebug {
  breakout: string;
  pullback: string;
  continuation: string;
  reversal: string;
}

function detectSetups(
  candles1h: Candle[],
  candles4h: Candle[],
  structure4h: string,
  adx4h: number,
  rsi1h: number,
  stoch1h: { k: number; d: number }
): { result: SetupResult | null; debug: SetupDebug } {
  if (candles1h.length < 30) {
    return {
      result: null,
      debug: { breakout: "insufficient_candles", pullback: "insufficient_candles", continuation: "insufficient_candles", reversal: "insufficient_candles" }
    };
  }

  const current = candles1h[candles1h.length - 1];
  const prev = candles1h[candles1h.length - 2];
  const atr1h = calcATR(candles1h.slice(-20), 14);
  const roc1h = calcROC(candles1h, 3);
  const avgVol = avgVolume(candles1h.slice(-21, -1), 20);
  const volOK = current.volume > avgVol * 1.2;

  const candleRange = current.high - current.low;
  const candleBody = Math.abs(current.close - current.open);
  const bodyPct = candleRange > 0 ? candleBody / candleRange : 0;

  const debug: SetupDebug = {
    breakout: "not_triggered",
    pullback: "not_triggered",
    continuation: "not_triggered",
    reversal: "not_triggered"
  };

  const candidates: SetupResult[] = [];

  // ─── SETUP 1: BREAKOUT ───
  const boxPeriod = 12;
  const boxCandles = candles1h.slice(-boxPeriod - 1, -1);
  const boxTop = Math.max(...boxCandles.map(c => c.high));
  const boxBottom = Math.min(...boxCandles.map(c => c.low));
  const boxHeight = boxTop - boxBottom;

  if (candleRange >= atr1h * 0.5 && bodyPct >= 0.5) {
    // LONG breakout
    if (current.close > boxTop * 1.001) {
      // LONG breakout: price must have been AT OR BELOW boxTop recently (inside or below range)
      let fresh = false;
      for (let i = 2; i <= 7; i++) {
        if (candles1h.length < i) break;
        if (candles1h[candles1h.length - i].close <= boxTop) { fresh = true; break; }
      }
      if (fresh) {
        const stop = Math.max(boxBottom, current.close - atr1h);
        const minStop = current.close * 0.992;
        const finalStop = stop < minStop ? minStop : stop;
        const target = current.close + (current.close - finalStop) * 2;
        candidates.push({
          found: true, type: "BREAKOUT", direction: "LONG",
          entry: current.close, stop: finalStop, target,
          confidence: 70 + (volOK ? 5 : 0) + (adx4h > 25 ? 10 : 0),
          details: `box:${boxBottom.toFixed(2)}-${boxTop.toFixed(2)} vol:${volOK}`
        });
        debug.breakout = "LONG_fresh";
      } else {
        debug.breakout = "LONG_not_fresh";
      }
    } else if (current.close < boxBottom / 1.001) {
      // SHORT breakout: price must have been AT OR ABOVE boxBottom recently (inside or above range)
      let fresh = false;
      for (let i = 2; i <= 7; i++) {
        if (candles1h.length < i) break;
        if (candles1h[candles1h.length - i].close >= boxBottom) { fresh = true; break; }
      }
      // Penalize breakout at extended levels
      const boxHeight = boxTop - boxBottom;
      const extension = boxHeight > 0 ? (boxTop - current.close) / boxHeight : 1;
      const notExtended = extension < 1.5;

      if (fresh && notExtended) {
        const stop = Math.min(boxTop, current.close + atr1h);
        const minStop = current.close * 1.008;
        const finalStop = stop > minStop ? minStop : stop;
        const target = current.close - (finalStop - current.close) * 2;
        const extendedPenalty = extension > 1.2 ? -10 : 0;
        candidates.push({
          found: true, type: "BREAKOUT", direction: "SHORT",
          entry: current.close, stop: finalStop, target,
          confidence: 70 + (volOK ? 5 : 0) + (adx4h > 25 ? 10 : 0) + extendedPenalty,
          details: `box:${boxBottom.toFixed(2)}-${boxTop.toFixed(2)} vol:${volOK} ext:${extension.toFixed(2)}`
        });
        debug.breakout = "SHORT_fresh";
      } else if (fresh && !notExtended) {
        debug.breakout = `SHORT_extended:${extension.toFixed(2)}`;
      } else {
        debug.breakout = "SHORT_not_fresh";
      }
    } else {
      debug.breakout = `no_break:close_${current.close.toFixed(2)}_box_${boxBottom.toFixed(2)}-${boxTop.toFixed(2)}`;
    }
  } else {
    debug.breakout = `weak_candle:range_${candleRange.toFixed(2)}_atr_${atr1h.toFixed(2)}_body_${(bodyPct*100).toFixed(0)}%`;
  }

  // ─── SETUP 2: PULLBACK ───
  // Simpler: in trend, price pulled back from recent extreme, now resuming
  if (adx4h > 20 && (structure4h === "UPTREND" || structure4h === "DOWNTREND")) {
    const trendDir = structure4h === "UPTREND" ? "LONG" : "SHORT";
    const recent10 = candles1h.slice(-11, -1);
    const recentHigh = Math.max(...recent10.map(c => c.high));
    const recentLow = Math.min(...recent10.map(c => c.low));
    const range = recentHigh - recentLow;
    // True retracement: how far price pulled back from the high, relative to the full range
    const retrace = range > 0 ? (recentHigh - current.close) / range : 0;

    if (trendDir === "LONG") {
      // Price pulled back from recent high, now bouncing
      const pulledBack = current.close < recentHigh && current.close > recentLow;
      const bouncing = current.close > current.open && bodyPct > 0.5;
      const momentum = roc1h > 0.1;

      // Relaxed gating: strong momentum OR decent retrace + candle confirmation
      const strongMomentum = roc1h > 0.25;
      const validPullback = (pulledBack && bouncing && momentum && retrace > 0.003) ||
                            (pulledBack && bouncing && strongMomentum && retrace > 0.001);
      if (validPullback) {
        const stop = Math.max(recentLow * 0.998, current.close - atr1h);
        const minStop = current.close * 0.992;
        const finalStop = stop < minStop ? minStop : stop;
        const target = current.close + (current.close - finalStop) * 2;
        candidates.push({
          found: true, type: "PULLBACK", direction: "LONG",
          entry: current.close, stop: finalStop, target,
          confidence: 65 + (volOK ? 5 : 0) + (adx4h > 25 ? 10 : 0) + (strongMomentum ? 5 : 0),
          details: `retrace:${(retrace*100).toFixed(2)}% high:${recentHigh.toFixed(2)} low:${recentLow.toFixed(2)} vol:${volOK}`
        });
        debug.pullback = "LONG_bounce";
      } else {
        debug.pullback = `LONG_pulled:${pulledBack}_bounce:${bouncing}_mom:${momentum}_retrace:${(retrace*100).toFixed(2)}%`;
      }
    } else {
      const pulledBack = current.close > recentLow && current.close < recentHigh;
      const rejecting = current.close < current.open && bodyPct > 0.5;
      const momentum = roc1h < -0.1;

      // Relaxed gating: strong momentum OR decent retrace + candle confirmation
      const strongMomentum = roc1h < -0.25;
      const validPullback = (pulledBack && rejecting && momentum && retrace > 0.003) ||
                            (pulledBack && rejecting && strongMomentum && retrace > 0.001);
      if (validPullback) {
        const stop = Math.min(recentHigh * 1.002, current.close + atr1h);
        const minStop = current.close * 1.008;
        const finalStop = stop > minStop ? minStop : stop;
        const target = current.close - (finalStop - current.close) * 2;
        candidates.push({
          found: true, type: "PULLBACK", direction: "SHORT",
          entry: current.close, stop: finalStop, target,
          confidence: 65 + (volOK ? 5 : 0) + (adx4h > 25 ? 10 : 0) + (strongMomentum ? 5 : 0),
          details: `retrace:${(retrace*100).toFixed(2)}% high:${recentHigh.toFixed(2)} low:${recentLow.toFixed(2)} vol:${volOK}`
        });
        debug.pullback = "SHORT_reject";
      } else {
        debug.pullback = `SHORT_pulled:${pulledBack}_reject:${rejecting}_mom:${momentum}_retrace:${(retrace*100).toFixed(2)}%`;
      }
    }
  } else {
    debug.pullback = `no_trend:structure_${structure4h}_adx_${adx4h.toFixed(1)}`;
  }

  // ─── SETUP 3: CONTINUATION ───
  // Pure trend momentum — catches grinding moves
  // Fires when trend is strong and price keeps moving with momentum
  if (adx4h > 25 && (structure4h === "UPTREND" || structure4h === "DOWNTREND")) {
    const trendDir = structure4h === "UPTREND" ? "LONG" : "SHORT";

    if (trendDir === "LONG") {
      // Strong uptrend + bullish candle + positive momentum
      const bullish = current.close > current.open && bodyPct > 0.5;
      const momentum = roc1h > 0.08; // Lowered for slow grind trends
      const notExtended = current.close < boxTop * 1.02; // Not parabolic

      if (bullish && momentum && notExtended) {
        // CORRECT: wider stop = further from price (lower for LONG)
        const stop = current.close - atr1h * 1.5;
        const minStop = current.close * 0.992;
        const finalStop = Math.max(stop, minStop);
        const target = current.close + (current.close - finalStop) * 2;
        candidates.push({
          found: true, type: "CONTINUATION", direction: "LONG",
          entry: current.close, stop: finalStop, target,
          confidence: 60 + (volOK ? 5 : 0) + (bodyPct > 0.7 ? 5 : 0),
          details: `grind_up:roc_${roc1h.toFixed(2)} body_${(bodyPct*100).toFixed(0)}% vol:${volOK}`
        });
        debug.continuation = "LONG_momentum";
      } else {
        debug.continuation = `LONG_bull:${bullish}_mom:${momentum}_ext:${!notExtended}_roc_${roc1h.toFixed(2)}`;
      }
    } else {
      const bearish = current.close < current.open && bodyPct > 0.5;
      const momentum = roc1h < -0.08; // Lowered for slow grind trends
      const notExtended = current.close > boxBottom / 1.02;

      if (bearish && momentum && notExtended) {
        // CORRECT: wider stop = further from price (higher for SHORT)
        const stop = current.close + atr1h * 1.5;
        const minStop = current.close * 1.008;
        const finalStop = Math.min(stop, minStop);
        const target = current.close - (finalStop - current.close) * 2;
        candidates.push({
          found: true, type: "CONTINUATION", direction: "SHORT",
          entry: current.close, stop: finalStop, target,
          confidence: 60 + (volOK ? 5 : 0) + (bodyPct > 0.7 ? 5 : 0),
          details: `grind_down:roc_${roc1h.toFixed(2)} body_${(bodyPct*100).toFixed(0)}% vol:${volOK}`
        });
        debug.continuation = "SHORT_momentum";
      } else {
        debug.continuation = `SHORT_bear:${bearish}_mom:${momentum}_ext:${!notExtended}_roc_${roc1h.toFixed(2)}`;
      }
    }
  } else {
    debug.continuation = `weak_trend:structure_${structure4h}_adx_${adx4h.toFixed(1)}`;
  }

  // ─── SETUP 4: REVERSAL ───
  if (structure4h === "RANGE" && adx4h < 20) {
    const highs4h = swingHighs(candles4h, 5);
    const lows4h = swingLows(candles4h, 5);

    if (highs4h.length >= 2 && lows4h.length >= 2) {
      const rangeHigh = highs4h[highs4h.length - 1].price;
      const rangeLow = lows4h[lows4h.length - 1].price;
      const mid = (rangeHigh + rangeLow) / 2;

      if (current.close < mid && current.close <= rangeLow * 1.005) {
        const oversold = rsi1h < 35 && stoch1h.k < 30;
        const bullish = current.close > current.open && bodyPct > 0.5;
        if (oversold && bullish) {
          const stop = Math.min(rangeLow * 0.995, current.close - atr1h);
          const target = mid;
          candidates.push({
            found: true, type: "REVERSAL", direction: "LONG",
            entry: current.close, stop, target,
            confidence: 60 + (volOK ? 5 : 0),
            details: `range_low:${rangeLow.toFixed(2)} mid:${mid.toFixed(2)} vol:${volOK}`
          });
          debug.reversal = "LONG_oversold";
        } else {
          debug.reversal = `LONG_oversold:${oversold}_bull:${bullish}`;
        }
      } else if (current.close > mid && current.close >= rangeHigh * 0.995) {
        const overbought = rsi1h > 65 && stoch1h.k > 70;
        const bearish = current.close < current.open && bodyPct > 0.5;
        if (overbought && bearish) {
          const stop = Math.max(rangeHigh * 1.005, current.close + atr1h);
          const target = mid;
          candidates.push({
            found: true, type: "REVERSAL", direction: "SHORT",
            entry: current.close, stop, target,
            confidence: 60 + (volOK ? 5 : 0),
            details: `range_high:${rangeHigh.toFixed(2)} mid:${mid.toFixed(2)} vol:${volOK}`
          });
          debug.reversal = "SHORT_overbought";
        } else {
          debug.reversal = `SHORT_overbought:${overbought}_bear:${bearish}`;
        }
      } else {
        debug.reversal = `no_extreme:close_${current.close.toFixed(2)}_mid_${mid.toFixed(2)}`;
      }
    } else {
      debug.reversal = "insufficient_4h_pivots";
    }
  } else {
    debug.reversal = `not_range:structure_${structure4h}_adx_${adx4h.toFixed(1)}`;
  }

  // Return best candidate by quality score, or null
  if (candidates.length === 0) {
    return { result: null, debug };
  }

  // FIX #3: Score by confidence + reward, not confidence alone
  candidates.sort((a, b) => {
    const rrA = Math.abs(a.target - a.entry) / Math.abs(a.entry - a.stop);
    const rrB = Math.abs(b.target - b.entry) / Math.abs(b.entry - b.stop);
    const scoreA = a.confidence + rrA * 10;
    const scoreB = b.confidence + rrB * 10;
    return scoreB - scoreA;
  });

  return { result: candidates[0], debug };
}

// ─── Trend Health ───

function trendHealth(adx: number, adxSlope: number, structure: string): "STRONG" | "MODERATE" | "WEAK" | "NONE" {
  // Early trend detection: rising ADX with slope > 0.5 signals transition from RANGE → TREND
  const earlyTrend = adxSlope > 0.5 && adx > 18;
  if ((adx < 15 && !earlyTrend) || structure === "RANGE") return "NONE";
  if (adx > 25 || (earlyTrend && adx > 20)) return "STRONG";
  if (adx > 18 || earlyTrend) return "MODERATE";
  return "WEAK";
}

// ─── Cooldown + Duplicate Suppression ───

export interface CooldownState {
  pair: string;
  direction: "LONG" | "SHORT";
  type: string;  // per-setup-type cooldown
  timestamp: number;
}

function getSignalHash(pair: string, direction: "LONG" | "SHORT", type: string, entry: number, atr: number): string {
  // Guard against ATR≈0 causing Infinity
  const safeAtr = Math.max(atr, entry * 0.001);
  // Tighter granularity: half-ATR buckets for better dedupe precision
  const entryBucket = Math.floor(entry / (safeAtr * 0.5));
  return `${pair}:${direction}:${type}:${entryBucket}`;
}

export function isOnCooldown(
  pair: string,
  direction: "LONG" | "SHORT",
  type: string,
  cooldowns: CooldownState[],
  cooldownMs = 4 * 60 * 60 * 1000
): boolean {
  const now = Date.now();
  return cooldowns.some(
    c => c.pair === pair && c.direction === direction && c.type === type && (now - c.timestamp) < cooldownMs
  );
}

export function isDuplicateSignal(
  hash: string,
  recentHashes: { hash: string; timestamp: number }[],
  ttlMs = 6 * 60 * 60 * 1000
): boolean {
  const now = Date.now();
  return recentHashes.some(h => h.hash === hash && (now - h.timestamp) < ttlMs);
}

// ─── Hold Logic ───

export interface HoldResult {
  shouldHold: boolean;
  reason: string;
  trailingStop: number | null;
  trendHealth: "STRONG" | "MODERATE" | "WEAK" | "NONE";
}

export function shouldHold(
  signal: Signal,
  candles4h: Candle[],
  candles1h: Candle[],
  currentPrice: number
): HoldResult {
  const structure4h = getStructure(candles4h);
  const { adx: adx4h, slope: adxSlope4h } = calcADX(candles4h, 14);
  const health = trendHealth(adx4h, adxSlope4h, structure4h);

  let structureValid = true;
  if (signal.type !== "REVERSAL") {
    structureValid = signal.direction === "LONG"
      ? structure4h === "UPTREND"
      : structure4h === "DOWNTREND";
  }

  if (!structureValid || health === "NONE") {
    return {
      shouldHold: false,
      reason: `4H ${structure4h} invalidates ${signal.type} ${signal.direction}. ADX ${adx4h.toFixed(1)}`,
      trailingStop: null,
      trendHealth: health
    };
  }

  const atr1h = calcATR(candles1h, 14);
  const trailDistance = atr1h * 2;

  let trailingStop: number | null = null;

  if (signal.direction === "LONG") {
    const recentLows = candles1h.slice(-8).map(c => c.low);
    const lowestRecent = Math.min(...recentLows);
    trailingStop = Math.max(signal.stop, lowestRecent - trailDistance);
  } else {
    const recentHighs = candles1h.slice(-8).map(c => c.high);
    const highestRecent = Math.max(...recentHighs);
    trailingStop = Math.min(signal.stop, highestRecent + trailDistance);
  }

  const inProfit = signal.direction === "LONG"
    ? currentPrice > signal.entry * 1.008
    : currentPrice < signal.entry * 0.992;

  if (inProfit && trailingStop !== null) {
    return {
      shouldHold: true,
      reason: `In profit. Trail at $${trailingStop.toFixed(2)}. Health: ${health}`,
      trailingStop,
      trendHealth: health
    };
  }

  return {
    shouldHold: true,
    reason: `4H ${structure4h} intact. ADX ${adx4h.toFixed(1)}. Hold for ${signal.target.toFixed(2)}.`,
    trailingStop: null,
    trendHealth: health
  };
}

// ─── Main Signal Generator ───

export function generateSignal(
  pair: string,
  candles1h: Candle[],
  candles4h: Candle[],
  cooldowns: CooldownState[] = [],
  recentHashes: { hash: string; timestamp: number }[] = []
): { signal: Signal | null; market: MarketData; debug: string[] } {

  const debug: string[] = [];

  // ── DEFENSIVE: Validate inputs ──
  if (!Array.isArray(candles1h) || !Array.isArray(candles4h)) {
    debug.push("invalid_candle_arrays");
    return { signal: null, market: { pair, price: 0, structure: "RANGE", adx: 0, rsi: 50, stochK: 50, stochD: 50 }, debug };
  }

  if (candles1h.length < 30 || candles4h.length < 30) {
    debug.push("insufficient_candles");
    return { signal: null, market: { pair, price: 0, structure: "RANGE", adx: 0, rsi: 50, stochK: 50, stochD: 50 }, debug };
  }

  const validCandles = candles1h.every(c =>
    c && typeof c.close === 'number' && typeof c.high === 'number' &&
    typeof c.low === 'number' && typeof c.open === 'number' &&
    typeof c.volume === 'number'
  );
  if (!validCandles) {
    debug.push("malformed_candle_data");
    return { signal: null, market: { pair, price: 0, structure: "RANGE", adx: 0, rsi: 50, stochK: 50, stochD: 50 }, debug };
  }

  const safeCooldowns = Array.isArray(cooldowns) ? cooldowns : [];
  const safeHashes = Array.isArray(recentHashes) ? recentHashes : [];

  const price = candles1h[candles1h.length - 1].close;
  const structure4h = getStructure(candles4h);
  const { adx: adx4h, slope: adxSlope4h } = calcADX(candles4h, 14);
  const rsi1h = calcRSI(candles1h, 14);
  const stoch1h = calcStochastic(candles1h, 14, 3);
  const atr1h = calcATR(candles1h, 14);

  const market: MarketData = {
    pair, price, structure: structure4h, adx: adx4h,
    rsi: rsi1h, stochK: stoch1h.k, stochD: stoch1h.d,
  };

  // ── Filter 1: Trend ──
  const health = trendHealth(adx4h, adxSlope4h, structure4h);
  debug.push(`4h_structure:${structure4h}_health:${health}_adx:${adx4h.toFixed(1)}_slope:${adxSlope4h.toFixed(2)}`);

  // ── Detect all setups ──
  const { result: setup, debug: setupDebug } = detectSetups(candles1h, candles4h, structure4h, adx4h, rsi1h, stoch1h);

  // DETAILED DEBUG: Show why each setup failed
  debug.push(`breakout:${setupDebug.breakout}`);
  debug.push(`pullback:${setupDebug.pullback}`);
  debug.push(`continuation:${setupDebug.continuation}`);
  debug.push(`reversal:${setupDebug.reversal}`);

  if (!setup || !setup.found) {
    debug.push("no_setup");
    return { signal: null, market, debug };
  }

  debug.push(`setup:${setup.type}_${setup.direction.toLowerCase()}_conf:${setup.confidence}_${setup.details}`);

  // ── Filter 2: Cooldown (per setup type) ──
  if (isOnCooldown(pair, setup.direction, setup.type, safeCooldowns)) {
    debug.push(`cooldown_active:${setup.direction}_${setup.type}`);
    return { signal: null, market, debug };
  }

  // ── Filter 3: Duplicate suppression ──
  const signalHash = getSignalHash(pair, setup.direction, setup.type, setup.entry, atr1h);
  if (isDuplicateSignal(signalHash, safeHashes)) {
    debug.push(`duplicate_signal:${signalHash}`);
    return { signal: null, market, debug };
  }

  // ── Build Signal ──
  const rr = Math.abs(setup.target - setup.entry) / Math.abs(setup.entry - setup.stop);
  const expectedMove = (Math.abs(setup.target - setup.entry) / setup.entry) * 100;

  // Volatility-normalized expectedMove: ATR-based threshold per setup type
  // ATR% = (ATR / price) * 100 — gives context-aware minimum move
  const atrPercent = (atr1h / price) * 100;
  const minMove =
    setup.type === "BREAKOUT"
      ? Math.max(1.5, atrPercent * 1.5)  // Breakout needs 1.5x ATR expansion, min 1.5%
      : setup.type === "REVERSAL"
      ? Math.max(1.0, atrPercent * 1.2)  // Reversal needs 1.2x ATR, min 1.0%
      : Math.max(0.5, atrPercent * 1.0);  // Pullback/continuation needs 1x ATR, min 0.5%

  if (rr < 1.5 || expectedMove < minMove) {
    debug.push(`rr_too_low:${rr.toFixed(2)}_move:${expectedMove.toFixed(2)}%_min:${minMove.toFixed(2)}%_atr:${atrPercent.toFixed(2)}%`);
    return { signal: null, market, debug };
  }

  const signal: Signal = {
    pair,
    direction: setup.direction,
    entry: setup.entry,
    stop: setup.stop,
    target: setup.target,
    confidence: setup.confidence,
    type: setup.type,
    reason: `${setup.type} ${setup.direction} | 4H:${structure4h} | ${setup.details} | Conf:${setup.confidence}`,
    timestamp: Date.now(),
    expectedMove,
    adx: adx4h,
    rsi: rsi1h,
    stochK: stoch1h.k,
    stochD: stoch1h.d,
    rr,
  };

  debug.push(`SIGNAL_${setup.type}_${setup.direction}_conf:${setup.confidence}_rr:${rr.toFixed(2)}_hash:${signalHash}`);
  return { signal, market, debug };
}

export function isSignalStillValid(signal: Signal, currentPrice: number): boolean {
  // Stop loss hit
  if (signal.direction === "LONG" && currentPrice < signal.stop) return false;
  if (signal.direction === "SHORT" && currentPrice > signal.stop) return false;

  // TARGET HIT — signal is complete, take profit
  if (signal.direction === "LONG" && currentPrice >= signal.target) return false;
  if (signal.direction === "SHORT" && currentPrice <= signal.target) return false;

  // Age expiry
  const ageHours = (Date.now() - signal.timestamp) / (1000 * 60 * 60);
  const maxAge = signal.type === "REVERSAL" ? 4 : 8;
  if (ageHours > maxAge) return false;

  return true;
}
