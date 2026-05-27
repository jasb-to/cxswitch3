// Stateless signal evaluation. No holds. No probation. No memory.
// Called by /api/signals and /api/cron. Same code, same result.

export interface Signal {
  symbol: "BTC" | "ETH" | "SOL";
  price: number;
  state: "FLAT" | "LONG" | "SHORT";
  entry: number;
  stopLoss: number;
  takeProfit: number;
  confidence: number; // 0-100
  updatedAt: string;
}

const PAIRS = {
  BTC: "XXBTZUSD",
  ETH: "XETHZUSD",
  SOL: "SOLUSD",
};

export async function evaluate(symbol: "BTC" | "ETH" | "SOL"): Promise<Signal> {
  const price = await getPrice(symbol);
  const history = await getHistory(symbol, 20); // last 20 prices
  
  // Simple momentum + structure
  const sma20 = history.reduce((a, b) => a + b, 0) / history.length;
  const recent = history.slice(-5);
  const momentum = (recent[recent.length - 1] - recent[0]) / recent[0];
  
  // Volatility for SL/TP
  const volatility = Math.max(...history) - Math.min(...history);
  
  let state: "FLAT" | "LONG" | "SHORT" = "FLAT";
  let confidence = 0;
  
  if (price > sma20 * 1.002 && momentum > 0.001) {
    state = "LONG";
    confidence = Math.min(95, 50 + momentum * 10000);
  } else if (price < sma20 * 0.998 && momentum < -0.001) {
    state = "SHORT";
    confidence = Math.min(95, 50 + Math.abs(momentum) * 10000);
  }
  
  const atr = volatility * 0.5; // simple ATR proxy
  
  return {
    symbol,
    price,
    state,
    entry: price,
    stopLoss: state === "LONG" ? price - atr : state === "SHORT" ? price + atr : price,
    takeProfit: state === "LONG" ? price + atr * 2 : state === "SHORT" ? price - atr * 2 : price,
    confidence: Math.floor(confidence),
    updatedAt: new Date().toISOString(),
  };
}

async function getPrice(symbol: string): Promise<number> {
  const res = await fetch(`https://api.kraken.com/0/public/Ticker?pair=${PAIRS[symbol]}`, { cache: "no-store" });
  const data = await res.json();
  return parseFloat(data.result[PAIRS[symbol]].c[0]);
}

async function getHistory(symbol: string, count: number): Promise<number[]> {
  // Fetch recent trades and extract prices
  const res = await fetch(`https://api.kraken.com/0/public/Trades?pair=${PAIRS[symbol]}&count=${count}`);
  const data = await res.json();
  return data.result[PAIRS[symbol]].map((t: any) => parseFloat(t[0])).slice(-count);
}
