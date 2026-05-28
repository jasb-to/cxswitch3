/**
 * SIGNAL ENGINE v2.8 — StochRSI Peak Detection + Kraken OHLC + CoinGecko Prices
 *
 * Kraken pair names:
 *   BTC/USD → XXBTZUSD (API key) or XBTUSD (altname)
 *   ETH/USD → XETHZUSD (API key) or ETHUSD (altname)
 *   SOL/USD → SOLUSD
 */

import { fetchPrices } from "./coingecko";

export type Symbol = "BTC" | "ETH" | "SOL";

const KRaken_ALTNAMES: Record<<Symbol, string> = {
  BTC: "XBTUSD",
  ETH: "ETHUSD",
  SOL: "SOLUSD",
};

export interface Signal {
  symbol: Symbol;
  price: number;
  change24h: number;
  high24h: number;
  low24h: number;
  bias: "Bullish" | "Bearish" | "Neutral";
  state: "FLAT" | "BUILDING" | "SNIPER";
  direction?: "LONG" | "SHORT";
  entry?: number;
  stopLoss?: number;
  takeProfit?: number;
  riskReward?: number;
  confidence: number;
  trigger: string;
  momentum: string;
  shouldAlert: boolean;
  rangePosition: number;
  moveTiming: "Early" | "Mid" | "Late";
  trendScore: number;
  candleBreak: string;
  volatilityState: string;
  stochRSI: number;
  stochRSIState: string;
  stochRSIPeak?: { peakValue: number; dropFromPeak: number } | null;
  stochRSITrough?: { troughValue: number; riseFromTrough: number } | null;
  stochRSIDirection: "rising" | "falling" | "neutral";
  tradeType: "With Trend" | "Counter Trend" | "—";
  dataQuality: "Kraken" | "Fallback";
  updatedAt: string;
}

// ─── Signal Cache ──────────────────────────────────────────────────
let signalCache: Signal[] = [];
let signalCacheTime = 0;
const SIGNAL_CACHE_TTL = 300000;

export function getCachedSignals(): Signal[] {
  if (Date.now() - signalCacheTime < SIGNAL_CACHE_TTL) return signalCache;
  return [];
}

export function setCachedSignals(signals: Signal[]) {
  signalCache = signals;
  signalCacheTime = Date.now();
}

// ─── Kraken OHLC ───────────────────────────────────────────────────
interface KrakenCandle {
  time: number;
  open: number;
  high: number;
  low: number;
  close: number;
}

async function fetchKrakenOHLC(symbol: Symbol): Promise<KrakenCandle[]> {
  const altname = KRaken_ALTNAMES[symbol];
  try {
    const res = await fetch(
      `https://api.kraken.com/0/public/OHLC?pair=${altname}&interval=60`,
      { cache: "no-store" }
    );
    if (!res.ok) {
      console.warn(`[Kraken] ${symbol} HTTP ${res.status}`);
      return [];
    }
    const data = await res.json();
    if (data.error && data.error.length > 0) {
      console.warn(`[Kraken] ${symbol} API error:`, data.error);
      return [];
    }

    const resultKeys = Object.keys(data.result).filter((k) => k !== "last");
    if (resultKeys.length === 0) {
      console.warn(`[Kraken] ${symbol} no pair data found`);
      return [];
    }

    const pairKey = resultKeys[0];
    const raw = data.result[pairKey] as number[][];

    return raw.map((c) => ({
      time: c[0],
      open: parseFloat(c[1]),
      high: parseFloat(c[2]),
      low: parseFloat(c[3]),
      close: parseFloat(c[4]),
    }));
  } catch (err) {
    console.warn(`[Kraken] ${symbol} error:`, (err as Error).message);
    return [];
  }
}

async function fetchAllOHLC(): Promise<<Record<<Symbol, KrakenCandle[]>> {
  const result: Partial<<Record<<Symbol, KrakenCandle[]>> = {};
  for (const sym of ["BTC", "ETH", "SOL"] as Symbol[]) {
    result[sym] = await fetchKrakenOHLC(sym);
    if (sym !== "SOL") await new Promise((r) => setTimeout(r, 300));
  }
  return result as Record<<Symbol, KrakenCandle[]>;
}

// ─── StochRSI ──────────────────────────────────────────────────────
function computeStochRSI(closes: number[], period = 14): { k: number[] } {
  if (closes.length < period + 5) return { k: [] };

  const gains: number[] = [];
  const losses: number[] = [];
  for (let i = 1; i < closes.length; i++) {
    const change = closes[i] - closes[i - 1];
    gains.push(change > 0 ? change : 0);
    losses.push(change < 0 ? -change : 0);
  }

  let avgGain = gains.slice(0, period).reduce((a, b) => a + b, 0) / period;
  let avgLoss = losses.slice(0, period).reduce((a, b) => a + b, 0) / period;
  const rsiValues: number[] = [];

  for (let i = period; i < gains.length; i++) {
    avgGain = (avgGain * (period - 1) + gains[i]) / period;
    avgLoss = (avgLoss * (period - 1) + losses[i]) / period;
    const rs = avgLoss === 0 ? 100 : avgGain / avgLoss;
    rsiValues.push(100 - 100 / (1 + rs));
  }

  const stochPeriod = Math.min(period, rsiValues.length);
  const kValues: number[] = [];

  for (let i = stochPeriod; i <= rsiValues.length; i++) {
    const slice = rsiValues.slice(i - stochPeriod, i);
    const minRSI = Math.min(...slice);
    const maxRSI = Math.max(...slice);
    const rangeRSI = maxRSI - minRSI;
    const rawStoch =
      rangeRSI === 0 ? 50 : ((slice[slice.length - 1] - minRSI) / rangeRSI) * 100;
    kValues.push(Math.max(0, Math.min(100, rawStoch)));
  }

  return { k: kValues };
}

// ─── Peak / Trough Detection ───────────────────────────────────────
function detectStochPeak(kValues: number[], minLevel = 70) {
  if (kValues.length < 3) {
    return {
      peaked: false,
      troughed: false,
      peakValue: null as number | null,
      troughValue: null as number | null,
      currentValue: kValues[kValues.length - 1] ?? 50,
      previousValue: kValues[kValues.length - 2] ?? 50,
      direction: "neutral" as "rising" | "falling" | "neutral",
      dropFromPeak: 0,
      riseFromTrough: 0,
    };
  }

  const c = kValues[kValues.length - 1];
  const p = kValues[kValues.length - 2];
  const p2 = kValues[kValues.length - 3];

  const peaked = p > p2 && p > c && p > minLevel;
  const troughed = p < p2 && p < c && p < 100 - minLevel;

  let direction: "rising" | "falling" | "neutral" = "neutral";
  if (c > p) direction = "rising";
  else if (c < p) direction = "falling";

  return {
    peaked,
    troughed,
    peakValue: peaked ? p : null,
    troughValue: troughed ? p : null,
    currentValue: c,
    previousValue: p,
    direction,
    dropFromPeak: peaked ? p - c : 0,
    riseFromTrough: troughed ? c - p : 0,
  };
}

// ─── 4H Bias from 1H candles ───────────────────────────────────────
function compute4HBias(candles: KrakenCandle[]): "Bullish" | "Bearish" | "Neutral" {
  if (candles.length < 8) return "Neutral";

  const blocks: { open: number; high: number; low: number; close: number }[] = [];
  for (let i = 0; i < candles.length - 3; i += 4) {
    const b = candles.slice(i, i + 4);
    blocks.push({
      open: b[0].open,
      high: Math.max(...b.map((c) => c.high)),
      low: Math.min(...b.map((c) => c.low)),
      close: b[b.length - 1].close,
    });
  }

  if (blocks.length < 2) return "Neutral";

  const recent = blocks.slice(-3);
  let up = 0,
    down = 0;
  for (let i = 1; i < recent.length; i++) {
    if (recent[i].close > recent[i - 1].close) up++;
    if (recent[i].close < recent[i - 1].close) down++;
  }

  const close = recent[recent.length - 1].close;
  const prevClose = recent[recent.length - 2].close;
  const highs = recent.map((b) => b.high);
  const lows = recent.map((b) => b.low);
  const mid = (Math.max(...highs) + Math.min(...lows)) / 2;

  if (up >= 2 && close > mid && close > prevClose) return "Bullish";
  if (down >= 2 && close < mid && close < prevClose) return "Bearish";
  return "Neutral";
}

// ─── 1H Analysis ───────────────────────────────────────────────────
function analyze1H(
  candles: KrakenCandle[],
  change24h: number,
  price: number,
  high24h: number,
  low24h: number
) {
  const fallback = {
    bias: "Neutral" as const,
    trendScore: 0,
    rangePosition: 0.5,
    moveTiming: "Early" as const,
    candleBreak: "Insufficient data",
    volatilityState: "—",
    high24h,
    low24h,
    dataQuality: "Fallback" as const,
  };

  if (candles.length < 4) return fallback;

  const allHighs = candles.map((c) => c.high);
  const allLows = candles.map((c) => c.low);
  const h24 = Math.max(...allHighs);
  const l24 = Math.min(...allLows);

  const recent = candles.slice(-6);
  const previous = candles.slice(-10, -6);

  const prevHighs = previous.map((c) => c.high);
  const prevLows = previous.map((c) => c.low);
  const rangeHigh = Math.max(...prevHighs);
  const rangeLow = Math.min(...prevLows);
  const rangeMid = (rangeHigh + rangeLow) / 2;

  const latest = recent[recent.length - 1];
  const close = latest.close;

  const rangePos =
    h24 === l24 ? 0.5 : Math.max(0, Math.min(1, (close - l24) / (h24 - l24)));

  let upCount = 0,
    downCount = 0;
  for (let i = 1; i < recent.length; i++) {
    if (recent[i].close > recent[i - 1].close) upCount++;
    if (recent[i].close < recent[i - 1].close) downCount++;
  }

  let bias: "Bullish" | "Bearish" | "Neutral" = "Neutral";
  let trendScore = 0;
  let candleBreak = "None";

  if (upCount >= 3 && close > rangeMid) {
    bias = "Bullish";
    trendScore = 30 + upCount * 15;
    candleBreak = close > rangeHigh ? "Broke above 4H range" : "Rising inside range";
  } else if (downCount >= 3 && close < rangeMid) {
    bias = "Bearish";
    trendScore = 30 + downCount * 15;
    candleBreak = close < rangeLow ? "Broke below 4H range" : "Falling inside range";
  } else if (rangePos < 0.3 && change24h < -1.5) {
    bias = "Bearish";
    trendScore = 25 + Math.abs(change24h) * 5;
    candleBreak = "Near 24h low — downtrend";
  } else if (rangePos > 0.7 && change24h > 1.5) {
    bias = "Bullish";
    trendScore = 25 + change24h * 5;
    candleBreak = "Near 24h high — uptrend";
  } else {
    const net = upCount - downCount;
    if (net >= 2 && close > rangeMid) {
      bias = "Bullish";
      trendScore = 20 + net * 10;
      candleBreak = "Rising inside range";
    } else if (net <= -2 && close < rangeMid) {
      bias = "Bearish";
      trendScore = 20 + Math.abs(net) * 10;
      candleBreak = "Falling inside range";
    } else {
      candleBreak = "Chopping";
      trendScore = Math.max(upCount, downCount) * 10;
    }
  }

  let moveTiming: "Early" | "Mid" | "Late" = "Early";
  const moveCandles = bias === "Bullish" ? upCount : downCount;
  if (moveCandles >= 4) moveTiming = "Late";
  else if (moveCandles >= 2) moveTiming = "Mid";

  const avgRange =
    previous.reduce((sum, c) => sum + (c.high - c.low), 0) / previous.length;
  const latestRange = latest.high - latest.low;
  const volState =
    latestRange > avgRange * 1.3
      ? "Expanding ✅"
      : latestRange > avgRange * 1.1
        ? "Normal"
        : "Contracting";

  return {
    bias,
    trendScore: Math.min(100, Math.round(trendScore)),
    rangePosition: rangePos,
    moveTiming,
    candleBreak,
    volatilityState: volState,
    high24h: h24,
    low24h: l24,
    dataQuality: "Kraken" as const,
  };
}

function getTrigger(candles: KrakenCandle[], bias: string): string {
  if (candles.length < 4) return "Waiting";
  const recent = candles.slice(-3);
  const close = recent[recent.length - 1].close;
  const prevClose = recent[recent.length - 2].close;
  const change = (close - prevClose) / prevClose;

  if (bias === "Bullish" && change > 0.001) return "Early Break Up";
  if (bias === "Bearish" && change < -0.001) return "Early Break Down";
  return "Waiting";
}

function getMomentum(candles: KrakenCandle[]): "Accelerating" | "Decelerating" | "Flat" {
  if (candles.length < 3) return "Flat";
  const r = candles.slice(-3);
  const c1 = Math.abs(r[1].close - r[0].close) / r[0].close;
  const c2 = Math.abs(r[2].close - r[1].close) / r[1].close;
  if (c2 > c1 * 1.2) return "Accelerating";
  if (c2 < c1 * 0.8) return "Decelerating";
  return "Flat";
}

// ─── Alert tracking ────────────────────────────────────────────────
const alertedPositions = new Map<string, { price: number; time: number }>();
const previousBiases = new Map<<Symbol, "Bullish" | "Bearish" | "Neutral">();

function shouldAlert(symbol: Symbol, direction: "LONG" | "SHORT", price: number): boolean {
  const key = `${symbol}:${direction}`;
  const last = alertedPositions.get(key);
  if (!last) return true;
  const mins = (Date.now() - last.time) / 60000;
  const priceChange = Math.abs((price - last.price) / last.price);
  return mins > 30 && priceChange > 0.02;
}

export function recordAlert(symbol: Symbol, direction: "LONG" | "SHORT", price: number) {
  alertedPositions.set(`${symbol}:${direction}`, { price, time: Date.now() });
}

export function detectBiasFlip(
  symbol: Symbol,
  currentBias: "Bullish" | "Bearish" | "Neutral",
  price: number
) {
  const oldBias = previousBiases.get(symbol);
  previousBiases.set(symbol, currentBias);
  if (!oldBias || oldBias === currentBias || currentBias === "Neutral")
    return { flipped: false };
  if (
    (oldBias === "Bullish" && currentBias === "Bearish") ||
    (oldBias === "Bearish" && currentBias === "Bullish")
  ) {
    return { flipped: true, oldBias, newBias: currentBias };
  }
  return { flipped: false };
}

// ─── Main evaluateSignal ───────────────────────────────────────────
export async function evaluateSignal(symbol: Symbol): Promise<<Signal> {
  const [ohlcMap, prices] = await Promise.all([
    fetchAllOHLC(),
    fetchPrices(),
  ]);

  const candles = ohlcMap[symbol];
  const data = prices[symbol];
  const price = data.price;
  const change24h = data.change24h;
  const high24h = data.high24h || price * 1.02;
  const low24h = data.low24h || price * 0.98;

  const closes = candles.map((c) => c.close);

  const bias4H = compute4HBias(candles);
  const a1H = analyze1H(candles, change24h, price, high24h, low24h);
  const stoch = computeStochRSI(closes);
  const peak = detectStochPeak(stoch.k, 70);

  const trigger = getTrigger(candles, a1H.bias);
  const momentum = getMomentum(candles);

  const stochRSI = Math.round(peak.currentValue);
  const stochRSIState =
    stochRSI < 20 ? "Oversold" : stochRSI > 80 ? "Overbought" : "Neutral";

  let state: Signal["state"] = "FLAT";
  let direction: Signal["direction"] = undefined;
  let confidence = 0;
  let finalTrigger = trigger;
  let tradeType: "With Trend" | "Counter Trend" | "—" = "—";

  if (a1H.bias !== "Neutral") {
    state = "BUILDING";
    direction = a1H.bias === "Bullish" ? "LONG" : "SHORT";
    confidence = Math.min(50, a1H.trendScore * 0.6);
  }

  const isAligned =
    (a1H.bias === "Bullish" && trigger === "Early Break Up") ||
    (a1H.bias === "Bearish" && trigger === "Early Break Down");
  const hasVolume = a1H.volatilityState.includes("Expanding");

  // ═══════════════════════════════════════════════════════════════════
  // WITH-TREND ENTRIES — trough detection for early entry
  // ═══════════════════════════════════════════════════════════════════
  if (bias4H === "Bullish" && a1H.bias === "Bullish" && peak.troughed && isAligned) {
    state = "SNIPER";
    direction = "LONG";
    tradeType = "With Trend";
    confidence = Math.min(90, 60 + a1H.trendScore * 0.3 + peak.riseFromTrough * 1.5);
    if (hasVolume) confidence += 10;
    finalTrigger = "With Trend: Trough Bounce";
  } else if (
    bias4H === "Bearish" &&
    a1H.bias === "Bearish" &&
    peak.peaked &&
    isAligned
  ) {
    state = "SNIPER";
    direction = "SHORT";
    tradeType = "With Trend";
    confidence = Math.min(90, 60 + a1H.trendScore * 0.3 + peak.dropFromPeak * 1.5);
    if (hasVolume) confidence += 10;
    finalTrigger = "With Trend: Peak Drop";
  }

  // ═══════════════════════════════════════════════════════════════════
  // COUNTER-TREND ENTRIES — peak/trough detection for early reversal
  // ═══════════════════════════════════════════════════════════════════
  else if (
    bias4H === "Bullish" &&
    a1H.bias === "Bearish" &&
    peak.peaked &&
    isAligned
  ) {
    state = "SNIPER";
    direction = "SHORT";
    tradeType = "Counter Trend";
    confidence = Math.min(95, 50 + peak.peakValue! * 0.3 + peak.dropFromPeak * 2);
    if (hasVolume) confidence += 5;
    finalTrigger = "Counter Trend: Peak Reversal";
  } else if (
    bias4H === "Bearish" &&
    a1H.bias === "Bullish" &&
    peak.troughed &&
    isAligned
  ) {
    state = "SNIPER";
    direction = "LONG";
    tradeType = "Counter Trend";
    confidence = Math.min(
      95,
      50 + (100 - peak.troughValue!) * 0.3 + peak.riseFromTrough * 2
    );
    if (hasVolume) confidence += 5;
    finalTrigger = "Counter Trend: Trough Bounce";
  }

  // ═══════════════════════════════════════════════════════════════════
  // BUILDING: Peak detected but bias hasn't flipped yet (watching)
  // ═══════════════════════════════════════════════════════════════════
  else if (bias4H === "Bullish" && peak.peaked && a1H.bias === "Bullish") {
    state = "BUILDING";
    direction = "SHORT";
    tradeType = "Counter Trend";
    confidence = Math.min(60, 40 + peak.peakValue! * 0.2);
    finalTrigger = "Momentum Exhaustion — Waiting for Bias Flip";
  } else if (bias4H === "Bearish" && peak.troughed && a1H.bias === "Bearish") {
    state = "BUILDING";
    direction = "LONG";
    tradeType = "Counter Trend";
    confidence = Math.min(60, 40 + (100 - peak.troughValue!) * 0.2);
    finalTrigger = "Momentum Building — Waiting for Bias Flip";
  }

  // Fallback with-trend entries (old threshold logic as backup)
  else if (
    bias4H === "Bullish" &&
    a1H.bias === "Bullish" &&
    stochRSI < 35 &&
    isAligned &&
    momentum === "Accelerating"
  ) {
    state = "SNIPER";
    direction = "LONG";
    tradeType = "With Trend";
    confidence = Math.min(70, 45 + a1H.trendScore * 0.15);
    finalTrigger = "With Trend: Stoch Reset";
  } else if (
    bias4H === "Bearish" &&
    a1H.bias === "Bearish" &&
    stochRSI > 65 &&
    isAligned &&
    momentum === "Accelerating"
  ) {
    state = "SNIPER";
    direction = "SHORT";
    tradeType = "With Trend";
    confidence = Math.min(70, 45 + a1H.trendScore * 0.15);
    finalTrigger = "With Trend: Stoch Elevated";
  }

  // Late move filter
  if (state === "SNIPER" && a1H.moveTiming === "Late" && momentum === "Decelerating") {
    state = "BUILDING";
    confidence = Math.floor(confidence * 0.4);
  }

  const shouldSendAlert =
    state === "SNIPER" && direction && shouldAlert(symbol, direction, price);

  let stopLoss: number | undefined;
  let takeProfit: number | undefined;
  let riskReward: number | undefined;

  if (state === "SNIPER" && direction) {
    const isCounter = tradeType === "Counter Trend";
    const baseSl = a1H.moveTiming === "Early" ? 0.035 : 0.02;
    const slPct = isCounter ? baseSl * 0.7 : baseSl;
    const tpPct = slPct * (isCounter ? 2.0 : 2.5);

    if (direction === "LONG") {
      stopLoss = price * (1 - slPct);
      takeProfit = price * (1 + tpPct);
    } else {
      stopLoss = price * (1 + slPct);
      takeProfit = price * (1 - tpPct);
    }
    riskReward = isCounter ? 2.0 : 2.5;
  }

  return {
    symbol,
    price,
    change24h,
    high24h: a1H.high24h,
    low24h: a1H.low24h,
    bias: a1H.bias,
    state,
    direction,
    entry: state === "SNIPER" ? price : undefined,
    stopLoss,
    takeProfit,
    riskReward,
    confidence: Math.floor(confidence),
    trigger: finalTrigger,
    momentum,
    shouldAlert: shouldSendAlert,
    rangePosition: a1H.rangePosition,
    moveTiming: a1H.moveTiming,
    trendScore: a1H.trendScore,
    candleBreak: a1H.candleBreak,
    volatilityState: a1H.volatilityState,
    stochRSI,
    stochRSIState,
    stochRSIPeak: peak.peaked
      ? { peakValue: Math.round(peak.peakValue!), dropFromPeak: Math.round(peak.dropFromPeak) }
      : null,
    stochRSITrough: peak.troughed
      ? { troughValue: Math.round(peak.troughValue!), riseFromTrough: Math.round(peak.riseFromTrough) }
      : null,
    stochRSIDirection: peak.direction,
    tradeType,
    dataQuality: a1H.dataQuality,
    updatedAt: new Date().toISOString(),
  };
}
