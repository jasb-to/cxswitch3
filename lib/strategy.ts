export type Symbol = "BTC" | "ETH" | "SOL";

export type SignalState = "EARLY" | "SNIPER" | "WAIT";

export type SetupType = "BREAKOUT" | "PULLBACK" | "REVERSAL" | "NONE";

export type MarketStructure = "UPTREND" | "DOWNTREND" | "RANGE";

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

  state: SignalState;
  bias: "LONG" | "SHORT" | "NEUTRAL";

  setup: SetupType;
  structure: MarketStructure;

  confidence: number;

  atr: number;

  stochK: number;
  stochD: number;
  rsi: number;

  reason: string;

  stopLoss: number | null;
  takeProfit: number | null;
  rr: number | null;

  expectedMove: number;

  updatedAt: string;
}

/* ---------------- UTILS ---------------- */

const clamp = (n: number, min: number, max: number) =>
  Math.max(min, Math.min(max, n));

const round = (n: number, d = 2) =>
  Math.round(n * 10 ** d) / 10 ** d;

/* ---------------- RSI ---------------- */

function rsi(closes: number[]) {
  let gain = 0;
  let loss = 0;

  for (let i = 1; i < closes.length; i++) {
    const diff = closes[i] - closes[i - 1];
    if (diff > 0) gain += diff;
    else loss -= diff;
  }

  const rs = gain / (loss || 1);
  return 100 - 100 / (1 + rs);
}

/* ---------------- ATR (REAL VOLATILITY ENGINE) ---------------- */

function atr(candles: Candle[], period = 14) {
  let trSum = 0;

  for (let i = 1; i < candles.length; i++) {
    const high = candles[i].high;
    const low = candles[i].low;
    const prevClose = candles[i - 1].close;

    const tr = Math.max(
      high - low,
      Math.abs(high - prevClose),
      Math.abs(low - prevClose)
    );

    trSum += tr;
  }

  return trSum / Math.min(period, candles.length);
}

/* ---------------- STRUCTURE (HH / HL MODEL) ---------------- */

function marketStructure(candles: Candle[]): MarketStructure {
  const highs = candles.map(c => c.high);
  const lows = candles.map(c => c.low);

  const higherHighs = highs[highs.length - 1] > highs[highs.length - 3];
  const higherLows = lows[lows.length - 1] > lows[lows.length - 3];

  const lowerHighs = highs[highs.length - 1] < highs[highs.length - 3];
  const lowerLows = lows[lows.length - 1] < lows[lows.length - 3];

  if (higherHighs && higherLows) return "UPTREND";
  if (lowerHighs && lowerLows) return "DOWNTREND";
  return "RANGE";
}

/* ---------------- STOCH ---------------- */

function stochKD(closes: number[]) {
  const slice = closes.slice(-14);

  const high = Math.max(...slice);
  const low = Math.min(...slice);

  const k =
    ((closes.at(-1)! - low) / (high - low || 1)) * 100;

  const d = k * 0.7 + 50 * 0.3;

  return { k, d };
}

/* ---------------- VOLUME ---------------- */

function volumeScore(candles: Candle[]) {
  const vols = candles.map(c => c.volume);
  const avg = vols.reduce((a, b) => a + b, 0) / vols.length;

  const last = vols.at(-1)!;

  return {
    spike: last > avg * 1.2,
    ratio: last / (avg || 1),
  };
}

/* ---------------- CORE ENGINE ---------------- */

export function generateSignal(
  symbol: Symbol,
  price: number,
  candles15m: Candle[],
  candles1h: Candle[]
): Signal {

  const closes = candles15m.map(c => c.close);

  const r = rsi(closes);
  const { k, d } = stochKD(closes);
  const vol = volumeScore(candles15m);

  const atrVal = atr(candles15m);
  const structure = marketStructure(candles1h);

  /* ---------------- BIAS (STRUCTURE ONLY) ---------------- */

  const bias: "LONG" | "SHORT" | "NEUTRAL" =
    structure === "UPTREND"
      ? "LONG"
      : structure === "DOWNTREND"
      ? "SHORT"
      : "NEUTRAL";

  /* ---------------- SETUP DETECTION ---------------- */

  const setup: SetupType =
    vol.spike && structure !== "RANGE"
      ? "BREAKOUT"
      : r < 45 && structure !== "RANGE"
      ? "PULLBACK"
      : "NONE";

  /* ---------------- ENTRY CONDITIONS ---------------- */

  const pullbackOK = r > 35 && r < 65;
  const breakoutOK = vol.spike;

  const validEntry =
    structure !== "RANGE" &&
    bias !== "NEUTRAL" &&
    (setup === "BREAKOUT" ? breakoutOK : pullbackOK);

  /* ---------------- EARLY / SNIPER ---------------- */

  const early = validEntry;

  const sniper =
    early &&
    vol.spike &&
    Math.abs(k - d) > 8;

  const state: SignalState =
    sniper ? "SNIPER"
    : early ? "EARLY"
    : "WAIT";

  /* ---------------- CONFIDENCE ---------------- */

  const confidence =
    state === "SNIPER"
      ? clamp(85 + r / 10, 80, 96)
      : state === "EARLY"
      ? clamp(60 + k / 2, 55, 82)
      : 20;

  /* ---------------- RISK MODEL ---------------- */

  const expectedMove =
    state === "SNIPER"
      ? clamp(atrVal * 1.5, 0.02, 0.06)
      : state === "EARLY"
      ? clamp(atrVal, 0.01, 0.04)
      : 0.01;

  let sl: number | null = null;
  let tp: number | null = null;

  if (state !== "WAIT") {
    const risk = expectedMove * 0.5;

    if (bias === "LONG") {
      sl = price * (1 - risk);
      tp = price * (1 + expectedMove);
    } else if (bias === "SHORT") {
      sl = price * (1 + risk);
      tp = price * (1 - expectedMove);
    }
  }

  const rr =
    sl && tp
      ? Math.abs((tp - price) / (price - sl))
      : null;

  return {
    symbol,
    price: round(price),

    state,
    bias,
    setup,
    structure,

    confidence: round(confidence),

    atr: round(atrVal, 2),

    stochK: round(k),
    stochD: round(d),
    rsi: round(r),

    reason:
      state === "SNIPER"
        ? "SNIPER (STRUCTURE + VOLUME + MOMENTUM)"
        : state === "EARLY"
        ? "EARLY (STRUCTURE BASED ENTRY)"
        : "NO STRUCTURE",

    stopLoss: sl ? round(sl, 2) : null,
    takeProfit: tp ? round(tp, 2) : null,
    rr: rr ? round(rr, 2) : null,

    expectedMove: round(expectedMove * 100, 2),

    updatedAt: new Date().toISOString(),
  };
}
