import { getOHLC, OHLCData } from "./kraken";

export interface Signal {
  symbol: string;
  state: "LONG" | "SHORT" | "FLAT";
  entry?: number;
  stopLoss?: number;
  takeProfit?: number;
  riskReward?: number;
  confidence: number;
  layer1?: string;
  layer2?: string;
  layer3?: string;
  updatedAt: string;
}

function detectTrendline(highs: number[], lows: number[]): "bullish_break" | "bearish_break" | "none" {
  if (highs.length < 3 || lows.length < 3) return "none";

  // Bullish break: close above descending trendline from last 2 swing highs
  const lastHigh1 = highs[highs.length - 2];
  const lastHigh2 = highs[highs.length - 3];
  const currentClose = highs[highs.length - 1];

  // Bearish break: close below ascending trendline from last 2 swing lows
  const lastLow1 = lows[lows.length - 2];
  const lastLow2 = lows[lows.length - 3];

  // Simple trendline: if highs are descending and price breaks above
  if (lastHigh2 > lastHigh1 && currentClose > lastHigh1) {
    return "bullish_break";
  }

  // If lows are ascending and price breaks below
  if (lastLow2 < lastLow1 && currentClose < lastLow1) {
    return "bearish_break";
  }

  return "none";
}

function detectRetest(ohlc: OHLCData[], bias: "bullish" | "bearish"): { confirmed: boolean; retestLevel: number } {
  if (ohlc.length < 5) return { confirmed: false, retestLevel: 0 };

  const recent = ohlc.slice(-10);

  if (bias === "bullish") {
    // Look for higher low after break
    const breakCandle = recent[0];
    const retestLows = recent.slice(1).map((c) => c.low);
    const hasHigherLow = retestLows.some((low, i) => {
      if (i === 0) return false;
      return low > retestLows[i - 1] && low > breakCandle.low;
    });
    return {
      confirmed: hasHigherLow,
      retestLevel: Math.min(...retestLows),
    };
  } else {
    // Look for lower high after break
    const breakCandle = recent[0];
    const retestHighs = recent.slice(1).map((c) => c.high);
    const hasLowerHigh = retestHighs.some((high, i) => {
      if (i === 0) return false;
      return high < retestHighs[i - 1] && high < breakCandle.high;
    });
    return {
      confirmed: hasLowerHigh,
      retestLevel: Math.max(...retestHighs),
    };
  }
}

function detectMomentumEntry(ohlc: OHLCData[], bias: "bullish" | "bearish"): { triggered: boolean; entryPrice: number } {
  if (ohlc.length < 2) return { triggered: false, entryPrice: 0 };

  const current = ohlc[ohlc.length - 1];
  const previous = ohlc[ohlc.length - 2];
  const avgVolume = ohlc.slice(-5).reduce((sum, c) => sum + c.volume, 0) / 5;

  if (bias === "bullish") {
    const triggered = current.close > previous.high && current.volume > avgVolume;
    return {
      triggered,
      entryPrice: triggered ? current.close : 0,
    };
  } else {
    const triggered = current.close < previous.low && current.volume > avgVolume;
    return {
      triggered,
      entryPrice: triggered ? current.close : 0,
    };
  }
}

export async function evaluateSignal(symbol: string): Promise<Signal> {
  console.log(`[v0] Evaluating ${symbol}`);

  // Map symbol to Kraken pair
  const pairMap: Record<string, string> = {
    BTC: "XXBTZUSD",
    ETH: "XETHZUSD",
    SOL: "SOLUSD",
  };
  const pair = pairMap[symbol] || symbol;

  // Layer 1: 4H Trendline Detection
  const ohlc4h = await getOHLC(pair, 240, 20);
  if (ohlc4h.length === 0) {
    return { symbol, state: "FLAT", confidence: 0, layer1: "Failed to fetch 4H", updatedAt: new Date().toISOString() };
  }

  const highs4h = ohlc4h.map((c) => c.high);
  const lows4h = ohlc4h.map((c) => c.low);
  const trendbreak = detectTrendline(highs4h, lows4h);

  if (trendbreak === "none") {
    return { symbol, state: "FLAT", confidence: 0, layer1: "No 4H break", updatedAt: new Date().toISOString() };
  }

  const bias = trendbreak === "bullish_break" ? "bullish" : "bearish";
  console.log(`[v0] ${symbol} Layer 1: ${bias} break`);

  // Layer 2: 15M Retest Confirmation
  const ohlc15m = await getOHLC(pair, 15, 20);
  if (ohlc15m.length === 0) {
    return { symbol, state: "FLAT", confidence: 30, layer1: bias, layer2: "Failed to fetch 15M", updatedAt: new Date().toISOString() };
  }

  const retest = detectRetest(ohlc15m, bias);
  if (!retest.confirmed) {
    return { symbol, state: "FLAT", confidence: 40, layer1: bias, layer2: "No retest formed", updatedAt: new Date().toISOString() };
  }

  console.log(`[v0] ${symbol} Layer 2: retest confirmed at ${retest.retestLevel}`);

  // Layer 3: 5M Momentum Entry
  const ohlc5m = await getOHLC(pair, 5, 20);
  if (ohlc5m.length === 0) {
    return { symbol, state: "FLAT", confidence: 50, layer1: bias, layer2: "Retest", layer3: "Failed to fetch 5M", updatedAt: new Date().toISOString() };
  }

  const momentum = detectMomentumEntry(ohlc5m, bias);
  if (!momentum.triggered) {
    return { symbol, state: "FLAT", confidence: 55, layer1: bias, layer2: "Retest", layer3: "Waiting for 5M trigger", updatedAt: new Date().toISOString() };
  }

  console.log(`[v0] ${symbol} Layer 3: momentum entry at ${momentum.entryPrice}`);

  // All 3 layers aligned - generate trade signal
  const entry = momentum.entryPrice;
  const sl = retest.retestLevel;
  const risk = Math.abs(entry - sl);
  const tp = entry + (bias === "bullish" ? risk * 1.5 : -risk * 1.5);
  const riskReward = risk > 0 ? Math.abs(tp - entry) / risk : 0;

  return {
    symbol,
    state: bias === "bullish" ? "LONG" : "SHORT",
    entry,
    stopLoss: sl,
    takeProfit: tp,
    riskReward: parseFloat(riskReward.toFixed(2)),
    confidence: 75,
    layer1: `${bias} break`,
    layer2: "Retest",
    layer3: "Momentum",
    updatedAt: new Date().toISOString(),
  };
}
