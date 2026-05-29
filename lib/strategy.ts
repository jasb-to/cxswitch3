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
  // Reverse all candles to chronological order (Kraken returns newest first)
  const candles4H_ordered = candles4H.slice().reverse();
  const candles15M_ordered = candles15M.slice().reverse();
  const candles5M_ordered = candles5M ? candles5M.slice().reverse() : undefined;

  const currentPrice = candles4H_ordered[candles4H_ordered.length - 1].close;
  const adx = calculateADX(candles4H_ordered);
  const stochK = calculateStochRSI(candles4H_ordered);
  const atr = calculateATR(candles4H_ordered);
  const { highLevel, lowLevel } = findSwings(candles4H_ordered, 50);

  // Calculate trend on both timeframes using SIMPLE method
  const trend4H = calculateTrend(candles4H_ordered);
  const trend15M = calculateTrend(candles15M_ordered);

  console.log(`[STRATEGY] ${symbol}: trend4H=${trend4H}, trend15M=${trend15M}, adx=${adx.toFixed(1)}, stoch=${stochK}, price=${currentPrice.toFixed(2)}`);

  let status: "LONG" | "SHORT" | "NO_SIGNAL" = "NO_SIGNAL";
  let entry: number | undefined;
  let stopLoss: number | undefined;
  let takeProfit: number | undefined;
  let reason = "Waiting for setup";
  let marketBias: "Bullish" | "Bearish" | "Neutral" = "Neutral";
  let entryType: "5M Momentum" | "4H Structure" | undefined;

  const adxThreshold = 15;
  const priceAboveResistance = currentPrice > highLevel;
  const priceBelowSupport = currentPrice < lowLevel;

  // Determine market bias from 4H trend
  marketBias = trend4H === "UP" ? "Bullish" : trend4H === "DOWN" ? "Bearish" : "Neutral";

  // Check if ADX is strong enough to trade
  if (adx < adxThreshold) {
    reason = `ADX too low (${adx.toFixed(1)} < ${adxThreshold}), market too choppy`;
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

  // LONG Setup: 4H bullish + 15M bullish + price at or breaking above resistance
  if (trend4H === "UP" && trend15M === "UP") {
    // Fire on structure break or oversold bounce
    if (priceAboveResistance || stochK < 30) {
      status = "LONG";
      entry = currentPrice;
      const atrCap = Math.min(atr, entry * 0.05);
      stopLoss = Math.round((entry - 1.5 * atrCap) * 100) / 100;
      takeProfit = Math.round((entry + 4 * atrCap) * 100) / 100;
      entryType = priceAboveResistance ? "4H Structure" : "5M Momentum";
      reason = entryType === "4H Structure" 
        ? `Bullish: 4H + 15M trending up, price broke resistance` 
        : `Bullish: 4H + 15M up, oversold bounce (Stoch=${Math.round(stochK)})`;
    }
  }

  // SHORT Setup: 4H bearish + 15M bearish + price at or breaking below support
  if (trend4H === "DOWN" && trend15M === "DOWN") {
    // Fire on structure break or overbought reversal
    if (priceBelowSupport || stochK > 70) {
      status = "SHORT";
      entry = currentPrice;
      const atrCap = Math.min(atr, entry * 0.05);
      stopLoss = Math.round((entry + 1.5 * atrCap) * 100) / 100;
      takeProfit = Math.round((entry - 4 * atrCap) * 100) / 100;
      entryType = priceBelowSupport ? "4H Structure" : "5M Momentum";
      reason = entryType === "4H Structure"
        ? `Bearish: 4H + 15M trending down, price broke support`
        : `Bearish: 4H + 15M down, overbought reversal (Stoch=${Math.round(stochK)})`;
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
