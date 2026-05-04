// ─── Version ─────────────────────────────────────────────────────────────────

export const APP_VERSION = "1.0.0";

// ─── Types ───────────────────────────────────────────────────────────────────

export type SignalDirection = "LONG" | "SHORT";
export type SignalState = "EARLY" | "CONFIRMED" | "END";

export interface Signal {
  symbol: string;
  direction: SignalDirection;
  state: SignalState;
  entry: number;
  sl: number;
  tp: number;
  confidence: number;
  createdAt: number;        // ms timestamp of EARLY creation
  candlesSince: number;     // 5M candles elapsed since EARLY
  breakoutLevel: number;    // the swing high/low that was broken
}

/** Per-symbol snapshot returned by /api/scan */
export interface SymbolSnapshot {
  symbol: string;
  price: number;
  breakout: SignalDirection | "NONE";
  checklist: ChecklistItem[];
  signal: Signal | null;
  scannedAt: number;
}

export interface ChecklistItem {
  label: string;
  passed: boolean;
  detail?: string;
}

export interface Candle {
  time: number;
  open: number;
  high: number;
  low: number;
  close: number;
}

// ─── Kraken pair mapping ──────────────────────────────────────────────────────

const KRAKEN_PAIRS: Record<string, string> = {
  BTC: "XBTUSD",
  ETH: "ETHUSD",
  SOL: "SOLUSD",
};

const TIMEFRAMES: Record<string, number> = {
  "4H": 240,
  "15M": 15,
  "5M": 5,
};

// ─── Kraken REST candles ──────────────────────────────────────────────────────

export async function fetchCandles(
  symbol: string,
  intervalMinutes: number,
  count = 200
): Promise<Candle[]> {
  const pair = KRAKEN_PAIRS[symbol];
  if (!pair) throw new Error(`Unknown symbol ${symbol}`);

  const since = Math.floor((Date.now() - count * intervalMinutes * 60 * 1000) / 1000);
  const url = `https://api.kraken.com/0/public/OHLC?pair=${pair}&interval=${intervalMinutes}&since=${since}`;

  // Cache for slightly less than one interval to avoid stale data while reducing duplicate API calls
  const revalidateSeconds = Math.max(30, Math.floor(intervalMinutes * 60 * 0.8));
  const res = await fetch(url, { next: { revalidate: revalidateSeconds } });
  if (!res.ok) throw new Error(`Kraken fetch failed: ${res.status}`);

  const json = await res.json();
  if (json.error?.length) throw new Error(`Kraken error: ${json.error.join(", ")}`);

  // Kraken returns { result: { PAIR: [...], last: N }, error: [] }
  const key = Object.keys(json.result).find((k) => k !== "last")!;
  const raw: number[][] = json.result[key];

  return raw.map(([time, open, high, low, close]) => ({
    time: time * 1000,
    open: parseFloat(open as unknown as string),
    high: parseFloat(high as unknown as string),
    low: parseFloat(low as unknown as string),
    close: parseFloat(close as unknown as string),
  }));
}

// ─── ATR ──────────────────────────────────────────────────────────────────────

function atr(candles: Candle[], period = 14): number {
  if (candles.length < period + 1) return 0;
  const trs: number[] = [];
  for (let i = 1; i < candles.length; i++) {
    const c = candles[i];
    const prev = candles[i - 1].close;
    trs.push(Math.max(c.high - c.low, Math.abs(c.high - prev), Math.abs(c.low - prev)));
  }
  // Simple average of last `period` true ranges
  const slice = trs.slice(-period);
  return slice.reduce((a, b) => a + b, 0) / slice.length;
}

// ─── Swing highs / lows ───────────────────────────────────────────────────────

function swingHighs(candles: Candle[], lookback = 3): number[] {
  const highs: number[] = [];
  for (let i = lookback; i < candles.length - lookback; i++) {
    const c = candles[i].high;
    let isHigh = true;
    for (let j = i - lookback; j <= i + lookback; j++) {
      if (j !== i && candles[j].high >= c) { isHigh = false; break; }
    }
    if (isHigh) highs.push(c);
  }
  return highs.slice(-3);
}

function swingLows(candles: Candle[], lookback = 3): number[] {
  const lows: number[] = [];
  for (let i = lookback; i < candles.length - lookback; i++) {
    const c = candles[i].low;
    let isLow = true;
    for (let j = i - lookback; j <= i + lookback; j++) {
      if (j !== i && candles[j].low <= c) { isLow = false; break; }
    }
    if (isLow) lows.push(c);
  }
  return lows.slice(-3);
}

// ─── Stochastic RSI ──────────────────────────────────────────────────────────

function stochRsiK(candles: Candle[], rsiPeriod = 14, stochPeriod = 14): number {
  if (candles.length < rsiPeriod + stochPeriod) return 50;
  const closes = candles.map((c) => c.close);

  // RSI values
  const rsiValues: number[] = [];
  for (let i = rsiPeriod; i < closes.length; i++) {
    let gain = 0, loss = 0;
    for (let j = i - rsiPeriod + 1; j <= i; j++) {
      const diff = closes[j] - closes[j - 1];
      if (diff > 0) gain += diff; else loss -= diff;
    }
    const avgGain = gain / rsiPeriod;
    const avgLoss = loss / rsiPeriod;
    const rs = avgLoss === 0 ? 100 : avgGain / avgLoss;
    rsiValues.push(100 - 100 / (1 + rs));
  }

  if (rsiValues.length < stochPeriod) return 50;
  const recent = rsiValues.slice(-stochPeriod);
  const minRsi = Math.min(...recent);
  const maxRsi = Math.max(...recent);
  if (maxRsi === minRsi) return 50;
  const k = ((rsiValues[rsiValues.length - 1] - minRsi) / (maxRsi - minRsi)) * 100;
  return Math.min(100, Math.max(0, k));
}

// ─── MACD histogram direction ─────────────────────────────────────────────────

function macdHistDirection(candles: Candle[], fast = 12, slow = 26, signal = 9): "up" | "down" | "flat" {
  if (candles.length < slow + signal) return "flat";
  const closes = candles.map((c) => c.close);

  function ema(data: number[], period: number): number[] {
    const k = 2 / (period + 1);
    const result: number[] = [data[0]];
    for (let i = 1; i < data.length; i++) {
      result.push(data[i] * k + result[i - 1] * (1 - k));
    }
    return result;
  }

  const fastEma = ema(closes, fast);
  const slowEma = ema(closes, slow);
  const macdLine = fastEma.map((v, i) => v - slowEma[i]);
  const signalLine = ema(macdLine.slice(slow - 1), signal);
  const histLen = signalLine.length;
  if (histLen < 2) return "flat";

  const lastHist = macdLine[macdLine.length - 1] - signalLine[histLen - 1];
  const prevHist = macdLine[macdLine.length - 2] - signalLine[histLen - 2];

  if (lastHist > prevHist) return "up";
  if (lastHist < prevHist) return "down";
  return "flat";
}

// ─── Confidence score (15M) ───────────────────────────────────────────────────

export function computeConfidence(
  candles15m: Candle[],
  direction: SignalDirection
): number {
  const k = stochRsiK(candles15m);
  const macdDir = macdHistDirection(candles15m);

  let score = 50;

  // Stoch RSI contribution (0–30 pts)
  if (direction === "LONG") {
    if (k < 20) score += 30;
    else if (k < 50) score += 15;
    else score -= 10;
  } else {
    if (k > 80) score += 30;
    else if (k > 50) score += 15;
    else score -= 10;
  }

  // MACD histogram direction contribution (0–20 pts)
  if (direction === "LONG" && macdDir === "up") score += 20;
  else if (direction === "SHORT" && macdDir === "down") score += 20;
  else if (macdDir === "flat") score += 0;
  else score -= 10;

  return Math.min(100, Math.max(0, score));
}

// ─── 4H breakout detection ────────────────────────────────────────────────────

export interface BreakoutResult {
  direction: SignalDirection;
  breakoutLevel: number;
  entry: number;
  sl: number;
  tp: number;
}

export function detect4HBreakout(candles4h: Candle[]): BreakoutResult | null {
  if (candles4h.length < 20) return null;

  const price = candles4h[candles4h.length - 1].close;
  const currentAtr = atr(candles4h);
  if (currentAtr === 0) return null;

  const highs = swingHighs(candles4h);
  const lows = swingLows(candles4h);

  if (highs.length === 0 && lows.length === 0) return null;

  const highestHigh = highs.length > 0 ? Math.max(...highs) : -Infinity;
  const lowestLow = lows.length > 0 ? Math.min(...lows) : Infinity;

  if (price > highestHigh && highs.length > 0) {
    return {
      direction: "LONG",
      breakoutLevel: highestHigh,
      entry: price,
      sl: price - 1.5 * currentAtr,
      tp: price + 3 * currentAtr,
    };
  }

  if (price < lowestLow && lows.length > 0) {
    return {
      direction: "SHORT",
      breakoutLevel: lowestLow,
      entry: price,
      sl: price + 1.5 * currentAtr,
      tp: price - 3 * currentAtr,
    };
  }

  return null;
}

// ─── Checklist builder ────────────────────────────────────────────────────────

export function buildChecklist(
  candles4h: Candle[],
  candles15m: Candle[],
  candles5m: Candle[],
  direction: SignalDirection | "NONE"
): ChecklistItem[] {
  if (direction === "NONE") {
    // Show neutral checklist — all checks pending
    const price = candles4h.length ? candles4h[candles4h.length - 1].close : 0;
    const highs = swingHighs(candles4h);
    const lows = swingLows(candles4h);
    const highestHigh = highs.length ? Math.max(...highs) : null;
    const lowestLow = lows.length ? Math.min(...lows) : null;

    return [
      {
        label: "4H swing high/low identified",
        passed: !!(highestHigh || lowestLow),
        detail: highestHigh ? `High: $${highestHigh.toLocaleString("en-US", { maximumFractionDigits: 2 })}` : undefined,
      },
      {
        label: "4H breakout above/below level",
        passed: false,
        detail: "Waiting for close beyond swing level",
      },
      {
        label: "15M StochRSI aligned",
        passed: false,
        detail: "No active direction",
      },
      {
        label: "15M MACD histogram momentum",
        passed: false,
        detail: "No active direction",
      },
      {
        label: "5M pullback to breakout level",
        passed: false,
        detail: "No active signal",
      },
    ];
  }

  const candles4hLast = candles4h[candles4h.length - 1];
  const price = candles4hLast?.close ?? 0;
  const currentAtrVal = atr(candles4h);
  const highs = swingHighs(candles4h);
  const lows = swingLows(candles4h);
  const highestHigh = highs.length ? Math.max(...highs) : null;
  const lowestLow = lows.length ? Math.min(...lows) : null;

  const hasSwingLevel = direction === "LONG" ? !!highestHigh : !!lowestLow;
  const levelVal = direction === "LONG" ? highestHigh : lowestLow;

  const brokeOut = direction === "LONG"
    ? (highestHigh != null && price > highestHigh)
    : (lowestLow != null && price < lowestLow);

  const k = stochRsiK(candles15m);
  const stochAligned = direction === "LONG" ? k < 50 : k > 50;
  const stochDetail = `StochRSI K: ${k.toFixed(1)} (${direction === "LONG" ? "< 50 for LONG" : "> 50 for SHORT"})`;

  const macdDir = macdHistDirection(candles15m);
  const macdAligned = direction === "LONG" ? macdDir === "up" : macdDir === "down";
  const macdDetail = `Histogram: ${macdDir}`;

  const lastPrice5m = candles5m.length ? candles5m[candles5m.length - 1].close : price;
  const pullbackThreshold = 0.005;
  const nearBreakout = levelVal != null
    ? Math.abs(lastPrice5m - levelVal) / levelVal <= pullbackThreshold
    : false;

  return [
    {
      label: "4H swing level identified",
      passed: hasSwingLevel,
      detail: levelVal != null
        ? `Level: $${levelVal.toLocaleString("en-US", { maximumFractionDigits: 2 })}`
        : "No swing level found",
    },
    {
      label: "4H breakout confirmed",
      passed: brokeOut,
      detail: brokeOut
        ? `Price $${price.toLocaleString("en-US", { maximumFractionDigits: 2 })} ${direction === "LONG" ? "above" : "below"} level`
        : "Waiting for close beyond level",
    },
    {
      label: "15M StochRSI aligned",
      passed: stochAligned,
      detail: stochDetail,
    },
    {
      label: "15M MACD momentum",
      passed: macdAligned,
      detail: macdDetail,
    },
    {
      label: "5M pullback to level",
      passed: nearBreakout,
      detail: nearBreakout
        ? "Price retested breakout level"
        : `5M price: $${lastPrice5m.toLocaleString("en-US", { maximumFractionDigits: 2 })}`,
    },
  ];
}

// ─── 5M pullback confirmation ─────────────────────────────────────────────────

export function check5MConfirmation(
  candles5m: Candle[],
  signal: Signal
): { confirm: boolean; end: boolean } {
  if (signal.state !== "EARLY") return { confirm: false, end: false };

  const price = candles5m[candles5m.length - 1]?.close ?? signal.entry;
  const pullbackThreshold = 0.005; // 0.5%

  const nearBreakout =
    Math.abs(price - signal.breakoutLevel) / signal.breakoutLevel <= pullbackThreshold;

  const end = signal.candlesSince >= 12;

  return { confirm: nearBreakout && !end, end };
}
