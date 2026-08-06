// lib/strategy.ts — v30 "Bias + Pullback to TL"
// ============================================================
// Enters BEFORE the 4H break. 15m confirmation at the 4H TL zone.
// Stateless. Compatible with v54 cron / v50.1 telegram / v54 dashboard.

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
  type: "ENTRY_1" | "ENTRY_2" | "ADD";
  scale: "ENTRY_1" | "ENTRY_2" | "ADD" | null;
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
  trend?: string;
  location?: string;
  trigger?: string;
  context?: any;
}

export interface SignalResult {
  signals?: Signal[];
  signal?: Signal;
  market?: any;
  debug: string[];
}

export const CURRENT_SIGNAL_VERSION = 30;
const MIN_RR = 1.5;
const TL_THRESHOLD = 0.008; // 0.8% — price must be within this of the 4H TL

function avg(arr: number[]): number {
  if (!arr.length) return 0;
  return arr.reduce((a, b) => a + b, 0) / arr.length;
}

function ema(closes: number[], period: number): number[] {
  const k = 2 / (period + 1);
  const ema: number[] = [closes[0]];
  for (let i = 1; i < closes.length; i++) {
    ema.push(closes[i] * k + ema[i - 1] * (1 - k));
  }
  return ema;
}

function atr(candles: Candle[], period: number = 14): number {
  const start = Math.max(1, candles.length - period);
  const trs: number[] = [];
  for (let i = start; i < candles.length; i++) {
    const c = candles[i];
    const p = candles[i - 1];
    trs.push(Math.max(c.high - c.low, Math.abs(c.high - p.close), Math.abs(c.low - p.close)));
  }
  return avg(trs);
}

function aggregateTo1D(candles4h: Candle[]): Candle[] {
  const sorted = [...candles4h].sort((a, b) => a.timestamp - b.timestamp);
  const groups = new Map<string, Candle[]>();
  for (const c of sorted) {
    const d = new Date(c.timestamp);
    const key = `${d.getUTCFullYear()}-${d.getUTCMonth()}-${d.getUTCDate()}`;
    if (!groups.has(key)) groups.set(key, []);
    groups.get(key)!.push(c);
  }
  const daily: Candle[] = [];
  for (const [, bars] of groups) {
    if (!bars.length) continue;
    daily.push({
      timestamp: bars[0].timestamp,
      open: bars[0].open,
      high: Math.max(...bars.map(b => b.high)),
      low: Math.min(...bars.map(b => b.low)),
      close: bars[bars.length - 1].close,
      volume: bars.reduce((s, b) => s + b.volume, 0),
    });
  }
  return daily.sort((a, b) => a.timestamp - b.timestamp);
}

function getBias(candles: Candle[]): "LONG" | "SHORT" | null {
  if (candles.length < 30) return null;
  const closes = candles.map(c => c.close);
  const ema8 = ema(closes, 8);
  const ema21 = ema(closes, 21);
  const e8 = ema8[ema8.length - 1];
  const e21 = ema21[ema21.length - 1];

  const recent = candles.slice(-5);
  const lows = recent.map(c => c.low);
  const highs = recent.map(c => c.high);
  const ll = lows[lows.length - 1] < Math.min(...lows.slice(0, -1));
  const hh = highs[highs.length - 1] > Math.max(...highs.slice(0, -1));

  if (e8 > e21 && !ll) return "LONG";
  if (e8 < e21 && !hh) return "SHORT";
  return null;
}

function findPivots(candles: Candle[], direction: "LONG" | "SHORT") {
  const pivots: { index: number; price: number; timestamp: number }[] = [];
  for (let i = 3; i < candles.length - 3; i++) {
    const isSwingLow =
      candles[i].low < candles[i - 1].low &&
      candles[i].low < candles[i - 2].low &&
      candles[i].low < candles[i + 1].low &&
      candles[i].low < candles[i + 2].low;
    const isSwingHigh =
      candles[i].high > candles[i - 1].high &&
      candles[i].high > candles[i - 2].high &&
      candles[i].high > candles[i + 1].high &&
      candles[i].high > candles[i + 2].high;

    if (direction === "LONG" && isSwingLow) {
      pivots.push({ index: i, price: candles[i].low, timestamp: candles[i].timestamp });
    }
    if (direction === "SHORT" && isSwingHigh) {
      pivots.push({ index: i, price: candles[i].high, timestamp: candles[i].timestamp });
    }
  }
  return pivots;
}

function fitTrendline(pivots: { index: number; price: number }[]) {
  if (pivots.length < 3) return null;
  const pts = pivots.slice(-5);
  const n = pts.length;
  const sumX = pts.reduce((s, p) => s + p.index, 0);
  const sumY = pts.reduce((s, p) => s + p.price, 0);
  const sumXY = pts.reduce((s, p) => s + p.index * p.price, 0);
  const sumX2 = pts.reduce((s, p) => s + p.index * p.index, 0);
  const denom = n * sumX2 - sumX * sumX;
  if (denom === 0) return null;
  const slope = (n * sumXY - sumX * sumY) / denom;
  const intercept = (sumY - slope * sumX) / n;
  return { slope, intercept };
}

function findPullbackEntry(
  candles15m: Candle[],
  direction: "LONG" | "SHORT",
  tlPrice: number
): { entry: number; stop: number; reason: string } | null {
  if (candles15m.length < 30) return null;

  const last = candles15m[candles15m.length - 1];
  const prev = candles15m[candles15m.length - 2];
  const closes = candles15m.map(c => c.close);
  const ema20 = ema(closes, 20);
  const e20 = ema20[ema20.length - 1];

  const recentLows = candles15m.slice(-20).map(c => c.low);
  const recentHighs = candles15m.slice(-20).map(c => c.high);
  const swingLow = Math.min(...recentLows);
  const swingHigh = Math.max(...recentHighs);
  const atr15m = atr(candles15m, 14);

  // Price must be interacting with the TL zone on 15m
  const nearTL = Math.abs(last.close - tlPrice) / tlPrice < TL_THRESHOLD;

  if (direction === "LONG") {
    const atSupport = nearTL || last.low <= tlPrice * 1.003 || last.low <= e20 * 1.008;
    const confirming = last.close > last.open && last.close > e20 && prev.close < prev.open;
    if (atSupport && confirming) {
      const sl = Math.min(swingLow, last.low - atr15m * 0.5);
      return { entry: last.close, stop: sl, reason: "15m TL retest + bull candle" };
    }
  } else {
    const atResistance = nearTL || last.high >= tlPrice * 0.997 || last.high >= e20 * 0.992;
    const confirming = last.close < last.open && last.close < e20 && prev.close > prev.open;
    if (atResistance && confirming) {
      const sl = Math.max(swingHigh, last.high + atr15m * 0.5);
      return { entry: last.close, stop: sl, reason: "15m TL retest + bear candle" };
    }
  }
  return null;
}

export function generateSignal(
  pair: string,
  candles1h: Candle[],
  candles4h: Candle[],
  candles15m: Candle[],
  _activeTrades?: any[],
  currentPrice?: number
): SignalResult {
  const debug: string[] = [];
  const now = Date.now();

  for (let i = 1; i < candles4h.length; i++) {
    if (candles4h[i].timestamp < candles4h[i - 1].timestamp) {
      debug.push("Candles not sorted");
      return { debug };
    }
  }

  if (candles4h.length < 30 || !candles15m.length) {
    debug.push("Insufficient data");
    return { debug };
  }

  // 1. BIAS GATE
  const candles1d = aggregateTo1D(candles4h);
  const bias1d = getBias(candles1d);
  const bias4h = getBias(candles4h);
  debug.push(`1D: ${bias1d || "NONE"} | 4H: ${bias4h || "NONE"}`);

  if (!bias1d || !bias4h || bias1d !== bias4h) {
    debug.push("Bias mismatch");
    return { debug };
  }
  const direction = bias1d;

  // 2. 4H TRENDLINE
  const pivots = findPivots(candles4h, direction);
  const tl = fitTrendline(pivots);
  if (!tl) {
    debug.push("No trendline");
    return { debug };
  }

  const last4h = candles4h[candles4h.length - 1];
  const tlNow = tl.slope * (candles4h.length - 1) + tl.intercept;
  const dist = (last4h.close - tlNow) / tlNow;
  debug.push(`TL: ${tlNow.toFixed(2)} | Price: ${last4h.close.toFixed(2)} | Dist: ${(dist * 100).toFixed(2)}%`);

  // 3. PRICE MUST BE NEAR THE TRENDLINE (pullback zone)
  const nearTL = Math.abs(dist) < TL_THRESHOLD;
  if (!nearTL) {
    debug.push(`Price ${(dist * 100).toFixed(2)}% from TL — outside ${(TL_THRESHOLD * 100).toFixed(2)}% zone`);
    return { debug };
  }

  // 4. 15m CONFIRMATION AT THE ZONE
  const pullback = findPullbackEntry(candles15m, direction, tlNow);
  if (!pullback) {
    debug.push("Waiting for 15m confirmation at TL...");
    return { debug };
  }

  // 5. BUILD SIGNAL
  const atr4h = atr(candles4h, 14);
  const entry = pullback.entry;
  const sl = pullback.stop;
  const tp = direction === "LONG" ? entry + atr4h * 4 : entry - atr4h * 4;

  const rr = direction === "LONG"
    ? (tp - entry) / (entry - sl)
    : (entry - tp) / (sl - entry);

  if (!isFinite(rr) || rr < MIN_RR) {
    debug.push(`R:R ${rr?.toFixed(2) || "inf"} < ${MIN_RR}`);
    return { debug };
  }

  const signal: Signal = {
    id: `${pair}_${now}`,
    pair,
    direction,
    type: "ENTRY_1",
    scale: "ENTRY_1",
    entry: Math.round(entry * 100) / 100,
    stop: Math.round(sl * 100) / 100,
    target: Math.round(tp * 100) / 100,
    confidence: 75,
    rr: Math.round(rr * 100) / 100,
    adx: 0,
    rsi: 0,
    stochK: 0,
    stochD: 0,
    expectedMove: Math.abs(tp - entry) / entry * 100,
    reason: `${direction} | ${pullback.reason} | 4H TL ${tlNow.toFixed(1)} | RR ${rr.toFixed(2)}`,
    timestamp: now,
    version: CURRENT_SIGNAL_VERSION,
    trend: direction,
    location: "NEAR_TL",
    trigger: "READY",
    context: {
      marketPhase: `${direction} aligned`,
      structure: "trendline_pullback",
      momentum: pullback.reason,
      pullback: "active",
      crossAge: 0,
    },
  };

  debug.push(`ENTRY: ${direction} @ ${signal.entry} | SL ${signal.stop} | TP ${signal.target} | RR ${signal.rr}`);

  return {
    signals: [signal],
    signal,
    market: {
      pair,
      price: Math.round((currentPrice ?? entry) * 100) / 100,
      timestamp: now,
      trend: direction,
      location: "NEAR_TL",
      trigger: "READY",
      trendlinePrice: Math.round(tlNow * 100) / 100,
      distToTrendline: Math.round(Math.abs(dist) * 10000) / 100,
      locationType: "PRE_BREAK",
      ema8_4h: 0,
      ema21_4h: 0,
      ema50_4h: 0,
    },
    debug,
  };
}

export function getMarketSnapshot(
  pair: string,
  candles1h: Candle[],
  candles4h: Candle[],
  candles15m: Candle[]
): any {
  const candles1d = aggregateTo1D(candles4h);
  const bias1d = getBias(candles1d);
  const bias4h = getBias(candles4h);
  const price = candles4h[candles4h.length - 1].close;

  const pivots = bias4h ? findPivots(candles4h, bias4h) : [];
  const tl = bias4h ? fitTrendline(pivots) : null;
  const tlPrice = tl ? tl.slope * (candles4h.length - 1) + tl.intercept : 0;
  const dist = tlPrice ? (price - tlPrice) / tlPrice : 1;
  const nearTL = Math.abs(dist) < TL_THRESHOLD;

  let trigger = "WAITING";
  if (!bias1d || bias1d !== bias4h) {
    trigger = "BIAS_MISMATCH";
  } else if (nearTL) {
    trigger = "READY";
  }

  return {
    pair,
    price: Math.round(price * 100) / 100,
    timestamp: Date.now(),
    trend: bias1d && bias1d === bias4h ? bias1d : "FLAT",
    location: tl ? (nearTL ? "NEAR_TL" : "BEYOND_TL") : "NONE",
    trigger,
    trendlinePrice: Math.round(tlPrice * 100) / 100,
    distToTrendline: tlPrice ? Math.round(Math.abs(dist) * 10000) / 100 : 0,
    locationType: tl ? "STRUCTURE" : "NONE",
    ema8_4h: 0,
    ema21_4h: 0,
    ema50_4h: 0,
  };
}

export interface ValidityCheck {
  valid: boolean;
  reason: string;
  exited: boolean;
}

export function isSignalStillValid(signal: Signal, currentPrice: number, now: number = Date.now()): ValidityCheck {
  const maxAge = 72 * 60 * 60 * 1000;
  if (now - signal.timestamp > maxAge) {
    return { valid: false, reason: "expired_ttl", exited: true };
  }

  const entryBuffer = 1.02;
  if (signal.direction === "LONG" && currentPrice > signal.entry * entryBuffer) {
    return { valid: false, reason: "missed_entry", exited: true };
  }
  if (signal.direction === "SHORT" && currentPrice < signal.entry * (2 - entryBuffer)) {
    return { valid: false, reason: "missed_entry", exited: true };
  }

  if (signal.direction === "LONG") {
    if (currentPrice <= signal.stop) return { valid: false, reason: "sl_hit", exited: true };
    if (currentPrice >= signal.target) return { valid: false, reason: "tp_hit", exited: true };
  } else {
    if (currentPrice >= signal.stop) return { valid: false, reason: "sl_hit", exited: true };
    if (currentPrice <= signal.target) return { valid: false, reason: "tp_hit", exited: true };
  }

  return { valid: true, reason: "active", exited: false };
}

export interface HoldResult {
  shouldHold: boolean;
  reason: string;
}

export function shouldHold(signal: Signal, candles4h: Candle[], currentPrice: number, _now?: number): HoldResult {
  const candles1d = aggregateTo1D(candles4h);
  const bias1d = getBias(candles1d);
  const bias4h = getBias(candles4h);

  if (signal.direction === "LONG" && bias4h === "SHORT") {
    return { shouldHold: false, reason: "4H_bias_flipped" };
  }
  if (signal.direction === "SHORT" && bias4h === "LONG") {
    return { shouldHold: false, reason: "4H_bias_flipped" };
  }

  const pivots = findPivots(candles4h, signal.direction);
  const tl = fitTrendline(pivots);
  if (tl) {
    const idx = candles4h.length - 1;
    const tlPrice = tl.slope * idx + tl.intercept;
    const last = candles4h[candles4h.length - 1];
    if (signal.direction === "LONG" && last.close < tlPrice) {
      return { shouldHold: false, reason: "trendline_reclaim" };
    }
    if (signal.direction === "SHORT" && last.close > tlPrice) {
      return { shouldHold: false, reason: "trendline_reclaim" };
    }
  }

  const validity = isSignalStillValid(signal, currentPrice);
  return { shouldHold: validity.valid, reason: validity.reason };
}

export function shouldHoldCompat(
  signal: Signal,
  candles4h: Candle[],
  _candles1h: Candle[],
  currentPrice: number
): HoldResult {
  return shouldHold(signal, candles4h, currentPrice);
}

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

export type TradeStatus = "ACTIVE" | "TP_HIT" | "SL_HIT" | "EXPIRED";

export function checkTradeStatus(signal: Signal, currentPrice: number, now: number = Date.now()): TradeStatus {
  const v = isSignalStillValid(signal, currentPrice, now);
  if (!v.valid && v.reason === "expired_ttl") return "EXPIRED";
  if (signal.direction === "LONG") {
    if (currentPrice >= signal.target) return "TP_HIT";
    if (currentPrice <= signal.stop) return "SL_HIT";
  } else {
    if (currentPrice <= signal.target) return "TP_HIT";
    if (currentPrice >= signal.stop) return "SL_HIT";
  }
  return "ACTIVE";
}

export function rebuildStateFromTrades(_trades: Record<string, any>): void {
  return;
}

export function recordTradeExit(
  _pair: string,
  _direction: "LONG" | "SHORT",
  _reason: string,
  _exitPrice: number,
  _candles4h?: Candle[]
): void {
  return;
}

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
  _activeTrades?: Record<string, any>,
  currentPrice?: number
): Promise<SignalResult> {
  return generateSignal(pair, candles1h, candles4h, candles15m, [], currentPrice);
}

export function isSignalStillValidBool(signal: Signal, currentPrice: number): boolean {
  return isSignalStillValid(signal, currentPrice).valid;
}
