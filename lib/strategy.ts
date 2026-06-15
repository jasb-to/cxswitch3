// lib/strategy.ts — v15 "BREAKOUT" 
// 4H Trend + 1H Breakout — momentum entries only
// Fixed risk, ATR-based stops, 4h cooldown
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
  confidence: number;
  type: "BREAKOUT";
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

function calcADX(candles: Candle[], period = 14): number {
  if (candles.length < period * 2 + 1) return 0;
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
    const dx = (Math.abs(plusDI - minusDI) / (plusDI + minusDI)) * 100;
    dxValues.push(dx);
  }
  if (dxValues.length < period) return 0;
  let adx = dxValues.slice(0, period).reduce((a, b) => a + b, 0) / period;
  for (let i = period; i < dxValues.length; i++) {
    adx = ((adx * (period - 1)) + dxValues[i]) / period;
  }
  return adx;
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

// ─── Breakout Detection (Loosened) ───

interface BreakoutResult {
  found: boolean;
  direction: "LONG" | "SHORT";
  breakLevel: number;
  candleRange: number;
  candleBody: number;
  bodyPct: number;
  fresh: boolean;
}

function detectBreakout(candles: Candle[], minRangeMult = 1.2, minBodyPct = 0.5): BreakoutResult | null {
  if (candles.length < 10) return null;

  const highs = swingHighs(candles, 3);
  const lows = swingLows(candles, 3);
  if (highs.length < 2 || lows.length < 2) return null;

  const current = candles[candles.length - 1];
  const atr = calcATR(candles.slice(-20), 14);

  const candleRange = current.high - current.low;
  const candleBody = Math.abs(current.close - current.open);
  const bodyPct = candleRange > 0 ? candleBody / candleRange : 0;

  // Must be a strong candle (not a doji/fakeout)
  if (candleRange < atr * minRangeMult) return null;
  if (bodyPct < minBodyPct) return null;

  // LONG breakout: close above recent swing high with 0.2% buffer
  const lastHigh = highs[highs.length - 1];
  const breakBuffer = 1.002;

  if (current.close > lastHigh.price * breakBuffer) {
    // Check if this is a FRESH breakout (not already extended)
    // At least 1 of last 3 candles was below the high
    let fresh = false;
    for (let i = 2; i <= 4; i++) {
      if (candles.length < i) break;
      if (candles[candles.length - i].close <= lastHigh.price) {
        fresh = true;
        break;
      }
    }

    return {
      found: true,
      direction: "LONG",
      breakLevel: lastHigh.price,
      candleRange,
      candleBody,
      bodyPct,
      fresh
    };
  }

  // SHORT breakout: close below recent swing low with 0.2% buffer
  const lastLow = lows[lows.length - 1];

  if (current.close < lastLow.price / breakBuffer) {
    let fresh = false;
    for (let i = 2; i <= 4; i++) {
      if (candles.length < i) break;
      if (candles[candles.length - i].close >= lastLow.price) {
        fresh = true;
        break;
      }
    }

    return {
      found: true,
      direction: "SHORT",
      breakLevel: lastLow.price,
      candleRange,
      candleBody,
      bodyPct,
      fresh
    };
  }

  return null;
}

// ─── Trend Health ───

function trendHealth(adx: number, structure: string): "STRONG" | "MODERATE" | "WEAK" | "NONE" {
  if (adx < 15 || structure === "RANGE") return "NONE";
  if (adx > 25) return "STRONG";
  if (adx > 18) return "MODERATE";
  return "WEAK";
}

// ─── Cooldown Check ───

export interface CooldownState {
  pair: string;
  direction: "LONG" | "SHORT";
  timestamp: number;
}

export function isOnCooldown(
  pair: string,
  direction: "LONG" | "SHORT",
  cooldowns: CooldownState[],
  cooldownMs = 4 * 60 * 60 * 1000 // 4 hours
): boolean {
  const now = Date.now();
  return cooldowns.some(
    c => c.pair === pair && c.direction === direction && (now - c.timestamp) < cooldownMs
  );
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
  const adx4h = calcADX(candles4h, 14);
  const health = trendHealth(adx4h, structure4h);

  const structureValid = signal.direction === "LONG" 
    ? structure4h === "UPTREND" || structure4h === "RANGE"
    : structure4h === "DOWNTREND" || structure4h === "RANGE";

  // Hard exit if trend dies or flips against us
  if (!structureValid || health === "NONE") {
    return {
      shouldHold: false,
      reason: `4H ${structure4h} invalidates ${signal.direction}. ADX ${adx4h.toFixed(1)}`,
      trailingStop: null,
      trendHealth: health
    };
  }

  // Trailing stop: 2x ATR(1H) from recent extreme
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

  // Only trail if in profit
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
  cooldowns: CooldownState[] = []
): { signal: Signal | null; market: MarketData; debug: string[] } {

  const price = candles1h[candles1h.length - 1].close;
  const structure4h = getStructure(candles4h);
  const structure1h = getStructure(candles1h);
  const roc1h = calcROC(candles1h, 3);
  const atr1h = calcATR(candles1h, 14);

  const adx4h = calcADX(candles4h, 14);
  const rsi1h = calcRSI(candles1h, 14);
  const stoch1h = calcStochastic(candles1h, 14, 3);

  const market: MarketData = {
    pair, price, structure: structure4h, adx: adx4h,
    rsi: rsi1h, stochK: stoch1h.k, stochD: stoch1h.d,
  };

  const debug: string[] = [];

  if (candles1h.length < 30 || candles4h.length < 30) {
    debug.push("insufficient_candles");
    return { signal: null, market, debug };
  }

  // ── Filter 1: Trend must exist ──
  const health = trendHealth(adx4h, structure4h);
  debug.push(`4h_structure:${structure4h}_health:${health}_adx:${adx4h.toFixed(1)}`);

  if (health === "NONE") {
    debug.push("no_trend_chop");
    return { signal: null, market, debug };
  }

  // ── Filter 2: 1H breakout ──
  const breakout = detectBreakout(candles1h);

  if (!breakout || !breakout.found) {
    debug.push("no_breakout");
    return { signal: null, market, debug };
  }

  debug.push(`breakout_${breakout.direction.toLowerCase()}_level:${breakout.breakLevel.toFixed(2)}_range:${breakout.candleRange.toFixed(2)}_body:${(breakout.bodyPct*100).toFixed(0)}%_fresh:${breakout.fresh}`);

  // ── Filter 3: Breakout must align with 4H trend ──
  const trendAligned = 
    (breakout.direction === "LONG" && structure4h === "UPTREND") ||
    (breakout.direction === "SHORT" && structure4h === "DOWNTREND");

  if (!trendAligned) {
    debug.push(`trend_mismatch:4h_${structure4h}_breakout_${breakout.direction}`);
    return { signal: null, market, debug };
  }

  debug.push("trend_aligned");

  // ── Filter 4: Cooldown ──
  if (isOnCooldown(pair, breakout.direction, cooldowns)) {
    debug.push(`cooldown_active:${breakout.direction}`);
    return { signal: null, market, debug };
  }

  debug.push("cooldown_clear");

  // ── Filter 5: Momentum check ──
  const momentumOK = breakout.direction === "LONG" ? roc1h > -0.3 : roc1h < 0.3;
  if (!momentumOK) {
    debug.push(`momentum_weak:roc_${roc1h.toFixed(2)}`);
    return { signal: null, market, debug };
  }

  debug.push(`momentum_ok:roc_${roc1h.toFixed(2)}`);

  // ── Build Signal ──
  const entry = price;
  const stopDistance = atr1h * 1.5;

  let stop: number, target: number;

  if (breakout.direction === "LONG") {
    stop = entry - stopDistance;
    target = entry + (stopDistance * 2); // 2:1 minimum
  } else {
    stop = entry + stopDistance;
    target = entry - (stopDistance * 2);
  }

  const actualStopPct = Math.abs(entry - stop) / entry;
  const actualTargetPct = Math.abs(target - entry) / entry;
  const rr = actualTargetPct / actualStopPct;

  // Confidence: trend strength + structure alignment + momentum + candle quality + freshness
  let confidence = 60;
  if (health === "STRONG") confidence += 15;
  else if (health === "MODERATE") confidence += 10;
  if (structure1h === structure4h) confidence += 10;
  if (breakout.bodyPct > 0.7) confidence += 5;
  if (Math.abs(roc1h) > 0.5) confidence += 5;
  if (breakout.fresh) confidence += 5; // Fresh breakout (not extended)
  else confidence -= 5; // Extended breakout, lower confidence
  confidence = Math.min(95, Math.max(50, confidence));

  const expectedMove = actualTargetPct * 100;

  // Only fire if R:R is acceptable
  if (rr < 1.5 || expectedMove < 2.5) {
    debug.push(`rr_too_low:${rr.toFixed(2)}_move:${expectedMove.toFixed(2)}%`);
    return { signal: null, market, debug };
  }

  const signal: Signal = {
    pair,
    direction: breakout.direction,
    entry,
    stop,
    target,
    confidence,
    type: "BREAKOUT",
    reason: `BREAKOUT ${breakout.direction} | 4H:${structure4h} 1H:${structure1h} | Break:${breakout.breakLevel.toFixed(2)} | Range:${breakout.candleRange.toFixed(2)} | Body:${(breakout.bodyPct*100).toFixed(0)}% | Fresh:${breakout.fresh} | ROC:${roc1h.toFixed(2)} | Conf:${confidence}`,
    timestamp: Date.now(),
    expectedMove,
    adx: adx4h,
    rsi: rsi1h,
    stochK: stoch1h.k,
    stochD: stoch1h.d,
    rr,
  };

  debug.push(`SIGNAL_${breakout.direction}_conf:${confidence}_rr:${rr.toFixed(2)}_stop:${actualStopPct.toFixed(2)}%`);
  return { signal, market, debug };
}

export function isSignalStillValid(signal: Signal, currentPrice: number): boolean {
  // Hard stop breach (no buffer — hit stop = invalid)
  if (signal.direction === "LONG" && currentPrice < signal.stop) return false;
  if (signal.direction === "SHORT" && currentPrice > signal.stop) return false;

  // Time decay: 8h for breakouts
  const ageHours = (Date.now() - signal.timestamp) / (1000 * 60 * 60);
  if (ageHours > 8) return false;

  return true;
}
