export type Symbol = "BTC" | "ETH" | "SOL";

export interface Signal {
  symbol: string;
  price: number;
  state: "FLAT" | "LONG" | "SHORT";
  entry?: number;
  stopLoss?: number;
  takeProfit?: number;
  riskReward?: number;
  confidence: number;
  updatedAt: string;
}

export interface TickerData {
  symbol: Symbol;
  price: number;
  high24h: number;
  low24h: number;
  vwap24h: number;
}

// Simplified single Ticker fetch for all 3 symbols
async function fetchTicker(): Promise<Record<Symbol, TickerData>> {
  try {
    const res = await fetch(
      "https://api.kraken.com/0/public/Ticker?pair=XBTUSD,ETHUSD,SOLUSD",
      { cache: "no-store" }
    );
    const data = await res.json();
    if (data.error?.length) throw new Error(data.error.join(", "));

    const result: Record<string, any> = data.result;
    
    return {
      BTC: {
        symbol: "BTC",
        price: parseFloat(result.XBTUSD.c[0]),
        high24h: parseFloat(result.XBTUSD.h[1]),
        low24h: parseFloat(result.XBTUSD.l[1]),
        vwap24h: parseFloat(result.XBTUSD.p[1]),
      },
      ETH: {
        symbol: "ETH",
        price: parseFloat(result.ETHUSD.c[0]),
        high24h: parseFloat(result.ETHUSD.h[1]),
        low24h: parseFloat(result.ETHUSD.l[1]),
        vwap24h: parseFloat(result.ETHUSD.p[1]),
      },
      SOL: {
        symbol: "SOL",
        price: parseFloat(result.SOLUSD.c[0]),
        high24h: parseFloat(result.SOLUSD.h[1]),
        low24h: parseFloat(result.SOLUSD.l[1]),
        vwap24h: parseFloat(result.SOLUSD.p[1]),
      },
    };
  } catch (err) {
    console.error("[TICKER] Fetch failed:", err);
    throw err;
  }
}

// Simplified signal evaluation: 24h range + VWAP distance
export async function evaluate(symbol: Symbol): Promise<Signal> {
  try {
    const ticker = await fetchTicker();
    const data = ticker[symbol];

    const dailyRange = data.high24h - data.low24h;
    const rangePosition = (data.price - data.low24h) / dailyRange; // 0-1 scale
    const vwapDistance = (data.price - data.vwap24h) / data.vwap24h; // % distance

    let state: "FLAT" | "LONG" | "SHORT" = "FLAT";
    let confidence = 0;

    // LONG: Price in upper 25% of 24h range AND above VWAP
    if (rangePosition > 0.75 && vwapDistance > 0.002) {
      state = "LONG";
      confidence = Math.min(95, 60 + (rangePosition - 0.75) * 140); // 60-95 scale
    }
    // SHORT: Price in lower 25% of 24h range AND below VWAP
    else if (rangePosition < 0.25 && vwapDistance < -0.002) {
      state = "SHORT";
      confidence = Math.min(95, 60 + (0.25 - rangePosition) * 140); // 60-95 scale
    }

    // Calculate SL/TP based on daily range
    const slDistance = dailyRange * 0.15; // 15% of daily range
    const tpDistance = dailyRange * 0.30; // 30% of daily range (2:1 R:R)

    const entry = data.price;
    let stopLoss = 0;
    let takeProfit = 0;

    if (state === "LONG") {
      stopLoss = entry - slDistance;
      takeProfit = entry + tpDistance;
    } else if (state === "SHORT") {
      stopLoss = entry + slDistance;
      takeProfit = entry - tpDistance;
    }

    const riskReward = slDistance > 0 ? tpDistance / slDistance : 0;

    return {
      symbol,
      price: data.price,
      state,
      entry: state !== "FLAT" ? entry : undefined,
      stopLoss: state !== "FLAT" ? stopLoss : undefined,
      takeProfit: state !== "FLAT" ? takeProfit : undefined,
      riskReward: state !== "FLAT" ? riskReward : undefined,
      confidence,
      updatedAt: new Date().toISOString(),
    };
  } catch (err: any) {
    console.error(`[SIGNAL] ${symbol} evaluation failed:`, err.message);
    return {
      symbol,
      price: 0,
      state: "FLAT",
      confidence: 0,
      updatedAt: new Date().toISOString(),
    };
  }
}
