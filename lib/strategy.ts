import { fetchCandles } from "./kraken";
import type { Candle } from "./kraken";

// ─── Types ────────────────────────────────────────────────────────────────────

export type Direction = "LONG" | "SHORT";
export type SignalState = "EARLY" | "CONFIRMED" | "END";

export interface Signal {
  symbol: string;
  direction: Direction;
  state: SignalState;
  entry: number;
  sl: number;
  tp: number;
  confidence: number;     // 0–100, display only, never gates signal creation
  createdAt: number;      // ms
  breakoutLevel: number;
  candlesSince: number;   // 5M candles elapsed since EARLY
}

// ─── In-memory signal store ───────────────────────────────────────────────────
// Module-level: survives between requests in the same serverless instance.
// EARLY/CONFIRMED signals are overwritten each run.
// END signals persist for 1 hour then drop automatically.

const signalStore = new Map<string, Signal>();

export function getAllSignals(): Signal[] {
  const now = Date.now();
  for (const [sym, sig] of signalStore.entries()) {
    if (sig.state === "END" && now - sig.createdAt > 60 * 60 * 1000) {
      signalStore.delete(sym);
    }
  }
  return Array.from(signalStore.values());
}

// ─── Indicators ───────────────────────────────────────────────────────────────

function calcATR(candles: Candle[], period = 14): number {
  if (candles.length < period + 1) return 0;
  const trs: number[] = [];
  for (let i = 1; i < candles.length; i++) {
    const { high, low } = candles[i];
    const prev = candles[i - 1].close;
    trs.push(Math.max(high - low, Math.abs(high - prev), Math.abs(low - prev)));
  }
  const slice = trs.slice(-period);
  return slice.reduce((a, b) => a + b, 0) / slice.length;
}

function calcStochRsiK(candles: Candle[], rsiPeriod = 14, stochPeriod = 14): number {
  if (candles.length < rsiPeriod + stochPeriod + 1) return 50;
  const closes = candles.map((c) => c.close);
  const rsiValues: number[] = [];
  for (let i = rsiPeriod; i < closes.length; i++) {
    let gains = 0, losses = 0;
    for (let j = i - rsiPeriod + 1; j <= i; j++) {
      const diff = closes[j] - closes[j - 1];
      if (diff > 0) gains += diff; else losses -= diff;
    }
    const rs = losses === 0 ? 100 : gains / losses;
    rsiValues.push(100 - 100 / (1 + rs));
  }
  if (rsiValues.length < stochPeriod) return 50;
  const slice = rsiValues.slice(-stochPeriod);
  const minRsi = Math.min(...slice);
  const maxRsi = Math.max(...slice);
  if (maxRsi === minRsi) return 50;
  return ((rsiValues[rsiValues.length - 1] - minRsi) / (maxRsi - minRsi)) * 100;
}

function calcMacdHist(candles: Candle[], fast = 12, slow = 26, signalPeriod = 9): number {
  if (candles.length < slow + signalPeriod) return 0;
  const closes = candles.map((c) => c.close);
  function ema(data: number[], period: number): number[] {
    const k = 2 / (period + 1);
    const result = [data[0]];
    for (let i = 1; i < data.length; i++) {
      result.push(data[i] * k + result[i - 1] * (1 - k));
    }
    return result;
  }
  const ema12 = ema(closes, fast);
  const ema26 = ema(closes, slow);
  const macdLine = ema12.map((v, i) => v - ema26[i]);
  const sig = ema(macdLine.slice(slow - 1), signalPeriod);
  const hist = macdLine.slice(slow - 1).map((v, i) => v - sig[i]);
  return hist[hist.length - 1] ?? 0;
}

function calcConfidence(candles15m: Candle[], direction: Direction): number {
  const k = calcStochRsiK(candles15m);
  const hist = calcMacdHist(candles15m);
  let score = 50;
  // StochRSI contribution
  if (direction === "LONG") {
    if (k > 70) score += 20; else if (k > 50) score += 10; else score -= 10;
  } else {
    if (k < 30) score += 20; else if (k < 50) score += 10; else score -= 10;
  }
  // MACD histogram direction
  if (direction === "LONG" && hist > 0) score += 20;
  else if (direction === "SHORT" && hist < 0) score += 20;
  else score -= 10;
  return Math.max(0, Math.min(100, score));
}

// ─── Swing highs / lows (Rule 1) ──────────────────────────────────────────────

function getSwingHighs(candles: Candle[], n = 3): number[] {
  const highs: number[] = [];
  for (let i = 2; i < candles.length - 1; i++) {
    if (candles[i].high > candles[i - 1].high && candles[i].high > candles[i + 1].high) {
      highs.push(candles[i].high);
    }
  }
  return highs.sort((a, b) => b - a).slice(0, n);
}

function getSwingLows(candles: Candle[], n = 3): number[] {
  const lows: number[] = [];
  for (let i = 2; i < candles.length - 1; i++) {
    if (candles[i].low < candles[i - 1].low && candles[i].low < candles[i + 1].low) {
      lows.push(candles[i].low);
    }
  }
  return lows.sort((a, b) => a - b).slice(0, n);
}

// ─── generateSignals — the one function ──────────────────────────────────────

const SYMBOLS = ["BTC/USD", "ETH/USD", "SOL/USD"];

export async function generateSignals(): Promise<{ signals: Signal[]; logs: string[] }> {
  const logs: string[] = [];
  const startMs = Date.now();
  logs.push(`[CRON START] ${new Date().toISOString()}`);

  // Fetch all candles in parallel across all symbols
  const fetches = SYMBOLS.map((symbol) =>
    Promise.all([
      fetchCandles(symbol, 240, 200),
      fetchCandles(symbol, 15, 100),
      fetchCandles(symbol, 5, 50),
    ]).then(([c4h, c15m, c5m]) => ({ symbol, c4h, c15m, c5m }))
      .catch((err) => ({ symbol, error: err instanceof Error ? err.message : String(err) }))
  );

  const allFetches = await Promise.all(fetches);
  const activeSignals: Signal[] = [];

  for (const result of allFetches) {
    const tag = result.symbol.split("/")[0];

    if ("error" in result) {
      logs.push(`[ERROR] ${tag}: ${result.error}`);
      continue;
    }

    const { symbol, c4h, c15m, c5m } = result;

    const price4h = c4h[c4h.length - 1]?.close ?? 0;
    const price5m = c5m[c5m.length - 1]?.close ?? price4h;

    logs.push(`[FETCH] ${tag} 4H: ${c4h.length} candles, latest: $${price4h.toLocaleString("en-US", { maximumFractionDigits: 2 })}`);
    logs.push(`[FETCH] ${tag} 15M: ${c15m.length} candles`);
    logs.push(`[FETCH] ${tag} 5M: ${c5m.length} candles`);

    // Rule 1: find last 3 swing highs and lows from 4H
    const swingHighs = getSwingHighs(c4h, 3);
    const swingLows = getSwingLows(c4h, 3);
    const highestHigh = swingHighs[0] ?? 0;
    const lowestLow = swingLows[0] ?? Infinity;

    logs.push(`[SWINGS] ${tag} 4H highs: [${swingHighs.map((h) => h.toFixed(0)).join(", ")}], lows: [${swingLows.map((l) => l.toFixed(0)).join(", ")}]`);

    // Rule 1 continued: breakout direction
    let direction: Direction | "NONE" = "NONE";
    if (highestHigh > 0 && price4h > highestHigh) direction = "LONG";
    else if (lowestLow < Infinity && price4h < lowestLow) direction = "SHORT";

    if (direction === "NONE") {
      logs.push(`[BREAKOUT] ${tag}: NONE — price $${price4h.toFixed(2)} below high $${highestHigh.toFixed(2)}, above low $${lowestLow.toFixed(2)}`);
      logs.push(`[SIGNAL] ${tag}: No signal`);
      // Mark any existing active signal as END
      const existing = signalStore.get(symbol);
      if (existing && existing.state !== "END") {
        signalStore.set(symbol, { ...existing, state: "END" });
      }
      continue;
    }

    logs.push(`[BREAKOUT] ${tag}: ${direction} — price $${price4h.toFixed(2)} ${direction === "LONG" ? "above high" : "below low"} $${(direction === "LONG" ? highestHigh : lowestLow).toFixed(2)}`);

    const atrVal = calcATR(c4h);
    const existing = signalStore.get(symbol);

    let signal: Signal;

    if (!existing || existing.state === "END") {
      // Rule 2: brand new EARLY signal
      const entry = price4h;
      const sl = direction === "LONG" ? entry - 1.5 * atrVal : entry + 1.5 * atrVal;
      const tp = direction === "LONG" ? entry + 3 * atrVal : entry - 3 * atrVal;
      signal = {
        symbol,
        direction,
        state: "EARLY",
        entry,
        sl,
        tp,
        confidence: calcConfidence(c15m, direction),
        createdAt: Date.now(),
        breakoutLevel: direction === "LONG" ? highestHigh : lowestLow,
        candlesSince: 0,
      };
    } else {
      // Update existing signal
      const candlesSince = existing.candlesSince + 1;
      const confidence = calcConfidence(c15m, existing.direction); // Rule 3: display only
      const pctFromLevel = Math.abs(price5m - existing.breakoutLevel) / existing.breakoutLevel;
      const pulledBack = pctFromLevel <= 0.005; // Rule 4: within 0.5%
      const expired = candlesSince >= 12;        // Rule 5: 12 × 5M candles

      let state: SignalState = existing.state;
      if (expired && existing.state !== "CONFIRMED") {
        state = "END";
      } else if (pulledBack && existing.state === "EARLY") {
        state = "CONFIRMED";
      }

      signal = { ...existing, candlesSince, confidence, state };
    }

    signalStore.set(symbol, signal);
    logs.push(`[SIGNAL] ${tag}: state=${signal.state}, entry=$${signal.entry.toFixed(2)}, SL=$${signal.sl.toFixed(2)}, TP=$${signal.tp.toFixed(2)}, confidence=${signal.confidence}%`);
    activeSignals.push(signal);
  }

  const duration = Date.now() - startMs;
  logs.push(`[CRON END] ${duration}ms — signals: ${activeSignals.length}`);

  return { signals: activeSignals, logs };
}
