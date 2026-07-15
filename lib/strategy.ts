// ============================================================
// CXSwitch v38 — EMA + ADX Bias, Price-First Exits
//
// CHANGES FROM v37.5:
// 1. Bias: EMA-based (instant) instead of pivot-based structure
// 2. Trend strength: ADX filter (no-trade zone below 20)
// 3. Exits: Price-based invalidation + EMA regime flip (fast)
// 4. Removed: StochRSI, Stoch extreme exits, RSI, complex pullback tiers
// 5. Kept: Pivots for swing-based TP/SL levels
// 6. Simplified: Single entry tier, no hysteresis bands, no cooldowns
// 7. UI/Persistence: All exports maintained for backward compatibility
// ============================================================

export interface Candle {
  timestamp: number;
  open: number;
  high: number;
  low: number;
  close: number;
  volume: number;
}

// ============================================================
// SIGNAL INTERFACE — Maintained for UI compatibility
// ============================================================
export interface Signal {
  id: string;
  pair: string;
  direction: "LONG" | "SHORT";
  entry: number;
  stop: number;
  target: number;
  confidence: number;
  timestamp: number;
  exited: boolean;
  status?: "ACTIVE" | "PENDING_EXIT" | "EXITED";
  exitReason?: string;
  exitRecommendedAt?: number;
  exitRecommendedPrice?: number;
  exitPrice?: number;
  exitTimestamp?: number;
  entryType?: "EARLY" | "BREAKOUT" | "RETEST";
  trendlinePrice?: number;
  volumeConfirmed?: boolean;
  type?: "ACCUMULATE" | "BREAKOUT";
  scale?: "ENTRY_1" | "ENTRY_2" | "ADD" | null;
  entryTier?: string;
  entryMode?: string;
  positionSizePct?: number;
  tradeState?: TradeState;
  regimeDirection?: string;
  conflictEntry?: boolean;
  entryTimeframe?: string;
  rr?: number;
  adx?: number;
  rsi?: number;
  stochK?: number;
  stochD?: number;
  highestPrice?: number;
  lowestPrice?: number;
  lockedStop?: number;
  profitLockActive?: boolean;
  version?: number;
  expectedMove?: number;
  reason?: string;
}

export interface SignalResult {
  signal?: Signal;
  market?: any;
  debug: string[];
}

export interface HoldResult {
  shouldHold: boolean;
  reason: string;
  updatedTradeState?: TradeState;
}

export interface Trendline {
  startIndex: number;
  endIndex: number;
  startPrice: number;
  endPrice: number;
  slope: number;
  type: "SUPPORT" | "RESISTANCE";
  touches: number;
  isValid: boolean;
  isBroken: boolean;
  brokenAt?: number;
  brokenPrice?: number;
}

export interface TradeState {
  phase: TradeLifecyclePhase;
  phaseEnteredAt: number;
  highestPrice: number;
  lowestPrice: number;
  entryPrice: number;
  lockedStop: number | null;
  profitLockLevel: number;
  currentR: number;
  entryTimestamp: number;
  lastDecisionTimestamp: number;
}

export interface MarketRegime {
  direction: "LONG" | "SHORT" | null;
  strength: number;
  adx: number | null;
  timestamp: number;
}

export interface ExitRecord {
  id: string;
  pair: string;
  direction: "LONG" | "SHORT";
  entry: number;
  exitPrice: number;
  pnl: number;
  reason: string;
  timestamp: number;
}

export type EntryTier = "NO_TRADE" | "WATCH" | "EARLY_ENTRY" | "CONFIRMED_ENTRY";
export type TradeLifecyclePhase = "WATCH" | "ENTRY" | "BUILDING" | "TREND" | "PROFIT_PROTECTION" | "EXIT" | "COOLDOWN";
export type PullbackTier = "DEEP" | "SHALLOW" | "MOMENTUM" | null;

export const CURRENT_SIGNAL_VERSION = 38;

function avg(arr: number[]): number {
  return arr.length ? arr.reduce((a, b) => a + b, 0) / arr.length : 0;
}

function isValid(v: any): boolean {
  return typeof v === "number" && Number.isFinite(v);
}

// ============================================================
// EMA — Core indicator for bias and exits
// ============================================================
export function ema(values: number[], period: number): number[] {
  if (values.length < period || !values.every(isValid)) return [];
  const k = 2 / (period + 1);
  const out: number[] = [];
  let prev = values.slice(0, period).reduce((a, b) => a + b, 0) / period;
  out.push(prev);
  for (let i = period; i < values.length; i++) {
    prev = values[i] * k + prev * (1 - k);
    out.push(prev);
  }
  return out.every(isValid) ? out : [];
}

// ============================================================
// ADX — Trend strength filter
// ============================================================
export function adx(candles: Candle[], period = 14): number | null {
  if (candles.length < period * 2) return null;
  const h = candles.map(c => c.high), l = candles.map(c => c.low), c = candles.map(c => c.close);
  const trs: number[] = [], pDM: number[] = [], mDM: number[] = [];
  for (let i = 1; i < candles.length; i++) {
    trs.push(Math.max(h[i] - l[i], Math.abs(h[i] - c[i - 1]), Math.abs(l[i] - c[i - 1])));
    pDM.push(h[i] - h[i - 1] > l[i - 1] - l[i] ? Math.max(h[i] - h[i - 1], 0) : 0);
    mDM.push(l[i - 1] - l[i] > h[i] - h[i - 1] ? Math.max(l[i - 1] - l[i], 0) : 0);
  }
  const smooth = (vals: number[], lookback: number) => {
    const r = [avg(vals.slice(0, lookback))];
    for (let i = lookback; i < vals.length; i++) r.push((r[r.length - 1] * (lookback - 1) + vals[i]) / lookback);
    return r;
  };
  const atrS = smooth(trs, period), pDIS = smooth(pDM, period), mDIS = smooth(mDM, period);
  if (!atrS.length) return null;
  const dx = atrS.map((_, i) => {
    const p = (pDIS[i] / atrS[i]) * 100, m = (mDIS[i] / atrS[i]) * 100;
    return p + m === 0 ? 0 : (Math.abs(p - m) / (p + m)) * 100;
  });
  const adxS = smooth(dx, period);
  const v = adxS[adxS.length - 1];
  return isValid(v) ? Math.round(v * 10) / 10 : null;
}

// ============================================================
// ATR — Stop loss and position sizing
// ============================================================
function atr(candles: Candle[], period = 14): number {
  const trs: number[] = [];
  for (let i = Math.max(1, candles.length - period); i < candles.length; i++) {
    trs.push(Math.max(candles[i].high - candles[i].low, Math.abs(candles[i].high - candles[i - 1].close), Math.abs(candles[i].low - candles[i - 1].close)));
  }
  return avg(trs);
}

// ============================================================
// 4H → 1D aggregation
// ============================================================
export function aggregateTo1D(candles4h: Candle[]): Candle[] {
  if (!candles4h?.length) return [];
  const sorted = [...candles4h].sort((a, b) => a.timestamp - b.timestamp);
  const groups = new Map<string, Candle[]>();
  for (const c of sorted) {
    const key = new Date(c.timestamp).toISOString().split("T")[0];
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

// ============================================================
// PIVOTS — Used ONLY for swing-based TP/SL levels
// ============================================================
function findPivots(candles: Candle[], leftBars = 3, rightBars = 2): {
  highs: { index: number; price: number }[];
  lows: { index: number; price: number }[];
} {
  const highs: { index: number; price: number }[] = [];
  const lows: { index: number; price: number }[] = [];
  for (let i = leftBars; i < candles.length - rightBars; i++) {
    const isHigh = candles.slice(i - leftBars, i).every(c => c.high <= candles[i].high) &&
                   candles.slice(i + 1, i + 1 + rightBars).every(c => c.high <= candles[i].high);
    if (isHigh) highs.push({ index: i, price: candles[i].high });
    const isLow = candles.slice(i - leftBars, i).every(c => c.low >= candles[i].low) &&
                  candles.slice(i + 1, i + 1 + rightBars).every(c => c.low >= candles[i].low);
    if (isLow) lows.push({ index: i, price: candles[i].low });
  }
  return { highs, lows };
}

function buildTrendlines(
  candles: Candle[],
  pivots: { index: number; price: number }[],
  type: "SUPPORT" | "RESISTANCE",
  minTouches = 2,
  atrTolerance = 0.3
): Trendline[] {
  const atrVal = atr(candles, 14);
  const tolerance = atrVal * atrTolerance;
  const lines: Trendline[] = [];
  for (let i = 0; i < pivots.length - 1; i++) {
    for (let j = i + 1; j < pivots.length; j++) {
      const p1 = pivots[i];
      const p2 = pivots[j];
      const slope = (p2.price - p1.price) / (p2.index - p1.index);
      if (type === "RESISTANCE" && slope > 0.001) continue;
      if (type === "SUPPORT" && slope < -0.001) continue;
      let touches = 0;
      let valid = true;
      for (let k = p1.index; k <= Math.min(p2.index + 5, candles.length - 1); k++) {
        const expectedPrice = p1.price + slope * (k - p1.index);
        const actualPrice = type === "RESISTANCE" ? candles[k].high : candles[k].low;
        const closePrice = candles[k].close;
        if (type === "RESISTANCE") {
          if (closePrice > expectedPrice + tolerance * 2) { valid = false; break; }
          if (Math.abs(actualPrice - expectedPrice) < tolerance) touches++;
        } else {
          if (closePrice < expectedPrice - tolerance * 2) { valid = false; break; }
          if (Math.abs(actualPrice - expectedPrice) < tolerance) touches++;
        }
      }
      if (valid && touches >= minTouches) {
        lines.push({
          startIndex: p1.index, endIndex: p2.index, startPrice: p1.price, endPrice: p2.price,
          slope, type, touches, isValid: true, isBroken: false,
        });
      }
    }
  }
  lines.sort((a, b) => {
    if (b.touches !== a.touches) return b.touches - a.touches;
    return b.endIndex - a.endIndex;
  });
  return lines.slice(0, 3);
}

function getTrendlinePrice(line: Trendline, index: number): number {
  return line.startPrice + line.slope * (index - line.startIndex);
}

function checkTrendlineBreak(
  candles: Candle[],
  trendlines: Trendline[],
  type: "SUPPORT" | "RESISTANCE"
): { broken: boolean; line?: Trendline; breakIndex?: number; breakPrice?: number } {
  if (candles.length < 3) return { broken: false };
  const currentIndex = candles.length - 1;
  const prevIndex = candles.length - 2;
  const current = candles[currentIndex];
  const prev = candles[prevIndex];
  for (const line of trendlines) {
    if (line.isBroken) continue;
    const lineCurrent = getTrendlinePrice(line, currentIndex);
    const linePrev = getTrendlinePrice(line, prevIndex);
    if (type === "RESISTANCE") {
      if (prev.close <= linePrev && current.close > lineCurrent) {
        line.isBroken = true; line.brokenAt = current.timestamp; line.brokenPrice = current.close;
        return { broken: true, line, breakIndex: currentIndex, breakPrice: current.close };
      }
    } else {
      if (prev.close >= linePrev && current.close < lineCurrent) {
        line.isBroken = true; line.brokenAt = current.timestamp; line.brokenPrice = current.close;
        return { broken: true, line, breakIndex: currentIndex, breakPrice: current.close };
      }
    }
  }
  return { broken: false };
}

// ============================================================
// VOLUME CONFIRMATION
// ============================================================
function isVolumeConfirmed(candles: Candle[], lookback = 10): boolean {
  if (candles.length < lookback + 2) return false;
  const volumes = candles.map(c => c.volume);
  const avgVol = avg(volumes.slice(-lookback - 1, -1));
  const currentVol = volumes[volumes.length - 1];
  return currentVol > avgVol * 1.2;
}

// ============================================================
// EMA BIAS — Instant, no lag, ADX-filtered
// ============================================================
function detectTrend(candles1d: Candle[]): {
  direction: "LONG" | "SHORT" | null;
  strength: number;
  adx: number | null;
  debug: string[];
} {
  const debug: string[] = [];

  if (candles1d.length < 50) {
    debug.push("Insufficient 1D data (< 50 candles)");
    return { direction: null, strength: 0, adx: null, debug };
  }

  const closes = candles1d.map(c => c.close);
  const e8 = ema(closes, 8);
  const e21 = ema(closes, 21);
  const e50 = ema(closes, 50);

  if (!e8.length || !e21.length || !e50.length) {
    debug.push("EMA calculation failed");
    return { direction: null, strength: 0, adx: null, debug };
  }

  const c0 = closes[closes.length - 1];
  const e8_0 = e8[e8.length - 1];
  const e21_0 = e21[e21.length - 1];
  const e50_0 = e50[e50.length - 1];

  let direction: "LONG" | "SHORT" | null = null;
  let strength = 0;

  if (c0 > e21_0 && e21_0 > e50_0) {
    direction = "LONG";
    strength = 80;
    debug.push(`EMA BIAS: LONG (Price ${c0.toFixed(0)} > EMA21 ${e21_0.toFixed(0)} > EMA50 ${e50_0.toFixed(0)})`);
  } else if (c0 < e21_0 && e21_0 < e50_0) {
    direction = "SHORT";
    strength = 80;
    debug.push(`EMA BIAS: SHORT (Price ${c0.toFixed(0)} < EMA21 ${e21_0.toFixed(0)} < EMA50 ${e50_0.toFixed(0)})`);
  } else if (c0 > e21_0) {
    direction = "LONG";
    strength = 50;
    debug.push(`EMA BIAS: LONG (Price ${c0.toFixed(0)} > EMA21 ${e21_0.toFixed(0)}, but EMA21 < EMA50 ${e50_0.toFixed(0)})`);
  } else if (c0 < e21_0) {
    direction = "SHORT";
    strength = 50;
    debug.push(`EMA BIAS: SHORT (Price ${c0.toFixed(0)} < EMA21 ${e21_0.toFixed(0)}, but EMA21 > EMA50 ${e50_0.toFixed(0)})`);
  } else {
    debug.push(`EMA BIAS: NEUTRAL (Price ${c0.toFixed(0)} ≈ EMA21 ${e21_0.toFixed(0)})`);
  }

  const adxVal = adx(candles1d);
  if (adxVal !== null) {
    debug.push(`1D ADX: ${adxVal.toFixed(1)}`);
    if (adxVal < 20) {
      debug.push(`ADX < 20 — NO TRADE ZONE (trend too weak)`);
      direction = null;
      strength = 0;
    } else if (adxVal >= 25) {
      strength = Math.min(100, strength + 10);
      debug.push(`ADX >= 25 — strong trend confirmed`);
    }
  } else {
    debug.push("ADX: N/A");
  }

  return { direction, strength, adx: adxVal, debug };
}

// ============================================================
// 4H ALIGNMENT CHECK
// ============================================================
function check4HAlignment(candles4h: Candle[], biasDirection: "LONG" | "SHORT"): {
  aligned: boolean;
  priceAboveEMA21: boolean;
  ema21Direction: "LONG" | "SHORT" | null;
  debug: string[];
} {
  const debug: string[] = [];
  const closes = candles4h.map(c => c.close);
  const e21 = ema(closes, 21);

  if (!e21.length) {
    debug.push("4H EMA21 unavailable");
    return { aligned: false, priceAboveEMA21: false, ema21Direction: null, debug };
  }

  const c0 = closes[closes.length - 1];
  const e21_0 = e21[e21.length - 1];
  const priceAboveEMA21 = c0 > e21_0;
  const ema21Direction = c0 > e21_0 ? "LONG" : "SHORT";
  const aligned = ema21Direction === biasDirection;

  debug.push(`4H: Price ${c0.toFixed(0)} vs EMA21 ${e21_0.toFixed(0)} → ${ema21Direction} (aligned: ${aligned})`);

  return { aligned, priceAboveEMA21, ema21Direction, debug };
}

// ============================================================
// MAIN SIGNAL GENERATION — Maintains all v37.5 UI exports
// ============================================================
export function generateSignal(
  pair: string,
  candles1h: Candle[],
  candles4h: Candle[],
  candles1d: Candle[],
  candles15m: Candle[],
  activeSignals: Signal[],
  currentPrice?: number
): SignalResult {
  const debug: string[] = [];
  const now = Date.now();

  if (!Array.isArray(activeSignals)) {
    console.warn(`[generateSignal] activeSignals is not an array for ${pair}, defaulting to empty`);
    activeSignals = [];
  }

  const active = activeSignals.find((s: any) => s && s.pair === pair && s.exited === false);
  if (active) {
    debug.push(`Already active: ${active.id}`);
    return { debug };
  }

  if (candles4h.length < 50 || candles1h.length < 30 || candles1d.length < 50) {
    debug.push("Insufficient data");
    return { debug };
  }

  const price = currentPrice ?? candles4h[candles4h.length - 1].close;

  // === STEP 1: 1D BIAS (EMA-based, instant) ===
  const trend = detectTrend(candles1d);
  debug.push(...trend.debug);

  if (!trend.direction) {
    debug.push("No valid 1D bias — waiting for EMA alignment + ADX > 20");
    return { debug };
  }

  const biasDirection = trend.direction;
  const isStrongTrend = trend.adx !== null && trend.adx >= 25 && trend.strength >= 80;

  // === STEP 2: 4H ALIGNMENT ===
  const alignment = check4HAlignment(candles4h, biasDirection);
  debug.push(...alignment.debug);

  if (!alignment.aligned) {
    debug.push(`4H not aligned with 1D bias — waiting for alignment`);
    return { debug };
  }

  // === STEP 3: TRENDLINE BREAK ===
  const pivots4h = findPivots(candles4h, 3, 2);
  let relevantLines: Trendline[] = [];
  let breakType: "RESISTANCE" | "SUPPORT";

  if (biasDirection === "LONG") {
    relevantLines = buildTrendlines(candles4h, pivots4h.highs, "RESISTANCE", 2, 0.3);
    breakType = "RESISTANCE";
    debug.push(`Trendlines: ${relevantLines.length} descending resistance (LONG setup)`);
  } else {
    relevantLines = buildTrendlines(candles4h, pivots4h.lows, "SUPPORT", 2, 0.3);
    breakType = "SUPPORT";
    debug.push(`Trendlines: ${relevantLines.length} ascending support (SHORT setup)`);
  }

  const breakEvent = checkTrendlineBreak(candles4h, relevantLines, breakType);
  const volConfirmed = isVolumeConfirmed(candles4h);
  debug.push(`Volume: ${volConfirmed ? "CONFIRMED (+20%)" : "weak"}`);

  // === STEP 4: ENTRY DECISION ===
  let entryType: "BREAKOUT" | "RETEST" | "EARLY" | null = null;
  let confidence = 50;
  let trendlinePrice = 0;

  if (breakEvent.broken && breakEvent.line) {
    entryType = "BREAKOUT";
    confidence = 80;
    if (volConfirmed) confidence += 5;
    if (isStrongTrend) confidence += 10;
    trendlinePrice = getTrendlinePrice(breakEvent.line, candles4h.length - 1);
    debug.push(`BREAKOUT ${biasDirection}: 4H ${breakEvent.line.type} broken`);
  } else if (alignment.priceAboveEMA21 && biasDirection === "LONG") {
    entryType = "EARLY";
    confidence = 60;
    if (isStrongTrend) confidence += 10;
    trendlinePrice = relevantLines[0] ? getTrendlinePrice(relevantLines[0], candles4h.length - 1) : price * 1.02;
    debug.push(`EARLY ${biasDirection}: Price above EMA21, no trendline break`);
  } else if (!alignment.priceAboveEMA21 && biasDirection === "SHORT") {
    entryType = "EARLY";
    confidence = 60;
    if (isStrongTrend) confidence += 10;
    trendlinePrice = relevantLines[0] ? getTrendlinePrice(relevantLines[0], candles4h.length - 1) : price * 0.98;
    debug.push(`EARLY ${biasDirection}: Price below EMA21, no trendline break`);
  }

  if (!entryType) {
    debug.push("No entry setup — waiting for trendline break or EMA alignment");
    return { debug };
  }

  // === STEP 5: LEVELS (pivots for swing-based TP/SL) ===
  const swingLow = Math.min(...candles4h.slice(-20).map(c => c.low));
  const swingHigh = Math.max(...candles4h.slice(-20).map(c => c.high));
  const atr4h = atr(candles4h, 14);

  let entry = price;
  let stop: number;
  let target: number;
  const atrMultiplier = entryType === "BREAKOUT" ? 1.5 : 2.0;

  if (biasDirection === "LONG") {
    stop = Math.min(swingLow * 0.998, entry - atr4h * atrMultiplier);
    target = entry + atr4h * 4;
    target = Math.min(target, swingHigh * 1.02);
  } else {
    stop = Math.max(swingHigh * 1.002, entry + atr4h * atrMultiplier);
    target = entry - atr4h * 4;
    target = Math.max(target, swingLow * 0.98);
  }

  const risk = Math.abs(entry - stop);
  const reward = Math.abs(target - entry);
  const rr = risk > 0 ? reward / risk : 0;

  if (rr < 1.5) {
    debug.push(`R:R ${rr.toFixed(2)} < 1.5 — skip`);
    return { debug };
  }

  confidence = Math.min(95, Math.round(confidence));

  let positionSizePct = 0.03;
  if (entryType === "BREAKOUT") positionSizePct = 0.05;
  else if (entryType === "RETEST") positionSizePct = 0.06;
  else positionSizePct = 0.03;

  // Build compatible Signal object for UI
  const signal: Signal = {
    id: `${pair}_${now}`,
    pair,
    direction: biasDirection,
    entry: Math.round(entry * 100) / 100,
    stop: Math.round(stop * 100) / 100,
    target: Math.round(target * 100) / 100,
    confidence: Math.round(confidence),
    timestamp: now,
    exited: false,
    entryType,
    trendlinePrice: Math.round(trendlinePrice * 100) / 100,
    volumeConfirmed: volConfirmed,
    type: "ACCUMULATE",
    scale: entryType === "RETEST" ? "ENTRY_1" : entryType === "BREAKOUT" ? "ENTRY_2" : "ENTRY_1",
    entryTier: entryType === "BREAKOUT" ? "CONFIRMED_ENTRY" : "EARLY_ENTRY",
    entryMode: entryType === "EARLY" ? "PULLBACK" : entryType === "RETEST" ? "RETEST" : "BREAKOUT",
    positionSizePct,
    regimeDirection: biasDirection,
    conflictEntry: false,
    entryTimeframe: "4H",
    rr: Math.round(rr * 100) / 100,
    adx: trend.adx !== null ? Math.round(trend.adx * 10) / 10 : undefined,
    rsi: undefined,  // Removed in v38
    stochK: undefined, // Removed in v38
    stochD: undefined, // Removed in v38
    version: CURRENT_SIGNAL_VERSION,
    tradeState: {
      phase: "ENTRY",
      phaseEnteredAt: now,
      highestPrice: entry,
      lowestPrice: entry,
      entryPrice: entry,
      lockedStop: null,
      profitLockLevel: 0,
      currentR: 0,
      entryTimestamp: now,
      lastDecisionTimestamp: now,
    },
  };

  debug.push(`SIGNAL: ${entryType} ${biasDirection} ${pair} @ ${entry.toFixed(2)}, SL ${stop.toFixed(2)}, TP ${target.toFixed(2)}, RR ${rr.toFixed(2)}, Conf ${confidence}%, Size ${(positionSizePct*100).toFixed(0)}%, ADX ${trend.adx?.toFixed(1) || "N/A"}${volConfirmed ? ", VOL+" : ""}`);

  return { signal, debug };
}

// ============================================================
// EXIT LOGIC — Price-first, EMA-based, no indicator lag
// ============================================================
export function shouldHold(
  signal: Signal,
  candles4h: Candle[],
  candles1d: Candle[],
  candles1h: Candle[],
  currentPrice: number
): HoldResult {
  const now = Date.now();

  // Build/update tradeState for UI compatibility
  const ts = signal.tradeState || {
    phase: "TREND",
    phaseEnteredAt: signal.timestamp,
    highestPrice: signal.entry,
    lowestPrice: signal.entry,
    entryPrice: signal.entry,
    lockedStop: null,
    profitLockLevel: 0,
    currentR: 0,
    entryTimestamp: signal.timestamp,
    lastDecisionTimestamp: signal.timestamp,
  };

  const newHighest = Math.max(ts.highestPrice, currentPrice);
  const newLowest = Math.min(ts.lowestPrice, currentPrice);
  const currentR = signal.direction === "LONG"
    ? (currentPrice - signal.entry) / (signal.entry - signal.stop)
    : (signal.entry - currentPrice) / (signal.stop - signal.entry);

  const updatedState: TradeState = {
    ...ts,
    highestPrice: newHighest,
    lowestPrice: newLowest,
    currentR,
    lastDecisionTimestamp: now,
  };

  // 1. HARD STOPS
  if (signal.direction === "LONG" && currentPrice <= signal.stop) {
    return { shouldHold: false, reason: "stop_loss", updatedTradeState: { ...updatedState, phase: "EXIT" } };
  }
  if (signal.direction === "SHORT" && currentPrice >= signal.stop) {
    return { shouldHold: false, reason: "stop_loss", updatedTradeState: { ...updatedState, phase: "EXIT" } };
  }

  // 2. TARGET HIT
  if (signal.direction === "LONG" && currentPrice >= signal.target) {
    return { shouldHold: false, reason: "target_hit", updatedTradeState: { ...updatedState, phase: "EXIT" } };
  }
  if (signal.direction === "SHORT" && currentPrice <= signal.target) {
    return { shouldHold: false, reason: "target_hit", updatedTradeState: { ...updatedState, phase: "EXIT" } };
  }

  // 3. EMA REGIME FLIP — instant, no pivot lag
  if (candles1d && candles1d.length >= 50) {
    const trend = detectTrend(candles1d);
    if (trend.direction && trend.direction !== signal.direction) {
      const hoursInTrade = (now - signal.timestamp) / (60 * 60 * 1000);
      if (hoursInTrade > 2) {
        return { shouldHold: false, reason: "1d_regime_flip", updatedTradeState: { ...updatedState, phase: "EXIT" } };
      }
    }
  }

  // 4. 4H EMA21 STRUCTURE FAILURE
  if (candles4h && candles4h.length >= 50) {
    const closes = candles4h.map(c => c.close);
    const e21 = ema(closes, 21);
    if (e21.length > 0) {
      const ema21Price = e21[e21.length - 1];
      const candlesAgainst = candles4h.slice(-4).filter(c => {
        if (signal.direction === "LONG") return c.close < ema21Price;
        return c.close > ema21Price;
      }).length;

      if (candlesAgainst >= 2) {
        return { shouldHold: false, reason: "4h_structure_failure", updatedTradeState: { ...updatedState, phase: "EXIT" } };
      }
    }
  }

  // 5. EMERGENCY PRICE EXIT
  const emergencyThreshold = signal.entry * 0.02;
  const candlesAgainstEmergency = candles4h.slice(-4).filter(c => {
    if (signal.direction === "SHORT") return c.close > signal.entry + emergencyThreshold;
    return c.close < signal.entry - emergencyThreshold;
  }).length;

  if (candlesAgainstEmergency >= 2 && currentR < 0) {
    return { shouldHold: false, reason: "emergency_price_exit", updatedTradeState: { ...updatedState, phase: "EXIT" } };
  }

  // 6. PROFIT PROTECTION
  let newPhase: TradeLifecyclePhase = ts.phase;
  if (currentR >= 3) {
    return { shouldHold: false, reason: "profit_protection_3R", updatedTradeState: { ...updatedState, phase: "EXIT", profitLockLevel: 3 } };
  }
  if (currentR >= 2) {
    const gain = Math.abs(currentPrice - signal.entry);
    const lockPrice = signal.direction === "LONG" ? signal.entry + gain * 0.5 : signal.entry - gain * 0.5;
    if ((signal.direction === "LONG" && currentPrice <= lockPrice) ||
        (signal.direction === "SHORT" && currentPrice >= lockPrice)) {
      return { shouldHold: false, reason: "profit_protection_2R", updatedTradeState: { ...updatedState, phase: "EXIT", profitLockLevel: 2, lockedStop: lockPrice } };
    }
    newPhase = "PROFIT_PROTECTION";
  } else if (currentR >= 1) {
    newPhase = "BUILDING";
  } else {
    newPhase = "ENTRY";
  }

  return { shouldHold: true, reason: `holding_${newPhase.toLowerCase()}_R${currentR.toFixed(1)}`, updatedTradeState: { ...updatedState, phase: newPhase } };
}

// ============================================================
// VALIDITY CHECKS — Maintained for UI compatibility
// ============================================================
export function isSignalStillValid(signal: Signal, currentPrice: number): { valid: boolean; reason: string; exited: boolean } {
  if (signal.direction === "LONG" && currentPrice <= signal.stop) return { valid: false, reason: "sl_hit", exited: true };
  if (signal.direction === "SHORT" && currentPrice >= signal.stop) return { valid: false, reason: "sl_hit", exited: true };
  if (signal.direction === "LONG" && currentPrice >= signal.target) return { valid: false, reason: "tp_hit", exited: true };
  if (signal.direction === "SHORT" && currentPrice <= signal.target) return { valid: false, reason: "tp_hit", exited: true };
  return { valid: true, reason: "active", exited: false };
}

export function filterExpiredSignals(signals: Signal[], currentPrices?: Record<string, number>) {
  const active: Signal[] = [];
  const exited: { signal: Signal; reason: string }[] = [];
  const now = Date.now();
  const EXITED_TTL_MS = 7 * 24 * 60 * 60 * 1000;
  for (const signal of signals) {
    if (!signal.exited) {
      const price = currentPrices?.[signal.pair];
      if (price !== undefined) {
        const check = isSignalStillValid(signal, price);
        if (!check.valid) { exited.push({ signal, reason: check.reason }); continue; }
      }
      active.push(signal); continue;
    }
    if (now - signal.timestamp < EXITED_TTL_MS) active.push(signal);
  }
  return { active, exited };
}

// ============================================================
// MARKET SNAPSHOT — Full UI compatibility
// ============================================================
export function getMarketSnapshot(
  pair: string,
  candles1h: Candle[],
  candles4h: Candle[],
  candles15m: Candle[],
  candles1d: Candle[],
  currentPrice?: number,
  signalResult?: SignalResult
) {
  const price = currentPrice ?? candles4h[candles4h.length - 1]?.close ?? 0;
  const trend = detectTrend(candles1d);
  const alignment = trend.direction ? check4HAlignment(candles4h, trend.direction) : { aligned: false, priceAboveEMA21: false, ema21Direction: null, debug: [] };
  const volConfirmed = isVolumeConfirmed(candles4h);
  const pivots4h = findPivots(candles4h, 3, 2);
  const resistanceLines = buildTrendlines(candles4h, pivots4h.highs, "RESISTANCE", 2, 0.3);
  const supportLines = buildTrendlines(candles4h, pivots4h.lows, "SUPPORT", 2, 0.3);
  const activeTrendlines = [...resistanceLines, ...supportLines]
    .filter(l => l.isValid && !l.isBroken)
    .map(l => ({ type: l.type, startPrice: l.startPrice, endPrice: l.endPrice, touches: l.touches, currentPrice: getTrendlinePrice(l, candles4h.length - 1) }));

  const closes4h = candles4h.map(c => c.close);
  const e21_4h = ema(closes4h, 21);
  const ema21Price = e21_4h.length > 0 ? e21_4h[e21_4h.length - 1] : 0;
  const distToEMA21 = ema21Price > 0 ? (price - ema21Price) / ema21Price : 0;

  const closes1d = candles1d.map(c => c.close);
  const e8_1d = ema(closes1d, 8);
  const e21_1d = ema(closes1d, 21);
  const e50_1d = ema(closes1d, 50);

  const adxVal = trend.adx ?? 0;
  let trendStrengthLabel = "WEAK";
  if (adxVal >= 30) trendStrengthLabel = "STRONG";
  else if (adxVal >= 20) trendStrengthLabel = "MEDIUM";

  let phase4h: "EXPANSION" | "PULLBACK" | "BUILDING" | "NEUTRAL" = "NEUTRAL";
  if (trend.direction === "LONG") {
    if (price > ema21Price * 1.02) phase4h = "EXPANSION";
    else if (price < ema21Price * 0.98) phase4h = "PULLBACK";
    else phase4h = "BUILDING";
  } else if (trend.direction === "SHORT") {
    if (price < ema21Price * 0.98) phase4h = "EXPANSION";
    else if (price > ema21Price * 1.02) phase4h = "PULLBACK";
    else phase4h = "BUILDING";
  }

  let readiness = 0;
  if (trend.direction) readiness += 30;
  if (trend.strength >= 50) readiness += 20;
  if (alignment.aligned) readiness += 20;
  if (adxVal >= 25) readiness += 15;
  if (volConfirmed) readiness += 5;
  if (signalResult?.signal) readiness += 10;
  readiness = Math.min(100, readiness);

  let readinessLabel = "NO_TRADE";
  let readinessColor = "text-gray-400";
  if (readiness >= 80) { readinessLabel = "READY"; readinessColor = "text-green-400"; }
  else if (readiness >= 60) { readinessLabel = "WARM"; readinessColor = "text-amber-400"; }
  else if (readiness >= 40) { readinessLabel = "WATCH"; readinessColor = "text-blue-400"; }

  return {
    pair,
    price: Math.round(price * 100) / 100,
    timestamp: Date.now(),
    bias: trend.direction ? { direction: trend.direction, strength: trend.strength } : null,
    volumeConfirmed: volConfirmed,
    trendlines: activeTrendlines,
    trendDirection: trend.direction,
    trendStrength: trend.strength,
    readiness,
    readinessLabel,
    readinessColor,
    adx: Math.round(adxVal * 10) / 10,
    trendStrengthLabel,
    trend: trend.direction ? `${trend.direction} ${trend.strength > 50 ? "STRONG" : "MEDIUM"}` : "NONE",
    regime: { direction: trend.direction, strength: trend.strength > 50 ? "STRONG" : "MEDIUM", confidence: trend.direction ? (trend.strength > 50 ? 75 : 50) : 0 },
    stochK: undefined, // Removed in v38
    stochD: undefined, // Removed in v38
    stoch1hK: undefined, // Removed in v38
    stoch1hD: undefined, // Removed in v38
    ema21: Math.round(ema21Price * 100) / 100,
    distToEMA21: Math.round(distToEMA21 * 10000) / 100,
    ema8_1d: e8_1d.length > 0 ? Math.round(e8_1d[e8_1d.length - 1] * 100) / 100 : 0,
    ema21_1d: e21_1d.length > 0 ? Math.round(e21_1d[e21_1d.length - 1] * 100) / 100 : 0,
    ema50_1d: e50_1d.length > 0 ? Math.round(e50_1d[e50_1d.length - 1] * 100) / 100 : 0,
    trendStrengthCompat: { adx: adxVal, isStrong: adxVal >= 25 },
    phase4h,
    phase1h: phase4h,
    structure15m: "Neutral", // Simplified in v38
    recommendedAction: signalResult?.signal ? `${signalResult.signal.direction} ${signalResult.signal.entryType}` : null,
    entryTier: signalResult?.signal ? (signalResult.signal.entryType === "BREAKOUT" ? "CONFIRMED_ENTRY" : "EARLY_ENTRY") : null,
    entryMode: signalResult?.signal ? (signalResult.signal.entryType === "EARLY" ? "PULLBACK" : "BREAKOUT") : null,
    positionSize: signalResult?.signal ? (signalResult.signal.positionSizePct ? (signalResult.signal.positionSizePct * 100).toFixed(0) + "%" : null) : null,
    signal: signalResult?.signal || null,
    summary: { status: signalResult?.signal ? "READY" : "WATCH", debug: signalResult?.debug || trend.debug || [] },
    activeTrade: null,
    debug: signalResult?.debug || trend.debug || [],
  };
}

// ============================================================
// COMPATIBILITY LAYER — All v37.5 exports maintained
// ============================================================
export function shouldHoldCompat(
  signal: Signal,
  candles4h: Candle[],
  candles1h: Candle[],
  currentPrice: number
): HoldResult {
  return shouldHold(signal, candles4h, aggregateTo1D(candles4h), candles1h, currentPrice);
}

export async function generateSignalAsync(
  pair: string,
  candles1h: Candle[],
  candles4h: Candle[],
  candles15m: Candle[],
  activeSignals?: Signal[],
  currentPrice?: number
): Promise<SignalResult> {
  return generateSignal(pair, candles1h, candles4h, aggregateTo1D(candles4h), candles15m, activeSignals || [], currentPrice);
}

export function migrateV36ToV37(signal: Signal): TradeState {
  return {
    phase: "ENTRY",
    phaseEnteredAt: signal.timestamp,
    highestPrice: signal.entry,
    lowestPrice: signal.entry,
    entryPrice: signal.entry,
    lockedStop: null,
    profitLockLevel: 0,
    currentR: 0,
    entryTimestamp: signal.timestamp,
    lastDecisionTimestamp: Date.now(),
  };
}

export function updateTradeManagerCompat(signal: Signal, currentPrice: number): TradeState {
  const currentR = signal.direction === "LONG"
    ? (currentPrice - signal.entry) / (signal.entry - signal.stop)
    : (signal.entry - currentPrice) / (signal.stop - signal.entry);
  return {
    phase: currentR >= 2 ? "TREND" : currentR >= 1 ? "BUILDING" : "ENTRY",
    phaseEnteredAt: signal.timestamp,
    highestPrice: Math.max(signal.entry, currentPrice),
    lowestPrice: Math.min(signal.entry, currentPrice),
    entryPrice: signal.entry,
    lockedStop: null,
    profitLockLevel: 0,
    currentR,
    entryTimestamp: signal.timestamp,
    lastDecisionTimestamp: Date.now(),
  };
}

export function calculateTradeState(signal: Signal, currentPrice: number): TradeState {
  return updateTradeManagerCompat(signal, currentPrice);
}

export async function loadExits(): Promise<any[]> { return []; }
export function setRegimePersistence(): void {}
export function setExitPersistence(): void {}
export function setTelemetryPersistence(): void {}
export async function persistTelemetry(): Promise<void> {}

// ============================================================
// Redis-backed lastExit functions (placeholder for injection)
// ============================================================
let _loadLastExit: ((pair: string) => Promise<{ direction: "LONG" | "SHORT"; reason: string; timestamp: number } | null>) | null = null;
let _persistLastExit: ((pair: string, record: { direction: "LONG" | "SHORT"; reason: string; timestamp: number }) => Promise<void>) | null = null;

export function setLastExitFunctions(
  loadFn: (pair: string) => Promise<{ direction: "LONG" | "SHORT"; reason: string; timestamp: number } | null>,
  persistFn: (pair: string, record: { direction: "LONG" | "SHORT"; reason: string; timestamp: number }) => Promise<void>
): void {
  _loadLastExit = loadFn;
  _persistLastExit = persistFn;
}
