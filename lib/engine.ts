/**
 * SIGNAL ENGINE - With position memory, caching, momentum filter
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

const lastPrices = new Map<Symbol, number>();
const lastChanges = new Map<Symbol, number>();
const alertedPositions = new Map<string, { price: number; time: number }>();

function getBias(change24h: number): "Bullish" | "Bearish" | "Neutral" {
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
  if (!last) { lastPrices.set(symbol, current); return "Waiting"; }
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

  if (bias !== "Neutral") {
    state = "BUILDING";
    direction = bias === "Bullish" ? "LONG" : "SHORT";
    confidence = Math.min(60, 40 + Math.abs(change24h) * 8);
  }

  const isAligned = 
    (bias === "Bullish" && trigger === "Early Break Up") ||
    (bias === "Bearish" && trigger === "Early Break Down");

  if (isAligned) {
    state = "SNIPER";
    confidence = Math.min(95, 70 + Math.abs(change24h) * 3);
  }

  // Momentum filter: downgrade if move is decelerating
  if (state === "SNIPER" && momentum === "Decelerating") {
    state = "BUILDING";
    confidence = Math.floor(confidence * 0.6);
  }

  const shouldSendAlert = state === "SNIPER" && direction && shouldAlert(symbol, direction, price);

  let stopLoss: number | undefined;
  let takeProfit: number | undefined;
  let riskReward: number | undefined;

  if (state === "SNIPER" && direction) {
    const slDistance = price * 0.025; // 2.5% base
    const tpDistance = slDistance * 2; // 2:1 R:R
    
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
    symbol, price, change24h, bias, state, direction,
    entry: state === "SNIPER" ? price : undefined,
    stopLoss, takeProfit, riskReward,
    confidence: Math.floor(confidence),
    trigger,
    momentum,
    shouldAlert: shouldSendAlert,
    updatedAt: new Date().toISOString(),
  };
}
