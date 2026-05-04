import { supabase } from "./supabase-client";
import { fetchCandles } from "./kraken";

export type SignalDirection = "LONG" | "SHORT";
export type SignalState = "EARLY" | "CONFIRMED" | "END";

export interface Signal {
  id?: number;
  symbol: string;
  direction: SignalDirection;
  state: SignalState;
  entry_price: number;
  stop_loss: number;
  take_profit: number;
  confidence: number;
  breakout_level: number;
  created_at?: string;
  updated_at?: string;
}

// ────────────────────────────────────────────────────────────────────────────────

export async function generateSignals(): Promise<{ signals: Signal[]; logs: string[] }> {
  const logs: string[] = [];
  const SYMBOLS = ["BTC/USD", "ETH/USD", "SOL/USD"];
  const startMs = Date.now();

  logs.push(`[CRON START] ${new Date().toISOString()}`);

  const newSignals: Signal[] = [];

  for (const symbol of SYMBOLS) {
    try {
      logs.push(`[FETCH] ${symbol}`);

      const [candles4h, candles15m, candles5m] = await Promise.all([
        fetchCandles(symbol.split("/")[0], 240, 100),
        fetchCandles(symbol.split("/")[0], 15, 100),
        fetchCandles(symbol.split("/")[0], 5, 30),
      ]);

      if (!candles4h.length || !candles15m.length) continue;

      const price = candles4h[candles4h.length - 1].close;
      const breakoutData = detect4HBreakout(candles4h);
      const confidence = breakoutData ? computeConfidence(candles15m, breakoutData.direction) : 0;

      if (breakoutData) {
        const signal: Signal = {
          symbol,
          direction: breakoutData.direction,
          state: "EARLY",
          entry_price: breakoutData.entry,
          stop_loss: breakoutData.sl,
          take_profit: breakoutData.tp,
          confidence,
          breakout_level: breakoutData.breakoutLevel,
        };

        newSignals.push(signal);
        logs.push(`[SIGNAL] ${symbol} ${signal.direction} EARLY (entry: ${signal.entry_price.toFixed(2)})`);
      } else {
        logs.push(`[NO BREAKOUT] ${symbol}`);
      }

      // Check 5M for confirmation on existing EARLY signals
      const { data: earlySignals } = await supabase
        .from("signals")
        .select("*")
        .eq("symbol", symbol)
        .eq("state", "EARLY")
        .order("created_at", { ascending: false })
        .limit(1);

      if (earlySignals && earlySignals.length > 0) {
        const earlySignal = earlySignals[0];
        const candles5mLast = candles5m[candles5m.length - 1];
        const pullbackThreshold = 0.005;

        if (
          Math.abs(candles5mLast.close - earlySignal.breakout_level) /
            earlySignal.breakout_level <=
          pullbackThreshold
        ) {
          await supabase
            .from("signals")
            .update({ state: "CONFIRMED", updated_at: new Date().toISOString() })
            .eq("id", earlySignal.id);

          logs.push(
            `[CONFIRMED] ${symbol} ${earlySignal.direction} (5M pullback detected)`
          );
        }
      }
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      logs.push(`[ERROR] ${symbol}: ${msg}`);
    }
  }

  // Upsert new signals
  for (const signal of newSignals) {
    const { data: existing } = await supabase
      .from("signals")
      .select("id")
      .eq("symbol", signal.symbol)
      .eq("direction", signal.direction)
      .neq("state", "END")
      .order("created_at", { ascending: false })
      .limit(1);

    if (existing && existing.length > 0) {
      logs.push(`[SKIP] ${signal.symbol} ${signal.direction} already active`);
    } else {
      await supabase.from("signals").insert(signal);
      logs.push(`[INSERT] ${signal.symbol} ${signal.direction}`);
    }
  }

  // Mark expired signals (12 * 5min = 60 min old)
  const expiryTime = new Date(Date.now() - 60 * 60 * 1000).toISOString();
  const { data: expiredSignals } = await supabase
    .from("signals")
    .select("id")
    .eq("state", "EARLY")
    .lt("updated_at", expiryTime);

  if (expiredSignals && expiredSignals.length > 0) {
    await supabase
      .from("signals")
      .update({ state: "END", updated_at: new Date().toISOString() })
      .eq("state", "EARLY")
      .lt("updated_at", expiryTime);

    logs.push(`[END] Expired ${expiredSignals.length} signal(s)`);
  }

  // Log cron execution
  const durationMs = Date.now() - startMs;
  await supabase.from("cron_runs").insert({
    signals_found: newSignals.length,
    duration_ms: durationMs,
    logs: logs.join("\n"),
  });

  logs.push(`[CRON END] ${durationMs}ms`);

  // Return all active signals
  const { data: allSignals } = await supabase
    .from("signals")
    .select("*")
    .neq("state", "END")
    .order("created_at", { ascending: false });

  return { signals: allSignals || [], logs };
}

export async function getAllSignals(): Promise<Signal[]> {
  const { data } = await supabase
    .from("signals")
    .select("*")
    .neq("state", "END")
    .order("created_at", { ascending: false });

  return data || [];
}

// ────────────────────────────────────────────────────────────────────────────────

interface Candle {
  time: number;
  open: number;
  high: number;
  low: number;
  close: number;
  volume: number;
}

function swingHighs(candles: Candle[]): number[] {
  const highs: number[] = [];
  for (let i = 1; i < candles.length - 1; i++) {
    if (candles[i].high > candles[i - 1].high && candles[i].high > candles[i + 1].high) {
      highs.push(candles[i].high);
    }
  }
  return highs;
}

function swingLows(candles: Candle[]): number[] {
  const lows: number[] = [];
  for (let i = 1; i < candles.length - 1; i++) {
    if (candles[i].low < candles[i - 1].low && candles[i].low < candles[i + 1].low) {
      lows.push(candles[i].low);
    }
  }
  return lows;
}

function atr(candles: Candle[]): number {
  const trs = candles.map((c, i) => {
    if (i === 0) return 0;
    const prev = candles[i - 1];
    const tr1 = c.high - c.low;
    const tr2 = Math.abs(c.high - prev.close);
    const tr3 = Math.abs(c.low - prev.close);
    return Math.max(tr1, tr2, tr3);
  });
  return trs.reduce((a, b) => a + b, 0) / trs.length;
}

function stochRsiK(candles: Candle[]): number {
  const closes = candles.map((c) => c.close);
  const rsiPeriod = 14;
  const stochPeriod = 14;

  const rsi = computeRsi(closes, rsiPeriod);
  const rsiValues = closes.slice(-stochPeriod).map((_, i) => {
    const subset = closes.slice(Math.max(0, closes.length - stochPeriod - i));
    return computeRsi(subset, rsiPeriod);
  });

  const minRsi = Math.min(...rsiValues);
  const maxRsi = Math.max(...rsiValues);
  const range = maxRsi - minRsi || 1;

  return ((rsi - minRsi) / range) * 100;
}

function computeRsi(closes: number[], period: number): number {
  const gains: number[] = [];
  const losses: number[] = [];

  for (let i = 1; i < closes.length; i++) {
    const change = closes[i] - closes[i - 1];
    gains.push(change > 0 ? change : 0);
    losses.push(change < 0 ? -change : 0);
  }

  const avgGain =
    gains.slice(-period).reduce((a, b) => a + b, 0) / period;
  const avgLoss =
    losses.slice(-period).reduce((a, b) => a + b, 0) / period;

  if (avgLoss === 0) return avgGain > 0 ? 100 : 0;
  const rs = avgGain / avgLoss;
  return 100 - 100 / (1 + rs);
}

function macdHistDirection(candles: Candle[]): "up" | "down" {
  const closes = candles.map((c) => c.close);
  const ema12 = computeEma(closes, 12);
  const ema26 = computeEma(closes, 26);
  const signal = computeEma(closes, 9);

  const macd = ema12 - ema26;
  const hist = macd - signal;

  return hist > 0 ? "up" : "down";
}

function computeEma(values: number[], period: number): number {
  const k = 2 / (period + 1);
  let ema = values[0];
  for (let i = 1; i < values.length; i++) {
    ema = values[i] * k + ema * (1 - k);
  }
  return ema;
}

function detect4HBreakout(
  candles: Candle[]
): { direction: SignalDirection; entry: number; sl: number; tp: number; breakoutLevel: number } | null {
  const price = candles[candles.length - 1].close;
  const highs = swingHighs(candles);
  const lows = swingLows(candles);

  const highestHigh = highs.length ? Math.max(...highs) : null;
  const lowestLow = lows.length ? Math.min(...lows) : null;

  const atrVal = atr(candles);

  if (highestHigh && price > highestHigh) {
    return {
      direction: "LONG",
      entry: price,
      sl: highestHigh - atrVal,
      tp: price + (price - (highestHigh - atrVal)) * 2,
      breakoutLevel: highestHigh,
    };
  }

  if (lowestLow && price < lowestLow) {
    return {
      direction: "SHORT",
      entry: price,
      sl: lowestLow + atrVal,
      tp: price - (lowestLow + atrVal - price) * 2,
      breakoutLevel: lowestLow,
    };
  }

  return null;
}

function computeConfidence(candles: Candle[], direction: SignalDirection): number {
  const stoch = stochRsiK(candles);
  const macdDir = macdHistDirection(candles);

  let score = 50;

  if (direction === "LONG") {
    if (stoch < 50) score += 15;
    if (macdDir === "up") score += 15;
  } else {
    if (stoch > 50) score += 15;
    if (macdDir === "down") score += 15;
  }

  return Math.min(100, Math.max(0, score));
}
