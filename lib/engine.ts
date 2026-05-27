/**
 * SIGNAL ENGINE - Stateless, simple, working
 * No Redis. No state memory. No sticky logic.
 * Evaluates from single price call + in-memory history.
 */

import { fetchPrices, PriceData } from "./coingecko";

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
  trigger: "Waiting" | "Early Break Up" | "Early Break Down" | "Pullback";
  updatedAt: string;
}

// In-memory price history (survives one request, lost on cold start)
const lastPrices = new Map<Symbol, number>();

function getBias(change24h: number): "Bullish" | "Bearish" | "Neutral" {
  if (change24h > 1.0) return "Bullish";
  if (change24h < -1.0) return "Bearish";
  return "Neutral";
}

function getTrigger(symbol: Symbol, current: number): Signal["trigger"] {
  const last = lastPrices.get(symbol);
  if (!last || last === 0) {
    lastPrices.set(symbol, current);
    return "Waiting";
  }

  const change = (current - last) / last;
  lastPrices.set(symbol, current);

  if (change > 0.003) return "Early Break Up";
  if (change < -0.003) return "Early Break Down";
  if (change > 0.001) return "Pullback";
  if (change < -0.001) return "Pullback";
  return "Waiting";
}

export async function evaluateSignal(symbol: Symbol): Promise<Signal> {
  const prices = await fetchPrices();
  const data = prices[symbol];

  const price = data.price;
  const change24h = data.change24h;
  const bias = getBias(change24h);
  const trigger = getTrigger(symbol, price);

  let state: Signal["state"] = "FLAT";
  let direction: Signal["direction"] = undefined;
  let confidence = 0;

  // BUILDING: Bias exists but no strong trigger yet
  if (bias !== "Neutral") {
    state = "BUILDING";
    direction = bias === "Bullish" ? "LONG" : "SHORT";
    confidence = Math.min(60, 40 + Math.abs(change24h) * 5);
  }

  // SNIPER: Bias + trigger aligned
  if (bias === "Bullish" && trigger === "Early Break Up") {
    state = "SNIPER";
    direction = "LONG";
    confidence = Math.min(95, 70 + change24h * 3);
  } else if (bias === "Bearish" && trigger === "Early Break Down") {
    state = "SNIPER";
    direction = "SHORT";
    confidence = Math.min(95, 70 + Math.abs(change24h) * 3);
  }

  // SL/TP ONLY for SNIPER
  let stopLoss: number | undefined;
  let takeProfit: number | undefined;
  let riskReward: number | undefined;

  if (state === "SNIPER" && direction) {
    const slPct = 0.03; // 3%
    const tpPct = 0.05; // 5%

    if (direction === "LONG") {
      stopLoss = price * (1 - slPct);
      takeProfit = price * (1 + tpPct);
    } else {
      stopLoss = price * (1 + slPct);
      takeProfit = price * (1 - tpPct);
    }

    riskReward = Math.abs((takeProfit - price) / (price - stopLoss));
    if (!isFinite(riskReward)) riskReward = 1.67;
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
    updatedAt: new Date().toISOString(),
  };
}
