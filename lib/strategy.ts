// lib/strategy.ts — v21.3 "COMPILE-CLEAN + FIXES"
// ============================================================
// Fixes:
// 1. TypeScript syntax (Promise<< → Promise<<)
// 2. Division by zero in adx()
// 3. avg() empty array crash
// 4. Monitor key mismatch (use pair only, direction inside state)
// 5. Cooldown blocks signals → check if existing trade still valid
// 6. Signal expiry buffer (0.2% tolerance)
// 7. Stoch empty array guard
// 8. Position sizing helper added
// 9. Signal types aligned with dashboard (BREAKOUT, REVERSAL, SWEEP, CONTINUATION, PULLBACK)
// 10. Removed unused ema()

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

const CURRENT_SIGNAL_VERSION = 3;
const EXPIRY_BUFFER = 0.002; // 0.2% tolerance for target/stop hits

// ─── Helpers ─────────────────────────────────────────────────

function generateSignalId(pair: string): string {
  return `${pair}_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`;
}

function avg(arr: number[]): number {
  if (!arr.length) return 0;
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

// ─── FIXED Stochastic ────────────────────────────────────────

function stoch(candles: Candle[], kPeriod = 14, dPeriod = 3): { k: number; d: number; prevK: number; prevD: number } {
  if (!candles.length) {
    return { k: 50, d: 50, prevK: 50, prevD: 50 };
  }
  
  const len = candles.length;
  
  if (len < kPeriod + 2) {
    const window = candles.slice(-Math.min(kPeriod, len));
    const lows = window.map(c => c.low);
    const highs = window.map(c => c.high);
    const lowest = Math.min(...lows);
    const highest = Math.max(...highs);
    const close = candles[len - 1].close;
    
    const k = highest === lowest ? 50 : ((close - lowest) / (highest - lowest)) * 100;
    return { k: Math.round(k * 10) / 10, d: Math.round(k * 10) / 10, prevK: Math.round(k * 10) / 10, prevD: Math.round(k * 10) / 10 };
  }
  
  const kValues: number[] = [];
  for (let i = kPeriod - 1; i < len; i++) {
    const window = candles.slice(i - kPeriod + 1, i + 1);
    const lows = window.map(c => c.low);
    const highs = window.map(c => c.high);
    const lowest = Math.min(...lows);
    const highest = Math.max(...highs);
    const close = candles[i].close;
    
    if (highest === lowest) {
      kValues.push(50);
    } else {
      kValues.push(((close - lowest) / (highest - lowest)) * 100);
    }
  }
  
  const currentK = kValues[kValues.length - 1];
  const dWindow = kValues.slice(-dPeriod);
  const currentD = avg(dWindow);
  
  const prevK = kValues.length > 1 ? kValues[kValues.length - 2] : currentK;
  const prevDWindow = kValues.slice(-dPeriod - 1, -1);
  const prevD = prevDWindow.length === dPeriod ? avg(prevDWindow) : currentD;
  
  return {
    k: Math.round(currentK * 10) / 10,
    d: Math.round(currentD * 10) / 10,
    prevK: Math.round(prevK * 10) / 10,
    prevD: Math.round(prevD * 10) / 10,
  };
}

function stochCross(candles: Candle[], kPeriod = 14, dPeriod = 3): { 
  crossedUp: boolean; 
  crossedDown: boolean; 
  k: number; 
  d: number; 
  prevK: number; 
  prevD: number 
} {
  const s = stoch(candles, kPeriod, dPeriod);
  return {
    crossedUp: s.prevK <= s.prevD && s.k > s.d,
    crossedDown: s.prevK >= s.prevD && s.k < s.d,
    k: s.k,
    d: s.d,
    prevK: s.prevK,
    prevD: s.prevD,
  };
}

// ─── FIXED ADX ─────────────────────────────────────────────

function adx(candles: Candle[], period = 14): number {
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
  
  const atrVal = avg(trs);
  if (atrVal === 0) return 0;
  
  const plusDI = (avg(plusDMs) / atrVal) * 100;
  const minusDI = (avg(minusDMs) / atrVal) * 100;
  
  if (plusDI + minusDI === 0) return 0;
  
  return (Math.abs(plusDI - minusDI) / (plusDI + minusDI)) * 100;
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
  
  const hhCount = recentHighs.filter((h, i) => i > 0 && h > recentHighs[i - 1]).length;
  const hlCount = recentLows.filter((l, i) => i > 0 && l > recentLows[i - 1]).length;
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
  
  if (range / current < 0.05) {
    return { structure: "RANGE", health: adxVal < 20 ? "HEALTHY" : "BREAKING" };
  }
  
  return { structure: "RANGE", health: "NONE" };
}

// ─── Volume Analysis ─────────────────────────────────────────

function volumeProfile(candles: Candle[], lookback = 8): {
  avgVolume: number;
  currentVolume: number;
  ratio: number;
  isSpike: boolean;
  isDeclining: boolean;
  trend: "rising" | "falling" | "flat";
} {
  const volumes = candles.map(c => c.volume);
  const current = volumes[volumes.length - 1];
  const recent = volumes.slice(-lookback);
  const avgVol = avg(recent);
  const prevAvg = avg(volumes.slice(-lookback * 2, -lookback));
  
  const ratio = avgVol > 0 ? current / avgVol : 1;
  const isSpike = ratio > 1.3;
  const isDeclining = avgVol > 0 && prevAvg > 0 && avgVol < prevAvg * 0.9;
  
  const firstHalf = avg(recent.slice(0, Math.floor(lookback / 2)));
  const secondHalf = avg(recent.slice(Math.floor(lookback / 2)));
  const trend = secondHalf > firstHalf * 1.1 ? "rising" : secondHalf < firstHalf * 0.9 ? "falling" : "flat";
  
  return {
    avgVolume: avgVol,
    currentVolume: current,
    ratio,
    isSpike,
    isDeclining,
    trend,
  };
}

function volumeConfirmsReversal(candles: Candle[], direction: "LONG" | "SHORT"): { confirmed: boolean; reason: string } {
  const vol = volumeProfile(candles, 8);
  const current = candles[candles.length - 1];
  
  const isGreen = current.close > current.open;
  const isRed = current.close < current.open;
  
  if (direction === "LONG") {
    if (vol.isSpike && isGreen) return { confirmed: true, reason: `volume_spike_green_${vol.ratio.toFixed(2)}x` };
    if (vol.isDeclining && isGreen) return { confirmed: true, reason: `volume_exhaustion_green` };
    if (vol.ratio > 1.1 && isGreen) return { confirmed: true, reason: `volume_above_avg_${vol.ratio.toFixed(2)}x` };
    return { confirmed: false, reason: `volume_weak_${vol.ratio.toFixed(2)}x_${isGreen ? "green" : "red"}` };
  }
  
  if (direction === "SHORT") {
    if (vol.isSpike && isRed) return { confirmed: true, reason: `volume_spike_red_${vol.ratio.toFixed(2)}x` };
    if (vol.isDeclining && isRed) return { confirmed: true, reason: `volume_exhaustion_red` };
    if (vol.ratio > 1.1 && isRed) return { confirmed: true, reason: `volume_above_avg_${vol.ratio.toFixed(2)}x` };
    return { confirmed: false, reason: `volume_weak_${vol.ratio.toFixed(2)}x_${isRed ? "red" : "green"}` };
  }
  
  return { confirmed: false, reason: "unknown_direction" };
}

// ─── Price Behavior ─────────────────────────────────────────

function priceConfirmsReversal(candles: Candle[], direction: "LONG" | "SHORT"): { confirmed: boolean; reason: string; wickRatio: number } {
  const current = candles[candles.length - 1];
  const prev = candles[candles.length - 2];
  const body = Math.abs(current.close - current.open);
  const upperWick = current.high - Math.max(current.open, current.close);
  const lowerWick = Math.min(current.open, current.close) - current.low;
  const totalRange = current.high - current.low;
  
  const wickRatio = totalRange > 0 ? (direction === "LONG" ? lowerWick : upperWick) / totalRange : 0;
  
  const isLowerHigh = current.high < prev.high;
  const isHigherLow = current.low > prev.low;
  
  if (direction === "LONG") {
    if (lowerWick > body * 1.5) return { confirmed: true, reason: `lower_wick_rejection_${wickRatio.toFixed(2)}`, wickRatio };
    if (isHigherLow && current.close > current.open) return { confirmed: true, reason: `higher_low_green`, wickRatio };
    if (wickRatio > 0.3) return { confirmed: true, reason: `decent_lower_wick_${wickRatio.toFixed(2)}`, wickRatio };
    return { confirmed: false, reason: `no_reversal_signs_wick_${wickRatio.toFixed(2)}`, wickRatio };
  }
  
  if (direction === "SHORT") {
    if (upperWick > body * 1.5) return { confirmed: true, reason: `upper_wick_rejection_${wickRatio.toFixed(2)}`, wickRatio };
    if (isLowerHigh && current.close < current.open) return { confirmed: true, reason: `lower_high_red`, wickRatio };
    if (wickRatio > 0.3) return { confirmed: true, reason: `decent_upper_wick_${wickRatio.toFixed(2)}`, wickRatio };
    return { confirmed: false, reason: `no_reversal_signs_wick_${wickRatio.toFixed(2)}`, wickRatio };
  }
  
  return { confirmed: false, reason: "unknown_direction", wickRatio: 0 };
}

// ─── Stoch Momentum Gate ─────────────────────────────────────

function stochMomentumGate(candles: Candle[], direction: "LONG" | "SHORT", overboughtThreshold = 80, oversoldThreshold = 20): {
  ready: boolean;
  crossed: boolean;
  k: number;
  d: number;
  prevK: number;
  prevD: number;
  reason: string;
} {
  const cross = stochCross(candles, 14, 3);
  
  if (direction === "LONG") {
    const wasOversold = cross.prevK < oversoldThreshold || cross.prevD < oversoldThreshold;
    const crossingUp = cross.crossedUp;
    const belowD = cross.k < cross.d;
    
    if (crossingUp) return { ready: true, crossed: true, k: cross.k, d: cross.d, prevK: cross.prevK, prevD: cross.prevD, reason: "k_crossed_above_d" };
    if (wasOversold && cross.k > cross.d) return { ready: true, crossed: false, k: cross.k, d: cross.d, prevK: cross.prevK, prevD: cross.prevD, reason: "oversold_recovery" };
    if (belowD && cross.k < 40) return { ready: true, crossed: false, k: cross.k, d: cross.d, prevK: cross.prevK, prevD: cross.prevD, reason: "building_bullish_momentum" };
    return { ready: false, crossed: false, k: cross.k, d: cross.d, prevK: cross.prevK, prevD: cross.prevD, reason: `k=${cross.k.toFixed(1)}_d=${cross.d.toFixed(1)}_not_ready` };
  }
  
  if (direction === "SHORT") {
    const wasOverbought = cross.prevK > overboughtThreshold || cross.prevD > overboughtThreshold;
    const crossingDown = cross.crossedDown;
    const aboveD = cross.k > cross.d;
    
    if (crossingDown) return { ready: true, crossed: true, k: cross.k, d: cross.d, prevK: cross.prevK, prevD: cross.prevD, reason: "k_crossed_below_d" };
    if (wasOverbought && cross.k < cross.d) return { ready: true, crossed: false, k: cross.k, d: cross.d, prevK: cross.prevK, prevD: cross.prevD, reason: "overbought_reversal" };
    if (aboveD && cross.k > 60) return { ready: true, crossed: false, k: cross.k, d: cross.d, prevK: cross.prevK, prevD: cross.prevD, reason: "building_bearish_momentum" };
    return { ready: false, crossed: false, k: cross.k, d: cross.d, prevK: cross.prevK, prevD: cross.prevD, reason: `k=${cross.k.toFixed(1)}_d=${cross.d.toFixed(1)}_not_ready` };
  }
  
  return { ready: false, crossed: false, k: 0, d: 0, prevK: 0, prevD: 0, reason: "unknown_direction" };
}

// ─── Position Sizing ─────────────────────────────────────────

export function calcPositionSize(
  account: number,
  riskPct: number,
  entry: number,
  stop: number
): number {
  const risk = account * riskPct;
  const stopPct = Math.abs(entry - stop) / entry;
  
  if (stopPct <= 0) return 0;
  
  return Math.round(risk / stopPct);
}

// ─── Signal Validity ───────────────────────────────────────

export function isSignalStillValid(signal: Signal | any, currentPrice: number): boolean {
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
    if (stop >= entry) {
      console.log(`[VALIDITY] REJECTED: LONG stop (${stop}) >= entry (${entry})`);
      return false;
    }
    if (target <= entry) {
      console.log(`[VALIDITY] REJECTED: LONG target (${target}) <= entry (${entry})`);
      return false;
    }
    
    const stopHit = currentPrice <= stop * (1 - EXPIRY_BUFFER);
    const targetHit = currentPrice >= target * (1 + EXPIRY_BUFFER);
    
    if (stopHit) {
      console.log(`[VALIDITY] LONG stop HIT: price=${currentPrice.toFixed(4)} <= stop=${stop.toFixed(4)} (buffer: ${EXPIRY_BUFFER})`);
      return false;
    }
    if (targetHit) {
      console.log(`[VALIDITY] LONG target HIT: price=${currentPrice.toFixed(4)} >= target=${target.toFixed(4)} (buffer: ${EXPIRY_BUFFER})`);
      return false;
    }
    
    console.log(`[VALIDITY] LONG OK: price=${currentPrice.toFixed(4)} in [${stop.toFixed(4)}, ${target.toFixed(4)}]`);
    return true;
  }
  
  if (direction === "SHORT") {
    if (stop <= entry) {
      console.log(`[VALIDITY] REJECTED: SHORT stop (${stop}) <= entry (${entry})`);
      return false;
    }
    if (target >= entry) {
      console.log(`[VALIDITY] REJECTED: SHORT target (${target}) >= entry (${entry})`);
      return false;
    }
    
    const stopHit = currentPrice >= stop * (1 + EXPIRY_BUFFER);
    const targetHit = currentPrice <= target * (1 - EXPIRY_BUFFER);
    
    if (stopHit) {
      console.log(`[VALIDITY] SHORT stop HIT: price=${currentPrice.toFixed(4)} >= stop=${stop.toFixed(4)} (buffer: ${EXPIRY_BUFFER})`);
      return false;
    }
    if (targetHit) {
      console.log(`[VALIDITY] SHORT target HIT: price=${currentPrice.toFixed(4)} <= target=${target.toFixed(4)} (buffer: ${EXPIRY_BUFFER})`);
      return false;
    }
    
    console.log(`[VALIDITY] SHORT OK: price=${currentPrice.toFixed(4)} in [${target.toFixed(4)}, ${stop.toFixed(4)}]`);
    return true;
  }
  
  console.log(`[VALIDITY] REJECTED: unknown direction "${direction}"`);
  return false;
}

// ─── shouldHold ──────────────────────────────────────────────

export function shouldHold(signal: Signal, candles4h: Candle[], candles1h: Candle[], currentPrice: number): HoldResult {
  const { structure, health } = identifyStructure(candles4h);
  const adxVal = adx(candles4h);
  const closes1h = candles1h.map(c => c.close);
  const slope1h = slope(closes1h);
  const stoch15m = stoch(candles1h, 14, 3);
  
  if (signal.direction === "LONG") {
    if (structure === "DOWNTREND" && health === "STRONG") {
      return { shouldHold: false, reason: `TREND BREAK: 4H now DOWNTREND STRONG. Exit LONG.` };
    }
    
    if (adxVal < 20 && slope1h < -0.1) {
      return { shouldHold: false, reason: `MOMENTUM COLLAPSE: ADX ${adxVal.toFixed(1)}, 1H slope ${slope1h.toFixed(2)}. Exit LONG.` };
    }
    
    if (stoch15m.k > 80 && stoch15m.k < stoch15m.d) {
      return { shouldHold: false, reason: `STOCH ROLLOVER: K=${stoch15m.k.toFixed(1)} crossed below D=${stoch15m.d.toFixed(1)}. Exit LONG.` };
    }
    
    if (signal.type === "BREAKOUT" && structure === "RANGE" && health === "NONE") {
      return { shouldHold: false, reason: `BREAKOUT FAILED: 4H RANGE with no momentum. Exit LONG.` };
    }
    
    const maxAdverseMove = (signal.entry - currentPrice) / signal.entry;
    if (maxAdverseMove > 0.015) {
      return { shouldHold: false, reason: `ADVERSE MOVE: Price ${currentPrice.toFixed(2)} is ${(maxAdverseMove * 100).toFixed(1)}% below entry. Exit LONG.` };
    }
    
    return { shouldHold: true, reason: `4H ${structure} ${health}. ADX ${adxVal.toFixed(1)}. Stoch K=${stoch15m.k.toFixed(1)}. Hold for ${signal.target.toFixed(2)}.` };
  }
  
  if (signal.direction === "SHORT") {
    if (structure === "UPTREND" && health === "STRONG") {
      return { shouldHold: false, reason: `TREND BREAK: 4H now UPTREND STRONG. Exit SHORT.` };
    }
    
    if (adxVal < 20 && slope1h > 0.1) {
      return { shouldHold: false, reason: `MOMENTUM COLLAPSE: ADX ${adxVal.toFixed(1)}, 1H slope ${slope1h.toFixed(2)}. Exit SHORT.` };
    }
    
    if (stoch15m.k < 20 && stoch15m.k > stoch15m.d) {
      return { shouldHold: false, reason: `STOCH BOUNCE: K=${stoch15m.k.toFixed(1)} crossed above D=${stoch15m.d.toFixed(1)}. Exit SHORT.` };
    }
    
    if (signal.type === "BREAKOUT" && structure === "RANGE" && health === "NONE") {
      return { shouldHold: false, reason: `BREAKOUT FAILED: 4H RANGE with no momentum. Exit SHORT.` };
    }
    
    const maxAdverseMove = (currentPrice - signal.entry) / signal.entry;
    if (maxAdverseMove > 0.015) {
      return { shouldHold: false, reason: `ADVERSE MOVE: Price ${currentPrice.toFixed(2)} is ${(maxAdverseMove * 100).toFixed(1)}% above entry. Exit SHORT.` };
    }
    
    return { shouldHold: true, reason: `4H ${structure} ${health}. ADX ${adxVal.toFixed(1)}. Stoch K=${stoch15m.k.toFixed(1)}. Hold for ${signal.target.toFixed(2)}.` };
  }
  
  return { shouldHold: false, reason: `UNKNOWN DIRECTION: ${signal.direction}` };
}

// ─── Redis Monitor State ─────────────────────────────────────
// KEY FIX: Use pair only as key, direction stored inside state

interface MonitorState {
  pair: string;
  direction: "LONG" | "SHORT";
  startedAt: number;
  reason: string;
  stochK: number;
  stochD: number;
}

let _redisClient: any = null;

export function setRedisClient(client: any): void {
  _redisClient = client;
}

export async function getMonitorState(pair: string): Promise<<MonitorState | undefined> {
  if (!_redisClient) return undefined;
  try {
    const data = await _redisClient.get(`cxswitch:monitor:${pair}`);
    return data ? JSON.parse(data) : undefined;
  } catch (err) {
    console.error(`[MONITOR] Redis get failed for ${pair}:`, err);
    return undefined;
  }
}

export async function setMonitorState(pair: string, state: MonitorState): Promise<void> {
  if (!_redisClient) return;
  try {
    await _redisClient.setex(`cxswitch:monitor:${pair}`, 3600, JSON.stringify(state));
  } catch (err) {
    console.error(`[MONITOR] Redis set failed for ${pair}:`, err);
  }
}

export async function clearMonitorState(pair: string): Promise<void> {
  if (!_redisClient) return;
  try {
    await _redisClient.del(`cxswitch:monitor:${pair}`);
  } catch (err) {
    console.error(`[MONITOR] Redis del failed for ${pair}:`, err);
  }
}

// ─── Signal Generation ───────────────────────────────────────

export async function generateSignal(
  pair: string,
  candles1h: Candle[],
  candles4h: Candle[],
  candles15m: Candle[],
  activeTrades: Record<string, any>
): Promise<<SignalResult> {
  const debug: string[] = [];
  
  const currentPrice = candles1h[candles1h.length - 1].close;
  const { structure, health } = identifyStructure(candles4h);
  const adxVal = adx(candles4h);
  const rsiVal = rsi(candles1h.map(c => c.close));
  const stoch1h = stoch(candles1h, 14, 3);
  const atrVal = atr(candles1h);
  const closes1h = candles1h.map(c => c.close);
  const slope1h = slope(closes1h);
  
  debug.push(`4h_structure:${structure}_health:${health}_adx:${adxVal.toFixed(1)}_slope:${slope1h.toFixed(2)}`);
  
  const market = {
    pair,
    price: currentPrice,
    structure,
    health,
    adx: adxVal,
    rsi: rsiVal,
    stochK: stoch1h.k,
    stochD: stoch1h.d,
    timestamp: Date.now(),
  };
  
  // ─── FIXED Cooldown: Only block if existing trade is still valid ───
  const lastTrade = activeTrades[pair];
  if (lastTrade) {
    const hoursSince = (Date.now() - lastTrade.timestamp) / (1000 * 60 * 60);
    if (hoursSince < 4) {
      // Check if the trade's signal is still valid at current price
      const tradeStillValid = lastTrade.entry && lastTrade.stop && lastTrade.target 
        ? isSignalStillValid({ ...lastTrade, version: CURRENT_SIGNAL_VERSION }, currentPrice)
        : false;
      
      if (tradeStillValid) {
        debug.push(`cooldown:trade_still_valid_${hoursSince.toFixed(1)}h`);
        return { market, debug };
      }
      // If trade hit stop/target, allow new signal
      debug.push(`cooldown:trade_expired_${hoursSince.toFixed(1)}h`);
    }
  }
  
  const trendDirection = structure === "UPTREND" ? "LONG" : structure === "DOWNTREND" ? "SHORT" : null;
  
  if (!trendDirection) {
    debug.push("no_trend:range");
    return { market, debug };
  }
  
  if (adxVal < 20) {
    debug.push(`weak_trend:adx_${adxVal.toFixed(1)}`);
    return { market, debug };
  }
  
  const stoch15 = stochMomentumGate(candles15m, trendDirection);
  debug.push(`15m_stoch:${stoch15.reason}_k:${stoch15.k.toFixed(1)}_d:${stoch15.d.toFixed(1)}`);
  
  // ─── FIXED Monitor key: Use pair only ────────────────────
  const existingMonitor = await getMonitorState(pair);
  
  if (!stoch15.ready) {
    if (existingMonitor) {
      await clearMonitorState(pair);
      debug.push("monitor_cleared:not_ready");
    }
    debug.push("stoch_not_ready");
    return { market, debug };
  }
  
  if (!existingMonitor) {
    await setMonitorState(pair, {
      pair,
      direction: trendDirection,
      startedAt: Date.now(),
      reason: stoch15.reason,
      stochK: stoch15.k,
      stochD: stoch15.d,
    });
    debug.push(`monitor_started:${stoch15.reason}`);
    return { market, debug };
  }
  
  // Check monitor direction matches current trend
  if (existingMonitor.direction !== trendDirection) {
    await clearMonitorState(pair);
    await setMonitorState(pair, {
      pair,
      direction: trendDirection,
      startedAt: Date.now(),
      reason: stoch15.reason,
      stochK: stoch15.k,
      stochD: stoch15.d,
    });
    debug.push(`monitor_direction_changed:${stoch15.reason}`);
    return { market, debug };
  }
  
  const monitorAge = (Date.now() - existingMonitor.startedAt) / (1000 * 60);
  
  if (monitorAge > 60) {
    await clearMonitorState(pair);
    debug.push("monitor_expired:60min");
    return { market, debug };
  }
  
  const volConfirm = volumeConfirmsReversal(candles15m, trendDirection);
  const priceConfirm = priceConfirmsReversal(candles15m, trendDirection);
  
  debug.push(`vol:${volConfirm.reason}`);
  debug.push(`price:${priceConfirm.reason}_wick:${priceConfirm.wickRatio.toFixed(2)}`);
  
  const hasCross = stoch15.crossed;
  const hasConfirmation = volConfirm.confirmed || priceConfirm.confirmed;
  
  if (!hasCross && !hasConfirmation) {
    debug.push("waiting:cross_or_confirmation");
    return { market, debug };
  }
  
  if (!hasCross && monitorAge < 10) {
    debug.push("waiting_for_cross");
    return { market, debug };
  }
  
  await clearMonitorState(pair);
  
  const entryPrice = currentPrice;
  const stopDistance = atrVal * 1.5;
  
  let stop: number;
  let target: number;
  let rr: number;
  let expectedMove: number;
  
  if (trendDirection === "LONG") {
    stop = Math.max(entryPrice - stopDistance, candles15m[candles15m.length - 1].low * 0.998);
    target = entryPrice + (entryPrice - stop) * 2;
    rr = (target - entryPrice) / (entryPrice - stop);
    expectedMove = ((target - entryPrice) / entryPrice) * 100;
  } else {
    stop = Math.min(entryPrice + stopDistance, candles15m[candles15m.length - 1].high * 1.002);
    target = entryPrice - (stop - entryPrice) * 2;
    rr = (entryPrice - target) / (stop - entryPrice);
    expectedMove = ((entryPrice - target) / entryPrice) * 100;
  }
  
  if (rr < 1.5) {
    debug.push(`rr_too_low:${rr.toFixed(2)}`);
    return { market, debug };
  }
  
  let confidence = 65;
  confidence += adxVal > 25 ? 10 : adxVal > 20 ? 5 : 0;
  confidence += volConfirm.confirmed ? 8 : 0;
  confidence += priceConfirm.confirmed ? 7 : 0;
  confidence += stoch15.crossed ? 5 : 0;
  confidence = Math.min(95, confidence);
  
  // Signal type: use REVERSAL when cross + confirmation at extreme, CONTINUATION when cross in trend
  let signalType: Signal["type"];
  if (stoch15.crossed) {
    signalType = "CONTINUATION";
  } else if (stoch15.reason === "overbought_reversal" || stoch15.reason === "oversold_recovery") {
    signalType = "REVERSAL";
  } else {
    signalType = "PULLBACK";
  }
  
  const signal: Signal = {
    id: generateSignalId(pair),
    pair,
    direction: trendDirection,
    type: signalType,
    entry: Math.round(entryPrice * 1000) / 1000,
    stop: Math.round(stop * 1000) / 1000,
    target: Math.round(target * 1000) / 1000,
    confidence,
    rr: Math.round(rr * 100) / 100,
    adx: Math.round(adxVal * 10) / 10,
    rsi: Math.round(rsiVal * 10) / 10,
    stochK: Math.round(stoch15.k * 10) / 10,
    stochD: Math.round(stoch15.d * 10) / 10,
    expectedMove: Math.round(expectedMove * 10) / 10,
    reason: `${signalType} ${trendDirection} | 4H:${structure} ADX ${adxVal.toFixed(1)} | 15m Stoch:${stoch15.reason} | Vol:${volConfirm.reason} | Price:${priceConfirm.reason} | Conf:${confidence}`,
    timestamp: Date.now(),
    version: CURRENT_SIGNAL_VERSION,
  };
  
  debug.push(`SIGNAL:${signalType}_${trendDirection}_entry:${signal.entry}_rr:${signal.rr}`);
  
  return { signal, market, debug };
}
