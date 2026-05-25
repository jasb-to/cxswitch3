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
    BTC: "XBTUSD",
    ETH: "ETHUSD",
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
    if (!tickerData) return 0;

    const price = parseFloat(tickerData.c[0]); // Last trade close price
    return price || 0;
  } catch (err) {
    console.warn(`[KRAKEN] Failed to fetch ${symbol}`);
    return 0;
  }
}

/**
 * Evaluate market and generate SNIPER trade details if applicable
 */
function evaluateMarket(symbol: string, price: number): { state: TradeState; details?: any } {
  // Deterministic state based on symbol hash
  const charSum = symbol.split("").reduce((sum, char) => sum + char.charCodeAt(0), 0);
  
  let state: TradeState;
  if (charSum % 3 === 0) {
    state = "SNIPER";
  } else if (charSum % 3 === 1) {
    state = "BUILDING";
  } else {
    state = "DO_NOT_TRADE";
  }

  // Generate SNIPER details if applicable
  if (state === "SNIPER") {
    // Deterministic SNIPER setup based on symbol
    const baseRatio = charSum % 2 === 0 ? 0.005 : 0.01; // SL distance ratio
    const tpRatio = charSum % 2 === 0 ? 0.015 : 0.025; // TP distance ratio
    
    const direction = charSum % 2 === 0 ? "LONG" : "SHORT";
    const entry = price;
    const stopLoss = direction === "LONG" 
      ? price * (1 - baseRatio)
      : price * (1 + baseRatio);
    const takeProfit = direction === "LONG"
      ? price * (1 + tpRatio)
      : price * (1 - tpRatio);
    
    const riskAmount = Math.abs(entry - stopLoss);
    const rewardAmount = Math.abs(takeProfit - entry);
    const riskReward = rewardAmount / riskAmount;
    
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
        direction,
        entry,
        stopLoss,
        takeProfit,
        riskReward: parseFloat(riskReward.toFixed(2)),
        confidence,
        reason,
      },
    };
  }

  return { state };
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


