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

  // Calculate initial directional movements and true range
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

  // Calculate DI values
  let plus_di = (plus_dm_sum / tr_sum) * 100;
  let minus_di = (minus_dm_sum / tr_sum) * 100;

  // Smooth the DI values (simplified smoothing)
  let di_diff_sum = 0;
  let di_sum_sum = 0;

  for (let i = period + 1; i < candles.length; i++) {
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

    plus_dm_sum = plus_dm_sum * 13 / 14 + plus_dm;
    minus_dm_sum = minus_dm_sum * 13 / 14 + minus_dm;
    tr_sum = tr_sum * 13 / 14 + tr;

    plus_di = (plus_dm_sum / tr_sum) * 100;
    minus_di = (minus_dm_sum / tr_sum) * 100;

    const di_diff = Math.abs(plus_di - minus_di);
    const di_sum = plus_di + minus_di;

    di_diff_sum += di_diff;
    di_sum_sum += di_sum;
  }

  // Calculate ADX as smoothed DX
  const dx = (di_diff_sum / (candles.length - period)) / (di_sum_sum / (candles.length - period)) * 100;
  const adx = Math.round(dx * 100) / 100;

  return Math.max(0, Math.min(100, adx));
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
  if (candles.length < 3) {
    const current = candles[candles.length - 1];
    return { highLevel: current.high, lowLevel: current.low };
  }

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

  // ADX threshold varies by symbol (SOL is more volatile, needs lower threshold)
  const adxThreshold = symbol === "SOL" ? 15 : 18;
  
  if (adx < adxThreshold) {
    reason = `ADX too low (${adx.toFixed(1)} < ${adxThreshold}), skipping choppy market`;
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

  console.log(
    `[STRATEGY] ${symbol} 4H: price=${currentPrice.toFixed(2)}, ema8=${ema8_4H.toFixed(2)}, ema21=${ema21_4H.toFixed(2)}, diff=${(ema8_4H - ema21_4H).toFixed(2)}`
  );

  let marketBias: "Bullish" | "Bearish" | "Neutral" = "Neutral";
  if (ema8_4H > ema21_4H) {
    marketBias = "Bullish";
  } else if (ema8_4H < ema21_4H) {
    marketBias = "Bearish";
  }

  // Calculate 5M momentum and volume spike detection
  let entry5MConfirmed = false;
  let entryType: "5M Momentum" | "4H Structure" | undefined;
  let volumeRatio: number | undefined;

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

  // LONG Signal: Price above resistance + bullish 15M EMA (Stoch is confidence only, not gating)
  const longConditions = {
    priceAboveResistance: currentPrice > highLevel,
    ema15MBullish: ema8_15M > ema21_15M,
  };

  console.log(
    `[STRATEGY] ${symbol} LONG conditions: priceAbove=${longConditions.priceAboveResistance} (${currentPrice.toFixed(2)} > ${highLevel.toFixed(2)}), ema15M=${longConditions.ema15MBullish} (${ema8_15M.toFixed(2)} > ${ema21_15M.toFixed(2)}), stochK=${stochK} (confidence only)`
  );

  if (
    longConditions.priceAboveResistance &&
    longConditions.ema15MBullish
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
      reason = `4H break above resistance + 15M bullish EMA`;
    }
  }

  // SHORT Signal: Price below support + bearish 15M EMA (Stoch is confidence only, not gating)
  const shortConditions = {
    priceBelowSupport: currentPrice < lowLevel,
    ema15MBearish: ema8_15M < ema21_15M,
  };

  console.log(
    `[STRATEGY] ${symbol} SHORT conditions: priceBelow=${shortConditions.priceBelowSupport} (${currentPrice.toFixed(2)} < ${lowLevel.toFixed(2)}), ema15M=${shortConditions.ema15MBearish} (${ema8_15M.toFixed(2)} < ${ema21_15M.toFixed(2)}), stochK=${stochK} (confidence only)`
  );

  if (
    shortConditions.priceBelowSupport &&
    shortConditions.ema15MBearish
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
      reason = `4H break below support + 15M bearish EMA`;
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
    volumeRatio: volumeRatio ? Math.round(volumeRatio * 100) / 100 : undefined,
    entry5MConfirmed,
    nearestSwingLevel: nearestSwingLevel ? Math.round(nearestSwingLevel * 100) / 100 : undefined,
    distanceToSwing,
    reason,
    updatedAt: new Date().toISOString(),
  };
}
