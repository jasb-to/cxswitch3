// app/api/signals/route.ts — v29.5 "Fix phase display + trend warnings"
// ============================================================

import { NextResponse } from "next/server";
import { getSignals, getSignalHistory } from "@/lib/state";
import { isSignalStillValid, shouldHold, Candle } from "@/lib/strategy";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";
export const revalidate = 0;

const TRACKED_PAIRS = ["BTC", "ETH", "SOL", "HYPE"] as const;

const KRAKEN_PAIRS: Record<string, string> = {
  BTC: "XBTUSD", ETH: "ETHUSD", SOL: "SOLUSD", HYPE: "HYPEUSD",
};

async function getCandles(pair: string, interval: number): Promise<Candle[]> {
  const kp = KRAKEN_PAIRS[pair] || pair + "USD";
  const res = await fetch(
    `https://api.kraken.com/0/public/OHLC?pair=${kp}&interval=${interval}`,
    { cache: "no-store" }
  );
  const data = await res.json();
  if (data.error?.length) throw new Error(data.error[0]);
  const key = Object.keys(data.result).find((k) => k !== "last")!;
  const raw = data.result[key];
  return raw.map((r: any[]) => ({
    timestamp: r[0] * 1000,
    open: parseFloat(r[1]), high: parseFloat(r[2]),
    low: parseFloat(r[3]), close: parseFloat(r[4]),
    volume: parseFloat(r[6]),
  }));
}

function avg(arr: number[]): number {
  if (!arr.length) return 0;
  return arr.reduce((a, b) => a + b, 0) / arr.length;
}

function ema(values: number[], period: number): number[] {
  const k = 2 / (period + 1);
  const result: number[] = [values[0]];
  for (let i = 1; i < values.length; i++) {
    result.push(values[i] * k + result[i - 1] * (1 - k));
  }
  return result;
}

function wilderSmooth(values: number[], period: number): number[] {
  if (values.length < period) return [];
  const result: number[] = [avg(values.slice(0, period))];
  for (let i = period; i < values.length; i++) {
    result.push((result[result.length - 1] * (period - 1) + values[i]) / period);
  }
  return result;
}

function trueRange(c: Candle, p: Candle): number {
  return Math.max(c.high - c.low, Math.abs(c.high - p.close), Math.abs(c.low - p.close));
}

function calculateIndicators(candles4h: Candle[]) {
  const closes = candles4h.map(c => c.close);
  let stochK = 50, stochD = 50;
  try {
    const rsiValues: number[] = [];
    for (let i = 14; i < closes.length; i++) {
      const window = closes.slice(i - 13, i + 1);
      let gains = 0, losses = 0;
      for (let j = 1; j < window.length; j++) {
        const change = window[j] - window[j - 1];
        if (change > 0) gains += change;
        else losses += Math.abs(change);
      }
      const avgGain = gains / 14, avgLoss = losses / 14;
      rsiValues.push(avgLoss === 0 ? 100 : 100 - (100 / (1 + avgGain / avgLoss)));
    }
    if (rsiValues.length >= 14) {
      const rawK: number[] = [];
      for (let i = 13; i < rsiValues.length; i++) {
        const w = rsiValues.slice(i - 13, i + 1);
        const lo = Math.min(...w), hi = Math.max(...w);
        rawK.push(hi === lo ? 50 : ((rsiValues[i] - lo) / (hi - lo)) * 100);
      }
      const kValues: number[] = [];
      for (let i = 2; i < rawK.length; i++) kValues.push(avg(rawK.slice(i - 2, i + 1)));
      if (kValues.length >= 3) {
        stochK = Math.round(kValues[kValues.length - 1] * 10) / 10;
        stochD = Math.round(avg(kValues.slice(-3)) * 10) / 10;
      }
    }
  } catch (e) {}

  let adxValue = 0;
  try {
    if (candles4h.length >= 43) {
      const trs: number[] = [], plusDMs: number[] = [], minusDMs: number[] = [];
      for (let i = 1; i < candles4h.length; i++) {
        const c = candles4h[i], p = candles4h[i - 1];
        trs.push(trueRange(c, p));
        const upMove = c.high - p.high, downMove = p.low - c.low;
        plusDMs.push(upMove > downMove && upMove > 0 ? upMove : 0);
        minusDMs.push(downMove > upMove && downMove > 0 ? downMove : 0);
      }
      const atrSmooth = wilderSmooth(trs, 14);
      const plusDISmooth = wilderSmooth(plusDMs, 14);
      const minusDISmooth = wilderSmooth(minusDMs, 14);
      const dxValues: number[] = [];
      for (let i = 0; i < atrSmooth.length; i++) {
        const atr = atrSmooth[i] || 0.0001;
        const pDI = (plusDISmooth[i] / atr) * 100, mDI = (minusDISmooth[i] / atr) * 100;
        dxValues.push(pDI + mDI > 0 ? (Math.abs(pDI - mDI) / (pDI + mDI)) * 100 : 0);
      }
      if (dxValues.length >= 14) {
        const adxSmooth = wilderSmooth(dxValues, 14);
        adxValue = Math.round(adxSmooth[adxSmooth.length - 1] * 10) / 10;
      }
    }
  } catch (e) {}

  let htBias: "BULLISH" | "BEARISH" | "NEUTRAL" = "NEUTRAL";
  try {
    const sorted = [...candles4h].sort((a, b) => a.timestamp - b.timestamp);
    const groups: Map<string, Candle[]> = new Map();
    for (const c of sorted) {
      const d = new Date(c.timestamp);
      const key = `${d.getUTCFullYear()}-${String(d.getUTCMonth() + 1).padStart(2, '0')}-${String(d.getUTCDate()).padStart(2, '0')}`;
      if (!groups.has(key)) groups.set(key, []);
      groups.get(key)!.push(c);
    }
    const daily: Candle[] = [];
    for (const [_, bars] of Array.from(groups.entries()).sort((a, b) => a[0].localeCompare(b[0]))) {
      if (!bars.length) continue;
      daily.push({
        timestamp: bars[0].timestamp, open: bars[0].open,
        high: Math.max(...bars.map(b => b.high)), low: Math.min(...bars.map(b => b.low)),
        close: bars[bars.length - 1].close, volume: bars.reduce((s, b) => s + b.volume, 0),
      });
    }
    daily.sort((a, b) => a.timestamp - b.timestamp);
    if (daily.length >= 30) {
      const dcloses = daily.map(c => c.close);
      const ema8 = ema(dcloses, 8), ema21 = ema(dcloses, 21), ema50 = ema(dcloses, 50);
      const last8 = ema8[ema8.length - 1], last21 = ema21[ema21.length - 1], last50 = ema50[ema50.length - 1];
      if (last8 > last21 && last21 > last50) htBias = "BULLISH";
      else if (last8 < last21 && last21 < last50) htBias = "BEARISH";
    }
  } catch (e) {}

  const trend1d = htBias === "BULLISH" ? "LONG" : htBias === "BEARISH" ? "SHORT" : "MIXED";
  return { adx: adxValue, stochK, stochD, htBias, trend1d };
}

export async function GET() {
  const signals = await getSignals();
  const history = await getSignalHistory();

  const currentPrices: Record<string, number> = {};
  const freshMarket: any[] = [];

  for (const pair of TRACKED_PAIRS) {
    try {
      const candles4h = await getCandles(pair, 240);
      if (candles4h?.length > 30) {
        const indicators = calculateIndicators(candles4h);
        const price = candles4h[candles4h.length - 1].close;
        currentPrices[pair] = price;

        freshMarket.push({
          pair, price: Math.round(price * 100) / 100,
          timestamp: Date.now(), phase: "NONE",
          trend: indicators.trend1d, htfBias: indicators.htBias,
          adx: indicators.adx, rsi: 0,
          stochK: indicators.stochK, stochD: indicators.stochD,
          zoneTop: null, zoneBottom: null, zoneScore: 0,
          closes4h: candles4h.slice(-50).map(c => c.close),
        });
      }
    } catch (e) {
      console.error(`[SIGNALS ROUTE] ${pair} failed:`, e);
    }
  }

  const validSignals = (Array.isArray(signals) ? signals : []).filter((s: any) => {
    const price = currentPrices[s.pair];
    if (!price) return (Date.now() - s.timestamp) < 3 * 60 * 60 * 1000;
    return isSignalStillValid(s, price).valid;
  });

  const enriched = await Promise.all(validSignals.map(async (s: any) => {
    const ageMin = (Date.now() - s.timestamp) / (1000 * 60);
    let status = "ACTIVE";
    const price = currentPrices[s.pair];
    if (price) {
      if (s.direction === "LONG") {
        if (price >= s.target) status = "TP_HIT";
        else if (price <= s.stop) status = "SL_HIT";
      } else {
        if (price <= s.target) status = "TP_HIT";
        else if (price >= s.stop) status = "SL_HIT";
      }
    }

    let holdAdvice = null;
    try {
      const candles4h = await getCandles(s.pair, 240);
      const p = currentPrices[s.pair] || s.entry;
      if (candles4h?.length > 30) holdAdvice = shouldHold(s.pair, s, candles4h, p);
    } catch (e) {}

    return {
      ...s,
      meta: { status, ageMinutes: Math.round(ageMin), actionable: status === "ACTIVE" && s.confidence >= 55 },
      holdAdvice,
    };
  }));

  // ── FIX: Override phase for active signals + add trend warnings ──
  for (const m of freshMarket) {
    const signal = enriched.find((s: any) => s.pair === m.pair);
    if (signal) {
      m.phase = "EXPANSION";
      // Trend warning: signal direction vs HTF bias mismatch
      if (signal.direction === "LONG" && m.htfBias === "BEARISH") {
        m.trendWarning = {
          severity: "HIGH",
          message: "LONG signal but HTF is BEARISH — consider early exit",
          type: "DIRECTION_MISMATCH",
        };
      } else if (signal.direction === "SHORT" && m.htfBias === "BULLISH") {
        m.trendWarning = {
          severity: "HIGH",
          message: "SHORT signal but HTF is BULLISH — consider early exit",
          type: "DIRECTION_MISMATCH",
        };
      } else if (signal.direction === "LONG" && m.htfBias === "NEUTRAL") {
        m.trendWarning = {
          severity: "MEDIUM",
          message: "LONG signal in NEUTRAL HTF — monitor closely",
          type: "WEAK_ALIGNMENT",
        };
      } else if (signal.direction === "SHORT" && m.htfBias === "NEUTRAL") {
        m.trendWarning = {
          severity: "MEDIUM",
          message: "SHORT signal in NEUTRAL HTF — monitor closely",
          type: "WEAK_ALIGNMENT",
        };
      }
    }
  }

  const response = NextResponse.json({
    signals: enriched,
    marketData: freshMarket,
    history: Array.isArray(history) ? history : [],
    updatedAt: new Date().toISOString(),
  });

  response.headers.set("Cache-Control", "no-store, no-cache, must-revalidate, proxy-revalidate");
  response.headers.set("Pragma", "no-cache");
  response.headers.set("Expires", "0");

  return response;
} 
