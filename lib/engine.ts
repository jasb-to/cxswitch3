export type Symbol = "BTC" | "ETH" | "SOL";

export interface Candle {
  open: number;
  high: number;
  low: number;
  close: number;
}

export interface Signal {
  symbol: string;
  price: number;
  state: "FLAT" | "LONG" | "SHORT";
  entry?: number;
  stopLoss?: number;
  takeProfit?: number;
  riskReward?: number;
  confidence: number;
  
  // Market data display
  candle4h?: Candle;
  candle15m?: Candle;
  bias4h?: string;
  structure15m?: string;
  
  updatedAt: string;
}

interface TickerData {
  symbol: Symbol;
  price: number;
  high24h: number;
  low24h: number;
  vwap24h: number;
}

const PAIRS: Record<Symbol, string> = {
  BTC: "XBTUSD",
  ETH: "ETHUSD",
  SOL: "SOLUSD",
};

// Single ticker fetch for all 3 symbols
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

// Fetch OHLC data for a specific timeframe
async function fetchOHLC(pair: string, interval: number): Promise<Candle | null> {
  try {
    const res = await fetch(
      `https://api.kraken.com/0/public/OHLC?pair=${pair}&interval=${interval}`,
      { cache: "no-store" }
    );
    const data = await res.json();
    if (data.error?.length) throw new Error(data.error.join(", "));

    const ohlcArray = data.result[pair];
    if (!ohlcArray || ohlcArray.length === 0) return null;

    const latest = ohlcArray[ohlcArray.length - 1];
    return {
      open: parseFloat(latest[1]),
      high: parseFloat(latest[2]),
      low: parseFloat(latest[3]),
      close: parseFloat(latest[4]),
    };
  } catch (err) {
    console.error(`[OHLC] ${pair} interval ${interval} failed:`, err);
    return null;
  }
}

// Analyze candle for bias
function analyzeBias(candle: Candle | undefined): { bias: string; structure: string } {
  if (!candle) return { bias: "Unknown", structure: "Unknown" };

  const bodySize = Math.abs(candle.close - candle.open);
  const totalRange = candle.high - candle.low;
  const bodyPercent = totalRange > 0 ? (bodySize / totalRange) * 100 : 0;

  const bias = candle.close > candle.open ? "Bullish" : "Bearish";
  
  let structure = "Neutral";
  if (bodyPercent > 70) {
    structure = candle.close > candle.open ? "Strong Bullish" : "Strong Bearish";
  } else if (bodyPercent > 40) {
    structure = candle.close > candle.open ? "Bullish Break" : "Bearish Break";
  } else if (bodyPercent < 20) {
    structure = "Doji/Indecision";
  }

  return { bias, structure };
}

export async function evaluate(symbol: Symbol): Promise<Signal> {
  try {
    const pair = PAIRS[symbol];
    
    // Fetch all data in parallel: ticker, 4H OHLC, 15M OHLC
    const [ticker, candle4h, candle15m] = await Promise.all([
      fetchTicker(),
      fetchOHLC(pair, 240), // 4 hours
      fetchOHLC(pair, 15),  // 15 minutes
    ]);

    const data = ticker[symbol];
    const { bias: bias4h, structure: structure15m } = analyzeBias(candle4h);

    const dailyRange = data.high24h - data.low24h;
    const rangePosition = (data.price - data.low24h) / dailyRange; // 0-1 scale
    const vwapDistance = (data.price - data.vwap24h) / data.vwap24h; // % distance

    let state: "FLAT" | "LONG" | "SHORT" = "FLAT";
    let confidence = 0;

    // LONG: Price in upper 25% of 24h range AND above VWAP AND 4H bullish
    if (rangePosition > 0.75 && vwapDistance > 0.002 && bias4h.includes("Bullish")) {
      state = "LONG";
      confidence = Math.min(95, 60 + (rangePosition - 0.75) * 140);
    }
    // SHORT: Price in lower 25% of 24h range AND below VWAP AND 4H bearish
    else if (rangePosition < 0.25 && vwapDistance < -0.002 && bias4h.includes("Bearish")) {
      state = "SHORT";
      confidence = Math.min(95, 60 + (0.25 - rangePosition) * 140);
    }

    // Calculate SL/TP based on daily range
    const slDistance = dailyRange * 0.15;
    const tpDistance = dailyRange * 0.30;

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
      candle4h,
      candle15m,
      bias4h,
      structure15m,
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
