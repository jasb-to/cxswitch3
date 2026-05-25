/**
 * TRADING STRATEGY ENGINE
 * Kraken prices → state generation → SNIPER details
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
 * Fetch live price from Kraken
 */
async function getKrakenTicker(symbol: string): Promise<number> {
  const krakenMap: Record<string, string> = {
    BTC: "XXBTZUSD",
    ETH: "XETHZUSD",
    SOL: "SOLUSD",
  };

  const krakenSymbol = krakenMap[symbol];
  if (!krakenSymbol) return 0;

  try {
    const response = await fetch(`https://api.kraken.com/0/public/Ticker?pair=${krakenSymbol}`, {
      cache: "no-store",
    });

    const data = await response.json();
    const tickerData = data.result?.[krakenSymbol];
    if (!tickerData) {
      console.warn(`[KRAKEN] No data for ${symbol} (${krakenSymbol})`);
      return 0;
    }

    const price = parseFloat(tickerData.c[0]); // Last trade close price
    if (price <= 0) {
      console.warn(`[KRAKEN] Invalid price for ${symbol}: ${price}`);
      return 0;
    }
    console.log(`[PRICE] ${symbol}: ${price}`);
    return price;
  } catch (err) {
    console.warn(`[KRAKEN] Failed to fetch ${symbol}:`, err);
    return 0;
  }
}

/**
 * Evaluate market and generate SNIPER trade details if applicable
 */
function evaluateMarket(symbol: string, price: number): { state: TradeState; details?: any } {
  // Guard: price must be positive
  if (!price || price <= 0) {
    return { 
      state: "DO_NOT_TRADE",
      details: {
        trend_4h: "Neutral",
        structure_15m: "Range",
        macro_bias: "Neutral",
        readiness_score: 0,
      }
    };
  }

  // Deterministic state based on symbol hash
  const charSum = symbol.split("").reduce((sum, char) => sum + char.charCodeAt(0), 0);
  
  let state: TradeState;
  let baseReadiness = 0;
  
  if (charSum % 3 === 0) {
    state = "SNIPER";
    baseReadiness = 90; // SNIPER = high readiness
  } else if (charSum % 3 === 1) {
    state = "BUILDING";
    baseReadiness = 50; // BUILDING = mid readiness
  } else {
    state = "DO_NOT_TRADE";
    baseReadiness = 15; // DO_NOT_TRADE = low readiness
  }

  // Generate deterministic market structure
  const structureIndex = charSum % 5;
  const structures = ["Breakout", "Compression", "Expansion", "Reversal", "Range"] as const;
  const structure_15m = structures[structureIndex];
  
  const trendIndex = charSum % 3;
  const trends = ["Bullish", "Bearish", "Neutral"] as const;
  const trend_4h = trends[trendIndex];
  const macro_bias = trends[(trendIndex + 1) % 3];
  
  // Boost readiness based on confluence
  let readiness_score = baseReadiness;
  if (trend_4h === "Bullish" && structure_15m === "Breakout") readiness_score += 15;
  if (trend_4h === "Bearish" && structure_15m === "Reversal") readiness_score += 15;
  if (macro_bias === trend_4h) readiness_score += 10;
  readiness_score = Math.min(100, readiness_score);

  // Generate SNIPER details if applicable
  if (state === "SNIPER") {
    const direction = charSum % 2 === 0 ? "LONG" : "SHORT";
    const entry = price;
    
    // SL: 0.8% for LONG, 0.8% for SHORT
    const sl = direction === "LONG" 
      ? price * 0.992
      : price * 1.008;
    
    // TP: 2% for LONG, 2% for SHORT
    const tp = direction === "LONG"
      ? price * 1.02
      : price * 0.98;
    
    const risk = Math.abs(entry - sl);
    const reward = Math.abs(tp - entry);
    let rr = reward / risk;
    
    // Guard against NaN/Infinity
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
      state,
      details: {
        trend_4h,
        structure_15m,
        macro_bias,
        readiness_score,
        direction,
        entry,
        stopLoss: parseFloat(sl.toFixed(2)),
        takeProfit: parseFloat(tp.toFixed(2)),
        riskReward: parseFloat(rr.toFixed(2)),
        confidence,
        reason,
      },
    };
  }

  return { 
    state,
    details: {
      trend_4h,
      structure_15m,
      macro_bias,
      readiness_score,
    }
  };
}

/**
 * Create a complete signal with Kraken prices
 */
export async function createSignal(symbol: string): Promise<Signal> {
  const price = await getKrakenTicker(symbol);
  const { state, details } = evaluateMarket(symbol, price);

  const signal: Signal = {
    symbol,
    price,
    state,
    ...details,
    updated_at: new Date().toISOString(),
  };

  return signal;
}


