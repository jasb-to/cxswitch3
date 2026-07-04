// lib/strategy.ts — v29.1 "State Machine: Accumulation → Expansion"
// ============================================================
// No arbitrary weights. No stoch levels. Just state transitions and market structure.

export interface Candle {
  timestamp: number;
  open: number;
  high: number;
  low: number;
  close: number;
  volume: number;
}

export interface Zone {
  top: number;
  bottom: number;
  left: number;      // start timestamp
  right: number;     // end timestamp (frozen on breakout)
  active: boolean;   // true = still growing, false = frozen
  volumeClimax: number;
  type: "ACCUMULATION" | "DISTRIBUTION";
}

export interface Signal {
  id: string;
  pair: string;
  direction: "LONG" | "SHORT";
  stage: "WATCHING" | "ACCUMULATION" | "READY" | "CONFIRMED";
  entry: number;
  stop: number;
  target: number;
  trail: number;
  confidence: number;
  rr: number;
  adx: number;
  zoneTop: number;
  zoneBottom: number;
  explanation: string;
  timestamp: number;
  version: number;
}

export interface SignalResult {
  signal?: Signal;
  market?: any;
  debug: string[];
  zone?: Zone;
  stage: "NONE" | "WATCHING" | "ACCUMULATION" | "READY" | "CONFIRMED" | "EXPANSION" | "EXHAUSTION";
  uiAlert?: UIAlert;
}

export interface UIAlert {
  type: "SHORT_ALERT_OVERSOLD_CROSS" | "LONG_ALERT_OVERBOUGHT_CROSS";
  message: string;
  stochK: number;
  stochD: number;
  timestamp: number;
}

export interface ValidityCheck {
  valid: boolean;
  reason: string;
  exited: boolean;
}

export interface HoldResult {
  shouldHold: boolean;
  reason: string;
}

export const CURRENT_SIGNAL_VERSION = 29;

// ─── Helpers ─────────────────────────────────────────────────────────────

function avg(arr: number[]): number {
  if (!arr.length) return 0;
  return arr.reduce((a, b) => a + b, 0) / arr.length;
}

function ema(values: number[], period: number): number[] {
  const k = 2 / (period + 1);
  const result: number[] = [values[0]];
  for (let i = 1; i < values.length; i++) {
    result.push(values[i] * k + result[i - 1] * (1 - k));
  }
  return result;
}

function atr(candles: Candle[], period: number = 14): number[] {
  const trs: number[] = [];
  for (let i = 1; i < candles.length; i++) {
    const c = candles[i], p = candles[i - 1];
    trs.push(Math.max(c.high - c.low, Math.abs(c.high - p.close), Math.abs(c.low - p.close)));
  }
  const result: number[] = [];
  for (let i = period - 1; i < trs.length; i++) {
    result.push(avg(trs.slice(i - period + 1, i + 1)));
  }
  return result;
}

function trueRange(c: Candle, p: Candle): number {
  return Math.max(c.high - c.low, Math.abs(c.high - p.close), Math.abs(c.low - p.close));
}

function rsi(closes: number[], period: number = 14): number {
  if (closes.length < period + 1) return 50;
  let gains = 0, losses = 0;
  for (let i = 1; i <= period; i++) {
    const change = closes[closes.length - period - 1 + i] - closes[closes.length - period - 2 + i];
    if (change > 0) gains += change;
    else losses += Math.abs(change);
  }
  let avgGain = gains / period;
  let avgLoss = losses / period;
  for (let i = period + 1; i < closes.length; i++) {
    const change = closes[i] - closes[i - 1];
    const gain = change > 0 ? change : 0;
    const loss = change < 0 ? Math.abs(change) : 0;
    avgGain = (avgGain * (period - 1) + gain) / period;
    avgLoss = (avgLoss * (period - 1) + loss) / period;
  }
  if (avgLoss === 0) return 100;
  return 100 - (100 / (1 + avgGain / avgLoss));
}

function stochRsi(closes: number[]): { k: number; d: number } {
  const rsiValues: number[] = [];
  for (let i = 14; i < closes.length; i++) {
    rsiValues.push(rsi(closes.slice(0, i + 1)));
  }
  if (rsiValues.length < 14) return { k: 50, d: 50 };
  
  const rawK: number[] = [];
  for (let i = 13; i < rsiValues.length; i++) {
    const w = rsiValues.slice(i - 13, i + 1);
    const lo = Math.min(...w), hi = Math.max(...w);
    rawK.push(hi === lo ? 50 : ((rsiValues[i] - lo) / (hi - lo)) * 100);
  }
  
  const kValues: number[] = [];
  for (let i = 2; i < rawK.length; i++) {
    kValues.push(avg(rawK.slice(i - 2, i + 1)));
  }
  
  if (kValues.length < 3) return { k: 50, d: 50 };
  return { k: Math.round(kValues[kValues.length - 1] * 10) / 10, d: Math.round(avg(kValues.slice(-3)) * 10) / 10 };
}

function adx(candles: Candle[]): number {
  if (candles.length < 15) return 0;
  const trs: number[] = [];
  const plusDMs: number[] = [];
  const minusDMs: number[] = [];
  for (let i = 1; i < candles.length; i++) {
    const c = candles[i], p = candles[i - 1];
    trs.push(Math.max(c.high - c.low, Math.abs(c.high - p.close), Math.abs(c.low - p.close)));
    plusDMs.push(c.high - p.high > p.low - c.low ? Math.max(c.high - p.high, 0) : 0);
    minusDMs.push(p.low - c.low > c.high - p.high ? Math.max(p.low - c.low, 0) : 0);
  }
  const atrSmooth = [avg(trs.slice(0, 14))];
  const plusDISmooth = [avg(plusDMs.slice(0, 14))];
  const minusDISmooth = [avg(minusDMs.slice(0, 14))];
  for (let i = 14; i < trs.length; i++) {
    atrSmooth.push((atrSmooth[atrSmooth.length - 1] * 13 + trs[i]) / 14);
    plusDISmooth.push((plusDISmooth[plusDISmooth.length - 1] * 13 + plusDMs[i]) / 14);
    minusDISmooth.push((minusDISmooth[minusDISmooth.length - 1] * 13 + minusDMs[i]) / 14);
  }
  const dxValues: number[] = [];
  for (let i = 0; i < atrSmooth.length; i++) {
    const pDI = (plusDISmooth[i] / atrSmooth[i]) * 100;
    const mDI = (minusDISmooth[i] / atrSmooth[i]) * 100;
    dxValues.push((pDI + mDI === 0) ? 0 : (Math.abs(pDI - mDI) / (pDI + mDI)) * 100);
  }
  const adxSmooth = [avg(dxValues.slice(0, 14))];
  for (let i = 14; i < dxValues.length; i++) {
    adxSmooth.push((adxSmooth[adxSmooth.length - 1] * 13 + dxValues[i]) / 14);
  }
  return Math.round(adxSmooth[adxSmooth.length - 1] * 10) / 10;
}

// ─── STATE MACHINE ───────────────────────────────────────────────────────

// Per-pair state persistence (in-memory; survives within process lifetime)
const stateStore: Map<string, {
  stage: "NONE" | "WATCHING" | "ACCUMULATION" | "READY" | "CONFIRMED";
  zone: Zone | null;
  impulseCandle: Candle | null;
  impulseDirection: "LONG" | "SHORT" | null;
  prevStoch: { k: number; d: number } | null;
}> = new Map();

export function getState(pair: string) {
  return stateStore.get(pair) || {
    stage: "NONE" as const,
    zone: null,
    impulseCandle: null,
    impulseDirection: null,
    prevStoch: null,
  };
}

export function setState(pair: string, state: any) {
  stateStore.set(pair, state);
}

export function resetState(pair: string) {
  stateStore.set(pair, {
    stage: "NONE" as const,
    zone: null,
    impulseCandle: null,
    impulseDirection: null,
    prevStoch: null,
  });
}

// ─── IMPULSE DETECTION ─────────────────────────────────────────────────

// Requires: ATR expansion AND momentum expansion (large body in one direction) AND volume climax
function detectImpulse(candles: Candle[]): { candle: Candle; direction: "LONG" | "SHORT" } | null {
  if (candles.length < 10) return null;
  
  const last = candles[candles.length - 1];
  const prev = candles[candles.length - 2];
  
  const body = Math.abs(last.close - last.open);
  const prevBodies = candles.slice(-10, -1).map(c => Math.abs(c.close - c.open));
  const avgBody = avg(prevBodies);
  
  const tr = trueRange(last, prev);
  const prevTRs = candles.slice(-10, -1).map((c, i) => 
    trueRange(c, candles[candles.length - 10 + i - 1] || candles[0])
  );
  const avgTR = avg(prevTRs);
  
  // Volume climax
  const prevVolumes = candles.slice(-10, -1).map(c => c.volume);
  const avgVol = avg(prevVolumes);
  const volClimax = last.volume > avgVol * 2;
  
  // Strong directional candle
  const strongBody = body > avgBody * 1.8;
  const expandingTR = tr > avgTR * 1.5;
  
  if (!strongBody || !expandingTR || !volClimax) return null;
  
  const direction = last.close > last.open ? "LONG" : "SHORT";
  
  return { candle: last, direction };
}

// ─── ACCUMULATION DETECTION ──────────────────────────────────────────────

// Requires: Range compression AND volatility contraction AND price not continuing impulse
function isAccumulating(candles: Candle[], impulseDir: "LONG" | "SHORT"): boolean {
  if (candles.length < 7) return false;
  
  const recent = candles.slice(-6);
  const highs = recent.map(c => c.high);
  const lows = recent.map(c => c.low);
  const range = Math.max(...highs) - Math.min(...lows);
  
  const atrSeries = atr(candles, 14);
  const currentATR = atrSeries[atrSeries.length - 1];
  const impulseATR = atrSeries[atrSeries.length - 7] || currentATR;
  
  // Range compression vs impulse
  const compressed = range < impulseATR * 2.5;
  
  // ATR contraction
  const atrContracted = currentATR < impulseATR * 0.7;
  
  // Price not continuing impulse direction
  const last = candles[candles.length - 1];
  const impulseClose = candles[candles.length - 7].close;
  const notContinuing = impulseDir === "LONG" 
    ? last.close < impulseClose + range * 0.3
    : last.close > impulseClose - range * 0.3;
  
  return compressed && atrContracted && notContinuing;
}

// ─── STOCH CROSS (direction only, not levels) ────────────────────────────

function stochCrossedUp(prev: { k: number; d: number } | null, curr: { k: number; d: number }): boolean {
  if (!prev) return false;
  return prev.k <= prev.d && curr.k > curr.d;
}

function stochCrossedDown(prev: { k: number; d: number } | null, curr: { k: number; d: number }): boolean {
  if (!prev) return false;
  return prev.k >= prev.d && curr.k < curr.d;
}

// ─── MAIN GENERATOR ────────────────────────────────────────────────────

export function generateSignal(
  pair: string,
  candles1h: Candle[],
  candles4h: Candle[],
  candles15m: Candle[],
  currentPrice?: number
): SignalResult {
  const debug: string[] = [];
  const price = currentPrice ?? candles4h[candles4h.length - 1]?.close ?? 0;
  
  let state = getState(pair);
  const closes = candles4h.map(c => c.close);
  const stoch = stochRsi(closes);
  const currentADX = adx(candles4h);
  
  // ── STAGE: NONE → WATCHING (impulse detected) ─────────────────────
  
  if (state.stage === "NONE") {
    const impulse = detectImpulse(candles4h);
    if (impulse) {
      state = {
        ...state,
        stage: "WATCHING",
        impulseCandle: impulse.candle,
        impulseDirection: impulse.direction,
      };
      setState(pair, state);
      debug.push(`WATCHING: ${impulse.direction} impulse on volume climax at ${impulse.candle.close.toFixed(1)}`);
      return { debug, stage: "WATCHING" };
    }
    debug.push("No impulse — scanning");
    return { debug, stage: "NONE" };
  }
  
  // ── STAGE: WATCHING → ACCUMULATION (range compression after impulse) ─
  
  if (state.stage === "WATCHING" && state.impulseDirection) {
    if (isAccumulating(candles4h, state.impulseDirection)) {
      const recent = candles4h.slice(-6);
      const top = Math.max(...recent.map(c => c.high));
      const bottom = Math.min(...recent.map(c => c.low));
      
      const zone: Zone = {
        top,
        bottom,
        left: recent[0].timestamp,
        right: recent[recent.length - 1].timestamp,
        active: true,
        volumeClimax: state.impulseCandle?.volume || 0,
        type: state.impulseDirection === "LONG" ? "ACCUMULATION" : "DISTRIBUTION",
      };
      
      state = { ...state, stage: "ACCUMULATION", zone };
      setState(pair, state);
      debug.push(`ACCUMULATION: Zone ${bottom.toFixed(1)}-${top.toFixed(1)} forming after ${state.impulseDirection} impulse`);
      return { debug, stage: "ACCUMULATION", zone };
    }
    
    // Reset if impulse continues without accumulation
    const last = candles4h[candles4h.length - 1];
    const impulseClose = state.impulseCandle?.close || 0;
    const continued = state.impulseDirection === "LONG" 
      ? last.close > impulseClose * 1.03
      : last.close < impulseClose * 0.97;
    
    if (continued) {
      debug.push("Impulse continued without accumulation — resetting");
      resetState(pair);
      return { debug, stage: "NONE" };
    }
    
    debug.push("WATCHING: waiting for accumulation pattern");
    return { debug, stage: "WATCHING" };
  }
  
  // ── STAGE: ACCUMULATION (grow zone) ───────────────────────────────
  
  if (state.stage === "ACCUMULATION" && state.zone) {
    const last = candles4h[candles4h.length - 1];
    
    // Grow the zone
    state.zone.top = Math.max(state.zone.top, last.high);
    state.zone.bottom = Math.min(state.zone.bottom, last.low);
    state.zone.right = last.timestamp;
    
    // Check for READY (stoch cross inside zone)
    const insideZone = last.close >= state.zone.bottom && last.close <= state.zone.top;
    const stochReady = state.impulseDirection === "LONG"
      ? stochCrossedUp(state.prevStoch, stoch)
      : stochCrossedDown(state.prevStoch, stoch);
    
    if (insideZone && stochReady) {
      state = { ...state, stage: "READY" };
      setState(pair, state);
      debug.push(`READY: Stoch crossed ${state.impulseDirection === "LONG" ? "up" : "down"} inside zone`);
      return { debug, stage: "READY", zone: state.zone };
    }
    
    // Reset if breaks zone wrong way
    const atrSeries = atr(candles4h, 14);
    const currentATR = atrSeries[atrSeries.length - 1];
    const brokeWrongWay = state.impulseDirection === "LONG"
      ? last.close < state.zone.bottom - currentATR * 0.5
      : last.close > state.zone.top + currentATR * 0.5;
    
    if (brokeWrongWay) {
      debug.push("Broke zone wrong way — resetting");
      resetState(pair);
      return { debug, stage: "NONE" };
    }
    
    setState(pair, state);
    debug.push(`ACCUMULATION: Zone growing ${state.zone.bottom.toFixed(1)}-${state.zone.top.toFixed(1)}`);
    return { debug, stage: "ACCUMULATION", zone: state.zone };
  }
  
  // ── STAGE: READY → CONFIRMED (breakout from zone) ───────────────────
  
  if (state.stage === "READY" && state.zone) {
    const last = candles4h[candles4h.length - 1];
    const atrSeries = atr(candles4h, 14);
    const currentATR = atrSeries[atrSeries.length - 1];
    
    const breakoutUp = last.close > state.zone.top + currentATR * 0.2;
    const breakoutDown = last.close < state.zone.bottom - currentATR * 0.2;
    
    const correctBreakout = state.impulseDirection === "LONG" ? breakoutUp : breakoutDown;
    
    if (correctBreakout) {
      // Freeze zone
      state.zone.active = false;
      state.zone.right = last.timestamp;
      
      const direction = state.impulseDirection === "LONG" ? "LONG" : "SHORT";
      const entry = last.close;
      const zoneHeight = state.zone.top - state.zone.bottom;
      
      // Stop: swing low/high in zone OR 2 ATR, whichever is tighter
      const swingStop = direction === "LONG" 
        ? state.zone.bottom 
        : state.zone.top;
      const atrStop = direction === "LONG"
        ? entry - currentATR * 2
        : entry + currentATR * 2;
      const stop = direction === "LONG"
        ? Math.max(swingStop, atrStop)
        : Math.min(swingStop, atrStop);
      
      const target = direction === "LONG"
        ? entry + zoneHeight * 2.5
        : entry - zoneHeight * 2.5;
      
      // Trail: start at entry - 1 ATR (long) or entry + 1 ATR (short)
      const trail = direction === "LONG"
        ? entry - currentATR
        : entry + currentATR;
      
      const rr = Math.abs(target - entry) / Math.abs(entry - stop);
      
      // Build explanation
      const parts: string[] = [];
      parts.push(`A ${direction === "LONG" ? "high-volume selloff" : "high-volume rally"} was followed by`);
      parts.push(`range compression within ${state.zone.bottom.toFixed(0)}-${state.zone.top.toFixed(0)},`);
      parts.push(`ATR contracted, momentum turned ${direction === "LONG" ? "positive" : "negative"},`);
      parts.push(`and price broke ${direction === "LONG" ? "above" : "below"} the accumulation zone.`);
      
      const signal: Signal = {
        id: `${pair}_${Date.now()}`,
        pair,
        direction,
        stage: "CONFIRMED",
        entry: Math.round(entry * 100) / 100,
        stop: Math.round(stop * 100) / 100,
        target: Math.round(target * 100) / 100,
        trail: Math.round(trail * 100) / 100,
        confidence: 75, // CONFIRMED = high confidence
        rr: Math.round(rr * 100) / 100,
        adx: currentADX,
        zoneTop: Math.round(state.zone.top * 100) / 100,
        zoneBottom: Math.round(state.zone.bottom * 100) / 100,
        explanation: parts.join(" "),
        timestamp: Date.now(),
        version: CURRENT_SIGNAL_VERSION,
      };
      
      // Reset state after signal
      resetState(pair);
      
      const market = {
        pair,
        price: Math.round(price * 100) / 100,
        timestamp: Date.now(),
        phase: "EXPANSION",
        trend: `${direction} EXPANSION`,
        adx: signal.adx,
        zoneTop: signal.zoneTop,
        zoneBottom: signal.zoneBottom,
        closes4h: candles4h.slice(-50).map(c => c.close),
      };
      
      debug.push(`SIGNAL: ${direction} CONFIRMED entry=${signal.entry} stop=${signal.stop} target=${signal.target} trail=${signal.trail} RR=${signal.rr}`);
      
      return { signal, market, debug, stage: "CONFIRMED", zone: state.zone };
    }
    
    // Still waiting for breakout
    debug.push("READY: waiting for breakout");
    return { debug, stage: "READY", zone: state.zone };
  }
  
  // Fallback — should not reach here
  debug.push(`Unexpected state: ${state.stage}`);
  return { debug, stage: state.stage as any };
}

// ─── Trail Stop Update ─────────────────────────────────────────────────

export function updateTrail(
  signal: Signal,
  candles4h: Candle[],
  currentPrice: number
): { trail: number; shouldExit: boolean; reason: string } {
  const len = candles4h.length;
  if (len < 5) return { trail: signal.trail, shouldExit: false, reason: "insufficient candles" };
  
  const atrSeries = atr(candles4h, 14);
  const currentATR = atrSeries[atrSeries.length - 1];
  
  // Swing-based trail: last 3 candles swing low/high OR 2 ATR from price, whichever is tighter
  const recent = candles4h.slice(-3);
  const swingLow = Math.min(...recent.map(c => c.low));
  const swingHigh = Math.max(...recent.map(c => c.high));
  
  let newTrail: number;
  
  if (signal.direction === "LONG") {
    const atrTrail = currentPrice - currentATR * 2;
    const swingTrail = swingLow - currentATR * 0.3;
    newTrail = Math.max(signal.trail, Math.max(atrTrail, swingTrail));
  } else {
    const atrTrail = currentPrice + currentATR * 2;
    const swingTrail = swingHigh + currentATR * 0.3;
    newTrail = Math.min(signal.trail, Math.min(atrTrail, swingTrail));
  }
  
  const hit = signal.direction === "LONG" ? currentPrice < newTrail : currentPrice > newTrail;
  
  return {
    trail: Math.round(newTrail * 100) / 100,
    shouldExit: hit,
    reason: hit ? `Trail hit at ${newTrail.toFixed(1)}` : "Holding",
  };
}

// ─── Market Snapshot ────────────────────────────────────────────────────

export function getMarketSnapshot(
  pair: string,
  candles1h: Candle[] | undefined,
  candles4h: Candle[],
  candles15m: Candle[] | undefined
): any {
  const state = getState(pair);
  const price = candles4h[candles4h.length - 1]?.close ?? 0;
  const closes = candles4h.map(c => c.close);
  const stoch = stochRsi(closes);
  
  return {
    pair,
    price: Math.round(price * 100) / 100,
    timestamp: Date.now(),
    phase: state.stage === "NONE" ? "SCANNING" : state.stage,
    trend: state.impulseDirection ? `${state.impulseDirection} ${state.stage}` : "NONE",
    adx: Math.round(adx(candles4h) * 10) / 10,
    stochK: stoch.k,
    stochD: stoch.d,
    zoneTop: state.zone ? Math.round(state.zone.top * 100) / 100 : null,
    zoneBottom: state.zone ? Math.round(state.zone.bottom * 100) / 100 : null,
    zoneActive: state.zone ? state.zone.active : false,
    closes4h: candles4h.slice(-50).map(c => c.close),
  };
}

// ─── Validity ───────────────────────────────────────────────────────────

export function isSignalStillValid(signal: Signal, currentPrice: number, now: number = Date.now()): ValidityCheck {
  const ageMs = now - signal.timestamp;
  const maxAge = 24 * 60 * 60 * 1000; // 24h for expansion entries
  
  if (ageMs > maxAge) {
    return { valid: false, reason: "expired_ttl", exited: true };
  }
  
  if (signal.direction === "LONG" && currentPrice <= signal.stop) {
    return { valid: false, reason: "sl_hit", exited: true };
  }
  if (signal.direction === "SHORT" && currentPrice >= signal.stop) {
    return { valid: false, reason: "sl_hit", exited: true };
  }
  
  if (signal.direction === "LONG" && currentPrice >= signal.target) {
    return { valid: false, reason: "tp_hit", exited: true };
  }
  if (signal.direction === "SHORT" && currentPrice <= signal.target) {
    return { valid: false, reason: "tp_hit", exited: true };
  }
  
  return { valid: true, reason: "active", exited: false };
}

// ─── shouldHold (uses trail, not stoch) ────────────────────────────────

export function shouldHold(
  pair: string,
  signal: Signal,
  candles4h: Candle[],
  currentPrice: number
): HoldResult {
  const trailUpdate = updateTrail(signal, candles4h, currentPrice);
  
  if (trailUpdate.shouldExit) {
    return { shouldHold: false, reason: `trail_stop — Price ${currentPrice.toFixed(1)} hit trail at ${trailUpdate.trail}` };
  }
  
  return { shouldHold: true, reason: `trailing at ${trailUpdate.trail}` };
}

// ─── filterExpiredSignals ───────────────────────────────────────────────

export function filterExpiredSignals(
  signals: Signal[],
  currentPrices: Record<string, number>,
  now?: number
): { active: Signal[]; exited: { signal: Signal; reason: string }[] } {
  const active: Signal[] = [];
  const exited: { signal: Signal; reason: string }[] = [];
  
  for (const signal of signals) {
    const price = currentPrices[signal.pair];
    if (price === undefined) {
      active.push(signal);
      continue;
    }
    const check = isSignalStillValid(signal, price, now);
    if (check.valid) active.push(signal);
    else exited.push({ signal, reason: check.reason });
  }
  
  return { active, exited };
}

// ─── checkTradeStatus ───────────────────────────────────────────────────

export type TradeStatus = "ACTIVE" | "TP_HIT" | "SL_HIT" | "EXHAUSTION" | "EXPIRED";

export function checkTradeStatus(signal: Signal, currentPrice: number, now: number = Date.now()): TradeStatus {
  const validity = isSignalStillValid(signal, currentPrice, now);
  
  if (!validity.valid && validity.reason === "expired_ttl") return "EXPIRED";
  if (!validity.valid && validity.reason === "sl_hit") return "SL_HIT";
  if (!validity.valid && validity.reason === "tp_hit") return "TP_HIT";
  
  return "ACTIVE";
}

// ============================================================
// COMPATIBILITY EXPORTS
// ============================================================

export async function getMonitorState(pair: string): Promise<any | undefined> {
  return undefined;
}

export async function clearMonitorState(pair: string): Promise<void> {
  return;
}

export async function setMonitorState(pair: string, state: any): Promise<void> {
  return;
}

export function setRedisClient(_: any): void {
  return;
}

export async function generateSignalCompat(
  pair: string,
  candles1h: Candle[],
  candles4h: Candle[],
  candles15m: Candle[],
  activeTrades?: Record<string, any>,
  currentPrice?: number
): Promise<SignalResult> {
  return generateSignal(pair, candles1h, candles4h, candles15m, currentPrice);
}

export function isSignalStillValidBool(signal: Signal, currentPrice: number): boolean {
  return isSignalStillValid(signal, currentPrice).valid;
}

export function shouldHoldCompat(
  pair: string,
  signal: Signal,
  candles4h: Candle[],
  candles1h: Candle[],
  currentPrice: number
): HoldResult {
  return shouldHold(pair, signal, candles4h, currentPrice);
}
