export type Symbol = "BTC" | "ETH" | "SOL";

export interface Candle {
  time: number;
  open: number;
  high: number;
  low: number;
  close: number;
  volume: number;
}

export interface Signal {
  symbol: Symbol;
  price: number;
  status: "LONG" | "SHORT" | "NO_SIGNAL";
  state: "WAIT" | "WATCH" | "LONG" | "SHORT";
  entry?: number;
  stopLoss?: number;
  takeProfit?: number;
  confidence: number;
  adx: number;
  stochK: number;
  marketBias: "Bullish" | "Bearish" | "Neutral";
  reason: string;
  updatedAt: string;
}

// Calculate ADX
function calculateADX(candles: Candle[], period: number = 14): number {
  if (candles.length < period + 1) return 0;

  let plus_dm_sum = 0;
  let minus_dm_sum = 0;
  let tr_sum = 0;

  for (let i = 1; i <= period; i++) {
    const curr = candles[i];
    const prev = candles[i - 1];

    const tr1 = curr.high - curr.low;
    const tr2 = Math.abs(curr.high - prev.close);
    const tr3 = Math.abs(curr.low - prev.close);
    const tr = Math.max(tr1, tr2, tr3);

    const up_move = curr.high - prev.high;
    const down_move = prev.low - curr.low;

    let plus_dm = 0;
    let minus_dm = 0;

    if (up_move > down_move && up_move > 0) plus_dm = up_move;
    if (down_move > up_move && down_move > 0) minus_dm = down_move;

    plus_dm_sum += plus_dm;
    minus_dm_sum += minus_dm;
    tr_sum += tr;
  }

  const plus_di = (plus_dm_sum / tr_sum) * 100;
  const minus_di = (minus_dm_sum / tr_sum) * 100;
  const dx = Math.abs(plus_di - minus_di) / (plus_di + minus_di) * 100;
  return Math.round(Math.max(0, Math.min(100, dx)) * 100) / 100;
}

// Calculate Stochastic RSI
function calculateStochRSI(candles: Candle[], period: number = 14): number {
  if (candles.length < period) return 50;

  let gains = 0;
  let losses = 0;

  for (let i = candles.length - period; i < candles.length; i++) {
    const change = candles[i].close - (i > 0 ? candles[i - 1].close : candles[i].close);
    if (change > 0) gains += change;
    else losses -= change;
  }

  const avg_gain = gains / period;
  const avg_loss = losses / period;
  const rs = avg_gain / (avg_loss || 0.0001);
  const rsi = 100 - 100 / (1 + rs);
  return Math.round(Math.max(0, Math.min(100, rsi)));
}

// Calculate Stochastic K and D (for crossover detection)
function calculateStochKD(candles: Candle[], period: number = 14, smoothK: number = 3, smoothD: number = 3) {
  if (candles.length < period) return { K: 50, D: 50, prevK: 50, prevD: 50 };

  // Calculate Stochastic %K
  let lowestLow = candles[candles.length - 1].low;
  let highestHigh = candles[candles.length - 1].high;

  for (let i = Math.max(0, candles.length - period); i < candles.length; i++) {
    lowestLow = Math.min(lowestLow, candles[i].low);
    highestHigh = Math.max(highestHigh, candles[i].high);
  }

  const fastK = ((candles[candles.length - 1].close - lowestLow) / (highestHigh - lowestLow)) * 100;

  // Smooth K
  let K_sum = 0;
  for (let i = Math.max(0, candles.length - smoothK); i < candles.length; i++) {
    const low = Math.min(...candles.slice(Math.max(0, i - period), i + 1).map(c => c.low));
    const high = Math.max(...candles.slice(Math.max(0, i - period), i + 1).map(c => c.high));
    K_sum += ((candles[i].close - low) / (high - low)) * 100;
  }
  const K = K_sum / smoothK;

  // D is SMA of K
  let D_sum = 0;
  for (let i = Math.max(0, candles.length - smoothD); i < candles.length; i++) {
    const low = Math.min(...candles.slice(Math.max(0, i - period), i + 1).map(c => c.low));
    const high = Math.max(...candles.slice(Math.max(0, i - period), i + 1).map(c => c.high));
    const k = ((candles[i].close - low) / (high - low)) * 100;
    D_sum += k;
  }
  const D = D_sum / smoothD;

  // Previous K and D from prior candle
  let prevK = 50, prevD = 50;
  if (candles.length > smoothK) {
    const priorIndex = candles.length - smoothK - 1;
    const low = Math.min(...candles.slice(Math.max(0, priorIndex - period), priorIndex + 1).map(c => c.low));
    const high = Math.max(...candles.slice(Math.max(0, priorIndex - period), priorIndex + 1).map(c => c.high));
    prevK = ((candles[priorIndex].close - low) / (high - low)) * 100;
    prevD = prevK; // Simplified
  }

  return { K: Math.round(K), D: Math.round(D), prevK: Math.round(prevK), prevD: Math.round(prevD) };
}

// 4H Bias: Determine Bullish/Bearish from structure
function determine4HBias(candles: Candle[]): "Bullish" | "Bearish" | "Neutral" {
  if (candles.length < 10) return "Neutral";

  const current = candles[candles.length - 1];
  const last20 = candles.slice(-20);

  // Check for higher highs and higher lows (Bullish)
  let higherHighs = 0;
  let higherLows = 0;

  for (let i = 1; i < last20.length; i++) {
    if (last20[i].high > last20[i - 1].high) higherHighs++;
    if (last20[i].low > last20[i - 1].low) higherLows++;
  }

  // Check for lower highs and lower lows (Bearish)
  let lowerHighs = 0;
  let lowerLows = 0;

  for (let i = 1; i < last20.length; i++) {
    if (last20[i].high < last20[i - 1].high) lowerHighs++;
    if (last20[i].low < last20[i - 1].low) lowerLows++;
  }

  if (higherHighs > 8 && higherLows > 8) return "Bullish";
  if (lowerHighs > 8 && lowerLows > 8) return "Bearish";

  return "Neutral";
}

// 1H Confirmation: Bullish/Bearish structure + Stoch direction + ADX
function determine1HConfirmation(candles: Candle[], adx: number): "Bullish" | "Bearish" | "Neutral" {
  if (adx < 20) return "Neutral"; // ADX too weak

  if (candles.length < 10) return "Neutral";

  const last10 = candles.slice(-10);

  // Check structure
  let higherHighs = 0;
  let higherLows = 0;
  let lowerHighs = 0;
  let lowerLows = 0;

  for (let i = 1; i < last10.length; i++) {
    if (last10[i].high > last10[i - 1].high) higherHighs++;
    else if (last10[i].high < last10[i - 1].high) lowerHighs++;

    if (last10[i].low > last10[i - 1].low) higherLows++;
    else if (last10[i].low < last10[i - 1].low) lowerLows++;
  }

  // Stoch RSI direction
  const stochK = calculateStochRSI(candles);
  const stochRising = candles[candles.length - 1].close > candles[candles.length - 2].close;

  if (higherHighs >= 4 && higherLows >= 4 && stochRising) return "Bullish";
  if (lowerHighs >= 4 && lowerLows >= 4 && !stochRising) return "Bearish";

  return "Neutral";
}

// 15M Entry Trigger: Detect Stoch K/D crossovers
function detect15MEntry(candles: Candle[], adx: number): "LONG" | "SHORT" | "NONE" {
  if (adx < 20) return "NONE";
  if (candles.length < 5) return "NONE";

  const { K, D, prevK, prevD } = calculateStochKD(candles);

  // LONG: K crosses above D, cross below 35, ADX > 20
  if (prevK < prevD && K > D && K < 35 && adx > 20) {
    return "LONG";
  }

  // SHORT: K crosses below D, cross above 65, ADX > 20
  if (prevK > prevD && K < D && K > 65 && adx > 20) {
    return "SHORT";
  }

  return "NONE";
}

export function generateSignal(
  symbol: Symbol,
  candles4H: Candle[],
  candles15M: Candle[],
  candles5M?: Candle[]
): Signal {
  // Reverse to chronological order
  const c4H = candles4H.slice().reverse();
  const c1H = candles15M.slice().reverse(); // Using 15M as 1H proxy for this implementation
  const c15M = candles15M.slice().reverse();

  if (c15M.length < 30 || c4H.length < 20 || c1H.length < 20) {
    return {
      symbol,
      price: 0,
      status: "NO_SIGNAL",
      state: "WAIT",
      confidence: 0,
      adx: 0,
      stochK: 0,
      marketBias: "Neutral",
      reason: "Insufficient data",
      updatedAt: new Date().toISOString(),
    };
  }

  const currentPrice = c15M[c15M.length - 1].close;
  const adx15M = calculateADX(c15M);
  const stochK15M = calculateStochRSI(c15M);
  const atr = calculateATR(c15M);

  // Determine bias and confirmation
  const bias4H = determine4HBias(c4H);
  const confirm1H = determine1HConfirmation(c1H, adx15M);
  const entry15M = detect15MEntry(c15M, adx15M);

  // Determine state
  let state: "WAIT" | "WATCH" | "LONG" | "SHORT" = "WAIT";
  let status: "LONG" | "SHORT" | "NO_SIGNAL" = "NO_SIGNAL";
  let entry: number | undefined;
  let stopLoss: number | undefined;
  let takeProfit: number | undefined;
  let reason = "";

  // ADX filter
  if (adx15M < 20) {
    state = "WAIT";
    reason = `ADX ${adx15M.toFixed(1)} < 20: Range/no trade`;
  } else if (adx15M < 25) {
    state = "WATCH";
    reason = `ADX ${adx15M.toFixed(1)}: Weak trend - monitoring`;
  } else {
    // Check for LONG signal
    if (bias4H === "Bullish" && confirm1H === "Bullish" && entry15M === "LONG") {
      state = "LONG";
      status = "LONG";
      entry = currentPrice;
      const atrCap = Math.min(atr, entry * 0.05);
      stopLoss = Math.round((entry - 1.5 * atrCap) * 100) / 100;
      takeProfit = Math.round((entry + 4 * atrCap) * 100) / 100;
      reason = `LONG: 4H Bullish + 1H Bullish + 15M K cross above D`;
    }
    // Check for SHORT signal
    else if (bias4H === "Bearish" && confirm1H === "Bearish" && entry15M === "SHORT") {
      state = "SHORT";
      status = "SHORT";
      entry = currentPrice;
      const atrCap = Math.min(atr, entry * 0.05);
      stopLoss = Math.round((entry + 1.5 * atrCap) * 100) / 100;
      takeProfit = Math.round((entry - 4 * atrCap) * 100) / 100;
      reason = `SHORT: 4H Bearish + 1H Bearish + 15M K cross below D`;
    }
    // WATCH state for potential entries
    else if ((bias4H === "Bullish" && confirm1H === "Bullish") || (bias4H === "Bearish" && confirm1H === "Bearish")) {
      state = "WATCH";
      reason = `${bias4H} setup ready, waiting for 15M Stoch crossover`;
    } else {
      state = "WAIT";
      reason = "No alignment across timeframes";
    }
  }

  // Calculate confidence score
  let confidenceScore = 0;
  if (bias4H !== "Neutral") confidenceScore += 30;
  if (confirm1H !== "Neutral") confidenceScore += 30;
  if (entry15M !== "NONE") confidenceScore += 20;
  if (adx15M > 25) confidenceScore += 20;

  return {
    symbol,
    price: Math.round(currentPrice * 100) / 100,
    status,
    state,
    entry: entry ? Math.round(entry * 100) / 100 : undefined,
    stopLoss,
    takeProfit,
    confidence: confidenceScore,
    adx: adx15M,
    stochK: stochK15M,
    marketBias: bias4H,
    reason,
    updatedAt: new Date().toISOString(),
  };
}

// Helper function for ATR
function calculateATR(candles: Candle[], period: number = 14): number {
  if (candles.length < period + 1) return 0;
  let tr_sum = 0;
  const start = Math.max(1, candles.length - period);
  for (let i = start; i < candles.length; i++) {
    const curr = candles[i];
    const prev = candles[i - 1];
    const tr1 = curr.high - curr.low;
    const tr2 = Math.abs(curr.high - prev.close);
    const tr3 = Math.abs(curr.low - prev.close);
    tr_sum += Math.max(tr1, tr2, tr3);
  }
  return tr_sum / period;
}
