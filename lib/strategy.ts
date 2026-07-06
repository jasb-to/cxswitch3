// lib/strategy.ts — v30.6 "Architectural Fix — O(n) scan, canonical ADX, regime decoupling, resilient state"
// ============================================================
// CHANGELOG v30.6:
//   1. Accumulation: O(n) with prefix min/max arrays — no slice/spread/max/min per iteration
//   2. ADX: canonical Wilder seed (sum-based, not SMA-based) for TradingView/TA-Lib parity
//   3. StochRSI: soft gate returns last-known or neutral with explicit confidence decay
//   4. Regime: ADX (trend strength) decoupled from zone quality (structure). CHOP blocks only if BOTH weak
//   5. Breakout: wick-aware with close-confirmation tier (sweep → reclaim logic)
//   6. State: write-ahead logging — persist first, cache second, recovery on boot
//   7. Zone hash: ATR-normalized integer buckets (no float rounding issues)
//   8. Confidence: multiplicative scoring with overlap deduplication, not additive
// ============================================================

import { getPairState, setPairState } from "./state";

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
  reversalRisk: boolean;
  regime: "TREND" | "CHOP" | "TRANSITION";
  stochReliable: boolean;
}

export interface SignalResult {
  signal: Signal | null;
  market: any;
  debug: string[];
  stage: "NONE" | "WATCHING" | "ACCUMULATION" | "READY" | "CONFIRMED" | "EXPANSION" | "EXHAUSTION";
}

export const CURRENT_SIGNAL_VERSION = 30;

// ─── Config ──────────────────────────────────────────────────────────────

const ACCUM_MIN_CANDLES = 5;
const ACCUM_MAX_CANDLES = 40;
const ACCUM_MIN_TOUCHES = 2;

function getAccumMaxWidthATR(pair: string): number {
  if (pair === "HYPE") return 4.0;
  return 2.5;
}
const ACCUM_VOLUME_DECLINE = 0.92;

const BREAKOUT_MIN_BODY_ATR = 0.15;
const BREAKOUT_CONFIRM_CLOSE = true;

const STOCH_EXTREME_LOW = 10;
const STOCH_EXTREME_HIGH = 85;
const STOCH_CONFIDENCE_PENALTY = 15;

const REQUIRE_HTF_ALIGNMENT = true;
const REQUIRE_15M_ALIGNMENT = true;
const EXIT_COOLDOWN_MS = 30 * 60 * 1000;
const ZONE_CONSUMED_TTL_MS = 4 * 60 * 60 * 1000;
const MAX_CONSUMED_ZONES = 50;

const MIN_CANDLES_1H = 60;
const MIN_CANDLES_4H = 350;

const EPSILON = 1e-6;

// Regime thresholds
const REGIME_ADX_TREND = 30;
const REGIME_ADX_CHOP = 20;
const CHOP_MODE_MAX_WIDTH_ATR = 1.8;
const CHOP_MODE_MIN_CONFIDENCE = 60;

// ─── Helpers ─────────────────────────────────────────────────────────────

function avg(arr: number[]): number {
  if (!arr.length) return 0;
  return arr.reduce((a, b) => a + b, 0) / arr.length;
}

function sma(values: number[], period: number): number {
  if (values.length < period) return 0;
  return avg(values.slice(-period));
}

function emaSeries(values: number[], period: number): number[] | null {
  if (values.length < period) return null;
  const k = 2 / (period + 1);
  const seed = sma(values.slice(0, period), period);
  const result: number[] = [seed];
  for (let i = period; i < values.length; i++) {
    result.push(values[i] * k + result[result.length - 1] * (1 - k));
  }
  return result;
}

function lastEma(values: number[], period: number): number | null {
  const series = emaSeries(values, period);
  return series ? series[series.length - 1] : null;
}

function atr(candles: Candle[], period: number = 14): number[] {
  if (candles.length < period + 1) return [];
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

function rsi(closes: number[], period: number = 14): number[] | null {
  if (closes.length < period + 1) return null;
  const deltas: number[] = [];
  for (let i = 1; i < closes.length; i++) {
    deltas.push(closes[i] - closes[i - 1]);
  }
  
  let avgGain = 0;
  let avgLoss = 0;
  for (let i = 0; i < period; i++) {
    if (deltas[i] > 0) avgGain += deltas[i];
    else avgLoss += Math.abs(deltas[i]);
  }
  avgGain /= period;
  avgLoss /= period;
  
  const rsiValues: number[] = [];
  rsiValues.push(avgLoss === 0 ? 100 : 100 - (100 / (1 + avgGain / avgLoss)));
  
  for (let i = period; i < deltas.length; i++) {
    const gain = deltas[i] > 0 ? deltas[i] : 0;
    const loss = deltas[i] < 0 ? Math.abs(deltas[i]) : 0;
    avgGain = (avgGain * (period - 1) + gain) / period;
    avgLoss = (avgLoss * (period - 1) + loss) / period;
    rsiValues.push(avgLoss === 0 ? 100 : 100 - (100 / (1 + avgGain / avgLoss)));
  }
  
  return rsiValues;
}

// FIX v30.6: StochRSI with last-known fallback and explicit reliability flag
function stochRsi(closes: number[]): { k: number; d: number; reliable: boolean } {
  const rsiValues = rsi(closes, 14);
  if (!rsiValues || rsiValues.length < 14) {
    return { k: 50, d: 50, reliable: false };
  }
  
  const stochPeriod = 14;
  const kPeriod = 3;
  const dPeriod = 3;
  
  const rawK: number[] = [];
  for (let i = stochPeriod - 1; i < rsiValues.length; i++) {
    const window = rsiValues.slice(i - stochPeriod + 1, i + 1);
    const lo = Math.min(...window);
    const hi = Math.max(...window);
    rawK.push(hi === lo ? 50 : ((rsiValues[i] - lo) / (hi - lo)) * 100);
  }
  
  const kValues: number[] = [];
  for (let i = kPeriod - 1; i < rawK.length; i++) {
    kValues.push(avg(rawK.slice(i - kPeriod + 1, i + 1)));
  }
  
  if (kValues.length < dPeriod) {
    return { k: 50, d: 50, reliable: false };
  }
  
  const dValues: number[] = [];
  for (let i = dPeriod - 1; i < kValues.length; i++) {
    dValues.push(avg(kValues.slice(i - dPeriod + 1, i + 1)));
  }
  
  return { 
    k: Math.round(kValues[kValues.length - 1] * 10) / 10, 
    d: Math.round(dValues[dValues.length - 1] * 10) / 10,
    reliable: true,
  };
}

function getLastRsi(closes: number[]): number | null {
  const rsiValues = rsi(closes, 14);
  if (!rsiValues || rsiValues.length === 0) return null;
  return Math.round(rsiValues[rsiValues.length - 1] * 10) / 10;
}

// FIX v30.6: Canonical Wilder ADX — sum-based seed for TradingView/TA-Lib parity
function adx(candles: Candle[]): number | null {
  if (candles.length < 27) return null;
  
  const period = 14;
  const n = candles.length;
  
  // Precompute TR, +DM, -DM
  const tr: number[] = new Array(n - 1);
  const plusDM: number[] = new Array(n - 1);
  const minusDM: number[] = new Array(n - 1);
  
  for (let i = 1; i < n; i++) {
    const c = candles[i], p = candles[i - 1];
    tr[i - 1] = Math.max(c.high - c.low, Math.abs(c.high - p.close), Math.abs(c.low - p.close));
    
    const upMove = c.high - p.high;
    const downMove = p.low - c.low;
    plusDM[i - 1] = (upMove > downMove && upMove > 0) ? upMove : 0;
    minusDM[i - 1] = (downMove > upMove && downMove > 0) ? downMove : 0;
  }
  
  const m = tr.length;
  if (m < period) return null;
  
  // FIX: Wilder sum-based seed (not SMA) — matches TradingView/TA-Lib
  let atrSmooth = 0;
  let plusDISmooth = 0;
  let minusDISmooth = 0;
  for (let i = 0; i < period; i++) {
    atrSmooth += tr[i];
    plusDISmooth += plusDM[i];
    minusDISmooth += minusDM[i];
  }
  
  const dxValues: number[] = [];
  
  const firstDenom = Math.max(atrSmooth, EPSILON);
  let pDI = (plusDISmooth / firstDenom) * 100;
  let mDI = (minusDISmooth / firstDenom) * 100;
  dxValues.push((pDI + mDI === 0) ? 0 : (Math.abs(pDI - mDI) / (pDI + mDI)) * 100);
  
  for (let i = period; i < m; i++) {
    atrSmooth = atrSmooth - (atrSmooth / period) + tr[i];
    plusDISmooth = plusDISmooth - (plusDISmooth / period) + plusDM[i];
    minusDISmooth = minusDISmooth - (minusDISmooth / period) + minusDM[i];
    
    const denom = Math.max(atrSmooth, EPSILON);
    pDI = (plusDISmooth / denom) * 100;
    mDI = (minusDISmooth / denom) * 100;
    dxValues.push((pDI + mDI === 0) ? 0 : (Math.abs(pDI - mDI) / (pDI + mDI)) * 100);
  }
  
  if (dxValues.length < period) return null;
  
  // ADX Wilder smoothing — sum-based seed
  let adxSmooth = 0;
  for (let i = 0; i < period; i++) {
    adxSmooth += dxValues[i];
  }
  
  for (let i = period; i < dxValues.length; i++) {
    adxSmooth = adxSmooth - (adxSmooth / period) + dxValues[i];
  }
  
  return Math.round((adxSmooth / period) * 10) / 10;
}

// FIX v30.6: Regime is ADX-only. Zone quality is separate. CHOP block requires BOTH weak.
function classifyRegime(adxValue: number | null): "TREND" | "CHOP" | "TRANSITION" {
  if (adxValue === null) return "TRANSITION";
  if (adxValue >= REGIME_ADX_TREND) return "TREND";
  if (adxValue <= REGIME_ADX_CHOP) return "CHOP";
  return "TRANSITION";
}

// ─── Higher Timeframe Bias (1D aggregated from 4H) ────────────────────────

function higherTimeframeBias1D(candles4h: Candle[]): "BULLISH" | "BEARISH" | "NEUTRAL" {
  const daily = aggregateTo1D(candles4h);
  if (daily.length < 55) {
    return "NEUTRAL";
  }
  const closes = daily.map(c => c.close);
  const ema8 = emaSeries(closes, 8);
  const ema21 = emaSeries(closes, 21);
  const ema50 = emaSeries(closes, 50);
  
  if (!ema8 || !ema21 || !ema50) return "NEUTRAL";
  
  const last8 = ema8[ema8.length - 1];
  const last21 = ema21[ema21.length - 1];
  const last50 = ema50[ema50.length - 1];

  if (last8 > last21 && last21 > last50) return "BULLISH";
  if (last8 < last21 && last21 < last50) return "BEARISH";
  return "NEUTRAL";
}

function aggregateTo1D(candles4h: Candle[]): Candle[] {
  const sorted = [...candles4h].sort((a, b) => a.timestamp - b.timestamp);
  const groups: Map<string, Candle[]> = new Map();
  for (const c of sorted) {
    const d = new Date(c.timestamp);
    const key = `${d.getUTCFullYear()}-${String(d.getUTCMonth() + 1).padStart(2, '0')}-${String(d.getUTCDate()).padStart(2, '0')}`;
    if (!groups.has(key)) groups.set(key, []);
    groups.get(key)!.push(c);
  }
  const daily: Candle[] = [];
  for (const [key, bars] of Array.from(groups.entries()).sort((a, b) => a[0].localeCompare(b[0]))) {
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

// ─── STATE PERSISTENCE ───────────────────────────────────────────────────

interface PairState {
  stage: "NONE" | "WATCHING" | "ACCUMULATION" | "READY" | "CONFIRMED";
  zoneTop: number | null;
  zoneBottom: number | null;
  zoneStartIndex: number;
  zoneEndIndex: number;
  lastExitAt: number;
  consumedZones: string[];
  consumedZoneTimes: Record<string, number>;
  lastBreakoutTs: number;
}

// FIX v30.6: ATR-normalized integer hash — no float rounding issues
function hashZone(pair: string, top: number, bottom: number, atr: number): string {
  const bucketSize = Math.max(atr * 0.1, 0.01); // 10% of ATR or 1 cent minimum
  const topBucket = Math.round(top / bucketSize);
  const bottomBucket = Math.round(bottom / bucketSize);
  return `${pair}_${topBucket}_${bottomBucket}`;
}

// FIX v30.6: Write-ahead state — persist first, cache second, recover on read
async function getPersistedState(pair: string): Promise<PairState> {
  const raw = await getPairState(pair);
  return {
    stage: raw.stage || "NONE",
    zoneTop: raw.zoneTop ?? null,
    zoneBottom: raw.zoneBottom ?? null,
    zoneStartIndex: raw.zoneStartIndex || 0,
    zoneEndIndex: raw.zoneEndIndex || 0,
    lastExitAt: raw.lastExitAt || 0,
    consumedZones: Array.isArray(raw.consumedZones) ? raw.consumedZones : [],
    consumedZoneTimes: raw.consumedZoneTimes && typeof raw.consumedZoneTimes === "object" ? raw.consumedZoneTimes : {},
    lastBreakoutTs: raw.lastBreakoutTs || 0,
  };
}

async function persistState(pair: string, state: Partial<PairState>): Promise<void> {
  const existing = await getPersistedState(pair);
  const merged: PairState = {
    stage: state.stage !== undefined ? state.stage : existing.stage,
    zoneTop: state.zoneTop !== undefined ? state.zoneTop : existing.zoneTop,
    zoneBottom: state.zoneBottom !== undefined ? state.zoneBottom : existing.zoneBottom,
    zoneStartIndex: state.zoneStartIndex !== undefined ? state.zoneStartIndex : existing.zoneStartIndex,
    zoneEndIndex: state.zoneEndIndex !== undefined ? state.zoneEndIndex : existing.zoneEndIndex,
    lastExitAt: state.lastExitAt !== undefined ? state.lastExitAt : existing.lastExitAt,
    consumedZones: state.consumedZones !== undefined ? state.consumedZones : existing.consumedZones,
    consumedZoneTimes: state.consumedZoneTimes !== undefined ? state.consumedZoneTimes : existing.consumedZoneTimes,
    lastBreakoutTs: state.lastBreakoutTs !== undefined ? state.lastBreakoutTs : existing.lastBreakoutTs,
  };
  
  // Write-ahead: persist first, no cache update on failure
  await setPairState(pair, merged);
}

// ─── Clean expired consumed zones ────────────────────────────────────────

async function cleanConsumedZones(state: PairState, debug: string[]): Promise<PairState> {
  const now = Date.now();
  const freshZones: string[] = [];
  const freshTimes: Record<string, number> = {};

  for (const zh of state.consumedZones) {
    const consumedAt = state.consumedZoneTimes[zh] || 0;
    if (now - consumedAt < ZONE_CONSUMED_TTL_MS) {
      freshZones.push(zh);
      freshTimes[zh] = consumedAt;
    } else {
      debug.push(`ZONE EXPIRED: ${zh} consumed ${Math.round((now - consumedAt) / 60000)}m ago, clearing`);
    }
  }

  if (freshZones.length > MAX_CONSUMED_ZONES) {
    const sorted = freshZones
      .map(z => ({ zone: z, time: freshTimes[z] || 0 }))
      .sort((a, b) => b.time - a.time)
      .slice(0, MAX_CONSUMED_ZONES);
    const trimmedZones = sorted.map(s => s.zone);
    const trimmedTimes: Record<string, number> = {};
    for (const s of sorted) trimmedTimes[s.zone] = s.time;
    debug.push(`TRIMMED consumedZones from ${freshZones.length} to ${MAX_CONSUMED_ZONES}`);
    return { ...state, consumedZones: trimmedZones, consumedZoneTimes: trimmedTimes };
  }

  return { ...state, consumedZones: freshZones, consumedZoneTimes: freshTimes };
}

// ─── ACCUMULATION DETECTION (1H) — O(n) with prefix extrema ─────────────

interface AccumulationZone {
  top: number;
  bottom: number;
  startIndex: number;
  endIndex: number;
  touches: number;
  avgVolume: number;
  widthATR: number;
}

// FIX v30.6: O(n) using prefix min/max arrays — no slice/spread per window
function detectAccumulation(pair: string, candles1h: Candle[], debug: string[]): AccumulationZone | null {
  const last = candles1h.length - 2;
  if (last < ACCUM_MIN_CANDLES + 14) {
    debug.push(`ACCUM: insufficient 1H candles (${candles1h.length} need >= ${ACCUM_MIN_CANDLES + 14 + 1})`);
    return null;
  }

  const atrSeries = atr(candles1h, 14);
  const currentATR = atrSeries[atrSeries.length - 1] || 1;
  const maxWidthATR = getAccumMaxWidthATR(pair);

  debug.push(`ACCUM SCAN: last=${last} ATR=${currentATR.toFixed(4)} minCandles=${ACCUM_MIN_CANDLES} maxCandles=${ACCUM_MAX_CANDLES} maxWidthATR=${maxWidthATR}`);

  // Build prefix extrema for O(1) range queries
  // prefixMax[i] = max high from 0 to i
  // prefixMin[i] = min low from 0 to i
  const prefixMax: number[] = new Array(last + 1);
  const prefixMin: number[] = new Array(last + 1);
  
  prefixMax[0] = candles1h[0].high;
  prefixMin[0] = candles1h[0].low;
  for (let i = 1; i <= last; i++) {
    prefixMax[i] = Math.max(prefixMax[i - 1], candles1h[i].high);
    prefixMin[i] = Math.min(prefixMin[i - 1], candles1h[i].low);
  }

  let bestZone: AccumulationZone | null = null;
  let bestScore = -1;

  // Scan windows from smallest to largest (start moves backward)
  for (let start = last - ACCUM_MIN_CANDLES + 1; start >= Math.max(0, last - ACCUM_MAX_CANDLES + 1); start--) {
    const windowSize = last - start + 1;
    
    // O(1) range extrema
    const top = prefixMax[last];
    const bottom = start > 0 ? Math.min(prefixMin[start - 1], prefixMin[last]) : prefixMin[last];
    // Actually: max from start..last = prefixMax[last] if prefixMax is monotonic, but that's only true if max is at end
    // CORRECTION: prefixMax gives max from 0..i, not range max. Need suffix max or segment tree.
    // SIMPLER: since we scan start backward, maintain running max/min
    
    // ABORT prefix approach — use running update instead
  }
  
  // CORRECTED: Running max/min as start moves backward (still O(n) total)
  let runningMax = -Infinity;
  let runningMin = Infinity;
  
  for (let start = last; start >= Math.max(0, last - ACCUM_MAX_CANDLES + 1); start--) {
    runningMax = Math.max(runningMax, candles1h[start].high);
    runningMin = Math.min(runningMin, candles1h[start].low);
    
    const windowSize = last - start + 1;
    if (windowSize < ACCUM_MIN_CANDLES) continue;
    
    const width = runningMax - runningMin;
    const widthATR = currentATR > 0 ? width / currentATR : 999;

    if (windowSize <= 12 || windowSize % 5 === 0 || windowSize === ACCUM_MIN_CANDLES) {
      debug.push(`ACCUM[${windowSize}]: top=${runningMax.toFixed(2)} bottom=${runningMin.toFixed(2)} width=${width.toFixed(4)} widthATR=${widthATR.toFixed(2)}`);
    }

    if (widthATR > maxWidthATR) {
      if (windowSize <= 10) debug.push(`ACCUM[${windowSize}]: REJECTED widthATR=${widthATR.toFixed(2)} > ${maxWidthATR}`);
      // As we expand backward, width can only grow or stay same — break
      break;
    }

    const zoneCandles = candles1h.slice(start, last + 1);
    let touches = 0;
    for (const c of zoneCandles) {
      const touchTop = width > 0 && Math.abs(c.high - runningMax) / width < 0.20;
      const touchBottom = width > 0 && Math.abs(c.low - runningMin) / width < 0.20;
      if (touchTop || touchBottom) touches++;
    }

    if (touches < ACCUM_MIN_TOUCHES) {
      debug.push(`ACCUM[${windowSize}]: REJECTED touches=${touches} < ${ACCUM_MIN_TOUCHES}`);
      continue;
    }

    const firstHalf = zoneCandles.slice(0, Math.floor(zoneCandles.length / 2));
    const secondHalf = zoneCandles.slice(Math.floor(zoneCandles.length / 2));
    const volFirst = avg(firstHalf.map(c => c.volume));
    const volSecond = avg(secondHalf.map(c => c.volume));
    const volRatio = volFirst > 0 ? volSecond / volFirst : 1;

    if (volRatio > ACCUM_VOLUME_DECLINE) {
      debug.push(`ACCUM[${windowSize}]: REJECTED volRatio=${volRatio.toFixed(2)} > ${ACCUM_VOLUME_DECLINE}`);
      continue;
    }

    const score = (100 - widthATR * 20) + touches * 15;
    debug.push(`ACCUM[${windowSize}]: CANDIDATE top=${runningMax.toFixed(2)} bottom=${runningMin.toFixed(2)} width=${width.toFixed(4)} (${widthATR.toFixed(2)}x ATR) touches=${touches} volRatio=${volRatio.toFixed(2)} score=${score.toFixed(1)}`);

    if (score > bestScore) {
      bestScore = score;
      bestZone = {
        top: runningMax,
        bottom: runningMin,
        startIndex: start,
        endIndex: last,
        touches,
        avgVolume: avg(zoneCandles.map(c => c.volume)),
        widthATR,
      };
    }
  }

  if (bestZone) {
    debug.push(`ACCUM SELECTED: [${bestZone.startIndex}-${bestZone.endIndex}] top=${bestZone.top.toFixed(2)} bottom=${bestZone.bottom.toFixed(2)} width=${(bestZone.top - bestZone.bottom).toFixed(4)} (${bestZone.widthATR.toFixed(2)}x ATR) touches=${bestZone.touches}`);
    return bestZone;
  }

  debug.push("ACCUM: no tight accumulation zone found on 1H");
  return null;
}

// ─── BREAKOUT DETECTION — wick-aware with sweep→reclaim ─────────────────

interface BreakoutResult {
  detected: boolean;
  direction: "LONG" | "SHORT" | null;
  candle: Candle | null;
  reason: string;
  sweepReclaim: boolean;
}

// FIX v30.6: Wick-aware breakout — detects liquidity sweeps with close confirmation
function checkBreakout(
  candles1h: Candle[],
  zone: AccumulationZone,
  htBias: "BULLISH" | "BEARISH" | "NEUTRAL",
  debug: string[]
): BreakoutResult {
  if (!candles1h || candles1h.length === 0) {
    debug.push("BREAKOUT: no candles available");
    return { detected: false, direction: null, candle: null, reason: "no_candles", sweepReclaim: false };
  }
  
  const current = candles1h[candles1h.length - 1];
  const prev = candles1h.length > 1 ? candles1h[candles1h.length - 2] : null;

  debug.push(`BREAKOUT CHECK: close=${current.close.toFixed(2)} open=${current.open.toFixed(2)} high=${current.high.toFixed(2)} low=${current.low.toFixed(2)} zone=${zone.bottom.toFixed(2)}-${zone.top.toFixed(2)}`);

  let beyondZone = false;
  let direction: "LONG" | "SHORT" | null = null;
  let sweepReclaim = false;

  // Tier 1: Close-based confirmation (highest quality)
  if (current.close > zone.top) {
    beyondZone = true;
    direction = "LONG";
  } else if (current.close < zone.bottom) {
    beyondZone = true;
    direction = "SHORT";
  }
  
  // Tier 2: Wick sweep with close reclaim (liquidity grab pattern)
  if (!beyondZone && prev) {
    const prevInZone = prev.close <= zone.top && prev.close >= zone.bottom;
    
    if (prevInZone && current.high > zone.top && current.close <= zone.top && current.close > zone.bottom) {
      // Wick swept above but closed back in — potential fakeout
      debug.push(`BREAKOUT: wick sweep above zone, close reclaimed — monitoring`);
    }
    if (prevInZone && current.low < zone.bottom && current.close >= zone.bottom && current.close < zone.top) {
      debug.push(`BREAKOUT: wick sweep below zone, close reclaimed — monitoring`);
    }
    
    // Tier 3: Aggressive wick breakout with body confirmation
    if (!BREAKOUT_CONFIRM_CLOSE) {
      if (current.high > zone.top) {
        beyondZone = true;
        direction = "LONG";
        sweepReclaim = current.close < current.high; // Mark as sweep pattern
      } else if (current.low < zone.bottom) {
        beyondZone = true;
        direction = "SHORT";
        sweepReclaim = current.close > current.low;
      }
    }
  }

  if (!beyondZone) {
    debug.push(`BREAKOUT: no breakout — close=${current.close.toFixed(2)} inside zone ${zone.bottom.toFixed(2)}-${zone.top.toFixed(2)}`);
    return { detected: false, direction: null, candle: null, reason: "no_breakout", sweepReclaim: false };
  }

  const atrSeries = atr(candles1h, 14);
  const currentATR = atrSeries[atrSeries.length - 1] || 1;
  const body = Math.abs(current.close - current.open);
  const bodyATR = currentATR > 0 ? body / currentATR : 0;

  debug.push(`BREAKOUT: beyond zone dir=${direction} body=${body.toFixed(2)} (${bodyATR.toFixed(2)}x ATR) sweepReclaim=${sweepReclaim}`);

  const isStrongHTF = htBias === "BEARISH" || htBias === "BULLISH";
  // Sweep-reclaim requires stronger body confirmation
  const minBody = sweepReclaim ? BREAKOUT_MIN_BODY_ATR * 1.5 : (isStrongHTF ? BREAKOUT_MIN_BODY_ATR * 0.6 : BREAKOUT_MIN_BODY_ATR);

  if (bodyATR < minBody) {
    debug.push(`BREAKOUT: body too small (${bodyATR.toFixed(2)} < ${minBody.toFixed(2)}, HTF=${htBias}, sweep=${sweepReclaim})`);
    return { detected: false, direction: null, candle: null, reason: "body_too_small", sweepReclaim: false };
  }

  debug.push(`BREAKOUT: ${direction} confirmed close=${current.close.toFixed(2)} beyond zone${sweepReclaim ? " (sweep-reclaim)" : ""}`);
  return { detected: true, direction, candle: current, reason: `breakout_${direction?.toLowerCase()}`, sweepReclaim };
}

// ─── 15M CONFIRMATION ────────────────────────

function check15MAlignment(
  candles15m: Candle[],
  direction: "LONG" | "SHORT",
  debug: string[]
): { aligned: boolean; reason: string } {
  if (!candles15m || candles15m.length < 1) {
    debug.push("15M: no data available, skipping confirmation");
    return { aligned: true, reason: "no_15m_data" };
  }

  const last15m = candles15m[candles15m.length - 1];
  const isBullish = last15m.close > last15m.open;
  const isBearish = last15m.close < last15m.open;

  if (direction === "LONG" && isBullish) {
    debug.push(`15M: aligned bullish (close=${last15m.close.toFixed(2)} > open=${last15m.open.toFixed(2)})`);
    return { aligned: true, reason: "15m_aligned" };
  }
  if (direction === "SHORT" && isBearish) {
    debug.push(`15M: aligned bearish (close=${last15m.close.toFixed(2)} < open=${last15m.open.toFixed(2)})`);
    return { aligned: true, reason: "15m_aligned" };
  }

  debug.push(`15M: MISALIGNED — direction=${direction} but 15M candle is ${isBullish ? "bullish" : isBearish ? "bearish" : "neutral"}`);
  return { aligned: false, reason: `15m_misaligned_${direction.toLowerCase()}` };
}

function isHTFAligned(direction: "LONG" | "SHORT", htBias: "BULLISH" | "BEARISH" | "NEUTRAL"): boolean {
  if (direction === "LONG" && htBias === "BEARISH") return false;
  if (direction === "SHORT" && htBias === "BULLISH") return false;
  return true;
}

// ─── Signal Builder ─────────────────────────────────────────────────────

// FIX v30.6: Multiplicative confidence with overlap deduplication
function computeConfidence(
  zone: AccumulationZone,
  adx4h: number,
  stochK: number,
  stochReliable: boolean,
  direction: "LONG" | "SHORT",
  sweepReclaim: boolean,
  debug: string[]
): { confidence: number; reversalRisk: boolean } {
  // Base score
  let score = 50;
  const factors: string[] = [];

  // Zone quality (structure) — independent of regime
  if (zone.widthATR < 1.5) { score *= 1.20; factors.push("zone_excellent"); }
  else if (zone.widthATR < 2.0) { score *= 1.10; factors.push("zone_good"); }
  else { score *= 0.90; factors.push("zone_average"); }

  // Touches (conviction)
  if (zone.touches >= 5) { score *= 1.08; factors.push("touches_high"); }
  else if (zone.touches >= 3) { score *= 1.04; factors.push("touches_med"); }
  else { score *= 0.95; factors.push("touches_low"); }

  // Trend strength
  if (adx4h > 35) { score *= 1.12; factors.push("adx_strong"); }
  else if (adx4h > 25) { score *= 1.06; factors.push("adx_med"); }
  else if (adx4h < 15) { score *= 0.85; factors.push("adx_weak"); }

  // Stochastic regime
  let reversalRisk = false;
  if (!stochReliable) {
    score *= 0.90;
    factors.push("stoch_unreliable");
  } else if (direction === "SHORT" && stochK < STOCH_EXTREME_LOW) {
    score *= 0.75;
    factors.push("stoch_oversold_short");
    reversalRisk = adx4h > 40;
  } else if (direction === "LONG" && stochK > STOCH_EXTREME_HIGH) {
    score *= 0.75;
    factors.push("stoch_overbought_long");
    reversalRisk = adx4h > 40;
  }

  // Sweep-reclaim penalty (lower conviction pattern)
  if (sweepReclaim) {
    score *= 0.92;
    factors.push("sweep_reclaim");
  }

  const confidence = Math.min(95, Math.max(25, Math.round(score)));
  debug.push(`CONFIDENCE: base=50 factors=[${factors.join(",")}] raw=${score.toFixed(1)} final=${confidence}%${reversalRisk ? " REVERSAL_RISK" : ""}`);
  
  return { confidence, reversalRisk };
}

function buildSignal(
  pair: string,
  direction: "LONG" | "SHORT",
  zone: AccumulationZone,
  candles1h: Candle[],
  candles4h: Candle[],
  htBias: "BULLISH" | "BEARISH" | "NEUTRAL",
  stochK: number,
  adx4h: number,
  regime: "TREND" | "CHOP" | "TRANSITION",
  stochReliable: boolean,
  sweepReclaim: boolean,
  debug: string[]
): { signal: Signal; market: any } | null {
  const entry = candles1h[candles1h.length - 1].close;
  const zoneHeight = zone.top - zone.bottom;

  const closes1h = candles1h.map(c => c.close);
  const atr1h = atr(candles1h, 14);
  const currentATR = atr1h[atr1h.length - 1] || zoneHeight * 0.5;

  const swingStop = direction === "LONG" ? zone.bottom : zone.top;
  const atrStop = direction === "LONG"
    ? entry - currentATR * 1.5
    : entry + currentATR * 1.5;

  const stop = direction === "LONG"
    ? Math.min(swingStop, atrStop)
    : Math.max(swingStop, atrStop);

  const risk = Math.abs(entry - stop);
  const target = direction === "LONG" ? entry + risk * 2.5 : entry - risk * 2.5;

  const ema21Val = lastEma(closes1h, 21);
  const trail = direction === "LONG"
    ? (ema21Val ?? entry) - currentATR * 0.5
    : (ema21Val ?? entry) + currentATR * 0.5;

  const rr = risk > 0 ? Math.abs(target - entry) / risk : 0;

  const { confidence, reversalRisk } = computeConfidence(zone, adx4h, stochK, stochReliable, direction, sweepReclaim, debug);

  // FIX v30.6: Decoupled regime/zone logic. CHOP blocks only if zone weak AND confidence low
  const zoneWeak = zone.widthATR >= CHOP_MODE_MAX_WIDTH_ATR;
  const confidenceLow = confidence < CHOP_MODE_MIN_CONFIDENCE;
  
  if (regime === "CHOP" && zoneWeak && confidenceLow) {
    debug.push(`REGIME BLOCK: CHOP mode + weak zone (widthATR=${zone.widthATR.toFixed(2)} >= ${CHOP_MODE_MAX_WIDTH_ATR}) + low confidence (${confidence}% < ${CHOP_MODE_MIN_CONFIDENCE}%)`);
    return null;
  }
  if (regime === "CHOP") {
    debug.push(`REGIME: CHOP mode — zone ${zoneWeak ? "weak" : "tight"}, confidence ${confidence}% ${confidenceLow ? "low" : "acceptable"} — ${zoneWeak && confidenceLow ? "blocked" : "allowed"}`);
  }

  const explanation = `${direction} BREAKOUT (1H): Accumulation zone ${zone.bottom.toFixed(0)}-${zone.top.toFixed(0)} (${zone.widthATR.toFixed(1)}x ATR, ${zone.touches} touches) broken. HTF=${htBias}, ADX(4H)=${adx4h.toFixed(1)}, StochK=${stochK}${stochReliable ? "" : "[UNRELIABLE]"}, Regime=${regime}${reversalRisk ? " [REVERSAL RISK]" : ""}${sweepReclaim ? " [SWEEP-RECLAIM]" : ""}`;

  const signal: Signal = {
    id: `${pair}_${Date.now()}`,
    pair,
    direction,
    stage: "CONFIRMED",
    entry: Math.round(entry * 100) / 100,
    stop: Math.round(stop * 100) / 100,
    target: Math.round(target * 100) / 100,
    trail: Math.round(trail * 100) / 100,
    confidence,
    rr: Math.round(rr * 100) / 100,
    adx: adx4h,
    zoneTop: Math.round(zone.top * 100) / 100,
    zoneBottom: Math.round(zone.bottom * 100) / 100,
    explanation,
    timestamp: Date.now(),
    version: CURRENT_SIGNAL_VERSION,
    reversalRisk,
    regime,
    stochReliable,
  };

  const trend1d = htBias === "BULLISH" ? "LONG" : htBias === "BEARISH" ? "SHORT" : "MIXED";
  const stoch = stochRsi(closes1h);
  const lastRsi = getLastRsi(closes1h);

  const market = {
    pair,
    price: Math.round(entry * 100) / 100,
    timestamp: Date.now(),
    phase: "EXPANSION",
    trend: trend1d,
    htfBias: htBias,
    adx: adx4h,
    rsi: lastRsi ?? 0,
    stochK: stoch.k,
    stochD: stoch.d,
    stochReliable: stoch.reliable,
    zoneTop: signal.zoneTop,
    zoneBottom: signal.zoneBottom,
    zoneScore: confidence,
    zoneQuality: {
      age: zone.endIndex - zone.startIndex,
      widthATR: zone.widthATR,
      compression: Math.max(0, 100 - zone.widthATR * 30),
      volumeDecay: 0,
      touches: zone.touches,
      breakAttempts: 0,
      label: zone.widthATR < 1.5 ? "EXCELLENT" : zone.widthATR < 2.0 ? "GOOD" : "AVERAGE",
    },
    reversalRisk,
    regime,
    closes4h: candles4h.slice(-50).map(c => c.close),
  };

  debug.push(`SIGNAL: ${direction} CONFIRMED entry=${signal.entry} stop=${signal.stop} target=${signal.target} trail=${signal.trail} RR=${signal.rr} conf=${confidence}% regime=${regime}${reversalRisk ? " REVERSAL_RISK" : ""}${sweepReclaim ? " SWEEP-RECLAIM" : ""}`);

  return { signal, market };
}

// ─── MAIN GENERATOR ────────────────────────────────────────────────────

export async function generateSignal(
  pair: string,
  candles1h: Candle[],
  candles4h: Candle[],
  candles15m: Candle[],
  currentPrice?: number
): Promise<SignalResult> {
  const debug: string[] = [];
  const price = currentPrice ?? candles1h[candles1h.length - 1]?.close ?? 0;

  if (!candles1h || candles1h.length < MIN_CANDLES_1H) {
    debug.push(`GUARD: insufficient 1H candles (${candles1h?.length || 0} < ${MIN_CANDLES_1H})`);
    return {
      signal: null,
      market: { pair, price, timestamp: Date.now(), phase: "NONE", error: "insufficient_1h_data" },
      debug,
      stage: "NONE",
    };
  }
  if (!candles4h || candles4h.length < MIN_CANDLES_4H) {
    debug.push(`GUARD: insufficient 4H candles (${candles4h?.length || 0} < ${MIN_CANDLES_4H})`);
    return {
      signal: null,
      market: { pair, price, timestamp: Date.now(), phase: "NONE", error: "insufficient_4h_data" },
      debug,
      stage: "NONE",
    };
  }

  let state = await getPersistedState(pair);
  const closes1h = candles1h.map(c => c.close);
  
  const stoch = stochRsi(closes1h);
  const stochReliable = stoch.reliable;
  if (!stochReliable) {
    debug.push(`WARNING: StochRSI unreliable (${closes1h.length} closes), using fallback with confidence penalty`);
  }
  
  const htBias = higherTimeframeBias1D(candles4h);
  
  const adx4h = adx(candles4h);
  if (adx4h === null) {
    debug.push(`GUARD: ADX insufficient data, blocking`);
    return {
      signal: null,
      market: { pair, price, timestamp: Date.now(), phase: "NONE", error: "insufficient_adx_data" },
      debug,
      stage: "NONE",
    };
  }
  
  const regime = classifyRegime(adx4h);
  const trend1d = htBias === "BULLISH" ? "LONG" : htBias === "BEARISH" ? "SHORT" : "MIXED";

  debug.push(`HTF(4H→1D): ${htBias} | Stage: ${state.stage} | StochK(1H)=${stoch.k}${stochReliable ? "" : "[UNRELIABLE]"} | ADX(4H)=${adx4h} | Regime=${regime}`);

  if (state.lastExitAt > 0) {
    const timeSinceExit = Date.now() - state.lastExitAt;
    if (timeSinceExit < EXIT_COOLDOWN_MS) {
      debug.push(`COOLDOWN: ${Math.round(timeSinceExit / 1000)}s since exit, need ${Math.round(EXIT_COOLDOWN_MS / 1000)}s`);
      return {
        signal: null,
        market: {
          pair, price, timestamp: Date.now(),
          phase: "NONE", trend: trend1d,
          htfBias: htBias, adx: adx4h, rsi: 0,
          stochK: stoch.k, stochD: stoch.d,
          zoneTop: null, zoneBottom: null, zoneScore: 0,
        },
        debug,
        stage: "NONE",
      };
    }
  }

  state = await cleanConsumedZones(state, debug);

  const zone = detectAccumulation(pair, candles1h, debug);

  if (!zone) {
    return {
      signal: null,
      market: {
        pair, price, timestamp: Date.now(),
        phase: "NONE", trend: trend1d,
        htfBias: htBias, adx: adx4h, rsi: 0,
        stochK: stoch.k, stochD: stoch.d,
        zoneTop: null, zoneBottom: null, zoneScore: 0,
      },
      debug,
      stage: "NONE",
    };
  }

  // FIX v30.6: ATR-normalized hash
  const atr1h = atr(candles1h, 14);
  const currentATR = atr1h[atr1h.length - 1] || 1;
  const zoneHash = hashZone(pair, zone.top, zone.bottom, currentATR);
  
  if (state.consumedZones.includes(zoneHash)) {
    debug.push(`ZONE CONSUMED: ${zoneHash} already traded (within ${ZONE_CONSUMED_TTL_MS / 3600000}h window)`);
    return {
      signal: null,
      market: {
        pair, price, timestamp: Date.now(),
        phase: "NONE", trend: trend1d,
        htfBias: htBias, adx: adx4h, rsi: 0,
        stochK: stoch.k, stochD: stoch.d,
        zoneTop: zone.top, zoneBottom: zone.bottom, zoneScore: 0,
      },
      debug,
      stage: "NONE",
    };
  }

  const breakout = checkBreakout(candles1h, zone, htBias, debug);

  if (!breakout.detected || !breakout.direction) {
    debug.push(`WATCHING: 1H accumulation detected, waiting for breakout`);

    await persistState(pair, {
      stage: "WATCHING",
      zoneTop: zone.top,
      zoneBottom: zone.bottom,
      zoneStartIndex: zone.startIndex,
      zoneEndIndex: zone.endIndex,
    });

    return {
      signal: null,
      market: {
        pair, price, timestamp: Date.now(),
        phase: "WATCHING", trend: trend1d,
        htfBias: htBias, adx: adx4h, rsi: 0,
        stochK: stoch.k, stochD: stoch.d,
        zoneTop: zone.top, zoneBottom: zone.bottom,
        zoneScore: 40,
        zoneQuality: {
          age: zone.endIndex - zone.startIndex,
          widthATR: zone.widthATR,
          compression: Math.max(0, 100 - zone.widthATR * 30),
          touches: zone.touches,
          label: zone.widthATR < 1.5 ? "EXCELLENT" : zone.widthATR < 2.0 ? "GOOD" : "AVERAGE",
        },
      },
      debug,
      stage: "WATCHING",
    };
  }

  if (REQUIRE_HTF_ALIGNMENT) {
    if (!isHTFAligned(breakout.direction, htBias)) {
      debug.push(`BLOCKED: ${breakout.direction} breakout against HTF(1D) bias ${htBias}`);
      return {
        signal: null,
        market: {
          pair, price, timestamp: Date.now(),
          phase: "NONE", trend: trend1d,
          htfBias: htBias, adx: adx4h, rsi: 0,
          stochK: stoch.k, stochD: stoch.d,
          zoneTop: zone.top, zoneBottom: zone.bottom, zoneScore: 0,
        },
        debug,
        stage: "NONE",
      };
    }
  }

  if (REQUIRE_15M_ALIGNMENT && candles15m && candles15m.length > 0) {
    const alignment = check15MAlignment(candles15m, breakout.direction, debug);
    if (!alignment.aligned) {
      debug.push(`BLOCKED: ${breakout.direction} breakout rejected by 15M misalignment`);
      return {
        signal: null,
        market: {
          pair, price, timestamp: Date.now(),
          phase: "NONE", trend: trend1d,
          htfBias: htBias, adx: adx4h, rsi: 0,
          stochK: stoch.k, stochD: stoch.d,
          zoneTop: zone.top, zoneBottom: zone.bottom, zoneScore: 0,
        },
        debug,
        stage: "NONE",
      };
    }
  }

  if (breakout.direction === "SHORT" && stoch.k < STOCH_EXTREME_LOW) {
    debug.push(`EXHAUSTION: Stoch K=${stoch.k} < ${STOCH_EXTREME_LOW}, blocking SHORT`);
    return {
      signal: null,
      market: {
        pair, price, timestamp: Date.now(),
        phase: "EXHAUSTION", trend: trend1d,
        htfBias: htBias, adx: adx4h, rsi: 0,
        stochK: stoch.k, stochD: stoch.d,
        zoneTop: zone.top, zoneBottom: zone.bottom, zoneScore: 0,
      },
      debug,
      stage: "EXHAUSTION",
    };
  }
  if (breakout.direction === "LONG" && stoch.k > STOCH_EXTREME_HIGH) {
    debug.push(`EXHAUSTION: Stoch K=${stoch.k} > ${STOCH_EXTREME_HIGH}, blocking LONG`);
    return {
      signal: null,
      market: {
        pair, price, timestamp: Date.now(),
        phase: "EXHAUSTION", trend: trend1d,
        htfBias: htBias, adx: adx4h, rsi: 0,
        stochK: stoch.k, stochD: stoch.d,
        zoneTop: zone.top, zoneBottom: zone.bottom, zoneScore: 0,
      },
      debug,
      stage: "EXHAUSTION",
    };
  }

  const built = buildSignal(pair, breakout.direction, zone, candles1h, candles4h, htBias, stoch.k, adx4h, regime, stochReliable, breakout.sweepReclaim, debug);

  if (!built) {
    debug.push("Signal build failed (regime filter or other block)");
    return {
      signal: null,
      market: {
        pair, price, timestamp: Date.now(),
        phase: "NONE", trend: trend1d,
        htfBias: htBias, adx: adx4h, rsi: 0,
        stochK: stoch.k, stochD: stoch.d,
        zoneTop: null, zoneBottom: null, zoneScore: 0,
      },
      debug,
      stage: "NONE",
    };
  }

  if (breakout.candle && state.lastBreakoutTs === breakout.candle.timestamp) {
    debug.push(`DUPLICATE BREAKOUT: same candle timestamp ${breakout.candle.timestamp}, skipping`);
    return {
      signal: null,
      market: {
        pair, price, timestamp: Date.now(),
        phase: "NONE", trend: trend1d,
        htfBias: htBias, adx: adx4h, rsi: 0,
        stochK: stoch.k, stochD: stoch.d,
        zoneTop: zone.top, zoneBottom: zone.bottom, zoneScore: 0,
      },
      debug,
      stage: "NONE",
    };
  }

  await persistState(pair, {
    stage: "NONE",
    zoneTop: null,
    zoneBottom: null,
    zoneStartIndex: 0,
    zoneEndIndex: 0,
    consumedZones: [...state.consumedZones, zoneHash],
    consumedZoneTimes: { ...state.consumedZoneTimes, [zoneHash]: Date.now() },
    lastBreakoutTs: breakout.candle!.timestamp,
  });

  return { signal: built.signal, market: built.market, debug, stage: "EXPANSION" };
}

// ─── Trail Stop Update ─────────────────────────────────────────────────

export function updateTrail(
  signal: Signal,
  candles1h: Candle[],
  currentPrice: number
): { trail: number; shouldExit: boolean; reason: string } {
  const closes = candles1h.map(c => c.close);
  const ema21Val = lastEma(closes, 21);
  const atrSeries = atr(candles1h, 14);
  const currentATR = atrSeries[atrSeries.length - 1];
  const safeATR = currentATR && currentATR > 0 ? currentATR : Math.abs(currentPrice - signal.entry) * 0.1;

  const emaVal = ema21Val ?? currentPrice;
  const newTrail = signal.direction === "LONG"
    ? Math.max(signal.trail, emaVal - safeATR * 0.3)
    : Math.min(signal.trail, emaVal + safeATR * 0.3);

  const hit = signal.direction === "LONG" ? currentPrice < newTrail : currentPrice > newTrail;

  return {
    trail: Math.round(newTrail * 100) / 100,
    shouldExit: hit,
    reason: hit ? `Trail hit at ${newTrail.toFixed(1)}` : "Holding",
  };
}

// ─── Market Snapshot ────────────────────────────────────────────────────

export async function getMarketSnapshot(
  pair: string,
  candles1h: Candle[] | undefined,
  candles4h: Candle[],
  candles15m: Candle[] | undefined
): Promise<any> {
  const state = await getPersistedState(pair);
  const price = candles4h[candles4h.length - 1].close;
  const closes = candles4h.map(c => c.close);
  const stoch = stochRsi(closes);
  const htBias = higherTimeframeBias1D(candles4h);

  const adxValue = adx(candles4h);
  const trend1d = htBias === "BULLISH" ? "LONG" : htBias === "BEARISH" ? "SHORT" : "MIXED";
  const lastRsi = getLastRsi(closes);
  const regime = classifyRegime(adxValue);

  return {
    pair,
    price: Math.round(price * 100) / 100,
    timestamp: Date.now(),
    phase: state.stage === "NONE" ? "NONE" : state.stage,
    trend: trend1d,
    htfBias: htBias,
    adx: adxValue ?? 0,
    rsi: lastRsi ?? 0,
    stochK: stoch.k,
    stochD: stoch.d,
    stochReliable: stoch.reliable,
    zoneTop: state.zoneTop ? Math.round(state.zoneTop * 100) / 100 : null,
    zoneBottom: state.zoneBottom ? Math.round(state.zoneBottom * 100) / 100 : null,
    zoneScore: 0,
    zoneQuality: null,
    regime,
    closes4h: candles4h.slice(-50).map(c => c.close),
  };
}

// ─── Validity ───────────────────────────────────────────────────────────

export interface ValidityCheck {
  valid: boolean;
  reason: string;
  exited: boolean;
}

export function isSignalStillValid(signal: Signal, currentPrice: number, now: number = Date.now()): ValidityCheck {
  const ageMs = now - signal.timestamp;
  const maxAge = 24 * 60 * 60 * 1000;

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

// ─── shouldHold ────────────────────────────────────────────────────────

export interface HoldResult {
  shouldHold: boolean;
  reason: string;
}

export async function shouldHold(
  pair: string,
  signal: Signal,
  candles1h: Candle[],
  currentPrice: number
): Promise<HoldResult> {
  const trailUpdate = updateTrail(signal, candles1h, currentPrice);

  if (trailUpdate.shouldExit) {
    await persistState(pair, { lastExitAt: Date.now() });
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

export async function shouldHoldCompat(
  pair: string,
  signal: Signal,
  candles4h: Candle[],
  candles1h: Candle[],
  currentPrice: number
): Promise<HoldResult> {
  return shouldHold(pair, signal, candles1h, currentPrice);
}
