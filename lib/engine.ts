export type Symbol = "BTC" | "ETH" | "SOL";

export interface LayerStatus {
  status: string;
  detail: string;
  met: boolean;
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
  layer1: LayerStatus;
  layer2: LayerStatus;
  layer3: LayerStatus;
  bias4h: string;
  updatedAt: string;
}

const PAIRS: Record<Symbol, string> = {
  BTC: "XBTUSD",
  ETH: "ETHUSD",
  SOL: "SOLUSD",
};

interface OHLC {
  time: number;
  open: number;
  high: number;
  low: number;
  close: number;
  volume: number;
}

async function fetchOHLC(symbol: Symbol, interval: number, count: number = 20): Promise<OHLC[]> {
  const pair = PAIRS[symbol];
  const url = `https://api.kraken.com/0/public/OHLC?pair=${pair}&interval=${interval}&since=${Math.floor(Date.now() / 1000) - interval * count * 60}`;

  try {
    const res = await fetch(url, { cache: "no-store" });
    const data = await res.json();
    if (data.error?.length) throw new Error(data.error.join(", "));

    const raw = data.result[pair] || data.result[Object.keys(data.result)[0]];
    if (!raw) return [];

    return raw.slice(-count).map((c: any[]) => ({
      time: c[0],
      open: parseFloat(c[1]),
      high: parseFloat(c[2]),
      low: parseFloat(c[3]),
      close: parseFloat(c[4]),
      volume: parseFloat(c[6]),
    }));
  } catch (err) {
    console.error(`[OHLC] ${symbol} ${interval}m failed:`, err);
    return [];
  }
}

function findSwingHighs(candles: OHLC[], count: number = 2): number[] {
  const highs: number[] = [];
  for (let i = 2; i < candles.length - 2; i++) {
    if (candles[i].high > candles[i-1].high && candles[i].high > candles[i-2].high &&
        candles[i].high > candles[i+1].high && candles[i].high > candles[i+2].high) {
      highs.push(candles[i].high);
      if (highs.length >= count) break;
    }
  }
  return highs;
}

function findSwingLows(candles: OHLC[], count: number = 2): number[] {
  const lows: number[] = [];
  for (let i = 2; i < candles.length - 2; i++) {
    if (candles[i].low < candles[i-1].low && candles[i].low < candles[i-2].low &&
        candles[i].low < candles[i+1].low && candles[i].low < candles[i+2].low) {
      lows.push(candles[i].low);
      if (lows.length >= count) break;
    }
  }
  return lows;
}

function detectTrendlineBreak(candles: OHLC[]): { bias: string; broken: boolean; detail: string } {
  if (candles.length < 10) {
    return { bias: "Neutral", broken: false, detail: "Insufficient data" };
  }

  const recent = candles.slice(-5);
  const previous = candles.slice(-10, -5);
  const currentClose = candles[candles.length - 1].close;

  // Find swing points for trendlines
  const swingHighs = findSwingHighs(candles.slice(0, -3));
  const swingLows = findSwingLows(candles.slice(0, -3));

  // Descending trendline (bearish) - connect 2 swing highs
  let bearishBreak = false;
  if (swingHighs.length >= 2) {
    const trendlineDrop = swingHighs[0] - swingHighs[1];
    const candlesBetween = 5; // approximate
    const slope = trendlineDrop / candlesBetween;
    const expectedHigh = swingHighs[1] - slope * 3;
    bearishBreak = currentClose > expectedHigh * 1.005;
  }

  // Ascending trendline (bullish) - connect 2 swing lows
  let bullishBreak = false;
  if (swingLows.length >= 2) {
    const trendlineRise = swingLows[1] - swingLows[0];
    const candlesBetween = 5;
    const slope = trendlineRise / candlesBetween;
    const expectedLow = swingLows[1] + slope * 3;
    bullishBreak = currentClose < expectedLow * 0.995;
  }

  // Also check simple structure
  const recentHigherLows = recent.every((c, i) => i === 0 || c.low >= recent[i-1].low * 0.998);
  const recentHigherHighs = recent.every((c, i) => i === 0 || c.high >= recent[i-1].high * 0.998);
  const recentLowerHighs = recent.every((c, i) => i === 0 || c.high <= recent[i-1].high * 1.002);
  const recentLowerLows = recent.every((c, i) => i === 0 || c.low <= recent[i-1].low * 1.002);

  if (bullishBreak || (recentHigherLows && recentHigherHighs)) {
    return { bias: "Bullish", broken: true, detail: "Trendline break + HH/HL structure" };
  }

  if (bearishBreak || (recentLowerHighs && recentLowerLows)) {
    return { bias: "Bearish", broken: true, detail: "Trendline break + LH/LL structure" };
  }

  // Check if close to break
  if (swingHighs.length >= 2) {
    const lastHigh = swingHighs[1];
    if (currentClose > lastHigh * 0.99 && currentClose < lastHigh * 1.005) {
      return { bias: "Bullish", broken: false, detail: "Near resistance breakout" };
    }
  }

  if (swingLows.length >= 2) {
    const lastLow = swingLows[1];
    if (currentClose < lastLow * 1.01 && currentClose > lastLow * 0.995) {
      return { bias: "Bearish", broken: false, detail: "Near support breakdown" };
    }
  }

  return { bias: "Neutral", broken: false, detail: "No clear trendline break" };
}

function detectRetest(candles: OHLC[], bias: string): { confirmed: boolean; detail: string; level?: number } {
  if (candles.length < 5) {
    return { confirmed: false, detail: "Insufficient data" };
  }

  const recent = candles.slice(-5);
  const mid = (Math.max(...recent.map(c => c.high)) + Math.min(...recent.map(c => c.low))) / 2;

  if (bias === "Bullish") {
    // Look for pullback that holds above previous support
    const higherLow = recent[0].low < recent[2].low && recent[2].low < recent[4].low;
    const holdsSupport = recent.every(c => c.low > mid * 0.995);

    if (higherLow && holdsSupport) {
      return { confirmed: true, detail: "Higher low formed, holding support", level: recent[4].low };
    }

    // Check if we just had a shallow pullback
    const pullback = (recent[0].high - recent[recent.length - 1].low) / recent[0].high;
    if (pullback > 0.005 && pullback < 0.03) {
      return { confirmed: true, detail: "Shallow pullback to support", level: recent[recent.length - 1].low };
    }

    return { confirmed: false, detail: "Waiting for bullish retest" };
  }

  if (bias === "Bearish") {
    // Look for rally that fails below previous resistance
    const lowerHigh = recent[0].high > recent[2].high && recent[2].high > recent[4].high;
    const underResistance = recent.every(c => c.high < mid * 1.005);

    if (lowerHigh && underResistance) {
      return { confirmed: true, detail: "Lower high formed, under resistance", level: recent[4].high };
    }

    // Check if we just had a shallow rally
    const rally = (recent[recent.length - 1].high - recent[0].low) / recent[0].low;
    if (rally > 0.005 && rally < 0.03) {
      return { confirmed: true, detail: "Shallow rally to resistance", level: recent[recent.length - 1].high };
    }

    return { confirmed: false, detail: "Waiting for bearish retest" };
  }

  return { confirmed: false, detail: "No bias for retest" };
}

function detectMomentumEntry(candles: OHLC[], bias: string): { triggered: boolean; detail: string; entry?: number } {
  if (candles.length < 3) {
    return { triggered: false, detail: "Insufficient data" };
  }

  const last = candles[candles.length - 1];
  const prev = candles[candles.length - 2];
  const prev2 = candles[candles.length - 3];

  // Volume check
  const avgVolume = candles.slice(-5).reduce((s, c) => s + c.volume, 0) / 5;
  const volumeOk = last.volume > avgVolume * 0.8;

  if (bias === "Bullish") {
    const breakUp = last.close > prev.high && last.close > prev2.high;
    const momentum = last.close > prev.close && prev.close > prev2.close * 0.998;

    if (breakUp && momentum && volumeOk) {
      return { triggered: true, detail: "Momentum break above recent highs", entry: last.close };
    }

    if (last.close > prev.close && last.low > prev.low) {
      return { triggered: true, detail: "Bullish continuation", entry: last.close };
    }

    return { triggered: false, detail: "Waiting for bullish momentum" };
  }

  if (bias === "Bearish") {
    const breakDown = last.close < prev.low && last.close < prev2.low;
    const momentum = last.close < prev.close && prev.close < prev2.close * 1.002;

    if (breakDown && momentum && volumeOk) {
      return { triggered: true, detail: "Momentum break below recent lows", entry: last.close };
    }

    if (last.close < prev.close && last.high < prev.high) {
      return { triggered: true, detail: "Bearish continuation", entry: last.close };
    }

    return { triggered: false, detail: "Waiting for bearish momentum" };
  }

  return { triggered: false, detail: "No bias for entry" };
}

export async function evaluate(symbol: Symbol): Promise<Signal> {
  // Fetch all timeframes
  const [candles4h, candles15m, candles5m] = await Promise.all([
    fetchOHLC(symbol, 240, 20),
    fetchOHLC(symbol, 15, 20),
    fetchOHLC(symbol, 5, 10),
  ]);

  const currentPrice = candles4h.length > 0 ? candles4h[candles4h.length - 1].close : 0;

  // Layer 1: 4H Trendline Break
  const layer1Result = detectTrendlineBreak(candles4h);
  const layer1: LayerStatus = {
    status: layer1Result.broken ? `${layer1Result.bias} Break` : layer1Result.bias,
    detail: layer1Result.detail,
    met: layer1Result.broken,
  };

  // Layer 2: 15M Retest (only if Layer 1 has bias)
  let layer2: LayerStatus = { status: "Waiting", detail: "Need 4H break first", met: false };
  if (layer1Result.broken) {
    const retest = detectRetest(candles15m, layer1Result.bias);
    layer2 = {
      status: retest.confirmed ? "Confirmed" : "Scanning",
      detail: retest.detail,
      met: retest.confirmed,
    };
  }

  // Layer 3: 5M Entry Trigger (only if Layer 2 confirmed)
  let layer3: LayerStatus = { status: "Waiting", detail: "Need retest first", met: false };
  let entry: number | undefined;
  let stopLoss: number | undefined;
  let takeProfit: number | undefined;
  let riskReward: number | undefined;
  let state: "FLAT" | "LONG" | "SHORT" = "FLAT";
  let confidence = 0;

  if (layer1Result.broken && layer2.met) {
    const trigger = detectMomentumEntry(candles5m, layer1Result.bias);
    layer3 = {
      status: trigger.triggered ? "Fired" : "Scanning",
      detail: trigger.detail,
      met: trigger.triggered,
    };

    if (trigger.triggered && trigger.entry) {
      entry = trigger.entry;
      state = layer1Result.bias === "Bullish" ? "LONG" : "SHORT";

      // Calculate SL/TP: 1.5x SL distance, 3% TP
      const retest = detectRetest(candles15m, layer1Result.bias);
      const slLevel = retest.level || (state === "LONG" ? candles15m[candles15m.length - 1].low : candles15m[candles15m.length - 1].high);
      const slDistance = Math.abs(entry - slLevel);

      // 1.5x SL: move SL back by 1.5x the retest distance
      stopLoss = state === "LONG" ? entry - slDistance * 1.5 : entry + slDistance * 1.5;
      
      // 3% TP from entry
      takeProfit = state === "LONG" ? entry * 1.03 : entry * 0.97;
      
      // Risk/Reward ratio
      const risk = Math.abs(entry - stopLoss);
      const reward = Math.abs(takeProfit - entry);
      riskReward = risk > 0 ? reward / risk : 0;

      // Confidence based on setup quality
      confidence = 60;
      if (layer1Result.broken) confidence += 10;
      if (layer2.met) confidence += 10;
      if (trigger.triggered) confidence += 10;
      const last = candles5m[candles5m.length - 1];
      if (last.volume > (candles5m.slice(-5).reduce((s, c) => s + c.volume, 0) / 5) * 1.2) confidence += 10;
      confidence = Math.min(95, confidence);
    }
  }

  // If no trigger but close, boost confidence for building
  if (!layer3.met && layer1Result.broken && layer2.met) {
    confidence = 45;
  } else if (layer1Result.broken && !layer2.met) {
    confidence = 30;
  } else if (!layer1Result.broken && layer1Result.bias !== "Neutral") {
    confidence = 20;
  }

  return {
    symbol,
    price: currentPrice,
    state,
    entry,
    stopLoss,
    takeProfit,
    riskReward,
    confidence,
    layer1,
    layer2,
    layer3,
    bias4h: layer1Result.bias,
    updatedAt: new Date().toISOString(),
  };
}
