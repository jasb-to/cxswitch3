/**
 * SIGNAL ENGINE - Tuned for early entries with hold duration
 * 
 * Thresholds:
 * - BUILDING at ±0.5% 24h change (early bias detection)
 * - SNIPER at ±0.6% 24h change + trigger alignment (confirmed move)
 * - SL: 2.5% (tight enough for discipline, wide enough for crypto)
 * - TP: 5% (2:1 R:R, captures full move)
 * 
 * Anti-whipsaw:
 * - Momentum filter: only alert when accelerating
 * - Position memory: 1 alert per direction per 30 min
 * - Trigger needs 0.15% price move in bias direction
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
  trigger: string;
  momentum: string;
  shouldAlert: boolean;
  updatedAt: string;
}

// In-memory tracking
const lastPrices = new Map<Symbol, number>();
const lastChanges = new Map<Symbol, number>();
const alertedPositions = new Map<string, { price: number; time: number }>();

function getBias(change24h: number): "Bullish" | "Bearish" | "Neutral" {
  // BUILDING threshold: 0.5% — early bias detection
  if (change24h > 0.5) return "Bullish";
  if (change24h < -0.5) return "Bearish";
  return "Neutral";
}

function getMomentum(symbol: Symbol, currentChange: number): "Accelerating" | "Decelerating" | "Flat" {
  const last = lastChanges.get(symbol);
  lastChanges.set(symbol, currentChange);
  if (!last) return "Flat";
  const delta = currentChange - last;
  if (Math.abs(delta) < 0.05) return "Flat";
  return delta > 0 ? "Accelerating" : "Decelerating";
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
  const prices = await fetchPrices();
  const data = prices[symbol];
  const price = data.price;
  const change24h = data.change24h;
  const bias = getBias(change24h);
  const trigger = getTrigger(symbol, price);
  const momentum = getMomentum(symbol, change24h);

  let state: Signal["state"] = "FLAT";
  let direction: Signal["direction"] = undefined;
  let confidence = 0;

  // BUILDING: 24h change > 0.5% or < -0.5%
  if (bias !== "Neutral") {
    state = "BUILDING";
    direction = bias === "Bullish" ? "LONG" : "SHORT";
    confidence = Math.min(55, 35 + Math.abs(change24h) * 10);
  }

  // SNIPER: 24h change > 0.6% or < -0.6% + trigger aligned + accelerating
  const sniperThreshold = 0.6;
  const isStrongBias = Math.abs(change24h) >= sniperThreshold;

  const isAligned = 
    (bias === "Bullish" && trigger === "Early Break Up") ||
    (bias === "Bearish" && trigger === "Early Break Down");

  if (isStrongBias && isAligned) {
    state = "SNIPER";
    confidence = Math.min(90, 60 + Math.abs(change24h) * 15);
  }

  // MOMENTUM FILTER: Downgrade if decelerating (prevents whipsaw)
  if (state === "SNIPER" && momentum === "Decelerating") {
    state = "BUILDING";
    confidence = Math.floor(confidence * 0.5);
  }

  // ANTI-SPAM
  const shouldSendAlert = state === "SNIPER" && direction && shouldAlert(symbol, direction, price);

  // SL/TP — 2.5% SL, 5% TP = 2:1 R:R
  let stopLoss: number | undefined;
  let takeProfit: number | undefined;
  let riskReward: number | undefined;

  if (state === "SNIPER" && direction) {
    const slDistance = price * 0.025;
    const tpDistance = slDistance * 2;

    if (direction === "LONG") {
      stopLoss = price - slDistance;
      takeProfit = price + tpDistance;
    } else {
      stopLoss = price + slDistance;
      takeProfit = price - tpDistance;
    }
    riskReward = 2.0;
  }

  return {
    symbol, 
    price, 
    change24h, 
    bias, 
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
    updatedAt: new Date().toISOString(),
  };
}

