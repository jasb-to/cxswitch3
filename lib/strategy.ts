// ============================================================
// CXSwitch v36.0 — Trendline Break + Stoch Momentum System
// 
// RULES:
// 1. 1D + 4H bias: EMA alignment + HH/HL (LONG) or LL/LH (SHORT)
// 2. Trendline break: Price closes through validated diagonal S/R
// 3. 15M entry: Stoch cross + momentum BEFORE break (early) or AFTER (confirmed)
// 4. Add on retest of broken trendline
// 5. Exit: 1H StochRSI tops/bottoms out
// 6. Hysteresis: Prevents re-entry in exhaustion zone
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
  entryType: "EARLY" | "BREAKOUT" | "RETEST";
  trendlinePrice: number;  // Price of the broken trendline at entry
}

export interface HoldResult {
  shouldHold: boolean;
  reason: string;
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

// ============================================================
// UTILITIES
// ============================================================

function avg(arr: number[]): number {
  return arr.length ? arr.reduce((a, b) => a + b, 0) / arr.length : 0;
}

function isValid(v: any): boolean {
  return typeof v === "number" && Number.isFinite(v);
}

function ema(values: number[], period: number): number[] {
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

function wilderRsi(values: number[], period = 14): number | null {
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

function atr(candles: Candle[], period = 14): number {
  const trs: number[] = [];
  for (let i = Math.max(1, candles.length - period); i < candles.length; i++) {
    trs.push(
      Math.max(
        candles[i].high - candles[i].low,
        Math.abs(candles[i].high - candles[i - 1].close),
        Math.abs(candles[i].low - candles[i - 1].close)
      )
    );
  }
  return avg(trs);
}

// ============================================================
// PIVOT DETECTION (for trendline construction)
// ============================================================

function findPivots(candles: Candle[], leftBars = 3, rightBars = 2): {
  highs: { index: number; price: number }[];
  lows: { index: number; price: number }[];
} {
  const highs: { index: number; price: number }[] = [];
  const lows: { index: number; price: number }[] = [];

  for (let i = leftBars; i < candles.length - rightBars; i++) {
    // Pivot High
    const isHigh = candles.slice(i - leftBars, i).every(c => c.high <= candles[i].high) &&
                   candles.slice(i + 1, i + 1 + rightBars).every(c => c.high <= candles[i].high);
    if (isHigh) highs.push({ index: i, price: candles[i].high });

    // Pivot Low
    const isLow = candles.slice(i - leftBars, i).every(c => c.low >= candles[i].low) &&
                  candles.slice(i + 1, i + 1 + rightBars).every(c => c.low >= candles[i].low);
    if (isLow) lows.push({ index: i, price: candles[i].low });
  }

  return { highs, lows };
}

// ============================================================
// TRENDLINE CONSTRUCTION (from confirmed pivots)
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

  // Try all pivot pairs
  for (let i = 0; i < pivots.length - 1; i++) {
    for (let j = i + 1; j < pivots.length; j++) {
      const p1 = pivots[i];
      const p2 = pivots[j];

      // Slope
      const slope = (p2.price - p1.price) / (p2.index - p1.index);

      // Classic direction check
      if (type === "RESISTANCE" && slope > 0.001) continue;  // Resistance should slope down or flat
      if (type === "SUPPORT" && slope < -0.001) continue;    // Support should slope up or flat

      // Validate: check all candles between pivots
      let touches = 0;
      let valid = true;

      for (let k = p1.index; k <= Math.min(p2.index + 5, candles.length - 1); k++) {
        const expectedPrice = p1.price + slope * (k - p1.index);
        const actualPrice = type === "RESISTANCE" ? candles[k].high : candles[k].low;
        const closePrice = candles[k].close;

        // For resistance: highs should stay below line + tolerance
        // For support: lows should stay above line - tolerance
        if (type === "RESISTANCE") {
          if (closePrice > expectedPrice + tolerance * 2) {
            valid = false;
            break;
          }
          if (Math.abs(actualPrice - expectedPrice) < tolerance) touches++;
        } else {
          if (closePrice < expectedPrice - tolerance * 2) {
            valid = false;
            break;
          }
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

  // Sort by recency and touches, keep best
  lines.sort((a, b) => {
    if (b.touches !== a.touches) return b.touches - a.touches;
    return b.endIndex - a.endIndex;
  });

  return lines.slice(0, 3);  // Keep top 3
}

// ============================================================
// TRENDLINE BREAK DETECTION
// ============================================================

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
      // Break: prev close <= line, current close > line
      if (prev.close <= linePrev && current.close > lineCurrent) {
        line.isBroken = true;
        line.brokenAt = current.timestamp;
        line.brokenPrice = current.close;
        return { broken: true, line, breakIndex: currentIndex, breakPrice: current.close };
      }
    } else {
      // Break: prev close >= line, current close < line
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
// MARKET STRUCTURE (HH/HL for LONG, LL/LH for SHORT)
// ============================================================

function analyzeStructure(candles: Candle[]): {
  direction: "LONG" | "SHORT" | null;
  strength: number;
  lastHH: number | null;
  lastHL: number | null;
  lastLH: number | null;
  lastLL: number | null;
} {
  if (candles.length < 20) return { direction: null, strength: 0, lastHH: null, lastHL: null, lastLH: null, lastLL: null };

  const { highs, lows } = findPivots(candles, 3, 2);
  if (highs.length < 3 || lows.length < 3) {
    return { direction: null, strength: 0, lastHH: null, lastHL: null, lastLH: null, lastLL: null };
  }

  // Count HH/HL vs LL/LH
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
    return {
      direction: "LONG",
      strength: Math.min(100, bullishScore * 20),
      lastHH: highs[highs.length - 1]?.price || null,
      lastHL: lows[lows.length - 1]?.price || null,
      lastLH: null,
      lastLL: null,
    };
  }
  if (bearishScore > bullishScore + 1) {
    return {
      direction: "SHORT",
      strength: Math.min(100, bearishScore * 20),
      lastHH: null,
      lastHL: null,
      lastLH: highs[highs.length - 1]?.price || null,
      lastLL: lows[lows.length - 1]?.price || null,
    };
  }

  return { direction: null, strength: 0, lastHH: null, lastHL: null, lastLH: null, lastLL: null };
}

// ============================================================
// BIAS DETECTION (1D + 4H)
// ============================================================

function detectBias(
  candles1d: Candle[],
  candles4h: Candle[]
): { direction: "LONG" | "SHORT" | null; strength: number; debug: string[] } {
  const debug: string[] = [];

  // 1D bias
  const structure1d = analyzeStructure(candles1d);
  debug.push(`1D Structure: ${structure1d.direction || "NONE"} (strength: ${structure1d.strength})`);

  // 4H bias
  const structure4h = analyzeStructure(candles4h);
  debug.push(`4H Structure: ${structure4h.direction || "NONE"} (strength: ${structure4h.strength})`);

  // EMA alignment on 4H
  const closes4h = candles4h.map(c => c.close);
  const e8 = ema(closes4h, 8);
  const e21 = ema(closes4h, 21);
  const e50 = ema(closes4h, 50);

  let emaBias: "LONG" | "SHORT" | null = null;
  if (e8.length && e21.length && e50.length) {
    const c0 = closes4h[closes4h.length - 1];
    const e8_0 = e8[e8.length - 1];
    const e21_0 = e21[e21.length - 1];
    const e50_0 = e50[e50.length - 1];

    if (c0 > e8_0 && e8_0 > e21_0 && e21_0 > e50_0) emaBias = "LONG";
    else if (c0 < e8_0 && e8_0 < e21_0 && e21_0 < e50_0) emaBias = "SHORT";
    else if (e8_0 > e21_0) emaBias = "LONG";
    else if (e8_0 < e21_0) emaBias = "SHORT";
  }
  debug.push(`4H EMA Bias: ${emaBias || "NONE"}`);

  // Combine: need 2 of 3 agreeing
  const votes = [structure1d.direction, structure4h.direction, emaBias].filter(Boolean);
  const longVotes = votes.filter(v => v === "LONG").length;
  const shortVotes = votes.filter(v => v === "SHORT").length;

  if (longVotes >= 2) {
    const strength = Math.round((structure1d.strength + structure4h.strength) / 2);
    debug.push(`BIAS: LONG (${longVotes}/3 votes)`);
    return { direction: "LONG", strength, debug };
  }
  if (shortVotes >= 2) {
    const strength = Math.round((structure1d.strength + structure4h.strength) / 2);
    debug.push(`BIAS: SHORT (${shortVotes}/3 votes)`);
    return { direction: "SHORT", strength, debug };
  }

  debug.push(`BIAS: UNCLEAR (L:${longVotes}, S:${shortVotes})`);
  return { direction: null, strength: 0, debug };
}

// ============================================================
// HYSTERESIS (prevents exhaustion re-entry)
// ============================================================

const hysteresisStore = new Map<string, { lastEntryPrice: number; lockUntil: number }>();
const POST_EXIT_COOLDOWN_MS = 30 * 60 * 1000;  // 30 min

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
  // Check if 4H stoch is in exhaustion zone
  const stoch4h = stochRsi(candles4h.map(c => c.close));

  if (direction === "LONG" && stoch4h.k > 75) return true;
  if (direction === "SHORT" && stoch4h.k < 25) return true;

  // Check hysteresis
  const hyst = getHysteresis(pair, Date.now());
  if (hyst) {
    const dist = Math.abs(price - hyst.lastEntryPrice) / hyst.lastEntryPrice;
    if (dist < 0.01) return true;  // Within 1% of last exit
  }

  return false;
}

// ============================================================
// ENTRY LOGIC
// ============================================================

export function generateSignal(
  pair: string,
  candles15m: Candle[],
  candles1h: Candle[],
  candles4h: Candle[],
  candles1d: Candle[],
  activeSignals: Signal[],
  currentPrice?: number
): { signal?: Signal; debug: string[] } {
  const debug: string[] = [];
  const now = Date.now();

  // Already active?
  const active = activeSignals.find(s => s.pair === pair && !s.exited);
  if (active) {
    debug.push(`Already active: ${active.id}`);
    return { debug };
  }

  if (candles4h.length < 50 || candles1h.length < 30 || candles15m.length < 20 || candles1d.length < 25) {
    debug.push("Insufficient data");
    return { debug };
  }

  const price = currentPrice ?? candles4h[candles4h.length - 1].close;

  // 1. BIAS
  const bias = detectBias(candles1d, candles4h);
  debug.push(...bias.debug);

  if (!bias.direction) {
    debug.push("No clear bias — waiting");
    return { debug };
  }

  // 2. Check exhaustion zone (hysteresis)
  if (isInExhaustionZone(pair, price, candles4h, bias.direction)) {
    debug.push("In exhaustion zone — hysteresis lock active");
    return { debug };
  }

  // 3. Build trendlines on 4H
  const pivots4h = findPivots(candles4h, 3, 2);
  const resistanceLines = buildTrendlines(candles4h, pivots4h.highs, "RESISTANCE", 2, 0.3);
  const supportLines = buildTrendlines(candles4h, pivots4h.lows, "SUPPORT", 2, 0.3);

  debug.push(`Trendlines: ${resistanceLines.length} resistance, ${supportLines.length} support`);

  // 4. Check for trendline breaks
  const longBreak = bias.direction === "LONG" 
    ? checkTrendlineBreak(candles4h, resistanceLines, "RESISTANCE")
    : { broken: false };
  const shortBreak = bias.direction === "SHORT"
    ? checkTrendlineBreak(candles4h, supportLines, "SUPPORT")
    : { broken: false };

  const breakEvent = bias.direction === "LONG" ? longBreak : shortBreak;

  // 5. Check 15M stoch for entry timing
  const closes15m = candles15m.map(c => c.close);
  const stoch15m = stochRsi(closes15m);
  debug.push(`15M Stoch: ${stoch15m.k}/${stoch15m.d}`);

  const closes1h = candles1h.map(c => c.close);
  const stoch1h = stochRsi(closes1h);
  debug.push(`1H Stoch: ${stoch1h.k}/${stoch1h.d}`);

  const closes4h = candles4h.map(c => c.close);
  const stoch4h = stochRsi(closes4h);
  debug.push(`4H Stoch: ${stoch4h.k}/${stoch4h.d}`);

  let entryType: "EARLY" | "BREAKOUT" | "RETEST" | null = null;
  let confidence = 50;
  let trendlinePrice = 0;

  // EARLY ENTRY: Before the break
  // 4H stoch oversold + 1H turning up + 15M cross up
  if (bias.direction === "LONG") {
    const is4hOversold = stoch4h.k < 25 && stoch4h.d < 30;
    const is1hTurning = stoch1h.k > stoch1h.d || stoch1h.k < 20;
    const is15mCrossing = stoch15m.k > stoch15m.d && stoch15m.k < 50;

    if (is4hOversold && is1hTurning && is15mCrossing) {
      entryType = "EARLY";
      confidence = 70;
      trendlinePrice = resistanceLines[0] ? getTrendlinePrice(resistanceLines[0], candles4h.length - 1) : price * 1.02;
      debug.push(`EARLY ENTRY: 4H oversold(${stoch4h.k}), 1H turning, 15M cross`);
    }
  } else {
    const is4hOverbought = stoch4h.k > 75 && stoch4h.d > 70;
    const is1hTurning = stoch1h.k < stoch1h.d || stoch1h.k > 80;
    const is15mCrossing = stoch15m.k < stoch15m.d && stoch15m.k > 50;

    if (is4hOverbought && is1hTurning && is15mCrossing) {
      entryType = "EARLY";
      confidence = 70;
      trendlinePrice = supportLines[0] ? getTrendlinePrice(supportLines[0], candles4h.length - 1) : price * 0.98;
      debug.push(`EARLY ENTRY: 4H overbought(${stoch4h.k}), 1H turning, 15M cross`);
    }
  }

  // BREAKOUT ENTRY: After the break
  if (!entryType && breakEvent.broken && breakEvent.line) {
    const is15mConfirming = bias.direction === "LONG"
      ? stoch15m.k > stoch15m.d
      : stoch15m.k < stoch15m.d;

    if (is15mConfirming) {
      entryType = "BREAKOUT";
      confidence = 80;
      trendlinePrice = getTrendlinePrice(breakEvent.line, candles4h.length - 1);
      debug.push(`BREAKOUT ENTRY: Trendline ${breakEvent.line.type} broken, 15M confirming`);
    }
  }

  // RETEST ENTRY: Price comes back to broken trendline
  if (!entryType && breakEvent.broken && breakEvent.line) {
    const linePrice = getTrendlinePrice(breakEvent.line, candles4h.length - 1);
    const distToLine = Math.abs(price - linePrice) / linePrice;

    if (distToLine < 0.005) {  // Within 0.5% of broken trendline
      const is15mBouncing = bias.direction === "LONG"
        ? stoch15m.k > stoch15m.d && stoch15m.k < 40
        : stoch15m.k < stoch15m.d && stoch15m.k > 60;

      if (is15mBouncing) {
        entryType = "RETEST";
        confidence = 75;
        trendlinePrice = linePrice;
        debug.push(`RETEST ENTRY: Price at broken trendline, 15M bouncing`);
      }
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
    target = Math.max(swingHigh * 1.02, entry + atr4h * 4, trendlinePrice * 1.03);
  } else {
    stop = Math.max(swingHigh, entry + atr4h * 1.5, trendlinePrice * 1.01);
    target = Math.min(swingLow * 0.98, entry - atr4h * 4, trendlinePrice * 0.97);
  }

  const risk = Math.abs(entry - stop);
  const reward = Math.abs(target - entry);
  const rr = risk > 0 ? reward / risk : 0;

  if (rr < 1.0) {
    debug.push(`R:R ${rr.toFixed(2)} < 1.0 — skip`);
    return { debug };
  }

  // Adjust confidence
  confidence += Math.min(15, bias.strength / 7);
  if (breakEvent.broken) confidence += 10;
  confidence = Math.min(95, confidence);

  const signal: Signal = {
    id: `${pair}_${now}`,
    pair,
    direction: bias.direction,
    entry: Math.round(entry * 100) / 100,
    stop: Math.round(stop * 100) / 100,
    target: Math.round(target * 100) / 100,
    confidence,
    timestamp: now,
    exited: false,
    entryType,
    trendlinePrice: Math.round(trendlinePrice * 100) / 100,
  };

  setHysteresis(pair, entry, now);

  debug.push(`SIGNAL: ${entryType} ${bias.direction} ${pair} @ ${entry.toFixed(2)}, SL ${stop.toFixed(2)}, TP ${target.toFixed(2)}, RR ${rr.toFixed(2)}, Conf ${confidence}%`);

  return { signal, debug };
}

// ============================================================
// EXIT LOGIC — Stoch-Driven
// ============================================================

export function shouldHold(
  signal: Signal,
  candles1h: Candle[],
  candles4h: Candle[],
  currentPrice: number
): HoldResult {
  const now = Date.now();

  // 1. Hard stop
  if (signal.direction === "LONG" && currentPrice <= signal.stop) {
    return { shouldHold: false, reason: "stop_loss" };
  }
  if (signal.direction === "SHORT" && currentPrice >= signal.stop) {
    return { shouldHold: false, reason: "stop_loss" };
  }

  // 2. Hard target
  if (signal.direction === "LONG" && currentPrice >= signal.target) {
    return { shouldHold: false, reason: "target_hit" };
  }
  if (signal.direction === "SHORT" && currentPrice <= signal.target) {
    return { shouldHold: false, reason: "target_hit" };
  }

  // 3. 1H Stoch exit — PRIMARY
  if (candles1h.length >= 30) {
    const closes1h = candles1h.map(c => c.close);
    const stoch1h = stochRsi(closes1h);

    if (signal.direction === "LONG") {
      // K crosses below D from above 65 — momentum reversal
      if (stoch1h.k < stoch1h.d && stoch1h.d > 65) {
        return { shouldHold: false, reason: "1h_stoch_cross_overbought" };
      }
      // K was high, now falling below 70 — topped out
      if (stoch1h.k < 70 && stoch1h.k < stoch1h.d) {
        return { shouldHold: false, reason: "1h_stoch_top" };
      }
    } else {
      // SHORT: K crosses above D from below 35
      if (stoch1h.k > stoch1h.d && stoch1h.d < 35) {
        return { shouldHold: false, reason: "1h_stoch_cross_oversold" };
      }
      // K was low, now rising above 30 — bottomed out
      if (stoch1h.k > 30 && stoch1h.k > stoch1h.d) {
        return { shouldHold: false, reason: "1h_stoch_bottom" };
      }
    }
  }

  // 4. 4H Stoch exit — BACKUP (if 1H misses it)
  if (candles4h.length >= 50) {
    const closes4h = candles4h.map(c => c.close);
    const stoch4h = stochRsi(closes4h);

    if (signal.direction === "LONG" && stoch4h.k > 80 && stoch4h.k < stoch4h.d) {
      return { shouldHold: false, reason: "4h_stoch_top" };
    }
    if (signal.direction === "SHORT" && stoch4h.k < 20 && stoch4h.k > stoch4h.d) {
      return { shouldHold: false, reason: "4h_stoch_bottom" };
    }
  }

  // 5. Time stop — going nowhere
  const hoursInTrade = (now - signal.timestamp) / (60 * 60 * 1000);
  if (hoursInTrade > 8) {
    const pnl = signal.direction === "LONG"
      ? (currentPrice - signal.entry) / signal.entry
      : (signal.entry - currentPrice) / signal.entry;
    if (pnl < 0.005) {
      return { shouldHold: false, reason: "time_stop_weak" };
    }
  }

  return { shouldHold: true, reason: "holding" };
}

// ============================================================
// HELPERS
// ============================================================

export function isSignalStillValid(signal: Signal, currentPrice: number): { valid: boolean; reason: string } {
  if (signal.direction === "LONG" && currentPrice <= signal.stop) return { valid: false, reason: "stop_loss" };
  if (signal.direction === "SHORT" && currentPrice >= signal.stop) return { valid: false, reason: "stop_loss" };
  if (signal.direction === "LONG" && currentPrice >= signal.target) return { valid: false, reason: "target_hit" };
  if (signal.direction === "SHORT" && currentPrice <= signal.target) return { valid: false, reason: "target_hit" };
  return { valid: true, reason: "active" };
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
  candles15m: Candle[],
  candles1h: Candle[],
  candles4h: Candle[],
  candles1d: Candle[],
  currentPrice?: number,
  signalResult?: { signal?: Signal; debug: string[] }
) {
  const price = currentPrice ?? candles4h[candles4h.length - 1]?.close ?? 0;
  const bias = detectBias(candles1d, candles4h);

  const stoch4h = candles4h.length >= 50 ? stochRsi(candles4h.map(c => c.close)) : { k: 50, d: 50 };
  const stoch1h = candles1h.length >= 30 ? stochRsi(candles1h.map(c => c.close)) : { k: 50, d: 50 };
  const stoch15m = candles15m.length >= 20 ? stochRsi(candles15m.map(c => c.close)) : { k: 50, d: 50 };

  // Build trendlines for display
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

  return {
    pair,
    price: Math.round(price * 100) / 100,
    timestamp: Date.now(),
    bias: bias.direction ? { direction: bias.direction, strength: bias.strength } : null,
    stoch4h,
    stoch1h,
    stoch15m,
    trendlines: activeTrendlines,
    signal: signalResult?.signal || null,
    debug: signalResult?.debug || [],
  };
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
  return shouldHold(signal, candles1h, candles4h, currentPrice);
}

export async function generateSignalAsync(
  pair: string,
  candles1h: Candle[],
  candles4h: Candle[],
  candles15m: Candle[],
  candles1d: Candle[],
  activeSignals?: Signal[],
  currentPrice?: number
): Promise<{ signal?: Signal; debug: string[] }> {
  return generateSignal(pair, candles15m, candles1h, candles4h, candles1d, activeSignals || [], currentPrice);
}

export async function loadExits(): Promise<any[]> { return []; }
export async function persistTelemetry(): Promise<void> {}

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
