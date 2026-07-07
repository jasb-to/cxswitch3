// lib/strategy.ts — v28 "1H Entry + HTF Direction"
// ============================================================
// 2026-07-07: 1H StochRSI cross entry, HTF direction filter, no zones, no EMA gate
// ============================================================

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
  type: "ENTRY";
  scale: "ENTRY_1" | null;
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
  exited?: boolean;
  exitReason?: string;
  exitPrice?: number;
  exitTimestamp?: number;
}

export interface MarketData {
  pair: string;
  price: number;
  timestamp: number;
  phase: "NONE" | "WATCHING" | "READY" | "EARLY_ENTRY" | "EXHAUSTION";
  trend: string;
  htfBias?: "BULLISH" | "BEARISH" | "NEUTRAL";
  adx: number;
  rsi: number;
  stochK: number;
  stochD: number;
  closes4h?: number[];
}

export interface SignalResult {
  signal?: Signal;
  market?: MarketData;
  debug: string[];
}

export const CURRENT_SIGNAL_VERSION = 28;

const LONG_TP_PCT = 0.035;
const LONG_SL_PCT = 0.025;
const SHORT_TP_PCT = 0.035;
const SHORT_SL_PCT = 0.025;
const MIN_RR = 1.2;
const EXIT_COOLDOWN_MS = 8 * 60 * 60 * 1000;

interface PairConfig {
  minADX: number;
  momentumThreshold: number;
  volumeMultiplier: number;
}

const PAIR_CONFIGS: Record<string, PairConfig> = {
  default: { minADX: 20, momentumThreshold: 55, volumeMultiplier: 1.3 },
  BTC: { minADX: 20, momentumThreshold: 55, volumeMultiplier: 1.3 },
  ETH: { minADX: 20, momentumThreshold: 55, volumeMultiplier: 1.3 },
  SOL: { minADX: 18, momentumThreshold: 50, volumeMultiplier: 1.4 },
  HYPE: { minADX: 15, momentumThreshold: 50, volumeMultiplier: 1.5 },
};

function getPairConfig(pair: string): PairConfig {
  return PAIR_CONFIGS[pair] || PAIR_CONFIGS.default;
}

function avg(arr: number[]): number {
  if (!arr.length) return 0;
  return arr.reduce((a, b) => a + b, 0) / arr.length;
}

// --- RSI ---
function rsi(closes: number[], period: number = 14): number {
  let gains = 0, losses = 0;
  for (let i = 1; i <= period && i < closes.length; i++) {
    const change = closes[closes.length - i] - closes[closes.length - i - 1];
    if (change > 0) gains += change; else losses += Math.abs(change);
  }
  const avgGain = gains / period, avgLoss = losses / period;
  if (avgLoss === 0) return 100;
  return 100 - (100 / (1 + avgGain / avgLoss));
}

function rsiSeries(closes: number[], period: number = 14): number[] {
  const series: number[] = [];
  for (let i = period; i < closes.length; i++) {
    series.push(rsi(closes.slice(i - period + 1, i + 1), period));
  }
  return series;
}

// --- STOCHRSI ---
function stochRsi(closes: number[], rsiPeriod: number = 14, stochPeriod: number = 14, kSmooth: number = 3, dSmooth: number = 3): { k: number; d: number } {
  const rsiValues = rsiSeries(closes, rsiPeriod);
  if (rsiValues.length < stochPeriod + kSmooth - 1) return { k: 50, d: 50 };

  const rawK: number[] = [];
  for (let i = stochPeriod - 1; i < rsiValues.length; i++) {
    const window = rsiValues.slice(i - stochPeriod + 1, i + 1);
    const lowest = Math.min(...window), highest = Math.max(...window);
    rawK.push(highest === lowest ? 50 : ((rsiValues[i] - lowest) / (highest - lowest)) * 100);
  }

  const kValues: number[] = [];
  for (let i = kSmooth - 1; i < rawK.length; i++) {
    kValues.push(avg(rawK.slice(i - kSmooth + 1, i + 1)));
  }

  if (kValues.length < dSmooth) return { k: 50, d: 50 };
  return { k: Math.round(kValues[kValues.length - 1] * 10) / 10, d: Math.round(avg(kValues.slice(-dSmooth)) * 10) / 10 };
}

// --- WILDER SMOOTHING ---
function wilderSmooth(values: number[], period: number): number[] {
  const result: number[] = [avg(values.slice(0, period))];
  for (let i = period; i < values.length; i++) {
    result.push((result[result.length - 1] * (period - 1) + values[i]) / period);
  }
  return result;
}

// --- ADX ---
function adx(candles: Candle[], period: number = 14): number {
  if (candles.length < period + 1) return 0;
  const trs: number[] = [], plusDMs: number[] = [], minusDMs: number[] = [];
  for (let i = 1; i < candles.length; i++) {
    const c = candles[i], p = candles[i - 1];
    trs.push(Math.max(c.high - c.low, Math.abs(c.high - p.close), Math.abs(c.low - p.close)));
    plusDMs.push(c.high - p.high > p.low - c.low ? Math.max(c.high - p.high, 0) : 0);
    minusDMs.push(p.low - c.low > c.high - p.high ? Math.max(p.low - c.low, 0) : 0);
  }
  const atrSmooth = wilderSmooth(trs, period);
  const plusDISmooth = wilderSmooth(plusDMs, period);
  const minusDISmooth = wilderSmooth(minusDMs, period);
  const dxValues: number[] = [];
  for (let i = 0; i < atrSmooth.length; i++) {
    const pDI = (plusDISmooth[i] / atrSmooth[i]) * 100, mDI = (minusDISmooth[i] / atrSmooth[i]) * 100;
    dxValues.push(pDI + mDI === 0 ? 0 : (Math.abs(pDI - mDI) / (pDI + mDI)) * 100);
  }
  return Math.round(wilderSmooth(dxValues, period).slice(-1)[0] * 10) / 10;
}

// --- AGGREGATE 4H TO 1D ---
function aggregateTo1D(candles4h: Candle[]): Candle[] {
  const sorted = [...candles4h].sort((a, b) => a.timestamp - b.timestamp);
  const groups: Map<string, Candle[]> = new Map();
  for (const c of sorted) {
    const d = new Date(c.timestamp);
    const key = `${d.getUTCFullYear()}-${d.getUTCMonth()}-${d.getUTCDate()}`;
    if (!groups.has(key)) groups.set(key, []);
    groups.get(key)!.push(c);
  }
  const daily: Candle[] = [];
  for (const [, bars] of groups) {
    if (!bars.length) continue;
    daily.push({ timestamp: bars[0].timestamp, open: bars[0].open, high: Math.max(...bars.map(b => b.high)), low: Math.min(...bars.map(b => b.low)), close: bars[bars.length - 1].close, volume: bars.reduce((s, b) => s + b.volume, 0) });
  }
  return daily.sort((a, b) => a.timestamp - b.timestamp);
}

// --- EMA ---
function ema(closes: number[], period: number): number[] {
  const k = 2 / (period + 1);
  const ema: number[] = [closes[0]];
  for (let i = 1; i < closes.length; i++) ema.push(closes[i] * k + ema[i - 1] * (1 - k));
  return ema;
}

// --- TREND DETECTION ---
function trendDirection(candles: Candle[]): { direction: "LONG" | "SHORT" | null; strength: string } {
  const len = candles.length;
  if (len < 25) return { direction: null, strength: "WEAK" };
  const closes = candles.map(c => c.close);
  const ema8 = ema(closes, 8), ema21 = ema(closes, 21);
  const direction = ema8[ema8.length - 1] > ema21[ema21.length - 1] ? "LONG" : "SHORT";
  const highs = candles.slice(-20).map(c => c.high), lows = candles.slice(-20).map(c => c.low);
  const hh = highs[highs.length - 1] > Math.max(...highs.slice(0, -1));
  const ll = lows[lows.length - 1] < Math.min(...lows.slice(0, -1));
  const strength = (direction === "LONG" && hh) || (direction === "SHORT" && ll) ? "STRONG" : "MEDIUM";
  return { direction, strength };
}

// --- EXIT TRACKING ---
interface ExitRecord { signalId: string; pair: string; direction: "LONG" | "SHORT"; exitTimestamp: number; exitReason: string; exitPrice: number; }
const exitStoreById: Map<string, ExitRecord> = new Map();
const exitStoreByPair: Map<string, ExitRecord> = new Map();

function recordExit(signalId: string, pair: string, direction: "LONG" | "SHORT", exitPrice: number, exitReason: string, now: number): void {
  const r: ExitRecord = { signalId, pair, direction, exitTimestamp: now, exitReason, exitPrice };
  exitStoreById.set(signalId, r); exitStoreByPair.set(pair, r);
}

export function hasExited(signalId: string): boolean { return exitStoreById.has(signalId); }

function isInCooldown(pair: string, now: number, direction?: "LONG" | "SHORT"): { inCooldown: boolean; remainingMs: number; lastExit?: ExitRecord } {
  const lastExit = exitStoreByPair.get(pair);
  if (!lastExit) return { inCooldown: false, remainingMs: 0 };
  if (direction && lastExit.direction !== direction) return { inCooldown: false, remainingMs: 0, lastExit };
  const elapsed = now - lastExit.exitTimestamp;
  return elapsed < EXIT_COOLDOWN_MS ? { inCooldown: true, remainingMs: EXIT_COOLDOWN_MS - elapsed, lastExit } : { inCooldown: false, remainingMs: 0, lastExit };
}

// --- 1H ENTRY DETECTION ---
interface EntryResult {
  hasEntry: boolean;
  direction: "LONG" | "SHORT" | null;
  strength: number;
  reasons: string[];
  stochK: number;
  stochD: number;
}

function detect1HEntry(candles1h: Candle[], config: PairConfig): EntryResult {
  const reasons: string[] = [];
  const closes = candles1h.map(c => c.close);
  const volumes = candles1h.map(c => c.volume);

  if (closes.length < 50) return { hasEntry: false, direction: null, strength: 0, reasons: ["insufficient_1h"], stochK: 50, stochD: 50 };

  const stoch = stochRsi(closes);
  const stochPrev = stochRsi(closes.slice(0, -1));

  const avgVol = avg(volumes.slice(-10)), lastVol = volumes[volumes.length - 1];
  const volSurge = lastVol > avgVol * config.volumeMultiplier;

  const crossUp = stochPrev.k <= stochPrev.d && stoch.k > stoch.d;
  const crossDown = stochPrev.k >= stochPrev.d && stoch.k < stoch.d;

  let direction: "LONG" | "SHORT" | null = null;
  let strength = 0;

  if (crossUp) {
    direction = "LONG";
    reasons.push("stoch_cross_up");
    strength += 60;
  } else if (crossDown) {
    direction = "SHORT";
    reasons.push("stoch_cross_down");
    strength += 60;
  }

  if (volSurge) { strength += 20; reasons.push("volume_surge"); }

  const adx1h = adx(candles1h);
  if (adx1h > config.minADX) { strength += 10; reasons.push("adx_ok"); }

  const roc = ((closes[closes.length - 1] - closes[closes.length - 4]) / closes[closes.length - 4]) * 100;
  if (Math.abs(roc) > 1.0) { strength += 10; reasons.push("velocity"); }

  const wasBelow70 = stochPrev.k < 70;
  const wasAbove30 = stochPrev.k > 30;

  if (direction === "LONG" && stoch.k > 70 && !wasBelow70) {
    reasons.push("stoch_already_overbought"); strength = 0; direction = null;
  }
  if (direction === "SHORT" && stoch.k < 30 && !wasAbove30) {
    reasons.push("stoch_already_oversold"); strength = 0; direction = null;
  }

  strength = Math.min(100, strength);
  return { hasEntry: strength >= config.momentumThreshold && direction !== null, direction, strength, reasons, stochK: stoch.k, stochD: stoch.d };
}

// --- MAIN SIGNAL GENERATOR ---
export function generateSignal(pair: string, candles1h: Candle[], candles4h: Candle[], candles15m: Candle[], currentPrice?: number): SignalResult {
  const debug: string[] = [];
  const config = getPairConfig(pair);
  const now = Date.now();

  for (let i = 1; i < candles4h.length; i++) {
    if (candles4h[i].timestamp < candles4h[i - 1].timestamp) { debug.push("Candles not sorted"); return { debug }; }
  }

  const candles1d = aggregateTo1D(candles4h);
  if (candles1d.length < 25 || candles4h.length < 30 || candles1h.length < 50) {
    debug.push("Insufficient candle data");
    return { debug };
  }

  const t1d = trendDirection(candles1d);
  const t4h = trendDirection(candles4h);
  debug.push(`1D: ${t1d.direction || "NONE"} ${t1d.strength}`);
  debug.push(`4H: ${t4h.direction || "NONE"} ${t4h.strength}`);

  const price = currentPrice ?? candles1h[candles1h.length - 1].close;
  const stoch4h = stochRsi(candles4h.map(c => c.close));
  const adx4h = adx(candles4h);

  let tradeDirection: "LONG" | "SHORT" | null = t1d.direction;

  if (t4h.direction !== t1d.direction) {
    if (t4h.strength === "STRONG" && t1d.strength !== "STRONG") {
      debug.push(`4H override: 4H=${t4h.direction} STRONG vs 1D=${t1d.direction} ${t1d.strength}`);
      tradeDirection = t4h.direction;
    } else {
      debug.push(`4H/1D mismatch blocked: 4H=${t4h.direction} vs 1D=${t1d.direction}`);
      tradeDirection = null;
    }
  }

  if (!tradeDirection) {
    const market: MarketData = {
      pair, price: Math.round(price * 100) / 100, timestamp: now,
      phase: "WATCHING", trend: `${t1d.direction || "NONE"} ${t1d.strength}`,
      htfBias: t1d.direction === "LONG" ? "BULLISH" : t1d.direction === "SHORT" ? "BEARISH" : "NEUTRAL",
      adx: Math.round(adx4h * 10) / 10, rsi: Math.round(rsi(candles4h.map(c => c.close)) * 10) / 10,
      stochK: stoch4h.k, stochD: stoch4h.d,
      closes4h: candles4h.map(c => c.close).slice(-50),
    };
    return { market, debug };
  }

  const cooldown = isInCooldown(pair, now, tradeDirection);
  if (cooldown.inCooldown) {
    debug.push(`EXIT COOLDOWN: ${(cooldown.remainingMs / 3600000).toFixed(1)}h remaining`);
    const market: MarketData = {
      pair, price: Math.round(price * 100) / 100, timestamp: now,
      phase: "WATCHING", trend: `${tradeDirection} ${t1d.strength}`,
      htfBias: tradeDirection === "LONG" ? "BULLISH" : "BEARISH",
      adx: Math.round(adx4h * 10) / 10, rsi: Math.round(rsi(candles4h.map(c => c.close)) * 10) / 10,
      stochK: stoch4h.k, stochD: stoch4h.d,
      closes4h: candles4h.map(c => c.close).slice(-50),
    };
    return { market, debug };
  }

  const entry1h = detect1HEntry(candles1h, config);
  debug.push(`1H StochRSI: K${entry1h.stochK} D${entry1h.stochD}`);

  if (entry1h.hasEntry && entry1h.direction === tradeDirection) {
    debug.push(`1H ENTRY: ${entry1h.direction} strength=${entry1h.strength} | ${entry1h.reasons.join(", ")}`);
  } else {
    debug.push(`1H: ${entry1h.hasEntry ? "wrong direction" : "no cross"} | ${entry1h.reasons.join(", ") || "waiting"}`);
  }

  if (!entry1h.hasEntry || entry1h.direction !== tradeDirection) {
    const phase = entry1h.stochK > 80 || entry1h.stochK < 20 ? "EXHAUSTION" : "WATCHING";
    const market: MarketData = {
      pair, price: Math.round(price * 100) / 100, timestamp: now,
      phase, trend: `${tradeDirection} ${t1d.strength}`,
      htfBias: tradeDirection === "LONG" ? "BULLISH" : "BEARISH",
      adx: Math.round(adx4h * 10) / 10, rsi: Math.round(rsi(candles4h.map(c => c.close)) * 10) / 10,
      stochK: stoch4h.k, stochD: stoch4h.d,
      closes4h: candles4h.map(c => c.close).slice(-50),
    };
    return { market, debug };
  }

  const entry = price;
  let sl: number, tp: number;
  if (entry1h.direction === "LONG") {
    sl = entry * (1 - LONG_SL_PCT); tp = entry * (1 + LONG_TP_PCT);
  } else {
    sl = entry * (1 + SHORT_SL_PCT); tp = entry * (1 - SHORT_TP_PCT);
  }

  const rr = Math.abs(tp - entry) / Math.abs(entry - sl);
  if (rr < MIN_RR) {
    debug.push(`R:R ${rr.toFixed(2)} < ${MIN_RR} — skipping`);
    const market: MarketData = {
      pair, price: Math.round(price * 100) / 100, timestamp: now,
      phase: "WATCHING", trend: `${tradeDirection} ${t1d.strength}`,
      htfBias: tradeDirection === "LONG" ? "BULLISH" : "BEARISH",
      adx: Math.round(adx4h * 10) / 10, rsi: Math.round(rsi(candles4h.map(c => c.close)) * 10) / 10,
      stochK: stoch4h.k, stochD: stoch4h.d,
      closes4h: candles4h.map(c => c.close).slice(-50),
    };
    return { market, debug };
  }

  const signal: Signal = {
    id: `${pair}_${now}`, pair, direction: entry1h.direction, type: "ENTRY", scale: "ENTRY_1",
    entry: Math.round(entry * 100) / 100, stop: Math.round(sl * 100) / 100, target: Math.round(tp * 100) / 100,
    confidence: entry1h.strength, rr: Math.round(rr * 100) / 100,
    adx: Math.round(adx4h * 10) / 10, rsi: Math.round(rsi(candles4h.map(c => c.close)) * 10) / 10,
    stochK: entry1h.stochK, stochD: entry1h.stochD,
    expectedMove: Math.round((Math.abs(tp - entry) / entry) * 100 * 10) / 10,
    reason: `${entry1h.direction} 1H ENTRY | 1D ${t1d.strength} | 4H ${t4h.strength} | 1H StochRSI K${entry1h.stochK} D${entry1h.stochD} cross | ${entry1h.reasons.join(", ")} | RR ${rr.toFixed(2)}`,
    timestamp: now, version: CURRENT_SIGNAL_VERSION,
  };

  const market: MarketData = {
    pair, price: Math.round(price * 100) / 100, timestamp: now,
    phase: "EARLY_ENTRY", trend: `${tradeDirection} ${t1d.strength}`,
    htfBias: entry1h.direction === "LONG" ? "BULLISH" : "BEARISH",
    adx: signal.adx, rsi: signal.rsi, stochK: stoch4h.k, stochD: stoch4h.d,
    closes4h: candles4h.map(c => c.close).slice(-50),
  };

  debug.push(`SIGNAL: ${signal.direction} entry=${signal.entry} TP=${signal.target} SL=${signal.stop} RR=${signal.rr}`);
  return { signal, market, debug };
}

// --- MARKET SNAPSHOT ---
export function getMarketSnapshot(pair: string, candles1h: Candle[], candles4h: Candle[], candles15m: Candle[]): MarketData {
  const candles1d = aggregateTo1D(candles4h);
  const t1d = trendDirection(candles1d);
  const t4h = trendDirection(candles4h);
  const stoch4h = stochRsi(candles4h.map(c => c.close));
  const price = candles4h[candles4h.length - 1].close;
  const adx4h = adx(candles4h);

  return {
    pair, price: Math.round(price * 100) / 100, timestamp: Date.now(),
    phase: "WATCHING", trend: t1d.direction ? `${t1d.direction} ${t1d.strength}` : "NONE",
    htfBias: t1d.direction === "LONG" ? "BULLISH" : t1d.direction === "SHORT" ? "BEARISH" : "NEUTRAL",
    adx: Math.round(adx4h * 10) / 10, rsi: Math.round(rsi(candles4h.map(c => c.close)) * 10) / 10,
    stochK: stoch4h.k, stochD: stoch4h.d,
    closes4h: candles4h.map(c => c.close).slice(-50),
  };
}

// --- VALIDITY ---
export interface ValidityCheck { valid: boolean; reason: string; exited: boolean; }

export function isSignalStillValid(signal: Signal, currentPrice: number, now: number = Date.now()): ValidityCheck {
  const ageMs = now - signal.timestamp;
  if (ageMs > 12 * 60 * 60 * 1000) return { valid: false, reason: "expired_ttl", exited: true };
  if (signal.direction === "LONG" && currentPrice <= signal.stop) return { valid: false, reason: "sl_hit", exited: true };
  if (signal.direction === "SHORT" && currentPrice >= signal.stop) return { valid: false, reason: "sl_hit", exited: true };
  if (signal.direction === "LONG" && currentPrice >= signal.target) return { valid: false, reason: "tp_hit", exited: true };
  if (signal.direction === "SHORT" && currentPrice <= signal.target) return { valid: false, reason: "tp_hit", exited: true };
  return { valid: true, reason: "active", exited: false };
}

// --- shouldHold ---
export interface HoldResult { shouldHold: boolean; reason: string; }

export function shouldHold(signal: Signal, candles4h: Candle[], currentPrice: number, now?: number): HoldResult {
  if (signal.exited || hasExited(signal.id)) return { shouldHold: false, reason: "already_exited" };

  const candles1d = aggregateTo1D(candles4h);
  const t1d = trendDirection(candles1d);
  const trendReversed = (signal.direction === "LONG" && t1d.direction === "SHORT") || (signal.direction === "SHORT" && t1d.direction === "LONG");

  if (trendReversed) {
    const inProfit = signal.direction === "LONG" ? currentPrice > signal.entry : currentPrice < signal.entry;
    if (!inProfit) {
      if (now) recordExit(signal.id, signal.pair, signal.direction, currentPrice, "trend_reversed_unprofitable", now);
      return { shouldHold: false, reason: "trend_reversed_unprofitable" };
    }
  }

  const validity = isSignalStillValid(signal, currentPrice, now);
  if (!validity.valid && now) recordExit(signal.id, signal.pair, signal.direction, currentPrice, validity.reason, now);
  return { shouldHold: validity.valid, reason: validity.reason };
}

// --- filterExpiredSignals ---
export function filterExpiredSignals(signals: Signal[], currentPrices: Record<string, number>, now?: number): { active: Signal[]; exited: { signal: Signal; reason: string }[] } {
  const active: Signal[] = [], exited: { signal: Signal; reason: string }[] = [];
  for (const signal of signals) {
    if (signal.exited || hasExited(signal.id)) continue;
    const price = currentPrices[signal.pair];
    if (price === undefined) { active.push(signal); continue; }
    const check = isSignalStillValid(signal, price, now);
    if (check.valid) active.push(signal);
    else { exited.push({ signal, reason: check.reason }); if (now) recordExit(signal.id, signal.pair, signal.direction, price, check.reason, now); }
  }
  return { active, exited };
}

// --- COMPATIBILITY ---
export async function generateSignalCompat(pair: string, candles1h: Candle[], candles4h: Candle[], candles15m: Candle[], activeTrades?: Record<string, any>, currentPrice?: number): Promise<SignalResult> {
  return generateSignal(pair, candles1h, candles4h, candles15m, currentPrice);
}
export function isSignalStillValidBool(signal: Signal, currentPrice: number): boolean { return isSignalStillValid(signal, currentPrice).valid; }
export function shouldHoldCompat(signal: Signal, candles4h: Candle[], candles1h: Candle[], currentPrice: number): HoldResult { return shouldHold(signal, candles4h, currentPrice); }
