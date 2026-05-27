/**
 * SIGNAL ENGINE - Optimized for early crypto entries
 */

import { fetchPrices } from "./coingecko";

export type Symbol = "BTC" | "ETH" | "SOL";

export interface Signal {
  symbol: Symbol;
  price: number;
  change24h: number;
  bias: "Bullish" | "Bearish" | "Neutral";
  state: "FLAT" | "BUILDING" | "SNIPER";
  direction?: "LONG" | "SHORT";
  entry?: number;
  stopLoss?: number;
  takeProfit?: number;
  riskReward?: number;
  confidence: number;
  trigger: "Waiting" | "Early Break Up" | "Early Break Down" | "Pullback Long" | "Pullback Short";
  updatedAt: string;
}

const lastPrices = new Map<Symbol, number>();
const lastStates = new Map<Symbol, { state: string; time: number }>();

function getBias(change24h: number): "Bullish" | "Bearish" | "Neutral" {
  if (change24h > 0.5) return "Bullish";   // lowered from 1.0
  if (change24h < -0.5) return "Bearish";  // lowered from -1.0
  return "Neutral";
}

function getTrigger(symbol: Symbol, current: number, bias: "Bullish" | "Bearish" | "Neutral"): Signal["trigger"] {
  const last = lastPrices.get(symbol);
  if (!last || last === 0) {
    lastPrices.set(symbol, current);
    return "Waiting";
  }

  const change = (current - last) / last;
  lastPrices.set(symbol, current);

  if (change > 0.0015) return "Early Break Up";    // lowered from 0.003
  if (change < -0.0015) return "Early Break Down"; // lowered from -0.003
  
  // NEW: Pullback entries for better R:R
  if (bias === "Bullish" && change < -0.0005) return "Pullback Long";
  if (bias === "Bearish" && change > 0.0005) return "Pullback Short";
  
  return "Waiting";
}

function getVolatilityAdjustedSL(price: number, change24h: number, direction: "LONG" | "SHORT"): number {
  const baseSL = 0.03;
  const volatility = Math.abs(change24h) / 100;
  const adjustedSL = Math.max(0.02, Math.min(0.045, baseSL + (volatility - 0.02)));
  
  return direction === "LONG" ? price * (1 - adjustedSL) : price * (1 + adjustedSL);
}

function getConfidence(bias: string, change24h: number, trigger: Signal["trigger"], symbol: Symbol): number {
  let confidence = bias !== "Neutral" ? 40 + Math.abs(change24h) * 8 : 0;
  
  const isAligned = 
    (bias === "Bullish" && (trigger === "Early Break Up" || trigger === "Pullback Long")) ||
    (bias === "Bearish" && (trigger === "Early Break Down" || trigger === "Pullback Short"));
  
  if (isAligned) confidence += 25;
  if (trigger.includes("Pullback")) confidence += 10;
  
  // Stale signal decay
  const last = lastStates.get(symbol);
  if (last?.state === "SNIPER") {
    const mins = (Date.now() - last.time) / 60000;
    if (mins > 30) confidence -= Math.min(20, mins - 30);
  }
  
  return Math.min(95, Math.max(0, confidence));
}

export async function evaluateSignal(symbol: Symbol): Promise<Signal> {
  const prices = await fetchPrices();
  const data = prices[symbol];

  const price = data.price;
  const change24h = data.change24h;
  const bias = getBias(change24h);
  const trigger = getTrigger(symbol, price, bias);

  let state: Signal["state"] = "FLAT";
  let direction: Signal["direction"] = undefined;

  if (bias !== "Neutral") {
    state = "BUILDING";
    direction = bias === "Bullish" ? "LONG" : "SHORT";
  }

  const isLongTrigger = trigger === "Early Break Up" || trigger === "Pullback Long";
  const isShortTrigger = trigger === "Early Break Down" || trigger === "Pullback Short";
  
  if (bias === "Bullish" && isLongTrigger) {
    state = "SNIPER"; direction = "LONG";
  } else if (bias === "Bearish" && isShortTrigger) {
    state = "SNIPER"; direction = "SHORT";
  }

  const confidence = getConfidence(bias, change24h, trigger, symbol);

  let stopLoss: number | undefined;
  let takeProfit: number | undefined;
  let riskReward: number | undefined;

  if (state === "SNIPER" && direction) {
    stopLoss = getVolatilityAdjustedSL(price, change24h, direction);
    const slDistance = Math.abs(price - stopLoss);
    const tpDistance = slDistance * 1.8;
    
    takeProfit = direction === "LONG" ? price + tpDistance : price - tpDistance;
    riskReward = Math.abs((takeProfit - price) / (price - stopLoss));
    if (!isFinite(riskReward)) riskReward = 1.8;
  }

  if (state === "SNIPER") {
    lastStates.set(symbol, { state: "SNIPER", time: Date.now() });
  }

  return {
    symbol, price, change24h, bias, state, direction,
    entry: state === "SNIPER" ? price : undefined,
    stopLoss, takeProfit, riskReward,
    confidence: Math.floor(confidence),
    trigger,
    updatedAt: new Date().toISOString(),
  };
}
