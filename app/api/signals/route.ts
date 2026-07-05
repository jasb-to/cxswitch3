// app/api/signals/route.ts — v29.3 "Always fresh market data, fix ADX=0"
// ============================================================

import { NextResponse } from "next/server";
import { getSignals, getSignalHistory } from "@/lib/state";
import { isSignalStillValid, shouldHold, getMarketSnapshot } from "@/lib/strategy";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";
export const revalidate = 0;

const TRACKED_PAIRS = ["BTC", "ETH", "SOL", "HYPE"] as const;

const KRAKEN_PAIRS: Record<string, string> = {
  BTC: "XBTUSD",
  ETH: "ETHUSD",
  SOL: "SOLUSD",
  HYPE: "HYPEUSD",
};

async function getCandles(pair: string, interval: number) {
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
    open: parseFloat(r[1]),
    high: parseFloat(r[2]),
    low: parseFloat(r[3]),
    close: parseFloat(r[4]),
    volume: parseFloat(r[6]),
  }));
}

export async function GET() {
  const signals = await getSignals();
  const history = await getSignalHistory();

  const currentPrices: Record<string, number> = {};
  const freshMarket: any[] = [];

  // Always generate fresh market data for all pairs
  for (const pair of TRACKED_PAIRS) {
    try {
      const candles4h = await getCandles(pair, 240);
      if (candles4h?.length > 30) {
        const snapshot = await getMarketSnapshot(pair, undefined, candles4h, undefined);
        freshMarket.push(snapshot);
        currentPrices[pair] = snapshot.price;
      }
    } catch (e) {
      console.error(`[SIGNALS ROUTE] ${pair} fetch failed:`, e);
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
      meta: {
        status,
        ageMinutes: Math.round(ageMin),
        actionable: status === "ACTIVE" && s.confidence >= 55,
      },
      holdAdvice
    };
  }));

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
