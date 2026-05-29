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
  entry?: number;
  stopLoss?: number;
  takeProfit?: number;
  riskReward?: number;
  confidence: number;
  adx: number;
  stochK: number;
  marketBias: "Bullish" | "Bearish" | "Neutral";
  entryType?: "5M Momentum" | "4H Structure";
  volumeRatio?: number;
  entry5MConfirmed?: boolean;
  nearestSwingLevel?: number;
  distanceToSwing?: number; // as percentage
  reason: string;
  updatedAt: string;
}

// Calculate ATR (Average True Range)
function calculateATR(candles: Candle[], period: number = 14): number {
  if (candles.length < period + 1) return 0;

  let tr_sum = 0;
  for (let i = 1; i < candles.length; i++) {
    const curr = candles[i];
    const prev = candles[i - 1];

    const tr1 = curr.high - curr.low;
    const tr2 = Math.abs(curr.high - prev.close);
    const tr3 = Math.abs(curr.low - prev.close);

    tr_sum += Math.max(tr1, tr2, tr3);
  }

  return tr_sum / period;
}

// Calculate ADX (Average Directional Index)
function calculateADX(candles: Candle[], period: number = 14): number {
  if (candles.length < period + 1) return 0;

  let plus_dm_sum = 0;
  let minus_dm_sum = 0;
  let tr_sum = 0;

  for (let i = 1; i < candles.length; i++) {
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

  const di_sum = plus_di + minus_di;
  const adx = Math.abs(plus_di - minus_di) / di_sum * 100;

  return Math.round(adx * 100) / 100;
}

// Calculate Stochastic RSI
function calculateStochRSI(candles: Candle[], period: number = 14): number {
  if (candles.length < period) return 50;

  // Calculate RSI first
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

  // Stochastic of RSI (use last 14 RSI values, simplified to current)
  return Math.round(Math.max(0, Math.min(100, rsi)));
}

// Find swing highs and lows
function findSwings(
  candles: Candle[],
  lookback: number = 20
): { highLevel: number; lowLevel: number } {
  if (candles.length < 3) return { highLevel: 0, lowLevel: 0 };

  let highLevel = candles[candles.length - 1].high;
  let lowLevel = candles[candles.length - 1].low;

  const start = Math.max(0, candles.length - lookback);

  for (let i = start; i < candles.length; i++) {
    if (candles[i].high > highLevel) highLevel = candles[i].high;
    if (candles[i].low < lowLevel) lowLevel = candles[i].low;
  }

  return { highLevel, lowLevel };
}

// Generate signal based on structure
export function generateSignal(
  symbol: Symbol,
  candles4H: Candle[],
  candles15M: Candle[],
  candles5M?: Candle[]
): Signal {
  const currentPrice = candles4H[candles4H.length - 1].close;
  const adx = calculateADX(candles4H);
  const stochK = calculateStochRSI(candles4H);
  const atr = calculateATR(candles4H);
  const { highLevel, lowLevel } = findSwings(candles4H, 50);

  // Default: no signal
  let status: "LONG" | "SHORT" | "NO_SIGNAL" = "NO_SIGNAL";
  let entry: number | undefined;
  let stopLoss: number | undefined;
  let takeProfit: number | undefined;
  let reason = "Waiting for setup";

  // ADX > 20 required to avoid chop
  if (adx < 20) {
    reason = `ADX too low (${adx.toFixed(1)}), skipping choppy market`;
    return {
      symbol,
      price: currentPrice,
      status,
      adx,
      stochK,
      confidence: 0,
      marketBias: "Neutral",
      reason,
      updatedAt: new Date().toISOString(),
    };
  }

  // LONG Signal: Price above resistance + oversold stoch + bullish 15M
  const stoch15M = calculateStochRSI(candles15M);
  const ema8_15M =
    candles15M.slice(-8).reduce((a, b) => a + b.close, 0) / 8;
  const ema21_15M =
    candles15M.slice(-21).reduce((a, b) => a + b.close, 0) / 21;

  // Calculate 4H market bias (EMA cross)
  const ema8_4H =
    candles4H.slice(-8).reduce((a, b) => a + b.close, 0) / 8;
  const ema21_4H =
    candles4H.slice(-21).reduce((a, b) => a + b.close, 0) / 21;

  let marketBias: "Bullish" | "Bearish" | "Neutral" = "Neutral";
  if (ema8_4H > ema21_4H) {
    marketBias = "Bullish";
  } else if (ema8_4H < ema21_4H) {
    marketBias = "Bearish";
  }

  // Calculate 5M momentum and volume spike detection
  let entry5MConfirmed = false;
  let entryType: "5M Momentum" | "4H Structure" | undefined;
  let volumeRatio = 1;

  if (candles5M && candles5M.length >= 30) {
    const ema8_5M = candles5M.slice(-8).reduce((a, b) => a + b.close, 0) / 8;
    const ema21_5M = candles5M.slice(-21).reduce((a, b) => a + b.close, 0) / 21;
    const avgVolume = candles5M.slice(-20).reduce((a, b) => a + b.volume, 0) / 20;
    const currentVolume = candles5M[candles5M.length - 1].volume;

    volumeRatio = Math.round((currentVolume / avgVolume) * 100) / 100;

    // 5M momentum confirmed: price above 5M EMA + volume spike
    entry5MConfirmed = currentVolume > avgVolume * 1.5 && (
      (marketBias === "Bullish" && ema8_5M > ema21_5M) ||
      (marketBias === "Bearish" && ema8_5M < ema21_5M)
    );
  }

  if (
    currentPrice > highLevel &&
    stochK < 35 &&
    stoch15M < 35 &&
    ema8_15M > ema21_15M
  ) {
    status = "LONG";
    entry = currentPrice;
    stopLoss = Math.round((entry - 1.5 * atr) * 100) / 100;
    takeProfit = Math.round((entry + 4 * atr) * 100) / 100;
    
    // Determine entry type based on 5M confirmation
    if (entry5MConfirmed) {
      entryType = "5M Momentum";
      reason = `5M Momentum: vol spike (${volumeRatio.toFixed(1)}x) + bullish EMA + 4H break`;
    } else {
      entryType = "4H Structure";
      reason = `4H break above resistance + oversold stoch (${stochK.toFixed(0)}) + 15M bullish`;
    }
  }

  // SHORT Signal: Price below support + overbought stoch + bearish 15M
  else if (
    currentPrice < lowLevel &&
    stochK > 65 &&
    stoch15M > 65 &&
    ema8_15M < ema21_15M
  ) {
    status = "SHORT";
    entry = currentPrice;
    stopLoss = Math.round((entry + 1.5 * atr) * 100) / 100;
    takeProfit = Math.round((entry - 4 * atr) * 100) / 100;
    
    // Determine entry type based on 5M confirmation
    if (entry5MConfirmed) {
      entryType = "5M Momentum";
      reason = `5M Momentum: vol spike (${volumeRatio.toFixed(1)}x) + bearish EMA + 4H break`;
    } else {
      entryType = "4H Structure";
      reason = `4H break below support + overbought stoch (${stochK.toFixed(0)}) + 15M bearish`;
    }
  }

  // Calculate risk/reward
  let riskReward: number | undefined;
  if (entry && stopLoss && takeProfit) {
    const risk = Math.abs(entry - stopLoss);
    const reward = Math.abs(takeProfit - entry);
    riskReward = Math.round((reward / risk) * 100) / 100;
  }

  // Calculate distance to nearest swing level
  let nearestSwingLevel: number | undefined;
  let distanceToSwing: number | undefined;

  if (status === "NO_SIGNAL") {
    const distToHigh = Math.abs(currentPrice - highLevel);
    const distToLow = Math.abs(currentPrice - lowLevel);

    if (distToHigh < distToLow) {
      nearestSwingLevel = highLevel;
      distanceToSwing = Math.round(((highLevel - currentPrice) / currentPrice) * 10000) / 100;
    } else {
      nearestSwingLevel = lowLevel;
      distanceToSwing = Math.round(((currentPrice - lowLevel) / currentPrice) * 10000) / 100;
    }
  }

  return {
    symbol,
    price: Math.round(currentPrice * 100) / 100,
    status,
    entry: entry ? Math.round(entry * 100) / 100 : undefined,
    stopLoss,
    takeProfit,
    riskReward,
    confidence: status === "NO_SIGNAL" ? 0 : Math.round((adx / 50) * 100),
    adx: Math.round(adx * 100) / 100,
    stochK: Math.round(stochK),
    marketBias,
    entryType,
    volumeRatio: Math.round(volumeRatio * 100) / 100,
    entry5MConfirmed,
    nearestSwingLevel: nearestSwingLevel ? Math.round(nearestSwingLevel * 100) / 100 : undefined,
    distanceToSwing,
    reason,
    updatedAt: new Date().toISOString(),
  };
}
