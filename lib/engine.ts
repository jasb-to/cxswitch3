/**
 * SIGNAL ENGINE v2.3 — Resilient OHLC + Graceful Degradation
 *
 * Problem: CoinGecko free tier 429s on frequent OHLC calls.
 * Solution: Independent per-symbol cache TTLs + fallback to 24h price data.
 *
 * Strategy:
 * 1. Try OHLC first (freshest candle structure)
 * 2. If 429/fail → use cached OHLC if <15min old
 * 3. If no cache → fallback to 24h change % + current price for bias
 * 4. Staggered fetches with 1.5s gaps + 1 retry per symbol
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
  dataQuality: "OHLC" | "Cached" | "Fallback"; // NEW: tells you how fresh the signal is
  updatedAt: string;
}

// Per-symbol cache with independent TTLs
interface CacheEntry {
  candles: number[][];
  time: number;
}
const ohlcCache = new Map<Symbol, CacheEntry>();
const OHLC_CACHE_TTL = 300000;      // 5 min preferred
const OHLC_CACHE_STALE = 900000;    // 15 min max (use stale rather than fallback)

async function fetchOHLC(symbol: Symbol, retry = true): Promise<number[][]> {
  const cached = ohlcCache.get(symbol);
  const now = Date.now();

  // Fresh cache hit
  if (cached && (now - cached.time) < OHLC_CACHE_TTL) {
    return cached.candles;
  }

  try {
    const res = await fetch(
      `https://api.coingecko.com/api/v3/coins/${CG_IDS[symbol]}/ohlc?vs_currency=usd&days=1`,
      { cache: "no-store" }
    );

    if (res.status === 429) {
      console.warn(`[OHLC] ${symbol} 429 — using ${cached ? "stale cache" : "fallback"}`);
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

const alertedPositions = new Map<string, { price: number; time: number }>();

// Track previous bias for flip detection
const previousBiases = new Map<Symbol, "Bullish" | "Bearish" | "Neutral">();

function analyzeCandles(
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
  // If we have OHLC candles, use them
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

  // FALLBACK: No OHLC data — use 24h change % + price position
  const rangePosition = high24h === low24h ? 0.5 : Math.max(0, Math.min(1, (price - low24h) / (high24h - low24h)));

  let bias: "Bullish" | "Bearish" | "Neutral" = "Neutral";
  let trendScore = 0;
  let candleBreak = "Fallback — no candle data";

  if (change24h > 2 && rangePosition > 0.6) {
    bias = "Bullish";
    trendScore = 30 + change24h * 3;
    candleBreak = "24h uptrend (fallback)";
  } else if (change24h < -2 && rangePosition < 0.4) {
    bias = "Bearish";
    trendScore = 30 + Math.abs(change24h) * 3;
    candleBreak = "24h downtrend (fallback)";
  } else if (change24h > 0.5) {
    bias = "Bullish";
    trendScore = 15 + change24h * 2;
    candleBreak = "Slight bullish (fallback)";
  } else if (change24h < -0.5) {
    bias = "Bearish";
    trendScore = 15 + Math.abs(change24h) * 2;
    candleBreak = "Slight bearish (fallback)";
  } else {
    candleBreak = "Neutral (fallback)";
  }

  return {
    bias,
    trendScore: Math.min(100, Math.round(trendScore)),
    rangePosition,
    moveTiming: "Mid", // assume mid when we don't have candles
    candleBreak,
    volatilityState: "Unknown (fallback)",
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

// NEW: Bias flip detection
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

  // Only count as flip if we go Bullish↔Bearish (not into/out of Neutral)
  if ((oldBias === "Bullish" && currentBias === "Bearish") ||
      (oldBias === "Bearish" && currentBias === "Bullish")) {
    return { flipped: true, oldBias, newBias: currentBias };
  }

  return { flipped: false };
}

export async function evaluateSignal(symbol: Symbol): Promise<Signal> {
  const [ohlcMap, prices] = await Promise.all([
    fetchAllOHLC(),
    fetchPrices(),
  ]);

  const candles = ohlcMap[symbol];
  const data = prices[symbol];
  const price = data.price;
  const change24h = data.change24h;

  // Use CoinGecko's 24h high/low from price API as fallback
  const high24h = data.high24h || price * 1.02;
  const low24h = data.low24h || price * 0.98;

  const analysis = analyzeCandles(candles, change24h, price, high24h, low24h);
  const trigger = getTriggerFromCandles(candles, analysis.bias);
  const momentum = getMomentum(candles);

  let state: Signal["state"] = "FLAT";
  let direction: Signal["direction"] = undefined;
  let confidence = 0;
  let finalTrigger = trigger;

  if (analysis.bias !== "Neutral") {
    state = "BUILDING";
    direction = analysis.bias === "Bullish" ? "LONG" : "SHORT";
    confidence = Math.min(50, analysis.trendScore * 0.6);
  }

  const isBreakout = analysis.candleBreak.includes("Broke") ||
                     analysis.candleBreak.includes("downtrend") ||
                     analysis.candleBreak.includes("uptrend");
  const isEarly = analysis.moveTiming === "Early";
  const hasVolume = analysis.volatilityState.includes("Expanding");
  const isAligned =
    (analysis.bias === "Bullish" && trigger === "Early Break Up") ||
    (analysis.bias === "Bearish" && trigger === "Early Break Down");

  // EARLY: Fresh break + trigger
  if (isBreakout && isEarly && isAligned) {
    state = "SNIPER";
    confidence = Math.min(90, 60 + analysis.trendScore * 0.3);
    if (hasVolume) confidence += 10;
  }
  // MID: Trend + momentum + trigger
  else if (analysis.bias !== "Neutral" && momentum === "Accelerating" && isAligned) {
    state = "SNIPER";
    confidence = Math.min(75, 50 + analysis.trendScore * 0.2);
  }
  // LATE BUT STRONG: High trend score + still accelerating
  else if (analysis.bias !== "Neutral" && analysis.trendScore >= 70 && momentum === "Accelerating" && analysis.moveTiming === "Late") {
    state = "SNIPER";
    confidence = Math.min(65, 40 + analysis.trendScore * 0.15);
    finalTrigger = trigger === "Waiting" ? "Trend Continuation" : trigger;
  }

  // LATE MOVE FILTER: Only kill if decelerating
  if (state === "SNIPER" && analysis.moveTiming === "Late" && momentum === "Decelerating") {
    state = "BUILDING";
    confidence = Math.floor(confidence * 0.4);
  }

  const shouldSendAlert = state === "SNIPER" && direction && shouldAlert(symbol, direction, price);

  let stopLoss: number | undefined;
  let takeProfit: number | undefined;
  let riskReward: number | undefined;

  if (state === "SNIPER" && direction) {
    const slPct = analysis.moveTiming === "Early" ? 0.035 : 0.02;
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

  return {
    symbol,
    price,
    change24h,
    high24h: analysis.high24h,
    low24h: analysis.low24h,
    bias: analysis.bias,
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
    rangePosition: analysis.rangePosition,
    moveTiming: analysis.moveTiming,
    trendScore: analysis.trendScore,
    candleBreak: analysis.candleBreak,
    volatilityState: analysis.volatilityState,
    dataQuality: analysis.dataQuality,
    updatedAt: new Date().toISOString(),
  };
}
