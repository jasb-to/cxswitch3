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
  reason: string;
  updatedAt: string;
}

// Calculate ATR (Average True Range)
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

// Calculate ADX (Average Directional Index) - simplified
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

// Calculate Stochastic RSI - simplified
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

// Find swing highs and lows
function findSwings(candles: Candle[], lookback: number = 20): { highLevel: number; lowLevel: number } {
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

// SLOPE-BASED TREND: Compare current vs previous SMA values to detect turning points
function calculateTrend(candles: Candle[]): "UP" | "DOWN" | "FLAT" {
  if (candles.length < 30) return "FLAT";
  
  // Calculate 8-period SMA current and previous
  const sma8_current = candles.slice(-8).reduce((sum, c) => sum + c.close, 0) / 8;
  const sma8_prev = candles.slice(-16, -8).reduce((sum, c) => sum + c.close, 0) / 8;
  
  // Calculate 21-period SMA current and previous
  const sma21_current = candles.slice(-21).reduce((sum, c) => sum + c.close, 0) / 21;
  const sma21_prev = candles.slice(-42, -21).reduce((sum, c) => sum + c.close, 0) / 21;
  
  // Calculate slopes (change in SMA)
  const slope8 = ((sma8_current - sma8_prev) / sma8_prev) * 100;
  const slope21 = ((sma21_current - sma21_prev) / sma21_prev) * 100;
  
  const currentClose = candles[candles.length - 1].close;
  
  console.log(`[STRATEGY] Trend: close=${currentClose.toFixed(2)}, sma8=${sma8_current.toFixed(2)} (slope=${slope8.toFixed(3)}%), sma21=${sma21_current.toFixed(2)} (slope=${slope21.toFixed(3)}%)`);
  
  // Bullish: both SMAs have positive slope (turning up)
  if (slope8 > 0.1 && slope21 > 0.05) return "UP";
  
  // Bearish: both SMAs have negative slope (turning down)
  if (slope8 < -0.1 && slope21 < -0.05) return "DOWN";
  
  return "FLAT";
}

export function generateSignal(
  symbol: Symbol,
  candles4H: Candle[],
  candles15M: Candle[],
  candles5M?: Candle[]
): Signal {
  // USE ONLY 15M TIMEFRAME FOR ALL CALCULATIONS - SIMPLEST, BEST FOR EARLY ENTRIES
  const candles = candles15M.slice().reverse();
  
  if (candles.length < 30) {
    return {
      symbol,
      price: 0,
      status: "NO_SIGNAL",
      confidence: 0,
      adx: 0,
      stochK: 0,
      marketBias: "Neutral",
      reason: "Not enough 15M data",
      updatedAt: new Date().toISOString(),
    };
  }

  const currentPrice = candles[candles.length - 1].close;
  const adx = calculateADX(candles);
  const stochK = calculateStochRSI(candles);
  const atr = calculateATR(candles);
  const { highLevel, lowLevel } = findSwings(candles, 50);

  // Calculate trend using 15M only
  const trend = calculateTrend(candles);

  console.log(`[STRATEGY] ${symbol}: trend=${trend}, adx=${adx.toFixed(1)}, stoch=${stochK}, price=${currentPrice.toFixed(2)}, high=${highLevel.toFixed(2)}, low=${lowLevel.toFixed(2)}`);

  let status: "LONG" | "SHORT" | "NO_SIGNAL" = "NO_SIGNAL";
  let entry: number | undefined;
  let stopLoss: number | undefined;
  let takeProfit: number | undefined;
  let reason = "Waiting for setup";
  let marketBias: "Bullish" | "Bearish" | "Neutral" = "Neutral";
  let entryType: "5M Momentum" | "4H Structure" | undefined;

  const adxThreshold = 12; // Lower threshold for 15M since it's noisier
  const priceAboveResistance = currentPrice > highLevel;
  const priceBelowSupport = currentPrice < lowLevel;

  // Market bias from trend
  marketBias = trend === "UP" ? "Bullish" : trend === "DOWN" ? "Bearish" : "Neutral";

  // Check if ADX is strong enough
  if (adx < adxThreshold) {
    reason = `ADX too low (${adx.toFixed(1)} < ${adxThreshold})`;
    return {
      symbol,
      price: Math.round(currentPrice * 100) / 100,
      status: "NO_SIGNAL",
      confidence: 0,
      adx,
      stochK: Math.round(stochK),
      marketBias,
      reason,
      updatedAt: new Date().toISOString(),
    };
  }

  // LONG: Trend is UP + either structure break (price > high) OR oversold bounce (stoch < 35)
  if (trend === "UP") {
    if (priceAboveResistance || stochK < 35) {
      status = "LONG";
      entry = currentPrice;
      const atrCap = Math.min(atr, entry * 0.05);
      stopLoss = Math.round((entry - 1.5 * atrCap) * 100) / 100;
      takeProfit = Math.round((entry + 4 * atrCap) * 100) / 100;
      entryType = priceAboveResistance ? "4H Structure" : "5M Momentum";
      reason = priceAboveResistance 
        ? `LONG: 15M trending up, price broke resistance` 
        : `LONG: 15M up, oversold bounce (Stoch=${Math.round(stochK)})`;
    }
  }

  // SHORT: Trend is DOWN + either structure break (price < low) OR overbought fail (stoch > 65)
  if (trend === "DOWN") {
    if (priceBelowSupport || stochK > 65) {
      status = "SHORT";
      entry = currentPrice;
      const atrCap = Math.min(atr, entry * 0.05);
      stopLoss = Math.round((entry + 1.5 * atrCap) * 100) / 100;
      takeProfit = Math.round((entry - 4 * atrCap) * 100) / 100;
      entryType = priceBelowSupport ? "4H Structure" : "5M Momentum";
      reason = priceBelowSupport
        ? `SHORT: 15M trending down, price broke support`
        : `SHORT: 15M down, overbought fail (Stoch=${Math.round(stochK)})`;
    }
  }

  // Calculate risk/reward
  let riskReward: number | undefined;
  if (entry && stopLoss && takeProfit) {
    const risk = Math.abs(entry - stopLoss);
    const reward = Math.abs(takeProfit - entry);
    riskReward = Math.round((reward / risk) * 100) / 100;
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
    adx,
    stochK: Math.round(stochK),
    marketBias,
    entryType,
    reason,
    updatedAt: new Date().toISOString(),
  };
}
