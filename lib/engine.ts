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

// Fetch ticker data for a single symbol with delay
async function fetchTickerForSymbol(pair: string, delay: number = 0): Promise<TickerData | null> {
  if (delay > 0) {
    await new Promise(resolve => setTimeout(resolve, delay));
  }
  
  try {
    const res = await fetch(
      `https://api.kraken.com/0/public/Ticker?pair=${pair}`,
      { cache: "no-store" }
    );
    const data = await res.json();
    if (data.error?.length) throw new Error(data.error.join(", "));

    const result: Record<string, any> = data.result;
    const keys = Object.keys(result);
    if (keys.length === 0) throw new Error(`No data for ${pair}`);
    
    const key = keys[0];
    const ticker = result[key];
    
    const symbol = pair.startsWith("XX") ? pair.substring(1, 4) : pair.substring(0, 3);
    
    return {
      symbol: symbol as Symbol,
      price: parseFloat(ticker.c[0]),
      high24h: parseFloat(ticker.h[1]),
      low24h: parseFloat(ticker.l[1]),
      vwap24h: parseFloat(ticker.p[1]),
    };
  } catch (err) {
    console.error(`[TICKER] ${pair} fetch failed:`, err);
    return null;
  }
}

// Fetch all tickers with delays to avoid rate limits
async function fetchAllTickers(): Promise<Record<Symbol, TickerData>> {
  const [btc, eth, sol] = await Promise.all([
    fetchTickerForSymbol("XXBTZUSD", 0),
    fetchTickerForSymbol("XETHZUSD", 500),
    fetchTickerForSymbol("SOLUSD", 1000),
  ]);

  if (!btc || !eth || !sol) {
    throw new Error("Failed to fetch one or more tickers");
  }

  return {
    BTC: btc,
    ETH: eth,
    SOL: sol,
  };
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
    
    // Fetch ticker and OHLC data
    const ticker = await fetchAllTickers();
    const data = ticker[symbol];
    
    // Fetch OHLC data in parallel with delays
    const candle4h = await fetchOHLC(pair, 240);
    await new Promise(resolve => setTimeout(resolve, 500));
    const candle15m = await fetchOHLC(pair, 15);

    const { bias: bias4h, structure: structure15m } = analyzeBias(candle4h);

    let state: "FLAT" | "LONG" | "SHORT" = "FLAT";
    let confidence = 0;

    // Simple logic: 4H bullish/bearish determines direction
    if (bias4h.includes("Bullish")) {
      state = "LONG";
      confidence = 85;
    } else if (bias4h.includes("Bearish")) {
      state = "SHORT";
      confidence = 85;
    }

    const entry = data.price;
    const stopLoss = state === "LONG" ? entry * 0.985 : state === "SHORT" ? entry * 1.015 : 0;
    const takeProfit = state === "LONG" ? entry * 1.03 : state === "SHORT" ? entry * 0.97 : 0;
    const riskReward = state !== "FLAT" ? 2.0 : 0; // 2:1 R:R

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
