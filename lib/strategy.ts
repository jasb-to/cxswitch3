// lib/strategy.ts — v20.2 "IDENTITY + VALIDITY + HOLD"
// ============================================================
// Signal identity via timestamp-based ID — no external deps
// Defensive validity checks with full logging
// shouldHold with structured exit reasons

// ─── Types ─────────────────────────────────────────────────

export interface Candle {
  timestamp: number;
  open: number;
  high: number;
  low: number;
  close: number;
  volume: number;
}

export interface Signal {
  id: string;
  pair: string;
  direction: "LONG" | "SHORT";
  type: "BREAKOUT" | "PULLBACK" | "CONTINUATION" | "REVERSAL" | "EARLY" | "SWEEP";
  entry: number;
  stop: number;
  target: number;
  confidence: number;
  rr: number;
  adx: number;
  rsi: number;
  stochK: number;
  stochD: number;
  expectedMove: number;
  reason: string;
  timestamp: number;
  version: number;
}

export interface HoldResult {
  shouldHold: boolean;
  reason: string;
}

export interface SignalResult {
  signal?: Signal;
  market?: any;
  debug: string[];
}

// ─── Constants ───────────────────────────────────────────────

const CURRENT_SIGNAL_VERSION = 2;

// ─── Helpers ─────────────────────────────────────────────────

function generateSignalId(pair: string): string {
  return `${pair}_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`;
}

function avg(arr: number[]): number {
  return arr.reduce((a, b) => a + b, 0) / arr.length;
}

function atr(candles: Candle[], period = 14): number {
  const trs: number[] = [];
  for (let i = 1; i < candles.length && i <= period; i++) {
    const c = candles[candles.length - i];
    const p = candles[candles.length - i - 1];
    const tr = Math.max(
      c.high - c.low,
      Math.abs(c.high - p.close),
      Math.abs(c.low - p.close)
    );
    trs.push(tr);
  }
  return avg(trs);
}

function ema(values: number[], period: number): number[] {
  const k = 2 / (period + 1);
  const result: number[] = [values[0]];
  for (let i = 1; i < values.length; i++) {
    result.push(values[i] * k + result[i - 1] * (1 - k));
  }
  return result;
}

function rsi(closes: number[], period = 14): number {
  let gains = 0, losses = 0;
  for (let i = 1; i <= period && i < closes.length; i++) {
    const change = closes[closes.length - i] - closes[closes.length - i - 1];
    if (change > 0) gains += change;
    else losses -= change;
  }
  const avgGain = gains / period;
  const avgLoss = losses / period;
  if (avgLoss === 0) return 100;
  const rs = avgGain / avgLoss;
  return 100 - (100 / (1 + rs));
}

function stoch(candles: Candle[], kPeriod = 14, dPeriod = 3): { k: number; d: number } {
  const lows = candles.slice(-kPeriod).map(c => c.low);
  const highs = candles.slice(-kPeriod).map(c => c.high);
  const lowest = Math.min(...lows);
  const highest = Math.max(...highs);
  const currentClose = candles[candles.length - 1].close;
  
  if (highest === lowest) return { k: 50, d: 50 };
  
  const kRaw = ((currentClose - lowest) / (highest - lowest)) * 100;
  
  // Simple SMA for D (in real impl you'd keep history)
  return { k: kRaw, d: kRaw };
}

function adx(candles: Candle[], period = 14): number {
  // Simplified ADX — in production use a proper implementation
  const trs: number[] = [];
  const plusDMs: number[] = [];
  const minusDMs: number[] = [];
  
  for (let i = 1; i < candles.length && i <= period + 1; i++) {
    const c = candles[candles.length - i];
    const p = candles[candles.length - i - 1];
    
    const tr = Math.max(c.high - c.low, Math.abs(c.high - p.close), Math.abs(c.low - p.close));
    const plusDM = c.high - p.high > p.low - c.low ? Math.max(c.high - p.high, 0) : 0;
    const minusDM = p.low - c.low > c.high - p.high ? Math.max(p.low - c.low, 0) : 0;
    
    trs.push(tr);
    plusDMs.push(plusDM);
    minusDMs.push(minusDM);
  }
  
  const atr = avg(trs);
  const plusDI = avg(plusDMs) / atr * 100;
  const minusDI = avg(minusDMs) / atr * 100;
  const dx = Math.abs(plusDI - minusDI) / (plusDI + minusDI) * 100;
  
  return dx;
}

function slope(values: number[], lookback = 5): number {
  const recent = values.slice(-lookback);
  const n = recent.length;
  const sumX = recent.reduce((s, _, i) => s + i, 0);
  const sumY = recent.reduce((s, v) => s + v, 0);
  const sumXY = recent.reduce((s, v, i) => s + i * v, 0);
  const sumX2 = recent.reduce((s, _, i) => s + i * i, 0);
  return (n * sumXY - sumX * sumY) / (n * sumX2 - sumX * sumX);
}

function identifyStructure(candles: Candle[]): { structure: string; health: string } {
  const closes = candles.map(c => c.close);
  const highs = candles.map(c => c.high);
  const lows = candles.map(c => c.low);
  
  const recentHighs = highs.slice(-20);
  const recentLows = lows.slice(-20);
  
  const hh = Math.max(...recentHighs);
  const ll = Math.min(...recentLows);
  const range = hh - ll;
  const mid = ll + range / 2;
  const current = closes[closes.length - 1];
  
  // Check for higher highs / higher lows (uptrend)
  const hhCount = recentHighs.filter((h, i) => i > 0 && h > recentHighs[i - 1]).length;
  const hlCount = recentLows.filter((l, i) => i > 0 && l > recentLows[i - 1]).length;
  
  // Check for lower highs / lower lows (downtrend)
  const lhCount = recentHighs.filter((h, i) => i > 0 && h < recentHighs[i - 1]).length;
  const llCount = recentLows.filter((l, i) => i > 0 && l < recentLows[i - 1]).length;
  
  const adxVal = adx(candles);
  const slopeVal = slope(closes);
  
  if (hhCount >= 3 && hlCount >= 3 && current > mid && slopeVal > 0) {
    return { structure: "UPTREND", health: adxVal > 25 ? "STRONG" : "WEAK" };
  }
  if (lhCount >= 3 && llCount >= 3 && current < mid && slopeVal < 0) {
    return { structure: "DOWNTREND", health: adxVal > 25 ? "STRONG" : "WEAK" };
  }
  
  // Range detection
  if (range / current < 0.05) {
    return { structure: "RANGE", health: adxVal < 20 ? "HEALTHY" : "BREAKING" };
  }
  
  return { structure: "RANGE", health: "NONE" };
}

// ─── Signal Validity ───────────────────────────────────────

export function isSignalStillValid(signal: Signal | any, currentPrice: number): boolean {
  // Reject old-version signals
  if (!signal || signal.version !== CURRENT_SIGNAL_VERSION) {
    console.log(`[VALIDITY] REJECTED: version mismatch (got ${signal?.version}, need ${CURRENT_SIGNAL_VERSION})`);
    return false;
  }

  const entry = Number(signal.entry);
  const stop = Number(signal.stop);
  const target = Number(signal.target);
  const direction = signal.direction;
  
  if (!entry || !stop || !target || isNaN(entry) || isNaN(stop) || isNaN(target)) {
    console.log(`[VALIDITY] REJECTED: missing/invalid fields — entry=${entry}, stop=${stop}, target=${target}`);
    return false;
  }

  if (direction === "LONG") {
    // For LONG: stop < entry < target
    if (stop >= entry) {
      console.log(`[VALIDITY] REJECTED: LONG stop (${stop}) >= entry (${entry})`);
      return false;
    }
    if (target <= entry) {
      console.log(`[VALIDITY] REJECTED: LONG target (${target}) <= entry (${entry})`);
      return false;
    }
    
    const stopHit = currentPrice <= stop;
    const targetHit = currentPrice >= target;
    
    if (stopHit) {
      console.log(`[VALIDITY] LONG stop HIT: price=${currentPrice.toFixed(4)} <= stop=${stop.toFixed(4)}`);
      return false;
    }
    if (targetHit) {
      console.log(`[VALIDITY] LONG target HIT: price=${currentPrice.toFixed(4)} >= target=${target.toFixed(4)}`);
      return false;
    }
    
    console.log(`[VALIDITY] LONG OK: price=${currentPrice.toFixed(4)} in [${stop.toFixed(4)}, ${target.toFixed(4)}]`);
    return true;
  }
  
  if (direction === "SHORT") {
    // For SHORT: target < entry < stop
    if (stop <= entry) {
      console.log(`[VALIDITY] REJECTED: SHORT stop (${stop}) <= entry (${entry})`);
      return false;
    }
    if (target >= entry) {
      console.log(`[VALIDITY] REJECTED: SHORT target (${target}) >= entry (${entry})`);
      return false;
    }
    
    const stopHit = currentPrice >= stop;
    const targetHit = currentPrice <= target;
    
    if (stopHit) {
      console.log(`[VALIDITY] SHORT stop HIT: price=${currentPrice.toFixed(4)} >= stop=${stop.toFixed(4)}`);
      return false;
    }
    if (targetHit) {
      console.log(`[VALIDITY] SHORT target HIT: price=${currentPrice.toFixed(4)} <= target=${target.toFixed(4)}`);
      return false;
    }
    
    console.log(`[VALIDITY] SHORT OK: price=${currentPrice.toFixed(4)} in [${target.toFixed(4)}, ${stop.toFixed(4)}]`);
    return true;
  }
  
  console.log(`[VALIDITY] REJECTED: unknown direction "${direction}"`);
  return false;
}

// ─── shouldHold ──────────────────────────────────────────────

export function shouldHold(
  signal: Signal,
  candles4h: Candle[],
  candles1h: Candle[],
  currentPrice: number
): HoldResult {
  const { structure, health } = identifyStructure(candles4h);
  const adxVal = adx(candles4h);
  const closes1h = candles1h.map(c => c.close);
  const slope1h = slope(closes1h);
  
  // LONG exits
  if (signal.direction === "LONG") {
    // Trend break: structure no longer supports LONG
    if (structure === "DOWNTREND" && health === "STRONG") {
      return { shouldHold: false, reason: `TREND BREAK: 4H now DOWNTREND STRONG. Exit LONG.` };
    }
    
    // Momentum collapse
    if (adxVal < 20 && slope1h < -0.1) {
      return { shouldHold: false, reason: `MOMENTUM COLLAPSE: ADX ${adxVal.toFixed(1)}, 1H slope ${slope1h.toFixed(2)}. Exit LONG.` };
    }
    
    // Structure invalidated for breakout
    if (signal.type === "BREAKOUT" && structure === "RANGE" && health === "NONE") {
      return { shouldHold: false, reason: `BREAKOUT FAILED: 4H RANGE with no momentum. Exit LONG.` };
    }
    
    // Price too far from entry (unusual move against position)
    const maxAdverseMove = (signal.entry - currentPrice) / signal.entry;
    if (maxAdverseMove > 0.015) { // 1.5% against
      return { shouldHold: false, reason: `ADVERSE MOVE: Price ${currentPrice.toFixed(2)} is ${(maxAdverseMove * 100).toFixed(1)}% below entry. Exit LONG.` };
    }
    
    return { shouldHold: true, reason: `4H ${structure} ${health}. ADX ${adxVal.toFixed(1)}. Hold for ${signal.target.toFixed(2)}.` };
  }
  
  // SHORT exits
  if (signal.direction === "SHORT") {
    if (structure === "UPTREND" && health === "STRONG") {
      return { shouldHold: false, reason: `TREND BREAK: 4H now UPTREND STRONG. Exit SHORT.` };
    }
    
    if (adxVal < 20 && slope1h > 0.1) {
      return { shouldHold: false, reason: `MOMENTUM COLLAPSE: ADX ${adxVal.toFixed(1)}, 1H slope ${slope1h.toFixed(2)}. Exit SHORT.` };
    }
    
    if (signal.type === "BREAKOUT" && structure === "RANGE" && health === "NONE") {
      return { shouldHold: false, reason: `BREAKOUT FAILED: 4H RANGE with no momentum. Exit SHORT.` };
    }
    
    const maxAdverseMove = (currentPrice - signal.entry) / signal.entry;
    if (maxAdverseMove > 0.015) {
      return { shouldHold: false, reason: `ADVERSE MOVE: Price ${currentPrice.toFixed(2)} is ${(maxAdverseMove * 100).toFixed(1)}% above entry. Exit SHORT.` };
    }
    
    return { shouldHold: true, reason: `4H ${structure} ${health}. ADX ${adxVal.toFixed(1)}. Hold for ${signal.target.toFixed(2)}.` };
  }
  
  return { shouldHold: false, reason: `UNKNOWN DIRECTION: ${signal.direction}` };
}

// ─── Signal Generation ───────────────────────────────────────

export function generateSignal(
  pair: string,
  candles1h: Candle[],
  candles4h: Candle[],
  activeTrades: Record<string, any>
): SignalResult {
  const debug: string[] = [];
  
  const currentPrice = candles1h[candles1h.length - 1].close;
  const { structure, health } = identifyStructure(candles4h);
  const adxVal = adx(candles4h);
  const rsiVal = rsi(candles1h.map(c => c.close));
  const stochVal = stoch(candles1h);
  const atrVal = atr(candles1h);
  const closes1h = candles1h.map(c => c.close);
  const slope1h = slope(closes1h);
  
  debug.push(`4h_structure:${structure}_health:${health}_adx:${adxVal.toFixed(1)}_slope:${slope1h.toFixed(2)}`);
  
  // Cooldown check
  const lastTrade = activeTrades[pair];
  if (lastTrade) {
    const hoursSince = (Date.now() - lastTrade.timestamp) / (1000 * 60 * 60);
    if (hoursSince < 4) {
      debug.push(`cooldown:${hoursSince.toFixed(1)}h`);
      return { debug };
    }
  }
  
  // Market data (always return this)
  const market = {
    pair,
    price: currentPrice,
    structure,
    health,
    adx: adxVal,
    rsi: rsiVal,
    stochK: stochVal.k,
    stochD: stochVal.d,
    timestamp: Date.now(),
  };
  
  // ─── BREAKOUT detection ──────────────────────────────────
  const recentCandles = candles4h.slice(-20);
  const highs = recentCandles.map(c => c.high);
  const lows = recentCandles.map(c => c.low);
  const boxHigh = Math.max(...highs);
  const boxLow = Math.min(...lows);
  const boxRange = boxHigh - boxLow;
  
  const isBreakoutLong = currentPrice > boxHigh && structure !== "DOWNTREND";
  const isBreakoutShort = currentPrice < boxLow && structure !== "UPTREND";
  
  // Volume check (simplified — use real volume if available)
  const recentVolume = avg(candles1h.slice(-5).map(c => c.volume));
  const prevVolume = avg(candles1h.slice(-10, -5).map(c => c.volume));
  const volumeSpike = recentVolume > prevVolume * 1.2;
  
  debug.push(`breakout:${isBreakoutLong ? "LONG" : isBreakoutShort ? "SHORT" : "none"}_vol:${volumeSpike}`);
  
  if (isBreakoutLong && volumeSpike && adxVal > 20) {
    const stop = Math.max(boxLow, currentPrice - atrVal * 1.5);
    const target = currentPrice + (currentPrice - stop) * 2;
    const rr = (target - currentPrice) / (currentPrice - stop);
    
    if (rr >= 1.5) {
      const signal: Signal = {
        id: generateSignalId(pair),
        pair,
        direction: "LONG",
        type: "BREAKOUT",
        entry: currentPrice,
        stop: Math.round(stop * 1000) / 1000,
        target: Math.round(target * 1000) / 1000,
        confidence: Math.min(95, Math.round(70 + adxVal * 0.5 + (volumeSpike ? 10 : 0))),
        rr: Math.round(rr * 100) / 100,
        adx: Math.round(adxVal * 10) / 10,
        rsi: Math.round(rsiVal * 10) / 10,
        stochK: Math.round(stochVal.k * 10) / 10,
        stochD: Math.round(stochVal.d * 10) / 10,
        expectedMove: Math.round(((target - currentPrice) / currentPrice * 100) * 10) / 10,
        reason: `BREAKOUT LONG | 4H:${structure} | box:${boxLow.toFixed(2)}-${boxHigh.toFixed(2)} vol:${volumeSpike} | Conf:${Math.min(95, Math.round(70 + adxVal * 0.5 + (volumeSpike ? 10 : 0)))}`,
        timestamp: Date.now(),
        version: CURRENT_SIGNAL_VERSION,
      };
      
      return { signal, market, debug };
    }
  }
  
  if (isBreakoutShort && volumeSpike && adxVal > 20) {
    const stop = Math.min(boxHigh, currentPrice + atrVal * 1.5);
    const target = currentPrice - (stop - currentPrice) * 2;
    const rr = (currentPrice - target) / (stop - currentPrice);
    
    if (rr >= 1.5) {
      const signal: Signal = {
        id: generateSignalId(pair),
        pair,
        direction: "SHORT",
        type: "BREAKOUT",
        entry: currentPrice,
        stop: Math.round(stop * 1000) / 1000,
        target: Math.round(target * 1000) / 1000,
        confidence: Math.min(95, Math.round(70 + adxVal * 0.5 + (volumeSpike ? 10 : 0))),
        rr: Math.round(rr * 100) / 100,
        adx: Math.round(adxVal * 10) / 10,
        rsi: Math.round(rsiVal * 10) / 10,
        stochK: Math.round(stochVal.k * 10) / 10,
        stochD: Math.round(stochVal.d * 10) / 10,
        expectedMove: Math.round(((currentPrice - target) / currentPrice * 100) * 10) / 10,
        reason: `BREAKOUT SHORT | 4H:${structure} | box:${boxLow.toFixed(2)}-${boxHigh.toFixed(2)} vol:${volumeSpike} | Conf:${Math.min(95, Math.round(70 + adxVal * 0.5 + (volumeSpike ? 10 : 0)))}`,
        timestamp: Date.now(),
        version: CURRENT_SIGNAL_VERSION,
      };
      
      return { signal, market, debug };
    }
  }
  
  // ─── PULLBACK detection ────────────────────────────────────
  const ema21 = ema(closes1h, 21);
  const ema50 = ema(closes1h, 50);
  const priceAboveEma21 = currentPrice > ema21[ema21.length - 1];
  const priceAboveEma50 = currentPrice > ema50[ema50.length - 1];
  
  const isPullbackLong = structure === "UPTREND" && !priceAboveEma21 && priceAboveEma50 && rsiVal < 50 && slope1h < 0;
  const isPullbackShort = structure === "DOWNTREND" && priceAboveEma21 && !priceAboveEma50 && rsiVal > 50 && slope1h > 0;
  
  debug.push(`pullback:${isPullbackLong ? "LONG" : isPullbackShort ? "SHORT" : "none"}`);
  
  if (isPullbackLong) {
    const stop = currentPrice - atrVal * 1.5;
    const target = currentPrice + atrVal * 3;
    const rr = (target - currentPrice) / (currentPrice - stop);
    
    const signal: Signal = {
      id: generateSignalId(pair),
      pair,
      direction: "LONG",
      type: "PULLBACK",
      entry: currentPrice,
      stop: Math.round(stop * 1000) / 1000,
      target: Math.round(target * 1000) / 1000,
      confidence: Math.min(90, Math.round(60 + (50 - rsiVal) * 0.5)),
      rr: Math.round(rr * 100) / 100,
      adx: Math.round(adxVal * 10) / 10,
      rsi: Math.round(rsiVal * 10) / 10,
      stochK: Math.round(stochVal.k * 10) / 10,
      stochD: Math.round(stochVal.d * 10) / 10,
      expectedMove: Math.round(((target - currentPrice) / currentPrice * 100) * 10) / 10,
      reason: `PULLBACK LONG | 4H:${structure} | RSI ${rsiVal.toFixed(1)} | Conf:${Math.min(90, Math.round(60 + (50 - rsiVal) * 0.5))}`,
      timestamp: Date.now(),
      version: CURRENT_SIGNAL_VERSION,
    };
    
    return { signal, market, debug };
  }
  
  if (isPullbackShort) {
    const stop = currentPrice + atrVal * 1.5;
    const target = currentPrice - atrVal * 3;
    const rr = (currentPrice - target) / (stop - currentPrice);
    
    const signal: Signal = {
      id: generateSignalId(pair),
      pair,
      direction: "SHORT",
      type: "PULLBACK",
      entry: currentPrice,
      stop: Math.round(stop * 1000) / 1000,
      target: Math.round(target * 1000) / 1000,
      confidence: Math.min(90, Math.round(60 + (rsiVal - 50) * 0.5)),
      rr: Math.round(rr * 100) / 100,
      adx: Math.round(adxVal * 10) / 10,
      rsi: Math.round(rsiVal * 10) / 10,
      stochK: Math.round(stochVal.k * 10) / 10,
      stochD: Math.round(stochVal.d * 10) / 10,
      expectedMove: Math.round(((currentPrice - target) / currentPrice * 100) * 10) / 10,
      reason: `PULLBACK SHORT | 4H:${structure} | RSI ${rsiVal.toFixed(1)} | Conf:${Math.min(90, Math.round(60 + (rsiVal - 50) * 0.5))}`,
      timestamp: Date.now(),
      version: CURRENT_SIGNAL_VERSION,
    };
    
    return { signal, market, debug };
  }
  
  // ─── CONTINUATION detection ────────────────────────────────
  const isContinuationLong = structure === "UPTREND" && slope1h > 0 && adxVal > 20 && rsiVal > 40 && rsiVal < 70;
  const isContinuationShort = structure === "DOWNTREND" && slope1h < 0 && adxVal > 20 && rsiVal > 30 && rsiVal < 60;
  
  debug.push(`continuation:${isContinuationLong ? "LONG" : isContinuationShort ? "SHORT" : "none"}`);
  
  if (isContinuationLong) {
    const stop = currentPrice - atrVal * 1.5;
    const target = currentPrice + atrVal * 2.5;
    const rr = (target - currentPrice) / (currentPrice - stop);
    
    const signal: Signal = {
      id: generateSignalId(pair),
      pair,
      direction: "LONG",
      type: "CONTINUATION",
      entry: currentPrice,
      stop: Math.round(stop * 1000) / 1000,
      target: Math.round(target * 1000) / 1000,
      confidence: Math.min(85, Math.round(65 + adxVal * 0.3)),
      rr: Math.round(rr * 100) / 100,
      adx: Math.round(adxVal * 10) / 10,
      rsi: Math.round(rsiVal * 10) / 10,
      stochK: Math.round(stochVal.k * 10) / 10,
      stochD: Math.round(stochVal.d * 10) / 10,
      expectedMove: Math.round(((target - currentPrice) / currentPrice * 100) * 10) / 10,
      reason: `CONTINUATION LONG | 4H:${structure} ADX ${adxVal.toFixed(1)} | Conf:${Math.min(85, Math.round(65 + adxVal * 0.3))}`,
      timestamp: Date.now(),
      version: CURRENT_SIGNAL_VERSION,
    };
    
    return { signal, market, debug };
  }
  
  if (isContinuationShort) {
    const stop = currentPrice + atrVal * 1.5;
    const target = currentPrice - atrVal * 2.5;
    const rr = (currentPrice - target) / (stop - currentPrice);
    
    const signal: Signal = {
      id: generateSignalId(pair),
      pair,
      direction: "SHORT",
      type: "CONTINUATION",
      entry: currentPrice,
      stop: Math.round(stop * 1000) / 1000,
      target: Math.round(target * 1000) / 1000,
      confidence: Math.min(85, Math.round(65 + adxVal * 0.3)),
      rr: Math.round(rr * 100) / 100,
      adx: Math.round(adxVal * 10) / 10,
      rsi: Math.round(rsiVal * 10) / 10,
      stochK: Math.round(stochVal.k * 10) / 10,
      stochD: Math.round(stochVal.d * 10) / 10,
      expectedMove: Math.round(((currentPrice - target) / currentPrice * 100) * 10) / 10,
      reason: `CONTINUATION SHORT | 4H:${structure} ADX ${adxVal.toFixed(1)} | Conf:${Math.min(85, Math.round(65 + adxVal * 0.3))}`,
      timestamp: Date.now(),
      version: CURRENT_SIGNAL_VERSION,
    };
    
    return { signal, market, debug };
  }
  
  // No signal
  debug.push("no_setup");
  return { market, debug };
}
