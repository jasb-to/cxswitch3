// app/api/cron/route.ts — v29.3 "Full Debug + Timeframe Alignment"
// ============================================================

import { NextResponse } from "next/server";

// ─── Types ──────────────────────────────────────────────────────────────

interface Candle {
  timestamp: number;
  open: number;
  high: number;
  low: number;
  close: number;
  volume: number;
}

interface Signal {
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

interface ZoneQuality {
  age: number;
  widthATR: number;
  compression: number;
  volumeDecay: number;
  touches: number;
  breakAttempts: number;
  label: "EXCELLENT" | "GOOD" | "AVERAGE" | "WEAK";
}

interface MarketData {
  pair: string;
  price: number;
  timestamp: number;
  phase: "NONE" | "WATCHING" | "ACCUMULATION" | "READY" | "CONFIRMED" | "EXPANSION" | "EXHAUSTION";
  trend: string;
  htfBias?: "BULLISH" | "BEARISH" | "NEUTRAL";
  adx: number;
  rsi: number;
  stochK: number;
  stochD: number;
  zoneTop: number | null;
  zoneBottom: number | null;
  zoneScore: number;
  zoneQuality?: ZoneQuality;
  closes4h?: number[];
}

interface ImpulseResult {
  detected: boolean;
  direction: "LONG" | "SHORT" | null;
  strength: number;
  volumeRatio: number;
  rangeATR: number;
  prevRangeATR: number;
  candleIndex: number;
  reason: string;
}

// ─── Config ─────────────────────────────────────────────────────────────

const PAIRS = ["BTC", "ETH", "SOL", "HYPE"] as const;
const MIN_CRON_INTERVAL_MS = 10 * 60 * 1000;
const SIGNAL_TTL_MS = 24 * 60 * 60 * 1000;

// Impulse detection thresholds (TUNABLE)
const IMPULSE_VOLUME_THRESHOLD = 1.5;      // 1.5x avg volume
const IMPULSE_RANGE_THRESHOLD = 1.2;       // 1.2x ATR
const IMPULSE_STRENGTH_MIN = 0.3;          // composite strength

// Timeframe alignment (NEW v29.3)
const REQUIRE_HTF_ALIGNMENT = true;          // 4H trend must agree with 1D bias
const HTF_ALIGNMENT_TOLERANCE = 0.02;      // 2% tolerance for "close enough"

// ─── Redis / KV State (placeholder — replace with your actual impl) ─────

// NOTE: Replace these with your actual @/lib/state imports
// For this standalone version, we use in-memory fallbacks

let _signals: Signal[] = [];
let _marketData: Record<string, MarketData> = {};
let _activeTrades: Record<string, any> = {};
let _lastCronRun = 0;
let _cronLogs: any[] = [];

async function getSignals(): Promise<Signal[]> { return _signals; }
async function setSignals(s: Signal[]) { _signals = s; }
async function getMarketDataKV(): Promise<Record<string, MarketData>> { return _marketData; }
async function setMarketData(m: MarketData[]) {
  for (const d of m) _marketData[d.pair] = d;
}
async function getActiveTrades(): Promise<Record<string, any>> { return _activeTrades; }
async function setActiveTrades(t: Record<string, any>) { _activeTrades = t; }
async function getLastCronRun(): Promise<number> { return _lastCronRun; }
async function setLastCronRun(t: number) { _lastCronRun = t; }
async function getCronLogs(): Promise<any[]> { return _cronLogs; }
async function setCronLogs(l: any[]) { _cronLogs = l; }
async function addSignalToHistory(s: Signal, reason: string, price: number) {
  console.log(`[HISTORY] ${s.pair} exited: ${reason} at ${price}`);
}

// ─── Kraken API ─────────────────────────────────────────────────────────

const KRAKEN_PAIRS: Record<string, string> = {
  BTC: "XBTUSD",
  ETH: "ETHUSD",
  SOL: "SOLUSD",
  HYPE: "HYPEUSD",
};

async function getCandles(pair: string, interval: number): Promise<Candle[]> {
  const kp = KRAKEN_PAIRS[pair] || pair + "USD";
  const res = await fetch(
    `https://api.kraken.com/0/public/OHLC?pair=${kp}&interval=${interval}`,
    { cache: "no-store" }
  );
  const data = await res.json();
  if (data.error?.length) throw new Error(data.error[0]);
  const key = Object.keys(data.result).find((k) => k !== "last")!;
  const raw = data.result[key];
  return raw.map((r: any[]) => ({
    timestamp: r[0] * 1000,
    open: parseFloat(r[1]),
    high: parseFloat(r[2]),
    low: parseFloat(r[3]),
    close: parseFloat(r[4]),
    volume: parseFloat(r[6]),
  }));
}

// ─── Technical Indicators ────────────────────────────────────────────────

function calcATR(candles: Candle[], period = 14): number[] {
  const trs: number[] = [];
  for (let i = 0; i < candles.length; i++) {
    const c = candles[i];
    const prev = i > 0 ? candles[i - 1].close : c.open;
    const tr = Math.max(
      c.high - c.low,
      Math.abs(c.high - prev),
      Math.abs(c.low - prev)
    );
    trs.push(tr);
  }
  const atr: number[] = [];
  let sum = 0;
  for (let i = 0; i < trs.length; i++) {
    if (i < period) {
      sum += trs[i];
      atr.push(sum / (i + 1));
    } else {
      atr.push((atr[i - 1] * (period - 1) + trs[i]) / period);
    }
  }
  return atr;
}

function calcEMA(values: number[], period: number): number[] {
  const k = 2 / (period + 1);
  const result: number[] = [values[0]];
  for (let i = 1; i < values.length; i++) {
    result.push(values[i] * k + result[i - 1] * (1 - k));
  }
  return result;
}

function calcRSI(closes: number[], period = 14): number[] {
  const rsi: number[] = [];
  let gain = 0, loss = 0;
  for (let i = 1; i < closes.length; i++) {
    const change = closes[i] - closes[i - 1];
    if (i <= period) {
      gain += Math.max(change, 0);
      loss += Math.max(-change, 0);
      if (i === period) rsi.push(100 - 100 / (1 + gain / loss));
    } else {
      gain = (gain * (period - 1) + Math.max(change, 0)) / period;
      loss = (loss * (period - 1) + Math.max(-change, 0)) / period;
      rsi.push(100 - 100 / (1 + gain / loss));
    }
  }
  // Pad with first value
  while (rsi.length < closes.length) rsi.unshift(rsi[0] || 50);
  return rsi;
}

function calcStochastic(
  highs: number[],
  lows: number[],
  closes: number[],
  kPeriod = 14,
  dPeriod = 3
): { k: number[]; d: number[] } {
  const kValues: number[] = [];
  for (let i = 0; i < closes.length; i++) {
    if (i < kPeriod - 1) { kValues.push(50); continue; }
    const sliceH = highs.slice(i - kPeriod + 1, i + 1);
    const sliceL = lows.slice(i - kPeriod + 1, i + 1);
    const highest = Math.max(...sliceH);
    const lowest = Math.min(...sliceL);
    const range = highest - lowest;
    kValues.push(range === 0 ? 50 : ((closes[i] - lowest) / range) * 100);
  }
  const dValues: number[] = [];
  for (let i = 0; i < kValues.length; i++) {
    if (i < dPeriod - 1) { dValues.push(50); continue; }
    const slice = kValues.slice(i - dPeriod + 1, i + 1);
    dValues.push(slice.reduce((a, b) => a + b, 0) / slice.length);
  }
  return { k: kValues, d: dValues };
}

function calcADX(candles: Candle[], period = 14): number[] {
  const trs: number[] = [];
  const plusDM: number[] = [];
  const minusDM: number[] = [];
  for (let i = 1; i < candles.length; i++) {
    const c = candles[i];
    const p = candles[i - 1];
    const tr = Math.max(c.high - c.low, Math.abs(c.high - p.close), Math.abs(c.low - p.close));
    const upMove = c.high - p.high;
    const downMove = p.low - c.low;
    trs.push(tr);
    plusDM.push(upMove > downMove && upMove > 0 ? upMove : 0);
    minusDM.push(downMove > upMove && downMove > 0 ? downMove : 0);
  }
  // Pad
  const atr = calcATR(candles, period);
  const adx: number[] = [0];
  let smoothedPlus = 0, smoothedMinus = 0;
  for (let i = 0; i < trs.length; i++) {
    if (i < period) {
      smoothedPlus += plusDM[i];
      smoothedMinus += minusDM[i];
    } else {
      smoothedPlus = (smoothedPlus * (period - 1) + plusDM[i]) / period;
      smoothedMinus = (smoothedMinus * (period - 1) + minusDM[i]) / period;
    }
    const atrVal = atr[i + 1] || 1;
    const plusDI = (smoothedPlus / atrVal) * 100;
    const minusDI = (smoothedMinus / atrVal) * 100;
    const dx = Math.abs(plusDI - minusDI) / (plusDI + minusDI) * 100;
    if (i < period * 2) { adx.push(dx); continue; }
    adx.push((adx[adx.length - 1] * (period - 1) + dx) / period);
  }
  while (adx.length < candles.length) adx.unshift(adx[0]);
  return adx;
}

// ─── HTF Bias Detection ─────────────────────────────────────────────────

function detectHTFBias(candles4h: Candle[]): "BULLISH" | "BEARISH" | "NEUTRAL" {
  const closes = candles4h.map((c) => c.close);
  if (closes.length < 50) return "NEUTRAL";
  const ema21 = calcEMA(closes, 21);
  const ema50 = calcEMA(closes, 50);
  const last = closes.length - 1;
  const price = closes[last];
  const e21 = ema21[last];
  const e50 = ema50[last];
  if (price > e21 && e21 > e50) return "BULLISH";
  if (price < e21 && e21 < e50) return "BEARISH";
  return "NEUTRAL";
}

function detect4HTrend(candles4h: Candle[]): { direction: string | null; strength: string } {
  const closes = candles4h.map((c) => c.close);
  if (closes.length < 30) return { direction: null, strength: "WEAK" };
  const ema8 = calcEMA(closes, 8);
  const ema21 = calcEMA(closes, 21);
  const last = closes.length - 1;
  const price = closes[last];
  const e8 = ema8[last];
  const e21 = ema21[last];
  const dir = price > e8 && price > e21 ? "LONG" : price < e8 && price < e21 ? "SHORT" : null;
  const spread = Math.abs(e8 - e21) / e21;
  const strength = spread > 0.02 ? "STRONG" : spread > 0.01 ? "MEDIUM" : "WEAK";
  return { direction: dir, strength };
}

// ─── Impulse Detection (v29.3 — FULLY LOGGED) ───────────────────────────

function detectImpulse(
  candles: Candle[],
  pair: string,
  log: (msg: string) => void
): ImpulseResult {
  const lookback = 20;
  const minCandles = lookback + 5;

  if (candles.length < minCandles) {
    return {
      detected: false, direction: null, strength: 0,
      volumeRatio: 0, rangeATR: 0, prevRangeATR: 0,
      candleIndex: -1, reason: `insufficient candles (${candles.length} < ${minCandles})`
    };
  }

  const closes = candles.map((c) => c.close);
  const highs = candles.map((c) => c.high);
  const lows = candles.map((c) => c.low);
  const volumes = candles.map((c) => c.volume);
  const atr = calcATR(candles, 14);

  const last = candles.length - 1;

  // Check last N candles for impulse
  for (let i = last; i > last - 5 && i >= lookback; i--) {
    const candle = candles[i];
    const prevCandle = candles[i - 1];

    // Volume analysis
    const recentVolumes = volumes.slice(i - lookback, i);
    const avgVolume = recentVolumes.reduce((a, b) => a + b, 0) / recentVolumes.length;
    const volumeRatio = avgVolume > 0 ? candle.volume / avgVolume : 0;

    // Range analysis
    const candleRange = candle.high - candle.low;
    const atrVal = atr[i] || candleRange;
    const rangeATR = atrVal > 0 ? candleRange / atrVal : 0;
    const prevRange = prevCandle.high - prevCandle.low;
    const prevATR = atr[i - 1] || prevRange;
    const prevRangeATR = prevATR > 0 ? prevRange / prevATR : 0;

    // Direction
    const isBullish = candle.close > candle.open;
    const isBearish = candle.close < candle.open;
    const bodySize = Math.abs(candle.close - candle.open);
    const wickRatio = bodySize > 0 ? candleRange / bodySize : 999;

    // Composite strength (0-1)
    const volScore = Math.min(volumeRatio / 3, 1);  // 3x vol = max score
    const rangeScore = Math.min(rangeATR / 2, 1);   // 2x ATR = max score
    const momentumScore = isBullish
      ? Math.max(0, (candle.close - prevCandle.close) / prevCandle.close * 50)
      : Math.max(0, (prevCandle.close - candle.close) / prevCandle.close * 50);
    const strength = (volScore * 0.4 + rangeScore * 0.4 + Math.min(momentumScore, 1) * 0.2);

    log(`[IMPULSE] ${pair} candle[${i}] vol=${volumeRatio.toFixed(2)}x range=${rangeATR.toFixed(2)}x prevRange=${prevRangeATR.toFixed(2)}x body=${bodySize.toFixed(2)} wickRatio=${wickRatio.toFixed(2)} strength=${strength.toFixed(3)} bullish=${isBullish} bearish=${isBearish}`);

    // Threshold check
    if (volumeRatio >= IMPULSE_VOLUME_THRESHOLD && rangeATR >= IMPULSE_RANGE_THRESHOLD && strength >= IMPULSE_STRENGTH_MIN) {
      const direction: "LONG" | "SHORT" = isBullish ? "LONG" : "SHORT";
      log(`[IMPULSE] ${pair} DETECTED: ${direction} at candle[${i}] strength=${strength.toFixed(3)}`);
      return {
        detected: true, direction, strength,
        volumeRatio, rangeATR, prevRangeATR,
        candleIndex: i, reason: "impulse_threshold_met"
      };
    }
  }

  log(`[IMPULSE] ${pair} NO IMPULSE: max checked=${Math.min(5, last - lookback + 1)} candles, thresholds: vol>=${IMPULSE_VOLUME_THRESHOLD}, range>=${IMPULSE_RANGE_THRESHOLD}, strength>=${IMPULSE_STRENGTH_MIN}`);
  return {
    detected: false, direction: null, strength: 0,
    volumeRatio: 0, rangeATR: 0, prevRangeATR: 0,
    candleIndex: -1, reason: "no_candle_met_thresholds"
  };
}

// ─── Zone Detection ───────────────────────────────────────────────────────

function detectZone(
  candles: Candle[],
  impulseIndex: number,
  pair: string,
  log: (msg: string) => void
): { top: number; bottom: number; quality: ZoneQuality } | null {
  if (impulseIndex < 5 || impulseIndex >= candles.length) return null;

  // Look at candles AFTER impulse for consolidation
  const postImpulse = candles.slice(impulseIndex + 1, impulseIndex + 21);
  if (postImpulse.length < 5) return null;

  const highs = postImpulse.map((c) => c.high);
  const lows = postImpulse.map((c) => c.low);
  const top = Math.max(...highs);
  const bottom = Math.min(...lows);
  const width = top - bottom;

  const closes = candles.map((c) => c.close);
  const atr = calcATR(candles, 14);
  const atrVal = atr[atr.length - 1] || width;
  const widthATR = atrVal > 0 ? width / atrVal : 0;

  // Count touches
  let touches = 0;
  for (const c of postImpulse) {
    if (Math.abs(c.high - top) < width * 0.1 || Math.abs(c.low - bottom) < width * 0.1) touches++;
  }

  // Volume decay
  const preVol = candles.slice(impulseIndex - 5, impulseIndex).reduce((a, c) => a + c.volume, 0) / 5;
  const postVol = postImpulse.reduce((a, c) => a + c.volume, 0) / postImpulse.length;
  const volumeDecay = preVol > 0 ? ((preVol - postVol) / preVol) * 100 : 0;

  // Compression (lower = tighter)
  const compression = Math.max(0, 100 - widthATR * 50);

  // Quality score
  let label: ZoneQuality["label"] = "WEAK";
  const score = (touches * 10) + compression + volumeDecay;
  if (score >= 120 && widthATR < 1.5) label = "EXCELLENT";
  else if (score >= 80 && widthATR < 2.0) label = "GOOD";
  else if (score >= 50) label = "AVERAGE";

  log(`[ZONE] ${pair} top=${top.toFixed(2)} bottom=${bottom.toFixed(2)} width=${widthATR.toFixed(2)}xATR touches=${touches} compression=${compression.toFixed(1)}% decay=${volumeDecay.toFixed(1)}% quality=${label}`);

  return {
    top, bottom,
    quality: {
      age: postImpulse.length,
      widthATR,
      compression,
      volumeDecay,
      touches,
      breakAttempts: 0,
      label,
    },
  };
}

// ─── Signal Generation ───────────────────────────────────────────────────

function generateSignalId(pair: string): string {
  return `${pair}-${Date.now()}-${Math.random().toString(36).slice(2, 6)}`;
}

interface GenerateResult {
  signal: Signal | null;
  market: MarketData | null;
  debug: string[];
}

async function generateSignal(
  pair: string,
  candles1h: Candle[],
  candles4h: Candle[],
  candles15m: Candle[],
  currentPrice: number,
  log: (msg: string) => void
): Promise<GenerateResult> {
  const debug: string[] = [];

  // 1. Calculate indicators
  const closes1h = candles1h.map((c) => c.close);
  const highs1h = candles1h.map((c) => c.high);
  const lows1h = candles1h.map((c) => c.low);

  const adx1h = calcADX(candles1h, 14);
  const rsi1h = calcRSI(closes1h, 14);
  const stoch1h = calcStochastic(highs1h, lows1h, closes1h, 14, 3);

  const adx = adx1h[adx1h.length - 1];
  const rsi = rsi1h[rsi1h.length - 1];
  const stochK = stoch1h.k[stoch1h.k.length - 1];
  const stochD = stoch1h.d[stoch1h.d.length - 1];

  // 2. Detect HTF bias and 4H trend
  const htfBias = detectHTFBias(candles4h);
  const trend4h = detect4HTrend(candles4h);

  log(`[HTF] ${pair} bias=${htfBias} 4H=${trend4h.direction || "MIXED"} strength=${trend4h.strength}`);

  // 3. Detect impulse
  const impulse = detectImpulse(candles1h, pair, log);

  if (!impulse.detected || !impulse.direction) {
    debug.push(`HTF Bias: ${htfBias}`);
    debug.push(`Stage: NONE`);
    debug.push(`No impulse -- ${impulse.reason}`);
    return {
      signal: null,
      market: {
        pair, price: currentPrice, timestamp: Date.now(),
        phase: "NONE", trend: `${trend4h.direction || "MIXED"} ${trend4h.strength}`,
        htfBias, adx, rsi, stochK, stochD,
        zoneTop: null, zoneBottom: null, zoneScore: 0,
      },
      debug,
    };
  }

  // 4. Timeframe alignment check (NEW v29.3)
  if (REQUIRE_HTF_ALIGNMENT) {
    const aligned =
      (impulse.direction === "LONG" && (htfBias === "BULLISH" || htfBias === "NEUTRAL")) ||
      (impulse.direction === "SHORT" && (htfBias === "BEARISH" || htfBias === "NEUTRAL"));

    if (!aligned) {
      log(`[ALIGN] ${pair} REJECTED: impulse=${impulse.direction} vs HTF=${htfBias}`);
      debug.push(`HTF Bias: ${htfBias}`);
      debug.push(`Stage: NONE`);
      debug.push(`Misaligned -- impulse=${impulse.direction} HTF=${htfBias}`);
      return {
        signal: null,
        market: {
          pair, price: currentPrice, timestamp: Date.now(),
          phase: "NONE", trend: `${trend4h.direction || "MIXED"} ${trend4h.strength}`,
          htfBias, adx, rsi, stochK, stochD,
          zoneTop: null, zoneBottom: null, zoneScore: 0,
        },
        debug,
      };
    }
    log(`[ALIGN] ${pair} PASSED: impulse=${impulse.direction} aligns with HTF=${htfBias}`);
  }

  // 5. Detect zone
  const zone = detectZone(candles1h, impulse.candleIndex, pair, log);

  if (!zone) {
    debug.push(`HTF Bias: ${htfBias}`);
    debug.push(`Stage: WATCHING`);
    debug.push(`Impulse detected but no zone formed yet`);
    return {
      signal: null,
      market: {
        pair, price: currentPrice, timestamp: Date.now(),
        phase: "WATCHING", trend: `${trend4h.direction || "MIXED"} ${trend4h.strength}`,
        htfBias, adx, rsi, stochK, stochD,
        zoneTop: null, zoneBottom: null, zoneScore: 0,
      },
      debug,
    };
  }

  // 6. Determine stage
  let stage: Signal["stage"] = "ACCUMULATION";
  if (zone.quality.label === "EXCELLENT" || zone.quality.label === "GOOD") {
    stage = "READY";
  }

  // 7. Build signal
  const direction = impulse.direction;
  const entry = direction === "LONG" ? zone.top : zone.bottom;
  const stop = direction === "LONG"
    ? zone.bottom - (zone.top - zone.bottom) * 0.5
    : zone.top + (zone.top - zone.bottom) * 0.5;
  const risk = Math.abs(entry - stop);
  const target = direction === "LONG" ? entry + risk * 2 : entry - risk * 2;
  const trail = direction === "LONG"
    ? zone.bottom
    : zone.top;

  const rr = risk > 0 ? Math.abs(target - entry) / risk : 0;

  // Confidence calculation
  let confidence = 50;
  confidence += zone.quality.label === "EXCELLENT" ? 20 : zone.quality.label === "GOOD" ? 15 : zone.quality.label === "AVERAGE" ? 5 : 0;
  confidence += adx > 25 ? 10 : 0;
  confidence += Math.abs(stochK - stochD) > 5 ? 5 : 0;
  confidence = Math.min(95, Math.max(30, confidence));

  const signal: Signal = {
    id: generateSignalId(pair),
    pair,
    direction,
    stage,
    entry: roundPrice(entry),
    stop: roundPrice(stop),
    target: roundPrice(target),
    trail: roundPrice(trail),
    confidence,
    rr: Math.round(rr * 100) / 100,
    adx: Math.round(adx * 10) / 10,
    zoneTop: roundPrice(zone.top),
    zoneBottom: roundPrice(zone.bottom),
    explanation: `${direction} ${stage}: ${impulse.direction} impulse detected at ${impulse.volumeRatio.toFixed(1)}x volume, ${zone.quality.label} zone (${zone.quality.widthATR.toFixed(1)}x ATR), HTF=${htfBias}, ADX=${adx.toFixed(1)}`,
    timestamp: Date.now(),
    version: 29,
  };

  log(`[SIGNAL] ${pair} ${direction} ${stage} entry=${signal.entry} SL=${signal.stop} TP=${signal.target} RR=${signal.rr} conf=${confidence}%`);

  const market: MarketData = {
    pair, price: currentPrice, timestamp: Date.now(),
    phase: stage === "READY" ? "READY" : "ACCUMULATION",
    trend: `${trend4h.direction || "MIXED"} ${trend4h.strength}`,
    htfBias, adx, rsi, stochK, stochD,
    zoneTop: zone.top, zoneBottom: zone.bottom,
    zoneScore: zone.quality.label === "EXCELLENT" ? 90 : zone.quality.label === "GOOD" ? 70 : zone.quality.label === "AVERAGE" ? 50 : 30,
    zoneQuality: zone.quality,
    closes4h: candles4h.slice(-50).map((c) => c.close),
  };

  return { signal, market, debug };
}

// ─── Signal Validation ──────────────────────────────────────────────────

function isSignalStillValid(signal: Signal, currentPrice: number, now: number): { valid: boolean; reason: string } {
  if (now - signal.timestamp > SIGNAL_TTL_MS) {
    return { valid: false, reason: "expired" };
  }
  if (signal.direction === "LONG" && currentPrice <= signal.stop) {
    return { valid: false, reason: "stop_loss" };
  }
  if (signal.direction === "SHORT" && currentPrice >= signal.stop) {
    return { valid: false, reason: "stop_loss" };
  }
  if (signal.direction === "LONG" && currentPrice >= signal.target) {
    return { valid: false, reason: "take_profit" };
  }
  if (signal.direction === "SHORT" && currentPrice <= signal.target) {
    return { valid: false, reason: "take_profit" };
  }
  return { valid: true, reason: "active" };
}

function shouldHold(pair: string, signal: Signal, candles4h: Candle[], currentPrice: number): { shouldHold: boolean; reason: string } {
  // Simple trail stop check
  if (signal.direction === "LONG" && currentPrice < signal.trail) {
    return { shouldHold: false, reason: "trail_stop_breached" };
  }
  if (signal.direction === "SHORT" && currentPrice > signal.trail) {
    return { shouldHold: false, reason: "trail_stop_breached" };
  }
  return { shouldHold: true, reason: "hold" };
}

function filterExpiredSignals(signals: Signal[], prices: Record<string, number>, now: number) {
  const active: Signal[] = [];
  const exited: { signal: Signal; reason: string }[] = [];
  for (const s of signals) {
    const price = prices[s.pair] || s.entry;
    const v = isSignalStillValid(s, price, now);
    if (v.valid) active.push(s);
    else exited.push({ signal: s, reason: v.reason });
  }
  return { active, exited };
}

// ─── Helpers ────────────────────────────────────────────────────────────

function roundPrice(n: number): number {
  if (n >= 10000) return Math.round(n);
  if (n >= 1000) return Math.round(n * 10) / 10;
  if (n >= 100) return Math.round(n * 100) / 100;
  return Math.round(n * 1000) / 1000;
}

// ─── Telegram Alert (placeholder) ─────────────────────────────────────────

async function sendAlert(data: any): Promise<void> {
  // Replace with your actual @/lib/telegram implementation
  console.log(`[TELEGRAM] Alert: ${JSON.stringify(data)}`);
}

// ─── Main Handler ───────────────────────────────────────────────────────

export const dynamic = "force-dynamic";
export const revalidate = 0;

export async function GET(request: Request) {
  const runStart = Date.now();
  const runId = `${runStart}-${Math.random().toString(36).slice(2, 8)}`;
  const logs: string[] = [];

  const log = (msg: string) => {
    const line = `[${new Date().toISOString()}] ${msg}`;
    logs.push(line);
    console.log(line);
  };

  log("========================================");
  log(`[CRON] Started runId=${runId} v29.3`);

  const url = new URL(request.url);
  const querySecret = url.searchParams.get("secret");
  const authHeader = request.headers.get("authorization");
  const forceRun = url.searchParams.get("force") === "true";

  const isAuthorized =
    querySecret === process.env.CRON_SECRET ||
    authHeader === `Bearer ${process.env.CRON_SECRET}`;

  if (!isAuthorized) {
    log("[CRON] Unauthorized");
    await persistLog(runId, logs, "unauthorized");
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }

  const lastRun = await getLastCronRun();
  if (!forceRun && runStart - lastRun < MIN_CRON_INTERVAL_MS) {
    log(`[CRON] Rate limited, lastRun=${lastRun}, diff=${runStart - lastRun}ms`);
    await persistLog(runId, logs, "rate_limited");
    return NextResponse.json({ success: true, skipped: true, reason: "rate_limited" });
  }
  await setLastCronRun(runStart);
  log(`[CRON] lastRun set, force=${forceRun}`);

  let activeTrades = await getActiveTrades();
  log(`[STATE] Active trades: ${Object.keys(activeTrades).join(", ") || "none"}`);

  const existingSignals = await getSignals();
  const currentPrices: Record<string, number> = {};

  log("[CRON] Fetching current prices...");
  for (const pair of PAIRS) {
    try {
      const candles = await getCandles(pair, 240);
      if (candles?.length) {
        currentPrices[pair] = candles[candles.length - 1].close;
        log(`[PRICE] ${pair} = ${currentPrices[pair]}`);
      } else {
        log(`[PRICE] ${pair} — no candles returned`);
      }
    } catch (e: any) {
      log(`[PRICE] ${pair} — ERROR: ${e.message}`);
    }
  }

  log(`[CRON] Filtering ${existingSignals.length} existing signals...`);
  const { active: validSignals, exited: preExited } = filterExpiredSignals(
    existingSignals,
    currentPrices,
    runStart
  );
  log(`[STATE] Valid: ${validSignals.length}, Expired: ${preExited.length}`);

  for (const { signal, reason } of preExited) {
    log(`[EXIT] ${signal.pair} — ${reason}`);
    await addSignalToHistory(signal, reason, currentPrices[signal.pair] || signal.entry);
    if (activeTrades[signal.pair]) delete activeTrades[signal.pair];
  }

  const newSignals: Signal[] = [];
  const marketDataList: MarketData[] = [];
  const alerts: any[] = [];

  for (const pair of PAIRS) {
    log(`[PAIR] ${pair} — starting processing`);
    try {
      log(`[FETCH] ${pair} — requesting 1H/4H/15M candles`);
      const [candles1h, candles4h, candles15m] = await Promise.all([
        getCandles(pair, 60),
        getCandles(pair, 240),
        getCandles(pair, 15),
      ]);
      log(
        `[FETCH] ${pair} — received: 1H=${candles1h?.length}, 4H=${candles4h?.length}, 15M=${candles15m?.length}`
      );

      if (!candles1h || !candles4h || !candles15m || candles4h.length < 30) {
        log(`[PAIR] ${pair} — SKIP: insufficient candles`);
        alerts.push({
          pair,
          status: "skip",
          reason: "insufficient_candles",
          counts: { h1: candles1h?.length, h4: candles4h?.length, m15: candles15m?.length },
        });
        continue;
      }

      const currentPrice = candles4h[candles4h.length - 1].close;
      const existingIdx = validSignals.findIndex((s) => s.pair === pair);
      const existingForPair = existingIdx >= 0 ? validSignals[existingIdx] : null;

      // v29.3: generateSignal now takes log function for detailed output
      const result = await generateSignal(pair, candles1h, candles4h, candles15m, currentPrice, log);

      let market = result.market;
      if (market) {
        market.closes4h = candles4h.slice(-50).map((c) => c.close);
        marketDataList.push(market);
      }

      if (existingForPair) {
        log(`[PAIR] ${pair} — has existing signal ${existingForPair.id}`);
        const validity = isSignalStillValid(existingForPair, currentPrice, runStart);
        if (!validity.valid) {
          log(`[PAIR] ${pair} — INVALID: ${validity.reason}`);
          await addSignalToHistory(existingForPair, validity.reason, currentPrice);
          if (activeTrades[pair]) delete activeTrades[pair];
          validSignals.splice(existingIdx, 1);
          alerts.push({ pair, status: "expired", reason: validity.reason });
        } else {
          const holdResult = shouldHold(pair, existingForPair, candles4h, currentPrice);
          if (!holdResult.shouldHold) {
            log(`[PAIR] ${pair} — FORCED EXIT: ${holdResult.reason}`);
            await addSignalToHistory(existingForPair, "forced_exit", currentPrice);
            if (activeTrades[pair]) delete activeTrades[pair];
            validSignals.splice(existingIdx, 1);
            alerts.push({ pair, status: "forced_exit", reason: holdResult.reason });
          } else {
            log(`[PAIR] ${pair} — Still valid, skipping generation`);
            continue;
          }
        }
      }

      if (!result.signal) {
        log(`[PAIR] ${pair} — NO SIGNAL (${result.debug.join(" | ")})`);
        alerts.push({ pair, status: "no_signal", debug: result.debug.join(" | ") });
        continue;
      }

      const signal = result.signal;
      log(
        `[PAIR] ${pair} — SIGNAL: ${signal.direction} ${signal.stage} entry=${signal.entry} TP=${signal.target} SL=${signal.stop} trail=${signal.trail} RR=${signal.rr}`
      );
      newSignals.push(signal);

      try {
        await sendAlert({
          symbol: signal.pair,
          state: signal.stage,
          price: roundPrice(signal.entry),
          bias: signal.direction,
          confidence: signal.confidence,
          stopLoss: roundPrice(signal.stop),
          takeProfit: roundPrice(signal.target),
          rr: signal.rr,
          reason: signal.explanation,
          updatedAt: new Date(signal.timestamp).toISOString(),
        });
        log(`[ALERT] ${pair} — SENT`);
        activeTrades[pair] = {
          direction: signal.direction,
          timestamp: Date.now(),
          entry: signal.entry,
          stop: signal.stop,
          target: signal.target,
          trail: signal.trail,
          id: signal.id,
          stage: signal.stage,
        };
        alerts.push({ pair, status: "sent" });
      } catch (err: any) {
        log(`[ALERT] ${pair} — FAILED: ${err.message}`);
        alerts.push({ pair, status: "alert_failed", error: err.message });
      }
    } catch (err: any) {
      log(`[PAIR] ${pair} — ERROR: ${err.message}`);
      alerts.push({ pair, status: "error", error: err.message });
    }
  }

  log("[CRON] Merging signals...");
  const merged = [...validSignals];
  for (const s of newSignals) {
    const idx = merged.findIndex((x: any) => x.pair === s.pair);
    if (idx >= 0) merged[idx] = s;
    else merged.push(s);
  }

  log("[CRON] Persisting state...");
  await Promise.all([
    setSignals(merged),
    setMarketData(marketDataList),
    setActiveTrades(activeTrades),
  ]);

  log(
    `[CRON] Done. signals=${merged.length}, marketData=${marketDataList.length}, exited=${preExited.length}`
  );
  log("========================================");

  const response = {
    success: true,
    signals: merged.length,
    marketData: marketDataList.length,
    exited: preExited.length,
    alerts,
    runId,
  };
  await persistLog(runId, logs, "complete", response);
  return NextResponse.json(response);
}

async function persistLog(runId: string, logs: string[], status: string, response?: any) {
  try {
    const existing = await getCronLogs();
    const entry = {
      runId,
      time: new Date().toISOString(),
      status,
      logCount: logs.length,
      logs: logs.slice(-50),
      response: response ? JSON.stringify(response) : undefined,
    };
    const updated = [entry, ...(existing || [])].slice(0, 20);
    await setCronLogs(updated);
  } catch (e) {
    console.error("[CRON] Failed to persist log:", e);
  }
}
