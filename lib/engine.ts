/**
 * SIGNAL ENGINE v2.6 — Bi-Directional (Trend + Counter-Trend)
 *
 * Strategy: Trade BOTH directions within a trending market.
 * 4H bias = primary trend. 1H StochRSI = entry timing.
 *
 * With-trend entries (higher confidence, wider stops):
 *   Bullish 4H + Stoch <20 → LONG (buy the dip)
 *   Bearish 4H + Stoch >80 → SHORT (sell the bounce)
 *
 * Counter-trend entries (lower confidence, tighter stops):
 *   Bullish 4H + Stoch >80 → SHORT (short the local top)
 *   Bearish 4H + Stoch <20 → LONG (buy the oversold bounce)
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
  tradeType: "With Trend" | "Counter Trend" | "—";
  dataQuality: "OHLC" | "Cached" | "Fallback";
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

// ─── OHLC Cache ────────────────────────────────────────────────────
interface CacheEntry { candles: number[][]; time: number; }
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

// ─── StochRSI ──────────────────────────────────────────────────────
function computeStochRSI(candles: number[][], period = 14): { k: number } {
  if (candles.length < period + 5) return { k: 50 };
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
  return { k: Math.max(0, Math.min(100, rawStoch)) };
}

// ─── 4H Bias ───────────────────────────────────────────────────────
function compute4HBias(candles: number[][]): "Bullish" | "Bearish" | "Neutral" {
  if (candles.length < 8) return "Neutral";
  const blocks: number[][] = [];
  for (let i = 0; i < candles.length - 3; i += 4) {
    const b = candles.slice(i, i + 4);
    blocks.push([0, b[0][1], Math.max(...b.map(c => c[2])), Math.min(...b.map(c => c[3])), b[b.length - 1][4]]);
  }
  if (blocks.length < 2) return "Neutral";
  const recent = blocks.slice(-3);
  let up = 0, down = 0;
  for (let i = 1; i < recent.length; i++) {
    if (recent[i][4] > recent[i-1][4]) up++;
    if (recent[i][4] < recent[i-1][4]) down++;
  }
  const close = recent[recent.length - 1][4];
  const prevClose = recent[recent.length - 2][4];
  const highs = recent.map(b => b[2]);
  const lows = recent.map(b => b[3]);
  const mid = (Math.max(...highs) + Math.min(...lows)) / 2;
  if (up >= 2 && close > mid && close > prevClose) return "Bullish";
  if (down >= 2 && close < mid && close < prevClose) return "Bearish";
  return "Neutral";
}

// ─── 1H Analysis ───────────────────────────────────────────────────
function analyze1H(candles: number[][], change24h: number, price: number, high24h: number, low24h: number) {
  const fallback = {
    bias: "Neutral" as const, trendScore: 0, rangePosition: 0.5, moveTiming: "Early" as const,
    candleBreak: "Insufficient data", volatilityState: "—", high24h, low24h, dataQuality: "Fallback" as const,
  };
  if (candles.length < 4) return fallback;

  const allHighs = candles.map(c => c[2]);
  const allLows = candles.map(c => c[3]);
  const h24 = Math.max(...allHighs);
  const l24 = Math.min(...allLows);
  const recent = candles.slice(-6);
  const previous = candles.slice(-10, -6);
  const prevHighs = previous.map(c => c[2]);
  const prevLows = previous.map(c => c[3]);
  const rangeHigh = Math.max(...prevHighs);
  const rangeLow = Math.min(...prevLows);
  const rangeMid = (rangeHigh + rangeLow) / 2;
  const latest = recent[recent.length - 1];
  const close = latest[4];
  const rangePos = h24 === l24 ? 0.5 : Math.max(0, Math.min(1, (close - l24) / (h24 - l24)));

  let upCount = 0, downCount = 0;
  for (let i = 1; i < recent.length; i++) {
    if (recent[i][4] > recent[i-1][4]) upCount++;
    if (recent[i][4] < recent[i-1][4]) downCount++;
  }

  let bias: "Bullish" | "Bearish" | "Neutral" = "Neutral";
  let trendScore = 0;
  let candleBreak = "None";

  if (upCount >= 3 && close > rangeMid) {
    bias = "Bullish"; trendScore = 30 + upCount * 15;
    candleBreak = close > rangeHigh ? "Broke above 4H range" : "Rising inside range";
  } else if (downCount >= 3 && close < rangeMid) {
    bias = "Bearish"; trendScore = 30 + downCount * 15;
    candleBreak = close < rangeLow ? "Broke below 4H range" : "Falling inside range";
  } else if (rangePos < 0.30 && change24h < -1.5) {
    bias = "Bearish"; trendScore = 25 + Math.abs(change24h) * 5;
    candleBreak = "Near 24h low — downtrend";
  } else if (rangePos > 0.70 && change24h > 1.5) {
    bias = "Bullish"; trendScore = 25 + change24h * 5;
    candleBreak = "Near 24h high — uptrend";
  } else {
    const net = upCount - downCount;
    if (net >= 2 && close > rangeMid) { bias = "Bullish"; trendScore = 20 + net * 10; candleBreak = "Rising inside range"; }
    else if (net <= -2 && close < rangeMid) { bias = "Bearish"; trendScore = 20 + Math.abs(net) * 10; candleBreak = "Falling inside range"; }
    else { candleBreak = "Chopping"; trendScore = Math.max(upCount, downCount) * 10; }
  }

  let moveTiming: "Early" | "Mid" | "Late" = "Early";
  const moveCandles = bias === "Bullish" ? upCount : downCount;
  if (moveCandles >= 4) moveTiming = "Late";
  else if (moveCandles >= 2) moveTiming = "Mid";

  const avgRange = previous.reduce((sum, c) => sum + (c[2] - c[3]), 0) / previous.length;
  const latestRange = latest[2] - latest[3];
  const volState = latestRange > avgRange * 1.3 ? "Expanding ✅" : latestRange > avgRange * 1.1 ? "Normal" : "Contracting";

  return { bias, trendScore: Math.min(100, Math.round(trendScore)), rangePosition: rangePos, moveTiming, candleBreak, volatilityState: volState, high24h: h24, low24h: l24, dataQuality: "OHLC" as const };
}

function getTrigger(candles: number[][], bias: string): string {
  if (candles.length < 4) return "Waiting";
  const recent = candles.slice(-3);
  const close = recent[recent.length - 1][4];
  const prevClose = recent[recent.length - 2][4];
  const change = (close - prevClose) / prevClose;
  if (bias === "Bullish" && change > 0.001) return "Early Break Up";
  if (bias === "Bearish" && change < -0.001) return "Early Break Down";
  return "Waiting";
}

function getMomentum(candles: number[][]): "Accelerating" | "Decelerating" | "Flat" {
  if (candles.length < 3) return "Flat";
  const r = candles.slice(-3);
  const c1 = Math.abs(r[1][4] - r[0][4]) / r[0][4];
  const c2 = Math.abs(r[2][4] - r[1][4]) / r[1][4];
  if (c2 > c1 * 1.2) return "Accelerating";
  if (c2 < c1 * 0.8) return "Decelerating";
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

export function detectBiasFlip(symbol: Symbol, currentBias: "Bullish" | "Bearish" | "Neutral", price: number) {
  const oldBias = previousBiases.get(symbol);
  previousBiases.set(symbol, currentBias);
  if (!oldBias || oldBias === currentBias || currentBias === "Neutral") return { flipped: false };
  if ((oldBias === "Bullish" && currentBias === "Bearish") || (oldBias === "Bearish" && currentBias === "Bullish")) {
    return { flipped: true, oldBias, newBias: currentBias };
  }
  return { flipped: false };
}

// ─── Main evaluateSignal ───────────────────────────────────────────
export async function evaluateSignal(symbol: Symbol): Promise<Signal> {
  const [ohlcMap, prices] = await Promise.all([fetchAllOHLC(), fetchPrices()]);
  const candles = ohlcMap[symbol];
  const data = prices[symbol];
  const price = data.price;
  const change24h = data.change24h;
  const high24h = data.high24h || price * 1.02;
  const low24h = data.low24h || price * 0.98;

  const bias4H = compute4HBias(candles);
  const a1H = analyze1H(candles, change24h, price, high24h, low24h);
  const stoch = computeStochRSI(candles);
  const trigger = getTrigger(candles, a1H.bias);
  const momentum = getMomentum(candles);

  const stochRSI = Math.round(stoch.k);
  const stochRSIState = stochRSI < 20 ? "Oversold" : stochRSI > 80 ? "Overbought" : "Neutral";

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

  const isAligned = (a1H.bias === "Bullish" && trigger === "Early Break Up") || (a1H.bias === "Bearish" && trigger === "Early Break Down");
  const hasVolume = a1H.volatilityState.includes("Expanding");

  // ═══════════════════════════════════════════════════════════════════
  // WITH-TREND ENTRIES (higher confidence, wider stops)
  // ═══════════════════════════════════════════════════════════════════

  // Bullish 4H + oversold 1H + trigger up = buy the dip
  if (bias4H === "Bullish" && a1H.bias === "Bullish" && stochRSI < 20 && isAligned) {
    state = "SNIPER"; direction = "LONG"; tradeType = "With Trend";
    confidence = Math.min(90, 60 + a1H.trendScore * 0.3);
    if (hasVolume) confidence += 10;
    finalTrigger = "With Trend: Buy Dip";
  }
  // Bearish 4H + overbought 1H + trigger down = sell the bounce
  else if (bias4H === "Bearish" && a1H.bias === "Bearish" && stochRSI > 80 && isAligned) {
    state = "SNIPER"; direction = "SHORT"; tradeType = "With Trend";
    confidence = Math.min(90, 60 + a1H.trendScore * 0.3);
    if (hasVolume) confidence += 10;
    finalTrigger = "With Trend: Sell Bounce";
  }

  // ═══════════════════════════════════════════════════════════════════
  // COUNTER-TREND ENTRIES (lower confidence, tighter stops)
  // ═══════════════════════════════════════════════════════════════════

  // Bullish 4H + overbought 1H + trigger down = short the local top
  else if (bias4H === "Bullish" && a1H.bias === "Bearish" && stochRSI > 80 && isAligned) {
    state = "SNIPER"; direction = "SHORT"; tradeType = "Counter Trend";
    confidence = Math.min(60, 40 + a1H.trendScore * 0.2);
    if (hasVolume) confidence += 5;
    finalTrigger = "Counter Trend: Short Top";
  }
  // Bearish 4H + oversold 1H + trigger up = buy the oversold bounce
  else if (bias4H === "Bearish" && a1H.bias === "Bullish" && stochRSI < 20 && isAligned) {
    state = "SNIPER"; direction = "LONG"; tradeType = "Counter Trend";
    confidence = Math.min(60, 40 + a1H.trendScore * 0.2);
    if (hasVolume) confidence += 5;
    finalTrigger = "Counter Trend: Buy Bottom";
  }

  // Fallback with-trend entries (Stoch <35 / >65 when perfect level missed)
  else if (bias4H === "Bullish" && a1H.bias === "Bullish" && stochRSI < 35 && isAligned && momentum === "Accelerating") {
    state = "SNIPER"; direction = "LONG"; tradeType = "With Trend";
    confidence = Math.min(70, 45 + a1H.trendScore * 0.15);
    finalTrigger = "With Trend: Stoch Reset";
  }
  else if (bias4H === "Bearish" && a1H.bias === "Bearish" && stochRSI > 65 && isAligned && momentum === "Accelerating") {
    state = "SNIPER"; direction = "SHORT"; tradeType = "With Trend";
    confidence = Math.min(70, 45 + a1H.trendScore * 0.15);
    finalTrigger = "With Trend: Stoch Elevated";
  }

  // Late move filter
  if (state === "SNIPER" && a1H.moveTiming === "Late" && momentum === "Decelerating") {
    state = "BUILDING";
    confidence = Math.floor(confidence * 0.4);
  }

  const shouldSendAlert = state === "SNIPER" && direction && shouldAlert(symbol, direction, price);

  // SL/TP — counter-trend gets tighter stops
  let stopLoss: number | undefined;
  let takeProfit: number | undefined;
  let riskReward: number | undefined;

  if (state === "SNIPER" && direction) {
    const isCounter = tradeType === "Counter Trend";
    const baseSl = a1H.moveTiming === "Early" ? 0.035 : 0.02;
    const slPct = isCounter ? baseSl * 0.7 : baseSl; // 30% tighter for counter-trend
    const tpPct = slPct * (isCounter ? 2.0 : 2.5);   // lower R:R for counter-trend

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
    symbol, price, change24h,
    high24h: a1H.high24h, low24h: a1H.low24h,
    bias: a1H.bias, state, direction,
    entry: state === "SNIPER" ? price : undefined,
    stopLoss, takeProfit, riskReward,
    confidence: Math.floor(confidence),
    trigger: finalTrigger,
    momentum,
    shouldAlert: shouldSendAlert,
    rangePosition: a1H.rangePosition,
    moveTiming: a1H.moveTiming,
    trendScore: a1H.trendScore,
    candleBreak: a1H.candleBreak,
    volatilityState: a1H.volatilityState,
    stochRSI, stochRSIState,
    tradeType,
    dataQuality: a1H.dataQuality,
    updatedAt: new Date().toISOString(),
  };
}
