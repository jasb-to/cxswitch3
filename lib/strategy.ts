// lib/strategy.ts — v17 "MULTI-SETUP"
// 4H Trend + 1H Breakout / Pullback / Reversal
// Catches grinding trends, continuations, and range extremes
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
  type: "BREAKOUT" | "PULLBACK" | "REVERSAL";
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

function avgVolume(candles: Candle[], period = 20): number {
  if (candles.length < period) return 0;
  return candles.slice(-period).reduce((sum, c) => sum + c.volume, 0) / period;
}

// ─── Setup Detection ───

interface SetupResult {
  found: boolean;
  type: "BREAKOUT" | "PULLBACK" | "REVERSAL";
  direction: "LONG" | "SHORT";
  entry: number;
  stop: number;
  target: number;
  confidence: number;
  details: string;
}

function detectSetups(
  candles1h: Candle[],
  candles4h: Candle[],
  structure4h: string,
  adx4h: number,
  rsi1h: number,
  stoch1h: { k: number; d: number }
): SetupResult | null {
  if (candles1h.length < 30) return null;

  const current = candles1h[candles1h.length - 1];
  const prev = candles1h[candles1h.length - 2];
  const atr1h = calcATR(candles1h.slice(-20), 14);
  const roc1h = calcROC(candles1h, 3);
  const avgVol = avgVolume(candles1h.slice(-21, -1), 20);
  const volOK = current.volume > avgVol * 1.2;

  const candleRange = current.high - current.low;
  const candleBody = Math.abs(current.close - current.open);
  const bodyPct = candleRange > 0 ? candleBody / candleRange : 0;

  // ─── SETUP 1: BREAKOUT ───
  // Box breakout — price breaks above/below recent consolidation
  const boxPeriod = 12;
  const boxCandles = candles1h.slice(-boxPeriod - 1, -1);
  const boxTop = Math.max(...boxCandles.map(c => c.high));
  const boxBottom = Math.min(...boxCandles.map(c => c.low));
  const boxHeight = boxTop - boxBottom;
  const boxHeightPct = boxHeight / current.close;

  // Breakout: close beyond box with momentum
  if (candleRange >= atr1h * 0.5 && bodyPct >= 0.5) {
    // LONG breakout
    if (current.close > boxTop * 1.001) {
      // Fresh: not already extended
      let fresh = false;
      for (let i = 2; i <= 7; i++) {
        if (candles1h.length < i) break;
        if (candles1h[candles1h.length - i].close <= boxTop) {
          fresh = true; break;
        }
      }
      if (fresh) {
        const stop = Math.max(boxBottom, current.close - atr1h);
        const target = current.close + (current.close - stop) * 2;
        return {
          found: true,
          type: "BREAKOUT",
          direction: "LONG",
          entry: current.close,
          stop,
          target,
          confidence: 70 + (volOK ? 5 : 0) + (adx4h > 25 ? 10 : 0),
          details: `box:${boxBottom.toFixed(2)}-${boxTop.toFixed(2)} height:${(boxHeightPct*100).toFixed(1)}% vol:${volOK}`
        };
      }
    }
    // SHORT breakout
    if (current.close < boxBottom / 1.001) {
      let fresh = false;
      for (let i = 2; i <= 7; i++) {
        if (candles1h.length < i) break;
        if (candles1h[candles1h.length - i].close >= boxBottom) {
          fresh = true; break;
        }
      }
      if (fresh) {
        const stop = Math.min(boxTop, current.close + atr1h);
        const target = current.close - (stop - current.close) * 2;
        return {
          found: true,
          type: "BREAKOUT",
          direction: "SHORT",
          entry: current.close,
          stop,
          target,
          confidence: 70 + (volOK ? 5 : 0) + (adx4h > 25 ? 10 : 0),
          details: `box:${boxBottom.toFixed(2)}-${boxTop.toFixed(2)} height:${(boxHeightPct*100).toFixed(1)}% vol:${volOK}`
        };
      }
    }
  }

  // ─── SETUP 2: PULLBACK (Trend Continuation) ───
  // In strong trend, price pulls back to support then bounces
  // Catches the yellow circles on your SOL chart
  if (adx4h > 20 && (structure4h === "UPTREND" || structure4h === "DOWNTREND")) {
    const trendDirection = structure4h === "UPTREND" ? "LONG" : "SHORT";

    // Find recent swing points on 1H for pullback levels
    const highs1h = swingHighs(candles1h.slice(-30), 2);
    const lows1h = swingLows(candles1h.slice(-30), 2);

    if (trendDirection === "LONG" && lows1h.length >= 2) {
      const recentLow = lows1h[lows1h.length - 1];
      // Price pulled back near a recent low, now bouncing
      const nearLow = Math.abs(current.close - recentLow.price) / current.close < 0.005;
      const bouncing = current.close > prev.close && prev.close <= recentLow.price * 1.002;
      const momentum = roc1h > 0.1 && bodyPct > 0.5;

      if (bouncing && momentum) {
        const stop = Math.min(recentLow.price * 0.998, current.close - atr1h);
        const target = current.close + (current.close - stop) * 2;
        return {
          found: true,
          type: "PULLBACK",
          direction: "LONG",
          entry: current.close,
          stop,
          target,
          confidence: 65 + (volOK ? 5 : 0) + (adx4h > 25 ? 10 : 0) + (nearLow ? 5 : 0),
          details: `pullback_to:${recentLow.price.toFixed(2)} bounce:${bouncing} mom:${momentum} vol:${volOK}`
        };
      }
    }

    if (trendDirection === "SHORT" && highs1h.length >= 2) {
      const recentHigh = highs1h[highs1h.length - 1];
      const nearHigh = Math.abs(current.close - recentHigh.price) / current.close < 0.005;
      const rejecting = current.close < prev.close && prev.close >= recentHigh.price * 0.998;
      const momentum = roc1h < -0.1 && bodyPct > 0.5;

      if (rejecting && momentum) {
        const stop = Math.max(recentHigh.price * 1.002, current.close + atr1h);
        const target = current.close - (stop - current.close) * 2;
        return {
          found: true,
          type: "PULLBACK",
          direction: "SHORT",
          entry: current.close,
          stop,
          target,
          confidence: 65 + (volOK ? 5 : 0) + (adx4h > 25 ? 10 : 0) + (nearHigh ? 5 : 0),
          details: `pullback_to:${recentHigh.price.toFixed(2)} reject:${rejecting} mom:${momentum} vol:${volOK}`
        };
      }
    }
  }

  // ─── SETUP 3: REVERSAL (Range Extreme) ───
  // In range, price hits extreme and reverses with divergence
  if (structure4h === "RANGE" && adx4h < 20) {
    const highs4h = swingHighs(candles4h, 5);
    const lows4h = swingLows(candles4h, 5);

    if (highs4h.length >= 2 && lows4h.length >= 2) {
      const rangeHigh = highs4h[highs4h.length - 1].price;
      const rangeLow = lows4h[lows4h.length - 1].price;
      const mid = (rangeHigh + rangeLow) / 2;

      // LONG reversal at range low
      if (current.close < mid && current.close <= rangeLow * 1.005) {
        const oversold = rsi1h < 35 && stoch1h.k < 30;
        const bullish = current.close > current.open && bodyPct > 0.5;
        if (oversold && bullish) {
          const stop = Math.min(rangeLow * 0.995, current.close - atr1h);
          const target = mid;
          return {
            found: true,
            type: "REVERSAL",
            direction: "LONG",
            entry: current.close,
            stop,
            target,
            confidence: 60 + (volOK ? 5 : 0),
            details: `range_low:${rangeLow.toFixed(2)} mid:${mid.toFixed(2)} oversold:${oversold} vol:${volOK}`
          };
        }
      }

      // SHORT reversal at range high
      if (current.close > mid && current.close >= rangeHigh * 0.995) {
        const overbought = rsi1h > 65 && stoch1h.k > 70;
        const bearish = current.close < current.open && bodyPct > 0.5;
        if (overbought && bearish) {
          const stop = Math.max(rangeHigh * 1.005, current.close + atr1h);
          const target = mid;
          return {
            found: true,
            type: "REVERSAL",
            direction: "SHORT",
            entry: current.close,
            stop,
            target,
            confidence: 60 + (volOK ? 5 : 0),
            details: `range_high:${rangeHigh.toFixed(2)} mid:${mid.toFixed(2)} overbought:${overbought} vol:${volOK}`
          };
        }
      }
    }
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

// ─── Cooldown + Duplicate Suppression ───

export interface CooldownState {
  pair: string;
  direction: "LONG" | "SHORT";
  timestamp: number;
}

function getSignalHash(pair: string, direction: "LONG" | "SHORT", entry: number, atr: number): string {
  const entryBucket = Math.floor(entry / atr);
  return `${pair}:${direction}:${entryBucket}`;
}

export function isOnCooldown(
  pair: string,
  direction: "LONG" | "SHORT",
  cooldowns: CooldownState[],
  cooldownMs = 4 * 60 * 60 * 1000
): boolean {
  const now = Date.now();
  return cooldowns.some(
    c => c.pair === pair && c.direction === direction && (now - c.timestamp) < cooldownMs
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
  const adx4h = calcADX(candles4h, 14);
  const health = trendHealth(adx4h, structure4h);

  // For BREAKOUT and PULLBACK: only hold if trend matches
  // For REVERSAL: hold until target or stop
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

  const price = candles1h[candles1h.length - 1].close;
  const structure4h = getStructure(candles4h);
  const adx4h = calcADX(candles4h, 14);
  const rsi1h = calcRSI(candles1h, 14);
  const stoch1h = calcStochastic(candles1h, 14, 3);
  const atr1h = calcATR(candles1h, 14);

  const market: MarketData = {
    pair, price, structure: structure4h, adx: adx4h,
    rsi: rsi1h, stochK: stoch1h.k, stochD: stoch1h.d,
  };

  const debug: string[] = [];

  if (candles1h.length < 30 || candles4h.length < 30) {
    debug.push("insufficient_candles");
    return { signal: null, market, debug };
  }

  // ── Filter 1: Trend must exist for trend setups ──
  const health = trendHealth(adx4h, structure4h);
  debug.push(`4h_structure:${structure4h}_health:${health}_adx:${adx4h.toFixed(1)}`);

  // ── Detect all setups ──
  const setup = detectSetups(candles1h, candles4h, structure4h, adx4h, rsi1h, stoch1h);

  if (!setup || !setup.found) {
    debug.push("no_setup");
    return { signal: null, market, debug };
  }

  debug.push(`setup:${setup.type}_${setup.direction.toLowerCase()}_conf:${setup.confidence}_${setup.details}`);

  // ── Filter 2: Cooldown ──
  if (isOnCooldown(pair, setup.direction, cooldowns)) {
    debug.push(`cooldown_active:${setup.direction}`);
    return { signal: null, market, debug };
  }

  // ── Filter 3: Duplicate suppression ──
  const signalHash = getSignalHash(pair, setup.direction, setup.entry, atr1h);
  if (isDuplicateSignal(signalHash, recentHashes)) {
    debug.push(`duplicate_signal:${signalHash}`);
    return { signal: null, market, debug };
  }

  // ── Build Signal ──
  const rr = Math.abs(setup.target - setup.entry) / Math.abs(setup.entry - setup.stop);
  const expectedMove = (Math.abs(setup.target - setup.entry) / setup.entry) * 100;

  if (rr < 1.5 || expectedMove < 2.0) {
    debug.push(`rr_too_low:${rr.toFixed(2)}_move:${expectedMove.toFixed(2)}%`);
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
  if (signal.direction === "LONG" && currentPrice < signal.stop) return false;
  if (signal.direction === "SHORT" && currentPrice > signal.stop) return false;

  const ageHours = (Date.now() - signal.timestamp) / (1000 * 60 * 60);
  const maxAge = signal.type === "REVERSAL" ? 4 : 8;
  if (ageHours > maxAge) return false;

  return true;
}
