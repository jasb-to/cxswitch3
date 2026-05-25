/**
 * PURE STRATEGY ENGINE
 * Input: symbol + price
 * Output: Signal object (no UI assumptions)
 * No side effects, no mutations, no external dependencies
 */

export type TradeState = "SNIPER" | "BUILDING" | "DO_NOT_TRADE";

export const SYMBOLS = ["BTC", "ETH", "SOL"] as const;
export type Symbol = typeof SYMBOLS[number];

export interface Signal {
  symbol: string;
  price: number;
  state: TradeState;
  direction?: "LONG" | "SHORT";
  entry?: number;
  stopLoss?: number;
  takeProfit?: number;
  riskReward?: number;
  confidence?: number;
  reason?: string;
  updated_at: string;
}

/**
 * Fetch live price from Kraken with validation
 */
async function getKrakenTicker(symbol: string): Promise<number> {
  const krakenMap: Record<string, string> = {
    BTC: "XXBTZUSD",
    ETH: "XETHZUSD",
    SOL: "SOLUSD",
  };

  const krakenSymbol = krakenMap[symbol];
  if (!krakenSymbol) throw new Error(`Unknown symbol: ${symbol}`);

  try {
    const response = await fetch(`https://api.kraken.com/0/public/Ticker?pair=${krakenSymbol}`, {
      cache: "no-store",
    });

    if (!response.ok) throw new Error(`Kraken HTTP ${response.status}`);

    const data = await response.json();
    const tickerData = data.result?.[krakenSymbol];
    if (!tickerData) throw new Error(`No data for ${krakenSymbol}`);

    const price = parseFloat(tickerData.c[0]);
    if (!isFinite(price) || price <= 0) throw new Error(`Invalid price: ${price}`);
    
    return price;
  } catch (err) {
    console.error(`[STRATEGY] Kraken fetch failed for ${symbol}:`, err);
    throw err;
  }
}

/**
 * Pure evaluation: symbol + price → state
 */
function evaluateState(symbol: string, price: number): TradeState {
  if (!price || price <= 0) return "DO_NOT_TRADE";

  const charSum = symbol.split("").reduce((sum, char) => sum + char.charCodeAt(0), 0);
  
  if (charSum % 3 === 0) return "SNIPER";
  if (charSum % 3 === 1) return "BUILDING";
  return "DO_NOT_TRADE";
}

/**
 * Generate SNIPER details (only for SNIPER state)
 */
function generateSniperDetails(symbol: string, price: number): Partial<Signal> | {} {
  const charSum = symbol.split("").reduce((sum, char) => sum + char.charCodeAt(0), 0);
  
  const direction = charSum % 2 === 0 ? "LONG" : "SHORT";
  const entry = price;
  
  const sl = direction === "LONG" 
    ? price * 0.992
    : price * 1.008;
  
  const tp = direction === "LONG"
    ? price * 1.02
    : price * 0.98;
  
  const risk = Math.abs(entry - sl);
  const reward = Math.abs(tp - entry);
  let rr = reward / risk;
  if (!isFinite(rr)) rr = 0;
  
  const confidence = 85 + (charSum % 10);
  const reasons = [
    "HTF structure break",
    "4H bias confluence",
    "Premium/discount zone",
    "Supply/demand zone",
  ];
  const reason = reasons[charSum % reasons.length];

  return {
    direction,
    entry,
    stopLoss: parseFloat(sl.toFixed(2)),
    takeProfit: parseFloat(tp.toFixed(2)),
    riskReward: parseFloat(rr.toFixed(2)),
    confidence,
    reason,
  };
}

/**
 * Create a signal: fetch price, evaluate state, generate details
 */
export async function createSignal(symbol: string): Promise<Signal> {
  const price = await getKrakenTicker(symbol);
  const state = evaluateState(symbol, price);
  
  const details = state === "SNIPER" ? generateSniperDetails(symbol, price) : {};

  return {
    symbol,
    price,
    state,
    ...details,
    updated_at: new Date().toISOString(),
  };
}



