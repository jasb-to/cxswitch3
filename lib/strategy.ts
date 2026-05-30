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
  state: "WAIT" | "WATCH" | "BUILDING" | "SNIPER";
  bias: "Bullish" | "Bearish" | "Neutral";
  confidence: number;
  adx: number;
  stochK: number;
  stochD: number;
  reason: string;
  updatedAt: string;
}

// Calculate ADX
function calculateADX(candles: Candle[], period: number = 14): { adx: number; prevAdx: number } {
  if (candles.length < period + 1) return { adx: 0, prevAdx: 0 };

  // Calculate current ADX
  let plusDM = 0, minusDM = 0, trueRange = 0;
  for (let i = Math.max(1, candles.length - period); i < candles.length; i++) {
    const curr = candles[i];
    const prev = candles[i - 1];

    const upMove = curr.high - prev.high;
    const downMove = prev.low - curr.low;

    if (upMove > 0 && upMove > downMove) plusDM += upMove;
    if (downMove > 0 && downMove > upMove) minusDM += downMove;

    const tr1 = curr.high - curr.low;
    const tr2 = Math.abs(curr.high - prev.close);
    const tr3 = Math.abs(curr.low - prev.close);
    trueRange += Math.max(tr1, tr2, tr3);
  }

  const avgTR = trueRange / period;
  const plusDI = (plusDM / avgTR) * 100;
  const minusDI = (minusDM / avgTR) * 100;
  const di = Math.abs(plusDI - minusDI) / (plusDI + minusDI);
  const currentAdx = Math.round(di * 100 * 10) / 10;

  // Calculate previous ADX (one period back)
  let prevAdx = 0;
  if (candles.length >= period + 2) {
    let plusDM_prev = 0, minusDM_prev = 0, trueRange_prev = 0;
    for (let i = Math.max(1, candles.length - period - 1); i < candles.length - 1; i++) {
      const curr = candles[i];
      const prev = candles[i - 1];

      const upMove = curr.high - prev.high;
      const downMove = prev.low - curr.low;

      if (upMove > 0 && upMove > downMove) plusDM_prev += upMove;
      if (downMove > 0 && downMove > upMove) minusDM_prev += downMove;

      const tr1 = curr.high - curr.low;
      const tr2 = Math.abs(curr.high - prev.close);
      const tr3 = Math.abs(curr.low - prev.close);
      trueRange_prev += Math.max(tr1, tr2, tr3);
    }

    const avgTR_prev = trueRange_prev / period;
    const plusDI_prev = (plusDM_prev / avgTR_prev) * 100;
    const minusDI_prev = (minusDM_prev / avgTR_prev) * 100;
    const di_prev = Math.abs(plusDI_prev - minusDI_prev) / (plusDI_prev + minusDI_prev);
    prevAdx = Math.round(di_prev * 100 * 10) / 10;
  }

  return { adx: currentAdx, prevAdx };
}

// Calculate Stochastic K and D (with K/D crossover detection)
function calculateStochKD(candles: Candle[], period: number = 14, smoothK: number = 3, smoothD: number = 3) {
  if (candles.length < period) return { K: 50, D: 50, prevK: 50, prevD: 50, kCrossAboveD: false, kCrossBelowD: false };

  // Calculate fast K
  const slice = candles.slice(-period);
  const lowestLow = Math.min(...slice.map(c => c.low));
  const highestHigh = Math.max(...slice.map(c => c.high));
  const currentClose = candles[candles.length - 1].close;
  const fastK = ((currentClose - lowestLow) / (highestHigh - lowestLow)) * 100;

  // Smooth K over smoothK periods
  let K_values: number[] = [];
  for (let i = Math.max(0, candles.length - smoothK); i < candles.length; i++) {
    const slice_i = candles.slice(Math.max(0, i - period + 1), i + 1);
    const low_i = Math.min(...slice_i.map(c => c.low));
    const high_i = Math.max(...slice_i.map(c => c.high));
    const k_i = ((candles[i].close - low_i) / (high_i - low_i)) * 100;
    K_values.push(k_i);
  }
  const K = K_values.length > 0 ? K_values.reduce((a, b) => a + b) / K_values.length : fastK;

  // D is SMA of K
  const D = K_values.length > smoothD ? K_values.slice(-smoothD).reduce((a, b) => a + b) / smoothD : K;

  // Previous K and D
  let prevK = K, prevD = D;
  if (candles.length > smoothK) {
    const priorSlice = candles.slice(Math.max(0, candles.length - smoothK - 1), candles.length - 1);
    if (priorSlice.length >= period) {
      const low_prior = Math.min(...priorSlice.map(c => c.low));
      const high_prior = Math.max(...priorSlice.map(c => c.high));
      prevK = ((candles[candles.length - 2].close - low_prior) / (high_prior - low_prior)) * 100;
      prevD = prevK;
    }
  }

  // Detect crossovers
  const kCrossAboveD = prevK <= prevD && K > D;
  const kCrossBelowD = prevK >= prevD && K < D;

  return { K: Math.round(K * 10) / 10, D: Math.round(D * 10) / 10, prevK: Math.round(prevK * 10) / 10, prevD: Math.round(prevD * 10) / 10, kCrossAboveD, kCrossBelowD };
}

// 4H Bias: Bullish/Bearish from structure (no signals)
function calculate4HBias(candles: Candle[]): "Bullish" | "Bearish" | "Neutral" {
  if (candles.length < 10) return "Neutral";

  const last5 = candles.slice(-5);
  const highs = last5.map(c => c.high);
  const lows = last5.map(c => c.low);

  // Higher highs and higher lows = Bullish
  const higherHighs = highs[4] > highs[3] && highs[3] > highs[2];
  const higherLows = lows[4] > lows[3] && lows[3] > lows[2];

  // Lower highs and lower lows = Bearish
  const lowerHighs = highs[4] < highs[3] && highs[3] < highs[2];
  const lowerLows = lows[4] < lows[3] && lows[3] < lows[2];

  // Price vs trendline (20-period SMA)
  const sma20 = candles.slice(-20).reduce((sum, c) => sum + c.close, 0) / 20;
  const currentPrice = candles[candles.length - 1].close;

  if ((higherHighs && higherLows) || currentPrice > sma20) return "Bullish";
  if ((lowerHighs && lowerLows) || currentPrice < sma20) return "Bearish";

  return "Neutral";
}

// 1H Confirmation: Structure + Stoch direction + ADX > 18 (updated threshold)
function calculate1HConfirmation(candles: Candle[], adx: number): "Bullish" | "Bearish" | "Neutral" {
  if (adx < 18) return "Neutral";
  if (candles.length < 5) return "Neutral";

  const last5 = candles.slice(-5);
  const highs = last5.map(c => c.high);
  const lows = last5.map(c => c.low);

  // Bullish structure: higher highs + higher lows + Stoch rising
  const bullishStructure = highs[4] > highs[3] && lows[4] > lows[3];
  const stochRising = candles[candles.length - 1].close > candles[Math.max(0, candles.length - 2)].close;

  // Bearish structure: lower highs + lower lows + Stoch falling
  const bearishStructure = highs[4] < highs[3] && lows[4] < lows[3];
  const stochFalling = candles[candles.length - 1].close < candles[Math.max(0, candles.length - 2)].close;

  if (bullishStructure && stochRising) return "Bullish";
  if (bearishStructure && stochFalling) return "Bearish";

  return "Neutral";
}

export function generateSignal(
  symbol: Symbol,
  candles4H: Candle[],
  candles1H: Candle[],
  candles15M: Candle[]
): Signal {
  // Reverse to chronological order
  const c4H = candles4H.slice().reverse();
  const c1H = candles1H.slice().reverse();
  const c15M = candles15M.slice().reverse();

  if (c4H.length < 5 || c1H.length < 5 || c15M.length < 14) {
    return {
      symbol,
      price: 0,
      state: "WAIT",
      bias: "Neutral",
      confidence: 0,
      adx: 0,
      stochK: 0,
      stochD: 0,
      reason: "Insufficient data",
      updatedAt: new Date().toISOString(),
    };
  }

  const currentPrice = c15M[c15M.length - 1].close;
  const { adx, prevAdx } = calculateADX(c15M);
  const stochKD = calculateStochKD(c15M);
  const adxSlope = adx >= prevAdx - 0.3; // Soft slope: allows flat or slight dip during early trend formation

  // Step 1: 4H Bias (Direction only)
  const bias4H = calculate4HBias(c4H);

  // Step 2: 1H Confirmation (requires ADX > 20)
  const confirmation1H = calculate1HConfirmation(c1H, adx);

  // Step 3: 15M Entry Trigger - Immediate SNIPER execution
  const { kCrossAboveD, kCrossBelowD } = stochKD;
  
  // SNIPER trigger condition: setup valid + crossover signal
  const buildingValid = bias4H !== "Neutral" && confirmation1H !== "Neutral" && adx >= 22;
  const sniperTrigger = buildingValid && (kCrossAboveD || kCrossBelowD);

  // Determine state based on ADX (adjusted thresholds: 18, 18-22, 22+)
  let state: "WAIT" | "WATCH" | "BUILDING" | "SNIPER" = "WAIT";
  let reason = "";

  if (adx < 18) {
    state = "WAIT";
    reason = `ADX ${adx.toFixed(1)} < 18: Range/choppy - no trade`;
  } else if (adx < 22) {
    state = "WATCH";
    reason = `ADX ${adx.toFixed(1)} (18-22): Weak trend - monitoring 4H=${bias4H}, 1H=${confirmation1H}`;
  } else {
    // ADX >= 22: Check for immediate SNIPER trigger
    if (sniperTrigger) {
      state = "SNIPER";
      reason = `BUILDING confirmed → K crossover detected (K=${stochKD.K.toFixed(1)}) → SNIPER ENTRY FIRED at ADX ${adx.toFixed(1)}`;
    } else if (buildingValid) {
      state = "BUILDING";
      reason = `Setup valid: 4H=${bias4H}, 1H=${confirmation1H}, ADX=${adx.toFixed(1)} - waiting for K/D crossover trigger`;
    } else if ((bias4H === "Bullish" && confirmation1H === "Bullish") || (bias4H === "Bearish" && confirmation1H === "Bearish")) {
      state = "BUILDING";
      reason = `Setup aligned: 4H=${bias4H}, 1H=${confirmation1H}, but ADX ${adx.toFixed(1)} < 22 threshold`;
    } else {
      state = "WAIT";
      reason = `ADX ${adx.toFixed(1)} but alignment missing: 4H=${bias4H}, 1H=${confirmation1H}`;
    }
  }

  // Calculate confidence score
  let confidence = 0;
  if (bias4H !== "Neutral") confidence += 30;
  if (confirmation1H !== "Neutral") confidence += 30;
  if (kCrossAboveD || kCrossBelowD) confidence += 20;
  if (adx > 22) confidence += 20;

  return {
    symbol,
    price: Math.round(currentPrice * 100) / 100,
    state,
    bias: bias4H,
    confidence: Math.min(100, confidence),
    adx: Math.round(adx * 10) / 10,
    stochK: Math.round(stochKD.K * 10) / 10,
    stochD: Math.round(stochKD.D * 10) / 10,
    reason,
    updatedAt: new Date().toISOString(),
  };
}
