// ============================================================
// CXSwitch v36.3 — Trendline Break + Counter-Trend Exhaustion Filter
// 
// Core: Trendline breaks on 4H (resistance/support)
// Filter: Only take breaks when market is at Stoch extremes
//   - LONG trend + overbought → look for SHORT on resistance break
//   - SHORT trend + oversold → look for LONG on support break
//   - 15M entry timing
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
  entry: number;
  stop: number;
  target: number;
  confidence: number;
  timestamp: number;
  exited: boolean;
  exitReason?: string;
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
  tradeState?: any;
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
}

export interface SignalResult {
  signal?: Signal;
  market?: any;
  debug: string[];
}

export interface HoldResult {
  shouldHold: boolean;
  reason: string;
  updatedTradeState?: any;
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

export type EntryTier = "NO_TRADE" | "WATCH" | "EARLY_ENTRY" | "CONFIRMED_ENTRY";
export type TradeLifecyclePhase = "WATCH" | "ENTRY" | "BUILDING" | "TREND" | "PROFIT_PROTECTION" | "EXIT" | "COOLDOWN";

export const CURRENT_SIGNAL_VERSION = 36;

// ============================================================
// UTILITIES
// ============================================================

function avg(arr: number[]): number {
  return arr.length ? arr.reduce((a, b) => a + b, 0) / arr.length : 0;
}

function isValid(v: any): boolean {
  return typeof v === "number" && Number.isFinite(v);
}

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

export function wilderRsi(values: number[], period = 14): number | null {
  if (values.length < period + 1 || !values.every(isValid)) return null;
  const diffs: number[] = [];
  for (let i = 1; i < values.length; i++) diffs.push(values[i] - values[i - 1]);
  let avgGain = 0, avgLoss = 0;
  for (let i = 0; i < period; i++) {
    avgGain += Math.max(0, diffs[i]);
    avgLoss += Math.max(0, -diffs[i]);
  }
  avgGain /= period;
  avgLoss /= period;
  for (let i = period; i < diffs.length; i++) {
    avgGain = (avgGain * (period - 1) + Math.max(0, diffs[i])) / period;
    avgLoss = (avgLoss * (period - 1) + Math.max(0, -diffs[i])) / period;
  }
  if (avgLoss === 0) return avgGain > 0 ? 100 : 50;
  return 100 - 100 / (1 + avgGain / avgLoss);
}

export function stochRsi(
  values: number[],
  rsiPeriod = 14,
  stochPeriod = 14,
  kSmooth = 3,
  dSmooth = 3
): { k: number; d: number } {
  if (!values.every(isValid)) return { k: 50, d: 50 };
  const rsiValues: number[] = [];
  for (let i = rsiPeriod; i < values.length; i++) {
    const r = wilderRsi(values.slice(0, i + 1), rsiPeriod);
    if (r !== null) rsiValues.push(r);
  }
  if (rsiValues.length < stochPeriod + kSmooth - 1) {
    return { k: rsiValues[rsiValues.length - 1] || 50, d: 50 };
  }
  const rawK: number[] = [];
  for (let i = stochPeriod - 1; i < rsiValues.length; i++) {
    const w = rsiValues.slice(i - stochPeriod + 1, i + 1);
    const lo = Math.min(...w), hi = Math.max(...w);
    rawK.push(hi === lo ? 50 : ((rsiValues[i] - lo) / (hi - lo)) * 100);
  }
  const kValues: number[] = [];
  for (let i = kSmooth - 1; i < rawK.length; i++) {
    kValues.push(avg(rawK.slice(i - kSmooth + 1, i + 1)));
  }
  if (kValues.length < dSmooth) return { k: kValues[kValues.length - 1] || 50, d: 50 };
  return {
    k: Math.round(kValues[kValues.length - 1] * 10) / 10,
    d: Math.round(avg(kValues.slice(-dSmooth)) * 10) / 10,
  };
}

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

function atr(candles: Candle[], period = 14): number {
  const trs: number[] = [];
  for (let i = Math.max(1, candles.length - period); i < candles.length; i++) {
    trs.push(Math.max(candles[i].high - candles[i].low, Math.abs(candles[i].high - candles[i - 1].close), Math.abs(candles[i].low - candles[i - 1].close)));
  }
  return avg(trs);
}

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
// PIVOT DETECTION
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

// ============================================================
// TRENDLINE CONSTRUCTION
// ============================================================

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
          startIndex: p1.index,
          endIndex: p2.index,
          startPrice: p1.price,
          endPrice: p2.price,
          slope,
          type,
          touches,
          isValid: true,
          isBroken: false,
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
        line.isBroken = true;
        line.brokenAt = current.timestamp;
        line.brokenPrice = current.close;
        return { broken: true, line, breakIndex: currentIndex, breakPrice: current.close };
      }
    } else {
      if (prev.close >= linePrev && current.close < lineCurrent) {
        line.isBroken = true;
        line.brokenAt = current.timestamp;
        line.brokenPrice = current.close;
        return { broken: true, line, breakIndex: currentIndex, breakPrice: current.close };
      }
    }
  }

  return { broken: false };
}

// ============================================================
// MARKET STRUCTURE
// ============================================================

function analyzeStructure(candles: Candle[]): {
  direction: "LONG" | "SHORT" | null;
  strength: number;
} {
  if (candles.length < 20) return { direction: null, strength: 0 };

  const { highs, lows } = findPivots(candles, 3, 2);
  if (highs.length < 3 || lows.length < 3) {
    return { direction: null, strength: 0 };
  }

  let hhCount = 0, hlCount = 0, llCount = 0, lhCount = 0;

  for (let i = 1; i < Math.min(highs.length, 5); i++) {
    if (highs[i].price > highs[i-1].price) hhCount++;
    else lhCount++;
  }

  for (let i = 1; i < Math.min(lows.length, 5); i++) {
    if (lows[i].price > lows[i-1].price) hlCount++;
    else llCount++;
  }

  const bullishScore = hhCount + hlCount;
  const bearishScore = llCount + lhCount;

  if (bullishScore > bearishScore + 1) {
    return { direction: "LONG", strength: Math.min(100, bullishScore * 20) };
  }
  if (bearishScore > bullishScore + 1) {
    return { direction: "SHORT", strength: Math.min(100, bearishScore * 20) };
  }

  return { direction: null, strength: 0 };
}

// ============================================================
// COUNTER-TREND BIAS DETECTION
// ============================================================
// Detects the TREND, returns the OPPOSITE direction
// We want to fade the trend at extremes
// ============================================================

function detectBias(
  candles1d: Candle[],
  candles4h: Candle[]
): { direction: "LONG" | "SHORT" | null; strength: number; adx: number | null; debug: string[] } {
  const debug: string[] = [];

  const structure1d = analyzeStructure(candles1d);
  debug.push(`1D Structure: ${structure1d.direction || "NONE"} (strength: ${structure1d.strength})`);

  const structure4h = analyzeStructure(candles4h);
  debug.push(`4H Structure: ${structure4h.direction || "NONE"} (strength: ${structure4h.strength})`);

  const closes4h = candles4h.map(c => c.close);
  const e8 = ema(closes4h, 8);
  const e21 = ema(closes4h, 21);
  const e50 = ema(closes4h, 50);

  let emaTrend: "LONG" | "SHORT" | null = null;
  if (e8.length && e21.length && e50.length) {
    const c0 = closes4h[closes4h.length - 1];
    const e8_0 = e8[e8.length - 1];
    const e21_0 = e21[e21.length - 1];
    const e50_0 = e50[e50.length - 1];

    if (c0 > e8_0 && e8_0 > e21_0 && e21_0 > e50_0) emaTrend = "LONG";
    else if (c0 < e8_0 && e8_0 < e21_0 && e21_0 < e50_0) emaTrend = "SHORT";
    else if (e8_0 > e21_0) emaTrend = "LONG";
    else if (e8_0 < e21_0) emaTrend = "SHORT";
  }
  debug.push(`4H EMA Trend: ${emaTrend || "NONE"}`);

  const adxVal = adx(candles4h);
  debug.push(`4H ADX: ${adxVal !== null ? adxVal.toFixed(1) : "N/A"}`);

  const votes = [structure1d.direction, structure4h.direction, emaTrend].filter(Boolean);
  const longVotes = votes.filter(v => v === "LONG").length;
  const shortVotes = votes.filter(v => v === "SHORT").length;

  // Determine trend direction
  let trendDirection: "LONG" | "SHORT" | null = null;
  let trendStrength = 0;

  if (longVotes >= 2) {
    trendDirection = "LONG";
    trendStrength = Math.round((structure1d.strength + structure4h.strength) / 2);
    debug.push(`TREND: LONG (${longVotes}/3 votes) | ADX: ${adxVal?.toFixed(1) || "N/A"}`);
  } else if (shortVotes >= 2) {
    trendDirection = "SHORT";
    trendStrength = Math.round((structure1d.strength + structure4h.strength) / 2);
    debug.push(`TREND: SHORT (${shortVotes}/3 votes) | ADX: ${adxVal?.toFixed(1) || "N/A"}`);
  } else {
    debug.push(`TREND: UNCLEAR (L:${longVotes}, S:${shortVotes}) | ADX: ${adxVal?.toFixed(1) || "N/A"}`);
    return { direction: null, strength: 0, adx: adxVal, debug };
  }

  // COUNTER-TREND: return OPPOSITE direction
  const counterDirection = trendDirection === "LONG" ? "SHORT" : "LONG";
  debug.push(`COUNTER BIAS: ${counterDirection} (fading ${trendDirection} trend)`);

  return { direction: counterDirection, strength: trendStrength, adx: adxVal, debug };
}

// ============================================================
// EXHAUSTION FILTER
// ============================================================
// Only allow entries when Stoch is at extremes
// LONG entry allowed when: 4H Stoch < 35 (oversold after SHORT trend)
// SHORT entry allowed when: 4H Stoch > 65 (overbought after LONG trend)
// ============================================================

function checkExhaustion(
  biasDirection: "LONG" | "SHORT" | null,
  stoch4h: { k: number; d: number }
): { allowed: boolean; reason: string } {
  if (!biasDirection) {
    return { allowed: false, reason: "No bias — no exhaustion check" };
  }

  if (biasDirection === "LONG") {
    // We want LONG entry — need oversold (market dumped)
    if (stoch4h.k < 35) {
      return { allowed: true, reason: `LONG exhaustion confirmed (4H Stoch ${stoch4h.k})` };
    }
    return { allowed: false, reason: `LONG blocked — not oversold (4H Stoch ${stoch4h.k})` };
  }

  if (biasDirection === "SHORT") {
    // We want SHORT entry — need overbought (market pumped)
    if (stoch4h.k > 65) {
      return { allowed: true, reason: `SHORT exhaustion confirmed (4H Stoch ${stoch4h.k})` };
    }
    return { allowed: false, reason: `SHORT blocked — not overbought (4H Stoch ${stoch4h.k})` };
  }

  return { allowed: false, reason: "Unknown bias" };
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
// HYSTERESIS
// ============================================================

const hysteresisStore = new Map<string, { lastEntryPrice: number; lockUntil: number }>();
const POST_EXIT_COOLDOWN_MS = 30 * 60 * 1000;

function getHysteresis(pair: string, now: number) {
  const s = hysteresisStore.get(pair);
  if (!s || now > s.lockUntil) return null;
  return s;
}

function setHysteresis(pair: string, price: number, now: number) {
  hysteresisStore.set(pair, { lastEntryPrice: price, lockUntil: now + POST_EXIT_COOLDOWN_MS });
}

function isInExhaustionZone(
  pair: string,
  price: number,
  candles4h: Candle[],
  direction: "LONG" | "SHORT"
): boolean {
  const stoch4h = stochRsi(candles4h.map(c => c.close));

  if (direction === "LONG" && stoch4h.k > 75) return true;
  if (direction === "SHORT" && stoch4h.k < 25) return true;

  const hyst = getHysteresis(pair, Date.now());
  if (hyst) {
    const dist = Math.abs(price - hyst.lastEntryPrice) / hyst.lastEntryPrice;
    if (dist < 0.01) return true;
  }

  return false;
}

// ============================================================
// ENTRY LOGIC — Trendline Break + Exhaustion Filter
// ============================================================

export function generateSignal(
  pair: string,
  candles1h: Candle[],
  candles4h: Candle[],
  candles1d: Candle[],
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

  if (candles4h.length < 50 || candles1h.length < 30 || candles1d.length < 25) {
    debug.push("Insufficient data");
    return { debug };
  }

  const price = currentPrice ?? candles4h[candles4h.length - 1].close;

  // 1. BIAS (counter-trend)
  const bias = detectBias(candles1d, candles4h);
  debug.push(...bias.debug);

  if (!bias.direction) {
    debug.push("No clear trend to fade — waiting");
    return { debug };
  }

  // 2. STOCH READINGS
  const closes1h = candles1h.map(c => c.close);
  const stoch1h = stochRsi(closes1h);
  debug.push(`1H Stoch: ${stoch1h.k}/${stoch1h.d}`);

  const closes4h = candles4h.map(c => c.close);
  const stoch4h = stochRsi(closes4h);
  debug.push(`4H Stoch: ${stoch4h.k}/${stoch4h.d}`);

  // 3. EXHAUSTION FILTER
  const exhaustion = checkExhaustion(bias.direction, stoch4h);
  debug.push(exhaustion.reason);

  if (!exhaustion.allowed) {
    debug.push("Exhaustion filter blocked — waiting for Stoch extreme");
    return { debug };
  }

  // 4. Check exhaustion zone (hysteresis)
  if (isInExhaustionZone(pair, price, candles4h, bias.direction)) {
    debug.push("In exhaustion zone — hysteresis lock active");
    return { debug };
  }

  // 5. Build trendlines
  const pivots4h = findPivots(candles4h, 3, 2);
  const resistanceLines = buildTrendlines(candles4h, pivots4h.highs, "RESISTANCE", 2, 0.3);
  const supportLines = buildTrendlines(candles4h, pivots4h.lows, "SUPPORT", 2, 0.3);

  debug.push(`Trendlines: ${resistanceLines.length} resistance, ${supportLines.length} support`);

  // 6. Check for trendline breaks
  const longBreak = bias.direction === "LONG" 
    ? checkTrendlineBreak(candles4h, resistanceLines, "RESISTANCE")
    : { broken: false };
  const shortBreak = bias.direction === "SHORT"
    ? checkTrendlineBreak(candles4h, supportLines, "SUPPORT")
    : { broken: false };

  const breakEvent = bias.direction === "LONG" ? longBreak : shortBreak;

  // 7. Volume check
  const volConfirmed = isVolumeConfirmed(candles4h);
  debug.push(`Volume: ${volConfirmed ? "CONFIRMED (+20%)" : "weak"}`);

  let entryType: "EARLY" | "BREAKOUT" | "RETEST" | null = null;
  let confidence = 50;
  let trendlinePrice = 0;

  // EARLY ENTRY (deep Stoch extreme without break yet)
  if (bias.direction === "LONG") {
    const is4hOversold = stoch4h.k < 25 && stoch4h.d < 30;
    const is1hTurning = stoch1h.k > stoch1h.d || stoch1h.k < 20;

    if (is4hOversold && is1hTurning) {
      entryType = "EARLY";
      confidence = 70;
      if (volConfirmed) confidence += 10;
      trendlinePrice = resistanceLines[0] ? getTrendlinePrice(resistanceLines[0], candles4h.length - 1) : price * 1.02;
      debug.push(`EARLY LONG: 4H oversold(${stoch4h.k}), 1H turning${volConfirmed ? ", volume confirmed" : ""}`);
    }
  } else {
    const is4hOverbought = stoch4h.k > 75 && stoch4h.d > 70;
    const is1hTurning = stoch1h.k < stoch1h.d || stoch1h.k > 80;

    if (is4hOverbought && is1hTurning) {
      entryType = "EARLY";
      confidence = 70;
      if (volConfirmed) confidence += 10;
      trendlinePrice = supportLines[0] ? getTrendlinePrice(supportLines[0], candles4h.length - 1) : price * 0.98;
      debug.push(`EARLY SHORT: 4H overbought(${stoch4h.k}), 1H turning${volConfirmed ? ", volume confirmed" : ""}`);
    }
  }

  // BREAKOUT ENTRY (trendline break + exhaustion confirmed)
  if (!entryType && breakEvent.broken && breakEvent.line) {
    entryType = "BREAKOUT";
    confidence = 80;
    if (volConfirmed) confidence += 5;
    trendlinePrice = getTrendlinePrice(breakEvent.line, candles4h.length - 1);
    debug.push(`BREAKOUT ${bias.direction}: Trendline ${breakEvent.line.type} broken${volConfirmed ? ", volume confirmed" : ""}`);
  }

  // RETEST ENTRY
  if (!entryType && breakEvent.broken && breakEvent.line) {
    const linePrice = getTrendlinePrice(breakEvent.line, candles4h.length - 1);
    const distToLine = Math.abs(price - linePrice) / linePrice;

    if (distToLine < 0.005) {
      entryType = "RETEST";
      confidence = 75;
      if (volConfirmed) confidence += 5;
      trendlinePrice = linePrice;
      debug.push(`RETEST ${bias.direction}: Price at broken trendline${volConfirmed ? ", volume confirmed" : ""}`);
    }
  }

  if (!entryType) {
    debug.push("No entry setup — waiting for trendline break or early signal");
    return { debug };
  }

  // Calculate stop and target
  const swingLow = Math.min(...candles4h.slice(-20).map(c => c.low));
  const swingHigh = Math.max(...candles4h.slice(-20).map(c => c.high));
  const atr4h = atr(candles4h, 14);

  let entry = price;
  let stop: number;
  let target: number;

  if (bias.direction === "LONG") {
    stop = Math.min(swingLow, entry - atr4h * 1.5, trendlinePrice * 0.99);
    target = Math.max(swingHigh, entry + atr4h * 4, trendlinePrice * 1.03);
  } else {
    stop = Math.max(swingHigh, entry + atr4h * 1.5, trendlinePrice * 1.01);
    target = Math.min(swingLow, entry - atr4h * 4, trendlinePrice * 0.97);
  }

  const risk = Math.abs(entry - stop);
  const reward = Math.abs(target - entry);
  const rr = risk > 0 ? reward / risk : 0;

  if (rr < 1.0) {
    debug.push(`R:R ${rr.toFixed(2)} < 1.0 — skip`);
    return { debug };
  }

  confidence += Math.min(15, bias.strength / 7);
  if (breakEvent.broken) confidence += 10;
  if (bias.adx !== null && bias.adx >= 25) confidence += 5;
  confidence = Math.min(95, Math.round(confidence));

  const signal: Signal = {
    id: `${pair}_${now}`,
    pair,
    direction: bias.direction,
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
    scale: entryType === "RETEST" ? "ADD" : "ENTRY_1",
    entryTier: entryType === "EARLY" ? "EARLY_ENTRY" : "CONFIRMED_ENTRY",
    entryMode: entryType === "EARLY" ? "PULLBACK" : "BREAKOUT",
    positionSizePct: entryType === "RETEST" ? 0.05 : 0.04,
    regimeDirection: bias.direction,
    conflictEntry: false,
    entryTimeframe: "4H",
    rr: Math.round(rr * 100) / 100,
    adx: bias.adx !== null ? Math.round(bias.adx * 10) / 10 : undefined,
    version: CURRENT_SIGNAL_VERSION,
  };

  setHysteresis(pair, entry, now);

  debug.push(`SIGNAL: ${entryType} ${bias.direction} ${pair} @ ${entry.toFixed(2)}, SL ${stop.toFixed(2)}, TP ${target.toFixed(2)}, RR ${rr.toFixed(2)}, Conf ${confidence}%, ADX ${bias.adx?.toFixed(1) || "N/A"}${volConfirmed ? ", VOL+" : ""}`);

  return { signal, debug };
}

// ============================================================
// EXIT LOGIC — Stoch-Driven
// ============================================================

export function shouldHold(
  signal: Signal,
  candles4h: Candle[],
  candles1d: Candle[],
  candles1h: Candle[],
  currentPrice: number
): HoldResult {
  const now = Date.now();

  // 1. Hard stop
  if (signal.direction === "LONG" && currentPrice <= signal.stop) {
    return { shouldHold: false, reason: "stop_loss", updatedTradeState: { phase: "EXIT" } };
  }
  if (signal.direction === "SHORT" && currentPrice >= signal.stop) {
    return { shouldHold: false, reason: "stop_loss", updatedTradeState: { phase: "EXIT" } };
  }

  // 2. Hard target
  if (signal.direction === "LONG" && currentPrice >= signal.target) {
    return { shouldHold: false, reason: "target_hit", updatedTradeState: { phase: "EXIT" } };
  }
  if (signal.direction === "SHORT" && currentPrice <= signal.target) {
    return { shouldHold: false, reason: "target_hit", updatedTradeState: { phase: "EXIT" } };
  }

  // 3. 1H Stoch exit — PRIMARY
  if (candles1h && candles1h.length >= 30) {
    const closes1h = candles1h.map(c => c.close);
    const stoch1h = stochRsi(closes1h);

    if (signal.direction === "LONG") {
      if (stoch1h.k < stoch1h.d && stoch1h.d > 65) {
        return { shouldHold: false, reason: "1h_stoch_cross_overbought", updatedTradeState: { phase: "EXIT" } };
      }
      if (stoch1h.k < 70 && stoch1h.k < stoch1h.d) {
        return { shouldHold: false, reason: "1h_stoch_top", updatedTradeState: { phase: "EXIT" } };
      }
    } else {
      if (stoch1h.k > stoch1h.d && stoch1h.d < 35) {
        return { shouldHold: false, reason: "1h_stoch_cross_oversold", updatedTradeState: { phase: "EXIT" } };
      }
      if (stoch1h.k > 30 && stoch1h.k > stoch1h.d) {
        return { shouldHold: false, reason: "1h_stoch_bottom", updatedTradeState: { phase: "EXIT" } };
      }
    }
  }

  // 4. 4H Stoch exit — BACKUP
  if (candles4h && candles4h.length >= 50) {
    const closes4h = candles4h.map(c => c.close);
    const stoch4h = stochRsi(closes4h);

    if (signal.direction === "LONG" && stoch4h.k > 80 && stoch4h.k < stoch4h.d) {
      return { shouldHold: false, reason: "4h_stoch_top", updatedTradeState: { phase: "EXIT" } };
    }
    if (signal.direction === "SHORT" && stoch4h.k < 20 && stoch4h.k > stoch4h.d) {
      return { shouldHold: false, reason: "4h_stoch_bottom", updatedTradeState: { phase: "EXIT" } };
    }
  }

  // 5. Time stop
  const hoursInTrade = (now - signal.timestamp) / (60 * 60 * 1000);
  if (hoursInTrade > 8) {
    const pnl = signal.direction === "LONG"
      ? (currentPrice - signal.entry) / signal.entry
      : (signal.entry - currentPrice) / signal.entry;
    if (pnl < 0.005) {
      return { shouldHold: false, reason: "time_stop_weak", updatedTradeState: { phase: "EXIT" } };
    }
  }

  return { shouldHold: true, reason: "holding", updatedTradeState: { phase: "TREND" } };
}

// ============================================================
// HELPERS
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
        if (!check.valid) {
          exited.push({ signal, reason: check.reason });
          continue;
        }
      }
      active.push(signal);
      continue;
    }
    if (now - signal.timestamp < EXITED_TTL_MS) active.push(signal);
  }
  return { active, exited };
}

// ============================================================
// MARKET SNAPSHOT
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
  const bias = detectBias(candles1d, candles4h);

  const stoch4h = candles4h.length >= 50 ? stochRsi(candles4h.map(c => c.close)) : { k: 50, d: 50 };
  const stoch1h = candles1h.length >= 30 ? stochRsi(candles1h.map(c => c.close)) : { k: 50, d: 50 };
  const stoch15m = candles15m.length >= 20 ? stochRsi(candles15m.map(c => c.close)) : { k: 50, d: 50 };

  const volConfirmed = isVolumeConfirmed(candles4h);

  const pivots4h = findPivots(candles4h, 3, 2);
  const resistanceLines = buildTrendlines(candles4h, pivots4h.highs, "RESISTANCE", 2, 0.3);
  const supportLines = buildTrendlines(candles4h, pivots4h.lows, "SUPPORT", 2, 0.3);

  const activeTrendlines = [...resistanceLines, ...supportLines]
    .filter(l => l.isValid && !l.isBroken)
    .map(l => ({
      type: l.type,
      startPrice: l.startPrice,
      endPrice: l.endPrice,
      touches: l.touches,
      currentPrice: getTrendlinePrice(l, candles4h.length - 1),
    }));

  // Check breaks for readiness
  const longBreak = bias.direction === "LONG" 
    ? checkTrendlineBreak(candles4h, resistanceLines, "RESISTANCE")
    : { broken: false };
  const shortBreak = bias.direction === "SHORT"
    ? checkTrendlineBreak(candles4h, supportLines, "SUPPORT")
    : { broken: false };

  const exhaustion = checkExhaustion(bias.direction, stoch4h);

  // v35 backward compat fields
  const t1h = detectTrend(candles1h);
  const t4h = detectTrend(candles4h);
  const t1d = detectTrend(candles1d);

  const closes4h = candles4h.map(c => c.close);
  const e21_4h = ema(closes4h, 21);
  const ema21Price = e21_4h.length > 0 ? e21_4h[e21_4h.length - 1] : 0;
  const distToEMA21 = ema21Price > 0 ? (price - ema21Price) / ema21Price : 0;

  const adxVal = adx(candles4h) ?? 0;
  const rsiVal = wilderRsi(closes4h);

  let trendStrengthLabel = "WEAK";
  if (adxVal >= 30) trendStrengthLabel = "STRONG";
  else if (adxVal >= 20) trendStrengthLabel = "MEDIUM";

  let phase4h: "EXPANSION" | "EXHAUSTION" | "BUILDING" | "NEUTRAL" = "NEUTRAL";
  if (bias.direction === "LONG") {
    if (stoch4h.k > 75) phase4h = "EXPANSION";
    else if (stoch4h.k < 25) phase4h = "EXHAUSTION";
    else phase4h = "BUILDING";
  } else if (bias.direction === "SHORT") {
    if (stoch4h.k < 25) phase4h = "EXPANSION";
    else if (stoch4h.k > 75) phase4h = "EXHAUSTION";
    else phase4h = "BUILDING";
  }

  let structure15m = "Neutral";
  if (candles15m.length >= 20) {
    const t15m = detectTrend(candles15m);
    if (t15m.direction === bias.direction) {
      structure15m = t15m.strength === "STRONG" ? "Breakout" : "Building";
    } else if (t15m.direction && t15m.direction !== bias.direction) {
      structure15m = "Reversal";
    }
  }

  // Readiness calculation
  let readiness = 0;
  if (bias.direction) readiness += 20;
  if (exhaustion.allowed) readiness += 30;
  if (adxVal >= 25) readiness += 20;
  else if (adxVal >= 20) readiness += 15;
  else if (adxVal >= 15) readiness += 10;
  if (longBreak.broken || shortBreak.broken) readiness += 20;
  if (volConfirmed) readiness += 10;
  if (signalResult?.signal) readiness += 15;
  readiness = Math.min(100, readiness);

  let readinessLabel = "NO TRADE";
  let readinessColor = "text-gray-400";
  if (readiness >= 80) { readinessLabel = "READY"; readinessColor = "text-green-400"; }
  else if (readiness >= 60) { readinessLabel = "WARM"; readinessColor = "text-amber-400"; }
  else if (readiness >= 40) { readinessLabel = "WATCH"; readinessColor = "text-blue-400"; }

  return {
    pair,
    price: Math.round(price * 100) / 100,
    timestamp: Date.now(),
    // v36 fields
    bias: bias.direction ? { direction: bias.direction, strength: bias.strength } : null,
    stoch4h,
    stoch1h,
    stoch15m,
    volumeConfirmed: volConfirmed,
    trendlines: activeTrendlines,
    // Counter-trend info
    trendDirection: bias.direction ? (bias.direction === "LONG" ? "SHORT" : "LONG") : null,
    counterDirection: bias.direction,
    isExhausted: exhaustion.allowed,
    exhaustionReason: exhaustion.reason,
    readiness,
    readinessLabel,
    readinessColor,
    adx: Math.round(adxVal * 10) / 10,
    trendStrengthLabel,
    // v35 backward compat
    trend: bias.direction ? `${bias.direction} ${bias.strength > 50 ? "STRONG" : "MEDIUM"}` : "NONE",
    regime: {
      direction: bias.direction,
      strength: bias.strength > 50 ? "STRONG" : "MEDIUM",
      confidence: bias.direction ? (bias.strength > 50 ? 75 : 50) : 0,
    },
    rsi: Math.round((rsiVal ?? 50) * 10) / 10,
    stochK: stoch4h.k,
    stochD: stoch4h.d,
    stoch1hK: stoch1h.k,
    stoch1hD: stoch1h.d,
    ema21: Math.round(ema21Price * 100) / 100,
    distToEMA21: Math.round(distToEMA21 * 10000) / 100,
    trend1h: t1h.direction ? { direction: t1h.direction, strength: t1h.strength } : null,
    trend4h: t4h.direction ? { direction: t4h.direction, strength: t4h.strength } : null,
    trend1d: t1d.direction ? { direction: t1d.direction, strength: t1d.strength } : null,
    trendStrength: { adx: adxVal, isStrong: adxVal >= 25 },
    phase4h,
    phase1h: phase4h,
    structure15m,
    recommendedAction: signalResult?.signal ? `${signalResult.signal.direction} ${signalResult.signal.entryType}` : null,
    entryTier: signalResult?.signal ? (signalResult.signal.entryType === "RETEST" ? "CONFIRMED_ENTRY" : "EARLY_ENTRY") : null,
    entryMode: signalResult?.signal ? (signalResult.signal.entryType === "EARLY" ? "PULLBACK" : "BREAKOUT") : null,
    positionSize: signalResult?.signal ? (signalResult.signal.entryType === "RETEST" ? "FULL" : "STARTER") : null,
    signal: signalResult?.signal || null,
    summary: {
      status: signalResult?.signal ? "READY" : "WATCH",
      debug: signalResult?.debug || bias.debug || [],
    },
    activeTrade: null,
    debug: signalResult?.debug || bias.debug || [],
    ...signalResult?.market,
  };
}

// ============================================================
// TREND DETECTION (helper for snapshot)
// ============================================================

function detectTrend(candles: Candle[]) {
  if (candles.length < 25) return { direction: null as "LONG" | "SHORT" | null, strength: "WEAK" };
  const closes = candles.map(c => c.close);
  const e8 = ema(closes, 8), e21 = ema(closes, 21);
  if (!e8.length || !e21.length) return { direction: null as "LONG" | "SHORT" | null, strength: "WEAK" };
  const direction = e8[e8.length - 1] > e21[e21.length - 1] ? "LONG" : "SHORT";
  const highs = candles.slice(-20).map(c => c.high), lows = candles.slice(-20).map(c => c.low);
  const hh = highs[highs.length - 1] > Math.max(...highs.slice(0, -1));
  const ll = lows[lows.length - 1] < Math.min(...lows.slice(0, -1));
  const strength = (direction === "LONG" && hh) || (direction === "SHORT" && ll) ? "STRONG" : "MEDIUM";
  return { direction, strength };
}

// ============================================================
// COMPAT / LEGACY
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
  return generateSignal(pair, candles1h, candles4h, aggregateTo1D(candles4h), activeSignals || [], currentPrice);
}

export function migrateV34ToV35(signal: Signal): any {
  return {
    phase: "ENTRY",
    phaseEnteredAt: signal.timestamp,
    highestPrice: signal.entry,
    lowestPrice: signal.entry,
    entryPrice: signal.entry,
    lockedStop: null,
    profitLockLevel: 0,
    exitPersistence: { consecutiveClosesBeyondEMA21: 0, lastCloseBeyondEMA21: 0, ema21SlopeHistory: [], warningCount: 0 },
    entryTimestamp: signal.timestamp,
    lastDecisionTimestamp: Date.now(),
    realizedPnl: 0,
    maxDrawdown: 0,
    maxProfit: 0,
    currentR: 0,
  };
}

export function updateTradeManagerCompat(signal: Signal, currentPrice: number): any {
  return { phase: "TREND", currentR: 0 };
}

export function calculateTradeState(signal: Signal, currentPrice: number): any {
  return updateTradeManagerCompat(signal, currentPrice);
}

export async function loadExits(): Promise<any[]> { return []; }
export function setRegimePersistence(): void {}
export function setExitPersistence(): void {}
export function setTelemetryPersistence(): void {}
export async function persistTelemetry(): Promise<void> {}
