/**
 * SIGNAL ENGINE v2.5 — Decoupled Signal Cache
 *
 * Problem: /api/signals was calling evaluateSignal() on every UI refresh,
 * burning through CoinGecko rate limits.
 *
 * Fix: Signals are computed ONLY by /api/cron. /api/signals returns cached.
 * StochRSI + 4H bias computed from 1H OHLC candles.
 */

import { fetchPrices } from "./coingecko";

export type Symbol = "BTC" | "ETH" | "SOL";

const CG_IDS: Record<Symbol, string> = {
  BTC: "bitcoin",
  ETH: "ethereum",
  SOL: "solana",
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
  dataQuality: "OHLC" | "Cached" | "Fallback";
  updatedAt: string;
}

// ─── Signal Cache (shared between cron and signals route) ──────────
let signalCache: Signal[] = [];
let signalCacheTime = 0;
const SIGNAL_CACHE_TTL = 300000; // 5 minutes

export function getCachedSignals(): Signal[] {
  if (Date.now() - signalCacheTime < SIGNAL_CACHE_TTL) {
    return signalCache;
  }
  return [];
}

export function setCachedSignals(signals: Signal[]) {
  signalCache = signals;
  signalCacheTime = Date.now();
}

// ─── OHLC Cache ────────────────────────────────────────────────────
interface CacheEntry {
  candles: number[][];
  time: number;
}
const ohlcCache = new Map<Symbol, CacheEntry>();
const OHLC_CACHE_TTL = 300000;
const OHLC_CACHE_STALE = 900000;

async function fetchOHLC(symbol: Symbol): Promise<number[][]> {
  const cached = ohlcCache.get(symbol);
  const now = Date.now();
  if (cached && (now - cached.time) < OHLC_CACHE_TTL) return cached.candles;

  try {
    const res = await fetch(
      `https://api.coingecko.com/api/v3/coins/${CG_IDS[symbol]}/ohlc?vs_currency=usd&days=1`,
      { cache: "no-store" }
    );
    if (res.status === 429) {
      console.warn(`[OHLC] ${symbol} 429`);
      if (cached && (now - cached.time) < OHLC_CACHE_STALE) return cached.candles;
      return [];
    }
    if (!res.ok) {
      console.warn(`[OHLC] ${symbol} HTTP ${res.status}`);
      if (cached && (now - cached.time) < OHLC_CACHE_STALE) return cached.candles;
      return [];
    }
    const data = await res.json();
    const candles = data as number[][];
    ohlcCache.set(symbol, { candles, time: now });
    return candles;
  } catch (err) {
    console.warn(`[OHLC] ${symbol} error:`, (err as Error).message);
    if (cached && (now - cached.time) < OHLC_CACHE_STALE) return cached.candles;
    return [];
  }
}

async function fetchAllOHLC(): Promise<Record<Symbol, number[][]>> {
  const result: Partial<Record<Symbol, number[][]>> = {};
  for (const sym of (["BTC", "ETH", "SOL"] as Symbol[])) {
    result[sym] = await fetchOHLC(sym);
    if (sym !== "SOL") await new Promise(r => setTimeout(r, 1500));
  }
  return result as Record<Symbol, number[][]>;
}

// ─── StochRSI Calculation ──────────────────────────────────────────
function computeStochRSI(candles: number[][], period = 14): { k: number; d: number } {
  if (candles.length < period + 5) return { k: 50, d: 50 };

  const closes = candles.map(c => c[4]);
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
    rsiValues.push(100 - (100 / (1 + rs)));
  }

  const stochPeriod = Math.min(period, rsiValues.length);
  const recentRSI = rsiValues.slice(-stochPeriod);
  const minRSI = Math.min(...recentRSI);
  const maxRSI = Math.max(...recentRSI);
  const rangeRSI = maxRSI - minRSI;
  const rawStoch = rangeRSI === 0 ? 50 : ((recentRSI[recentRSI.length - 1] - minRSI) / rangeRSI) * 100;
  const k = Math.max(0, Math.min(100, rawStoch));
  return { k, d: k };
}

// ─── 4H Bias from 1H candles ───────────────────────────────────────
function compute4HBias(candles: number[][]): "Bullish" | "Bearish" | "Neutral" {
  if (candles.length < 8) return "Neutral";

  const fourHourBlocks: number[][] = [];
  for (let i = 0; i < candles.length - 3; i += 4) {
    const block = candles.slice(i, i + 4);
    const open = block[0][1];
    const high = Math.max(...block.map(c => c[2]));
    const low = Math.min(...block.map(c => c[3]));
    const close = block[block.length - 1][4];
    fourHourBlocks.push([0, open, high, low, close]);
  }

  if (fourHourBlocks.length < 2) return "Neutral";

  const recent4H = fourHourBlocks.slice(-3);
  let upCount = 0, downCount = 0;
  for (let i = 1; i < recent4H.length; i++) {
    if (recent4H[i][4] > recent4H[i-1][4]) upCount++;
    if (recent4H[i][4] < recent4H[i-1][4]) downCount++;
  }

  const latest = recent4H[recent4H.length - 1];
  const prev = recent4H[recent4H.length - 2];
  const close = latest[4];
  const prevClose = prev[4];

  const recentHighs = recent4H.map(b => b[2]);
  const recentLows = recent4H.map(b => b[3]);
  const rangeHigh = Math.max(...recentHighs);
  const rangeLow = Math.min(...recentLows);
  const rangeMid = (rangeHigh + rangeLow) / 2;

  if (upCount >= 2 && close > rangeMid && close > prevClose) return "Bullish";
  if (downCount >= 2 && close < rangeMid && close < prevClose) return "Bearish";
  return "Neutral";
}

// ─── 1H Analysis ───────────────────────────────────────────────────
function analyze1H(
  candles: number[][],
  change24h: number,
  price: number,
  high24h: number,
  low24h: number
): {
  bias: "Bullish" | "Bearish" | "Neutral";
  trendScore: number;
  rangePosition: number;
  moveTiming: "Early" | "Mid" | "Late";
  candleBreak: string;
  volatilityState: string;
  high24h: number;
  low24h: number;
  dataQuality: "OHLC" | "Cached" | "Fallback";
} {
  if (candles.length >= 4) {
    const allHighs = candles.map(c => c[2]);
    const allLows = candles.map(c => c[3]);
    const candleHigh24h = Math.max(...allHighs);
    const candleLow24h = Math.min(...allLows);

    const recent = candles.slice(-6);
    const previous = candles.slice(-10, -6);

    const prevHighs = previous.map(c => c[2]);
    const prevLows = previous.map(c => c[3]);
    const rangeHigh = Math.max(...prevHighs);
    const rangeLow = Math.min(...prevLows);
    const rangeMid = (rangeHigh + rangeLow) / 2;

    const latest = recent[recent.length - 1];
    const [, , , , close] = latest;

    const rangePosition = candleHigh24h === candleLow24h ? 0.5 : Math.max(0, Math.min(1, (close - candleLow24h) / (candleHigh24h - candleLow24h)));

    let upCount = 0, downCount = 0;
    for (let i = 1; i < recent.length; i++) {
      if (recent[i][4] > recent[i-1][4]) upCount++;
      if (recent[i][4] < recent[i-1][4]) downCount++;
    }

    let bias: "Bullish" | "Bearish" | "Neutral" = "Neutral";
    let trendScore = 0;
    let candleBreak = "None";

    if (upCount >= 3 && close > rangeMid) {
      bias = "Bullish";
      trendScore = 30 + upCount * 15;
      if (close > rangeHigh) candleBreak = "Broke above 4H range";
      else candleBreak = "Rising inside range";
    } else if (downCount >= 3 && close < rangeMid) {
      bias = "Bearish";
      trendScore = 30 + downCount * 15;
      if (close < rangeLow) candleBreak = "Broke below 4H range";
      else candleBreak = "Falling inside range";
    } else if (rangePosition < 0.30 && change24h < -1.5) {
      bias = "Bearish";
      trendScore = 25 + Math.abs(change24h) * 5;
      candleBreak = "Near 24h low — downtrend";
    } else if (rangePosition > 0.70 && change24h > 1.5) {
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

    const avgRange = previous.reduce((sum, c) => sum + (c[2] - c[3]), 0) / previous.length;
    const latestRange = latest[2] - latest[3];
    const volatilityState = latestRange > avgRange * 1.3 ? "Expanding ✅" :
                            latestRange > avgRange * 1.1 ? "Normal" : "Contracting";

    return {
      bias,
      trendScore: Math.min(100, Math.round(trendScore)),
      rangePosition,
      moveTiming,
      candleBreak,
      volatilityState,
      high24h: candleHigh24h,
      low24h: candleLow24h,
      dataQuality: "OHLC",
    };
  }

  // Fallback
  const rangePosition = high24h === low24h ? 0.5 : Math.max(0, Math.min(1, (price - low24h) / (high24h - low24h)));
  let bias: "Bullish" | "Bearish" | "Neutral" = "Neutral";
  let trendScore = 0;

  if (change24h > 2 && rangePosition > 0.6) {
    bias = "Bullish";
    trendScore = 30 + change24h * 3;
  } else if (change24h < -2 && rangePosition < 0.4) {
    bias = "Bearish";
    trendScore = 30 + Math.abs(change24h) * 3;
  } else if (change24h > 0.5) {
    bias = "Bullish";
    trendScore = 15 + change24h * 2;
  } else if (change24h < -0.5) {
    bias = "Bearish";
    trendScore = 15 + Math.abs(change24h) * 2;
  }

  return {
    bias,
    trendScore: Math.min(100, Math.round(trendScore)),
    rangePosition,
    moveTiming: "Mid",
    candleBreak: "Fallback",
    volatilityState: "Unknown",
    high24h,
    low24h,
    dataQuality: "Fallback",
  };
}

function getTriggerFromCandles(candles: number[][], bias: string): string {
  if (candles.length < 4) return "Waiting";
  const recent = candles.slice(-3);
  const latest = recent[recent.length - 1];
  const prev = recent[recent.length - 2];
  const [, , , , close] = latest;
  const [, , , , prevClose] = prev;
  const change = (close - prevClose) / prevClose;

  if (bias === "Bullish" && change > 0.001) return "Early Break Up";
  if (bias === "Bearish" && change < -0.001) return "Early Break Down";
  return "Waiting";
}

function getMomentum(candles: number[][]): "Accelerating" | "Decelerating" | "Flat" {
  if (candles.length < 3) return "Flat";
  const recent = candles.slice(-3);
  const changes = [
    Math.abs(recent[1][4] - recent[0][4]) / recent[0][4],
    Math.abs(recent[2][4] - recent[1][4]) / recent[1][4],
  ];
  if (changes[1] > changes[0] * 1.2) return "Accelerating";
  if (changes[1] < changes[0] * 0.8) return "Decelerating";
  return "Flat";
}

// ─── Alert tracking ────────────────────────────────────────────────
const alertedPositions = new Map<string, { price: number; time: number }>();
const previousBiases = new Map<Symbol, "Bullish" | "Bearish" | "Neutral">();

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
): { flipped: boolean; oldBias?: string; newBias?: string } {
  const oldBias = previousBiases.get(symbol);
  previousBiases.set(symbol, currentBias);

  if (!oldBias || oldBias === currentBias || currentBias === "Neutral") {
    return { flipped: false };
  }
  if ((oldBias === "Bullish" && currentBias === "Bearish") ||
      (oldBias === "Bearish" && currentBias === "Bullish")) {
    return { flipped: true, oldBias, newBias: currentBias };
  }
  return { flipped: false };
}

// ─── Main evaluateSignal ───────────────────────────────────────────
export async function evaluateSignal(symbol: Symbol): Promise<Signal> {
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

  const bias4H = compute4HBias(candles);
  const analysis1H = analyze1H(candles, change24h, price, high24h, low24h);
  const stoch = computeStochRSI(candles);
  const trigger = getTriggerFromCandles(candles, analysis1H.bias);
  const momentum = getMomentum(candles);

  const stochRSI = Math.round(stoch.k);
  const stochRSIState = stochRSI < 20 ? "Oversold" : stochRSI > 80 ? "Overbought" : "Neutral";

  let state: Signal["state"] = "FLAT";
  let direction: Signal["direction"] = undefined;
  let confidence = 0;
  let finalTrigger = trigger;

  if (analysis1H.bias !== "Neutral") {
    state = "BUILDING";
    direction = analysis1H.bias === "Bullish" ? "LONG" : "SHORT";
    confidence = Math.min(50, analysis1H.trendScore * 0.6);
  }

  const isAligned =
    (analysis1H.bias === "Bullish" && trigger === "Early Break Up") ||
    (analysis1H.bias === "Bearish" && trigger === "Early Break Down");

  const hasVolume = analysis1H.volatilityState.includes("Expanding");

  // === LONG ENTRY ===
  if (bias4H === "Bullish" && analysis1H.bias === "Bullish" && stochRSI < 20 && isAligned) {
    state = "SNIPER";
    direction = "LONG";
    confidence = Math.min(90, 60 + analysis1H.trendScore * 0.3);
    if (hasVolume) confidence += 10;
    finalTrigger = "4H Bullish + Stoch Oversold";
  }
  else if (bias4H === "Bullish" && analysis1H.bias === "Bullish" && stochRSI < 35 && isAligned && momentum === "Accelerating") {
    state = "SNIPER";
    direction = "LONG";
    confidence = Math.min(75, 50 + analysis1H.trendScore * 0.2);
    finalTrigger = "4H Bullish + Stoch Reset";
  }

  // === SHORT ENTRY ===
  else if (bias4H === "Bearish" && analysis1H.bias === "Bearish" && stochRSI > 80 && isAligned) {
    state = "SNIPER";
    direction = "SHORT";
    confidence = Math.min(90, 60 + analysis1H.trendScore * 0.3);
    if (hasVolume) confidence += 10;
    finalTrigger = "4H Bearish + Stoch Overbought";
  }
  else if (bias4H === "Bearish" && analysis1H.bias === "Bearish" && stochRSI > 65 && isAligned && momentum === "Accelerating") {
    state = "SNIPER";
    direction = "SHORT";
    confidence = Math.min(75, 50 + analysis1H.trendScore * 0.2);
    finalTrigger = "4H Bearish + Stoch Elevated";
  }

  // LATE MOVE FILTER
  if (state === "SNIPER" && analysis1H.moveTiming === "Late" && momentum === "Decelerating") {
    state = "BUILDING";
    confidence = Math.floor(confidence * 0.4);
  }

  const shouldSendAlert = state === "SNIPER" && direction && shouldAlert(symbol, direction, price);

  let stopLoss: number | undefined;
  let takeProfit: number | undefined;
  let riskReward: number | undefined;

  if (state === "SNIPER" && direction) {
    const slPct = analysis1H.moveTiming === "Early" ? 0.035 : 0.02;
    const tpPct = slPct * 2.5;
    if (direction === "LONG") {
      stopLoss = price * (1 - slPct);
      takeProfit = price * (1 + tpPct);
    } else {
      stopLoss = price * (1 + slPct);
      takeProfit = price * (1 - tpPct);
    }
    riskReward = 2.5;
  }

  const signal: Signal = {
    symbol,
    price,
    change24h,
    high24h: analysis1H.high24h,
    low24h: analysis1H.low24h,
    bias: analysis1H.bias,
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
    rangePosition: analysis1H.rangePosition,
    moveTiming: analysis1H.moveTiming,
    trendScore: analysis1H.trendScore,
    candleBreak: analysis1H.candleBreak,
    volatilityState: analysis1H.volatilityState,
    stochRSI,
    stochRSIState,
    dataQuality: analysis1H.dataQuality,
    updatedAt: new Date().toISOString(),
  };

  return signal;
}
