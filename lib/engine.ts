/**
 * SIGNAL ENGINE v2 — Early Entry Detection
 * 
 * Uses CoinGecko OHLC (1H candles) instead of 24h change %.
 * This catches moves at the START when they break structure,
 * not 12 hours later when 24h change finally registers.
 * 
 * Key insight: A move starts on the 1H candle that breaks the previous
 * 4H range. By the time 24h change hits ±3%, that move is OLD.
 * 
 * We want to enter when:
 * 1. Price breaks above/below the last 4H consolidation range
 * 2. The break candle has expanding volume (confirmation)
 * 3. We're in the FIRST 1-2 hours of the new move (early)
 * 4. The break is WITH the 4H bias, not against it
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
  // Trend analysis fields (aligned with UI)
  rangePosition: number;      // 0-1, where price sits in 24h range
  moveTiming: "Early" | "Mid" | "Late";
  trendScore: number;         // 0-100 (renamed from trendStrength)
  candleBreak: string;        // what the latest candle did
  volatilityState: string;    // volume/volatility signal (renamed from volumeSignal)
  updatedAt: string;
}

// OHLC cache (1H candles for last 24h = 24 candles)
let ohlcCache: Map<Symbol, number[][]> | null = null;
let ohlcCacheTime = 0;
const OHLC_CACHE_TTL = 300000; // 5 minutes

async function fetchOHLC(symbol: Symbol): Promise<number[][]> {
  // Return cached if fresh
  if (ohlcCache && ohlcCache.has(symbol) && (Date.now() - ohlcCacheTime) < OHLC_CACHE_TTL) {
    return ohlcCache.get(symbol)!;
  }

  try {
    const res = await fetch(
      `https://api.coingecko.com/api/v3/coins/${CG_IDS[symbol]}/ohlc?vs_currency=usd&days=1`,
      { cache: "no-store" }
    );

    if (!res.ok) {
      console.warn(`[OHLC] ${symbol} failed:`, res.status);
      return ohlcCache?.get(symbol) || [];
    }

    const data = await res.json();
    // CoinGecko returns: [timestamp, open, high, low, close]
    const candles = data as number[][];

    if (!ohlcCache) ohlcCache = new Map();
    ohlcCache.set(symbol, candles);
    ohlcCacheTime = Date.now();

    return candles;
  } catch (err) {
    console.warn(`[OHLC] ${symbol} error:`, err);
    return ohlcCache?.get(symbol) || [];
  }
}

// In-memory tracking
const lastPrices = new Map<Symbol, number>();
const alertedPositions = new Map<string, { price: number; time: number }>();

function analyzeCandles(candles: number[][]): {
  bias: "Bullish" | "Bearish" | "Neutral";
  trendScore: number;
  rangePosition: number;
  moveTiming: "Early" | "Mid" | "Late";
  candleBreak: string;
  volatilityState: string;
  high24h: number;
  low24h: number;
} {
  // Default fallback
  const fallback = {
    bias: "Neutral" as const,
    trendScore: 0,
    rangePosition: 0.5,
    moveTiming: "Early" as const,
    candleBreak: "Insufficient data",
    volatilityState: "—",
    high24h: 0,
    low24h: 0,
  };

  if (candles.length < 4) return fallback;

  // 24h high/low from all candles
  const allHighs = candles.map(c => c[2]);
  const allLows = candles.map(c => c[3]);
  const high24h = Math.max(...allHighs);
  const low24h = Math.min(...allLows);

  const recent = candles.slice(-6); // last 6 hours
  const previous = candles.slice(-10, -6); // 4 candles before that

  // 4H range (consolidation zone)
  const prevHighs = previous.map(c => c[2]);
  const prevLows = previous.map(c => c[3]);
  const rangeHigh = Math.max(...prevHighs);
  const rangeLow = Math.min(...prevLows);
  const rangeMid = (rangeHigh + rangeLow) / 2;

  // Latest candle
  const latest = recent[recent.length - 1];
  const prev = recent[recent.length - 2];
  const [, , , , close] = latest;

  // Range position (0 = at bottom, 1 = at top) using 24h range, not 4H range
  const rangePosition = high24h === low24h ? 0.5 : Math.max(0, Math.min(1, (close - low24h) / (high24h - low24h)));

  // Trend strength: consecutive candles in same direction
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
  } else {
    candleBreak = "Chopping";
    trendScore = Math.max(upCount, downCount) * 10;
  }

  // Move timing: how extended is the move?
  let moveTiming: "Early" | "Mid" | "Late" = "Early";
  const moveCandles = bias === "Bullish" ? upCount : downCount;
  if (moveCandles >= 4) moveTiming = "Late";
  else if (moveCandles >= 2) moveTiming = "Mid";

  // Volume/volatility signal: compare latest candle range to average
  const avgRange = previous.reduce((sum, c) => sum + (c[2] - c[3]), 0) / previous.length;
  const latestRange = latest[2] - latest[3];
  const volatilityState = latestRange > avgRange * 1.3 ? "Expanding ✅" : 
                          latestRange > avgRange * 1.1 ? "Normal" : "Contracting";

  return {
    bias,
    trendScore: Math.min(100, trendScore),
    rangePosition,
    moveTiming,
    candleBreak,
    volatilityState,
    high24h,
    low24h,
  };
}

function getTrigger(symbol: Symbol, current: number): string {
  const last = lastPrices.get(symbol);
  if (!last) { 
    lastPrices.set(symbol, current); 
    return "Waiting"; 
  }
  const change = (current - last) / last;
  lastPrices.set(symbol, current);
  if (change > 0.0015) return "Early Break Up";
  if (change < -0.0015) return "Early Break Down";
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

export async function evaluateSignal(symbol: Symbol): Promise<Signal> {
  // Fetch both price and OHLC
  const [prices, candles] = await Promise.all([
    fetchPrices(),
    fetchOHLC(symbol),
  ]);

  const data = prices[symbol];
  const price = data.price;
  const change24h = data.change24h;

  // Analyze structure from 1H candles
  const analysis = analyzeCandles(candles);
  const trigger = getTrigger(symbol, price);
  const momentum = getMomentum(candles);

  let state: Signal["state"] = "FLAT";
  let direction: Signal["direction"] = undefined;
  let confidence = 0;

  // BUILDING: Bias detected from candle structure
  if (analysis.bias !== "Neutral") {
    state = "BUILDING";
    direction = analysis.bias === "Bullish" ? "LONG" : "SHORT";
    confidence = Math.min(50, analysis.trendScore * 0.5);
  }

  // SNIPER: Structure break + trigger + early timing + volume
  const isBreakout = analysis.candleBreak.includes("Broke");
  const isEarly = analysis.moveTiming === "Early";
  const hasVolume = analysis.volatilityState.includes("Expanding");
  const isAligned = 
    (analysis.bias === "Bullish" && trigger === "Early Break Up") ||
    (analysis.bias === "Bearish" && trigger === "Early Break Down");

  // EARLY ENTRY LOGIC:
  // If we broke structure AND it's early in the move → SNIPER
  // Even if momentum is flat, a fresh break is worth entering
  if (isBreakout && isEarly && isAligned) {
    state = "SNIPER";
    confidence = Math.min(90, 60 + analysis.trendScore * 0.3);
    if (hasVolume) confidence += 10;
  }

  // MID-MOVE ENTRY:
  // If trend is strong, momentum accelerating, and we have trigger
  // Enter even if not a fresh break (catching continuation)
  else if (analysis.bias !== "Neutral" && momentum === "Accelerating" && isAligned) {
    state = "SNIPER";
    confidence = Math.min(75, 50 + analysis.trendScore * 0.2);
  }

  // LATE MOVE FILTER:
  // If move is Late AND momentum decelerating → downgrade
  if (state === "SNIPER" && analysis.moveTiming === "Late" && momentum === "Decelerating") {
    state = "BUILDING";
    confidence = Math.floor(confidence * 0.4);
  }

  // ANTI-SPAM
  const shouldSendAlert = state === "SNIPER" && direction && shouldAlert(symbol, direction, price);

  // SL/TP — wider SL for early entries (give room for pullback)
  let stopLoss: number | undefined;
  let takeProfit: number | undefined;
  let riskReward: number | undefined;

  if (state === "SNIPER" && direction) {
    // Early entries get wider SL (3.5%) because we expect pullback before continuation
    // Late entries get tighter SL (2%)
    const slPct = analysis.moveTiming === "Early" ? 0.035 : 0.02;
    const tpPct = slPct * 2.5; // 2.5:1 R:R

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
    trigger,
    momentum,
    shouldAlert: shouldSendAlert,
    // Trend fields aligned with UI
    rangePosition: analysis.rangePosition,
    moveTiming: analysis.moveTiming,
    trendScore: analysis.trendScore,
    candleBreak: analysis.candleBreak,
    volatilityState: analysis.volatilityState,
    updatedAt: new Date().toISOString(),
  };
}
