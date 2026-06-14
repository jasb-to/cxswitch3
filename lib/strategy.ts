// lib/strategy.ts — v14 "THE TRAP" (Aggressive Edition)
// Liquidity Sweep + FVG Retest — maximizes entry frequency
// Non-lagging, price-action only
// ============================================================

export interface Candle {
  time: number;
  open: number;
  high: number;
  low: number;
  close: number;
  volume: number;
}

export interface Signal {
  pair: string;
  direction: "LONG" | "SHORT";
  entry: number;
  stop: number;
  target: number;
  confidence: number;
  type: "SWEEP" | "EARLY";
  reason: string;
  timestamp: number;
  expectedMove: number;
  adx: number;
  rsi: number;
  stochK: number;
  stochD: number;
  rr: number;
  candles1h?: Candle[];
  candles4h?: Candle[];
}

export interface MarketData {
  pair: string;
  price: number;
  structure: string;
  adx: number;
  rsi: number;
  stochK: number;
  stochD: number;
}

interface SwingPoint {
  idx: number;
  price: number;
  type: "high" | "low";
}

function swingHighs(candles: Candle[], lookback = 3): SwingPoint[] {
  const highs: SwingPoint[] = [];
  for (let i = lookback; i < candles.length - lookback; i++) {
    const c = candles[i];
    let isHigh = true;
    for (let j = 1; j <= lookback; j++) {
      if (candles[i - j].high >= c.high || candles[i + j].high >= c.high) {
        isHigh = false;
        break;
      }
    }
    if (isHigh) highs.push({ idx: i, price: c.high, type: "high" });
  }
  return highs;
}

function swingLows(candles: Candle[], lookback = 3): SwingPoint[] {
  const lows: SwingPoint[] = [];
  for (let i = lookback; i < candles.length - lookback; i++) {
    const c = candles[i];
    let isLow = true;
    for (let j = 1; j <= lookback; j++) {
      if (candles[i - j].low <= c.low || candles[i + j].low <= c.low) {
        isLow = false;
        break;
      }
    }
    if (isLow) lows.push({ idx: i, price: c.low, type: "low" });
  }
  return lows;
}

function getStructure(candles: Candle[]): "UPTREND" | "DOWNTREND" | "RANGE" {
  const highs = swingHighs(candles, 5);
  const lows = swingLows(candles, 5);
  if (highs.length < < 2 || lows.length < 2) return "RANGE";

  const recentHighs = highs.slice(-3);
  const recentLows = lows.slice(-3);

  const higherHighs = recentHighs.every((h, i) => i === 0 ? true : h.price > recentHighs[i - 1].price);
  const higherLows = recentLows.every((l, i) => i === 0 ? true : l.price > recentLows[i - 1].price);
  const lowerHighs = recentHighs.every((h, i) => i === 0 ? true : h.price < recentHighs[i - 1].price);
  const lowerLows = recentLows.every((l, i) => i === 0 ? true : l.price < recentLows[i - 1].price);

  if (higherHighs && higherLows) return "UPTREND";
  if (lowerHighs && lowerLows) return "DOWNTREND";

  const recent = candles.slice(-20);
  if (recent.length >= 10) {
    const firstHalf = recent.slice(0, 10).reduce((a, c) => a + c.close, 0) / 10;
    const secondHalf = recent.slice(-10).reduce((a, c) => a + c.close, 0) / 10;
    const slope = (secondHalf - firstHalf) / firstHalf;
    if (slope > 0.015) return "UPTREND";
    if (slope < -0.015) return "DOWNTREND";
  }
  return "RANGE";
}

function calcADX(candles: Candle[], period = 14): number {
  if (candles.length < period * 2 + 1) return 0;
  const tr: number[] = [];
  const plusDM: number[] = [];
  const minusDM: number[] = [];
  for (let i = 1; i < candles.length; i++) {
    const prev = candles[i - 1], curr = candles[i];
    tr.push(Math.max(curr.high - curr.low, Math.abs(curr.high - prev.close), Math.abs(curr.low - prev.close)));
    plusDM.push(curr.high - prev.high > prev.low - curr.low ? Math.max(curr.high - prev.high, 0) : 0);
    minusDM.push(prev.low - curr.low > curr.high - prev.high ? Math.max(prev.low - curr.low, 0) : 0);
  }
  let atr = tr.slice(0, period).reduce((a, b) => a + b, 0);
  let plusDI_sum = plusDM.slice(0, period).reduce((a, b) => a + b, 0);
  let minusDI_sum = minusDM.slice(0, period).reduce((a, b) => a + b, 0);
  let dxValues: number[] = [];
  for (let i = period; i < tr.length; i++) {
    atr = atr - (atr / period) + tr[i];
    plusDI_sum = plusDI_sum - (plusDI_sum / period) + plusDM[i];
    minusDI_sum = minusDI_sum - (minusDI_sum / period) + minusDM[i];
    const plusDI = 100 * (plusDI_sum / atr);
    const minusDI = 100 * (minusDI_sum / atr);
    const dx = (Math.abs(plusDI - minusDI) / (plusDI + minusDI)) * 100;
    dxValues.push(dx);
  }
  if (dxValues.length < period) return 0;
  let adx = dxValues.slice(0, period).reduce((a, b) => a + b, 0) / period;
  for (let i = period; i < dxValues.length; i++) {
    adx = ((adx * (period - 1)) + dxValues[i]) / period;
  }
  return adx;
}

function calcRSI(candles: Candle[], period = 14): number {
  if (candles.length < period + 1) return 50;
  let gains = 0, losses = 0;
  for (let i = candles.length - period; i < candles.length; i++) {
    const change = candles[i].close - candles[i - 1].close;
    if (change > 0) gains += change; else losses += Math.abs(change);
  }
  const avgGain = gains / period;
  const avgLoss = losses / period;
  if (avgLoss === 0) return 100;
  const rs = avgGain / avgLoss;
  return 100 - (100 / (1 + rs));
}

function calcStochastic(candles: Candle[], kPeriod = 14, dPeriod = 3): { k: number; d: number } {
  if (candles.length < kPeriod + dPeriod) return { k: 50, d: 50 };
  const kValues: number[] = [];
  for (let i = candles.length - kPeriod - dPeriod + 1; i <= candles.length - kPeriod; i++) {
    const slice = candles.slice(i, i + kPeriod);
    const lowest = Math.min(...slice.map(c => c.low));
    const highest = Math.max(...slice.map(c => c.high));
    const current = candles[i + kPeriod - 1].close;
    const k = highest === lowest ? 50 : ((current - lowest) / (highest - lowest)) * 100;
    kValues.push(k);
  }
  const k = kValues[kValues.length - 1];
  const d = kValues.reduce((a, b) => a + b, 0) / kValues.length;
  return { k, d };
}

function calcATR(candles: Candle[], period = 14): number {
  if (candles.length < period + 1) return 0;
  let sum = 0;
  for (let i = candles.length - period; i < candles.length; i++) {
    const prev = candles[i - 1], curr = candles[i];
    const tr = Math.max(curr.high - curr.low, Math.abs(curr.high - prev.close), Math.abs(curr.low - prev.close));
    sum += tr;
  }
  return sum / period;
}

function calcROC(candles: Candle[], period = 3): number {
  if (candles.length < period + 1) return 0;
  const current = candles[candles.length - 1].close;
  const past = candles[candles.length - 1 - period].close;
  return ((current - past) / past) * 100;
}

interface SweepResult {
  found: boolean;
  direction: "LONG" | "SHORT";
  sweepLevel: number;
  wickExtreme: number;
  rejectionClose: number;
  recency: number;
}

function detectLiquiditySweep(candles: Candle[]): SweepResult | null {
  const highs = swingHighs(candles, 3);
  const lows = swingLows(candles, 3);
  if (highs.length < 2 || lows.length < 2) return null;

  const current = candles[candles.length - 1];

  const lastLow = lows[lows.length - 1];
  
  if (current.low < lastLow.price && current.close > lastLow.price) {
    const wickDepth = (lastLow.price - current.low) / lastLow.price;
    if (wickDepth > 0.003) {
      return {
        found: true,
        direction: "LONG",
        sweepLevel: lastLow.price,
        wickExtreme: current.low,
        rejectionClose: current.close,
        recency: 0
      };
    }
  }

  const lastHigh = highs[highs.length - 1];
  
  if (current.high > lastHigh.price && current.close < lastHigh.price) {
    const wickDepth = (current.high - lastHigh.price) / lastHigh.price;
    if (wickDepth > 0.003) {
      return {
        found: true,
        direction: "SHORT",
        sweepLevel: lastHigh.price,
        wickExtreme: current.high,
        rejectionClose: current.close,
        recency: 0
      };
    }
  }

  return null;
}

interface CHoCHResult {
  found: boolean;
  direction: "LONG" | "SHORT";
  breakLevel: number;
}

function detectCHOCH(candles: Candle[], sweep: SweepResult): CHoCHResult | null {
  const highs = swingHighs(candles, 3);
  const lows = swingLows(candles, 3);
  const current = candles[candles.length - 1];
  const prev = candles[candles.length - 2];

  if (sweep.direction === "LONG") {
    const recentHighs = highs.slice(-3);
    if (recentHighs.length < 2) return null;
    const priorHigh = recentHighs[recentHighs.length - 2];
    if (current.close > priorHigh.price && prev.close <= priorHigh.price) {
      return { found: true, direction: "LONG", breakLevel: priorHigh.price };
    }
  } else {
    const recentLows = lows.slice(-3);
    if (recentLows.length < 2) return null;
    const priorLow = recentLows[recentLows.length - 2];
    if (current.close < priorLow.price && prev.close >= priorLow.price) {
      return { found: true, direction: "SHORT", breakLevel: priorLow.price };
    }
  }

  return null;
}

interface FVGResult {
  found: boolean;
  direction: "LONG" | "SHORT";
  top: number;
  bottom: number;
  midpoint: number;
  idx: number;
}

function detectFVG(candles: Candle[], direction: "LONG" | "SHORT"): FVGResult | null {
  if (candles.length < 3) return null;
  
  // 8 candles = 32h on 4H, recent enough to be actionable
  for (let i = candles.length - 3; i >= Math.max(0, candles.length - 8); i--) {
    if (i + 2 >= candles.length) continue;
    const c1 = candles[i];
    const c2 = candles[i + 1];
    const c3 = candles[i + 2];

    if (direction === "LONG") {
      if (c1.high < c3.low && c3.close > c1.close) {
        return {
          found: true,
          direction: "LONG",
          top: c3.low,
          bottom: c1.high,
          midpoint: (c3.low + c1.high) / 2,
          idx: i
        };
      }
    } else {
      if (c1.low > c3.high && c3.close < c1.close) {
        return {
          found: true,
          direction: "SHORT",
          top: c1.low,
          bottom: c3.high,
          midpoint: (c1.low + c3.high) / 2,
          idx: i
        };
      }
    }
  }
  return null;
}

function isFVGValid(fvg: FVGResult, candles: Candle[], currentIdx: number): boolean {
  for (let i = fvg.idx + 3; i <= currentIdx; i++) {
    if (i >= candles.length) break;
    const c = candles[i];
    
    if (fvg.direction === "LONG") {
      if (c.low <= fvg.bottom) return false;
    } else {
      if (c.high >= fvg.top) return false;
    }
  }
  return true;
}

export interface HoldResult {
  shouldHold: boolean;
  reason: string;
  trailingStop: number | null;
  trendHealth: "STRONG" | "MODERATE" | "WEAK";
}

export function shouldHold(
  signal: Signal,
  candles4h: Candle[],
  candles1h: Candle[],
  currentPrice: number
): HoldResult {
  const structure4h = getStructure(candles4h);
  const adx4h = calcADX(candles4h, 14);
  const stoch1h = calcStochastic(candles1h, 14, 3);
  
  const structureValid = signal.direction === "LONG" 
    ? structure4h === "UPTREND" || structure4h === "RANGE"
    : structure4h === "DOWNTREND" || structure4h === "RANGE";
  
  let trendHealth: "STRONG" | "MODERATE" | "WEAK";
  if (adx4h > 20) trendHealth = "STRONG";
  else if (adx4h > 15) trendHealth = "MODERATE";
  else trendHealth = "WEAK";
  
  const atr4h = calcATR(candles4h, 14);
  const trailDistance = atr4h * 2;
  
  let trailingStop: number | null = null;
  
  if (signal.direction === "LONG" && stoch1h.k > 80) {
    trailingStop = Math.max(signal.entry * 1.002, currentPrice - trailDistance);
  } else if (signal.direction === "SHORT" && stoch1h.k < 20) {
    trailingStop = Math.min(signal.entry * 0.998, currentPrice + trailDistance);
  }
  
  const hardExit = !structureValid || trendHealth === "WEAK";
  
  if (hardExit) {
    return {
      shouldHold: false,
      reason: `4H ${structure4h} invalidates ${signal.direction}. ADX ${adx4h.toFixed(1)}`,
      trailingStop: null,
      trendHealth
    };
  }
  
  if (trailingStop !== null) {
    const inProfit = signal.direction === "LONG" 
      ? currentPrice > signal.entry * 1.005
      : currentPrice < signal.entry * 0.995;
    
    if (inProfit) {
      return {
        shouldHold: true,
        reason: `1H Stoch extreme (${stoch1h.k.toFixed(1)}). Trail at $${trailingStop.toFixed(2)}. Ignore noise.`,
        trailingStop,
        trendHealth
      };
    }
  }
  
  return {
    shouldHold: true,
    reason: `4H ${structure4h} intact. ADX ${adx4h.toFixed(1)}. Hold for ${signal.target.toFixed(2)}.`,
    trailingStop: null,
    trendHealth
  };
}

export function generateSignal(
  pair: string,
  candles1h: Candle[],
  candles4h: Candle[],
  _activeTrades?: Record<string, any>
): { signal: Signal | null; market: MarketData; debug?: string[] } {
  
  const price = candles1h[candles1h.length - 1].close;
  const structure4h = getStructure(candles4h);
  const structure1h = getStructure(candles1h);
  const roc1h = calcROC(candles1h, 3);
  const atr1h = calcATR(candles1h, 14);
  
  const adx4h = calcADX(candles4h, 14);
  const rsi1h = calcRSI(candles1h, 14);
  const stoch1h = calcStochastic(candles1h, 14, 3);

  const market: MarketData = {
    pair, price, structure: structure4h, adx: adx4h,
    rsi: rsi1h, stochK: stoch1h.k, stochD: stoch1h.d,
  };

  const debug: string[] = [];

  if (candles1h.length < 30 || candles4h.length < 30) {
    debug.push("insufficient_candles");
    return { signal: null, market, debug };
  }

  const sweep = detectLiquiditySweep(candles1h);
  
  if (!sweep) {
    debug.push("no_liquidity_sweep");
  } else {
    debug.push(`sweep_${sweep.direction.toLowerCase()}_level:${sweep.sweepLevel.toFixed(2)}_wick:${sweep.wickExtreme.toFixed(2)}`);
  }

  let bias: "LONG" | "SHORT" | "NONE" = "NONE";
  
  if (structure4h === "UPTREND") {
    bias = "LONG";
    debug.push("4h_bias_long");
  } else if (structure4h === "DOWNTREND") {
    bias = "SHORT";
    debug.push("4h_bias_short");
  } else {
    const highs4h = swingHighs(candles4h, 5);
    const lows4h = swingLows(candles4h, 5);
    if (highs4h.length >= 2 && lows4h.length >= 2) {
      const rangeHigh = highs4h[highs4h.length - 1].price;
      const rangeLow = lows4h[lows4h.length - 1].price;
      const mid = (rangeHigh + rangeLow) / 2;
      if (price < mid) {
        bias = "LONG";
        debug.push("4h_range_bottom_bias_long");
      } else {
        bias = "SHORT";
        debug.push("4h_range_top_bias_short");
      }
    }
  }

  if (sweep && sweep.direction === bias) {
    const choch = detectCHOCH(candles1h, sweep);
    
    if (choch && choch.found) {
      debug.push(`choch_${choch.direction.toLowerCase()}_break:${choch.breakLevel.toFixed(2)}`);
    }
    
    const momentumOK = sweep.direction === "LONG" ? roc1h > -0.5 : roc1h < 0.5;
    
    if (!momentumOK) {
      debug.push(`momentum_fail(roc:${roc1h.toFixed(2)})`);
    } else {
      debug.push(`momentum_ok(roc:${roc1h.toFixed(2)})`);
      
      const stopPct = 0.02;
      const targetPct = 0.04;
      
      let entry: number, stop: number, target: number;
      
      if (sweep.direction === "LONG") {
        entry = price;
        stop = Math.min(sweep.wickExtreme * 0.998, entry * (1 - stopPct));
        target = entry * (1 + targetPct);
        const minStop = entry * 0.985;
        if (stop > minStop) stop = minStop;
      } else {
        entry = price;
        stop = Math.max(sweep.wickExtreme * 1.002, entry * (1 + stopPct));
        target = entry * (1 - targetPct);
        const minStop = entry * 1.015;
        if (stop < minStop) stop = minStop;
      }
      
      const actualStopPct = Math.abs(entry - stop) / entry;
      const actualTargetPct = Math.abs(target - entry) / entry;
      const rr = actualTargetPct / actualStopPct;
      
      let confidence = choch && choch.found ? 80 : 70;
      if (structure4h === structure1h) confidence += 5;
      if (Math.abs(roc1h) > 0.5) confidence += 5;
      confidence = Math.min(95, confidence);
      
      const expectedMove = actualTargetPct * 100;
      
      if (rr >= 1.5 && expectedMove >= 3.0) {
        const chochTag = choch && choch.found ? "+CHoCH" : "(early)";
        const signal: Signal = {
          pair, direction: sweep.direction, entry, stop, target, confidence,
          type: "SWEEP",
          reason: `SWEEP${chochTag} ${sweep.direction} | 4H:${structure4h} 1H:${structure1h} | Sweep:${sweep.sweepLevel.toFixed(2)} Wick:${sweep.wickExtreme.toFixed(2)} | ROC:${roc1h.toFixed(2)} | Conf:${confidence}`,
          timestamp: Date.now(), expectedMove,
          adx: adx4h, rsi: rsi1h, stochK: stoch1h.k, stochD: stoch1h.d, rr,
        };
        debug.push(`SIGNAL_${sweep.direction}_SWEEP${chochTag}_conf:${confidence}_rr:${rr.toFixed(2)}`);
        return { signal, market, debug };
      } else {
        debug.push(`rr_too_low(${rr.toFixed(2)}<<1.5)`);
      }
    }
  }

  if (bias !== "NONE") {
    const fvg4h = detectFVG(candles4h, bias);
    
    if (fvg4h && fvg4h.found) {
      debug.push(`fvg4h_${bias.toLowerCase()}_top:${fvg4h.top.toFixed(2)}_bottom:${fvg4h.bottom.toFixed(2)}`);
      
      const current4hIdx = candles4h.length - 1;
      const fvgValid = isFVGValid(fvg4h, candles4h, current4hIdx);
      
      if (!fvgValid) {
        debug.push("fvg_filled_invalidated");
      } else {
        debug.push("fvg_unfilled_valid");
        
        const inFVG = bias === "LONG" 
          ? (price <= fvg4h.top && price >= fvg4h.bottom)
          : (price >= fvg4h.bottom && price <= fvg4h.top);
        
        // LOOSENED: Wider threshold — 5x FVG height or 1% of price
        const fvgHeight = Math.abs(fvg4h.top - fvg4h.bottom);
        const nearThreshold = Math.max(fvgHeight * 5, price * 0.01);
        const nearFVG = Math.abs(price - fvg4h.midpoint) < nearThreshold;
        
        // LOOSENED: Removed "correct side" check — just needs to be near FVG
        const approaching = true;
        
        if (inFVG || nearFVG) {
          debug.push(`price_in_fvg_zone:${inFVG}_near:${nearFVG}`);
          
          // FIXED: Rejection check — any bullish/bearish candle in last 3 hours
          // Removed FVG-level interaction requirement
          let rejection = false;
          for (let i = 1; i <= 3; i++) {
            if (candles1h.length < i) break;
            const c = candles1h[candles1h.length - i];
            if (bias === "LONG") {
              // Any bullish candle = close > open
              if (c.close > c.open) {
                rejection = true;
                break;
              }
            } else {
              // Any bearish candle = close < open
              if (c.close < c.open) {
                rejection = true;
                break;
              }
            }
          }
          
          if (rejection) {
            debug.push("1h_momentum_aligned");
            
            const stopPct = 0.02;
            const targetPct = 0.04;
            
            let entry = price;
            let stop: number, target: number;
            
            if (bias === "LONG") {
              stop = Math.min(fvg4h.bottom * 0.998, entry * (1 - stopPct));
              target = entry * (1 + targetPct);
              const minStop = entry * 0.985;
              if (stop > minStop) stop = minStop;
            } else {
              stop = Math.max(fvg4h.top * 1.002, entry * (1 + stopPct));
              target = entry * (1 - targetPct);
              const minStop = entry * 1.015;
              if (stop < minStop) stop = minStop;
            }
            
            const actualStopPct = Math.abs(entry - stop) / entry;
            const actualTargetPct = Math.abs(target - entry) / entry;
            const rr = actualTargetPct / actualStopPct;
            
            let confidence = 65;
            if (inFVG) confidence += 10;
            if (structure1h === structure4h) confidence += 10;
            confidence = Math.min(90, confidence);
            
            const expectedMove = actualTargetPct * 100;
            
            if (rr >= 1.5 && expectedMove >= 3.0) {
              const signal: Signal = {
                pair, direction: bias, entry, stop, target, confidence,
                type: "EARLY",
                reason: `FVG_RETEST ${bias} | 4H:${structure4h} 1H:${structure1h} | FVG:${fvg4h.bottom.toFixed(2)}-${fvg4h.top.toFixed(2)} | ROC:${roc1h.toFixed(2)} | Conf:${confidence}`,
                timestamp: Date.now(), expectedMove,
                adx: adx4h, rsi: rsi1h, stochK: stoch1h.k, stochD: stoch1h.d, rr,
              };
              debug.push(`SIGNAL_${bias}_EARLY(FVG)_conf:${confidence}_rr:${rr.toFixed(2)}`);
              return { signal, market, debug };
            }
          } else {
            debug.push("no_1h_momentum");
          }
        } else {
          debug.push(`price_not_near_fvg(price:${price.toFixed(2)}_mid:${fvg4h.midpoint.toFixed(2)}_threshold:${nearThreshold.toFixed(2)})`);
        }
      }
    } else {
      debug.push(`no_fvg4h_${bias.toLowerCase()}`);
    }
  }

  debug.push("no_signal");
  return { signal: null, market, debug };
}

export function isSignalStillValid(signal: Signal, currentPrice: number): boolean {
  if (signal.direction === "LONG" && currentPrice < signal.stop * 1.005) return false;
  if (signal.direction === "SHORT" && currentPrice > signal.stop * 0.995) return false;
  
  const ageHours = (Date.now() - signal.timestamp) / (1000 * 60 * 60);
  
  const maxAge = signal.type === "EARLY" ? 2 : 6;
  if (ageHours > maxAge) return false;
  
  return true;
}
