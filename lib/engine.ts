import { fetchSimplePrice } from "./coingecko";

export type Symbol = "BTC" | "ETH" | "SOL";

export interface Signal {
  symbol: Symbol;
  price: number;
  change24h: number;
  bias: "Bullish" | "Bearish" | "Neutral";
  state: "FLAT" | "BUILDING" | "SNIPER";
  confidence: number;
  entry?: number;
  stopLoss?: number;
  takeProfit?: number;
  direction?: "LONG" | "SHORT";
  updatedAt: string;
}

const symbolMap: Record<Symbol, "bitcoin" | "ethereum" | "solana"> = {
  BTC: "bitcoin",
  ETH: "ethereum",
  SOL: "solana",
};

export async function evaluate(symbol: Symbol): Promise<Signal> {
  try {
    const prices = await fetchSimplePrice();
    const key = symbolMap[symbol];
    const price = prices[key as keyof typeof prices].usd;
    const change24h = prices[key as keyof typeof prices].usd_24h_change;

    let bias: "Bullish" | "Bearish" | "Neutral" = "Neutral";
    if (change24h > 1.0) bias = "Bullish";
    else if (change24h < -1.0) bias = "Bearish";

    let state: "FLAT" | "BUILDING" | "SNIPER" = "FLAT";
    let confidence = 0;
    let entry: number | undefined;
    let stopLoss: number | undefined;
    let takeProfit: number | undefined;
    let direction: "LONG" | "SHORT" | undefined;

    if (bias === "Bullish") {
      state = "BUILDING";
      confidence = Math.min(95, 50 + Math.abs(change24h) * 10);
      
      if (change24h > 0.3) {
        state = "SNIPER";
        confidence = Math.min(95, 70 + Math.abs(change24h) * 10);
        entry = price;
        stopLoss = price * 0.97;
        takeProfit = price * 1.05;
        direction = "LONG";
      }
    } else if (bias === "Bearish") {
      state = "BUILDING";
      confidence = Math.min(95, 50 + Math.abs(change24h) * 10);
      
      if (change24h < -0.3) {
        state = "SNIPER";
        confidence = Math.min(95, 70 + Math.abs(change24h) * 10);
        entry = price;
        stopLoss = price * 1.03;
        takeProfit = price * 0.95;
        direction = "SHORT";
      }
    }

    return {
      symbol,
      price,
      change24h,
      bias,
      state,
      confidence,
      entry,
      stopLoss,
      takeProfit,
      direction,
      updatedAt: new Date().toISOString(),
    };
  } catch (err: any) {
    console.error(`[SIGNAL] ${symbol} evaluation failed:`, err.message);
    return {
      symbol,
      price: 0,
      change24h: 0,
      bias: "Neutral",
      state: "FLAT",
      confidence: 0,
      updatedAt: new Date().toISOString(),
    };
  }
}
