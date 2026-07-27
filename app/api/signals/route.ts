// app/api/signals/route.ts — v50 "First Wave"
// ============================================================

import { NextResponse } from "next/server";
import { getSignals, getMarketData, getSignalHistory } from "@/lib/state";
import { isSignalStillValid, shouldHold, getMarketSnapshot } from "@/lib/strategy";
import { getCandles, krakenPairFormat } from "@/lib/kraken";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";
export const revalidate = 0;

const PAIRS = ["BTC", "ETH", "SOL", "HYPE"];

export async function GET() {
  let signals = await getSignals();
  let marketData = await getMarketData();
  const history = await getSignalHistory();

  const currentPrices: Record<string, number> = {};

  // Fallback: generate market data if KV is empty
  if (!marketData || marketData.length === 0) {
    console.log("[SIGNALS API] KV marketData empty, generating fallback...");
    const freshMarket: any[] = [];
    for (const pair of PAIRS) {
      try {
        const [candles1h, candles4h, candles15m] = await Promise.all([
          getCandles(krakenPairFormat(pair + "/USD"), 60),
          getCandles(krakenPairFormat(pair + "/USD"), 240),
          getCandles(krakenPairFormat(pair + "/USD"), 15)
        ]);
        if (candles1h?.length && candles4h?.length && candles15m?.length) {
          const snapshot = getMarketSnapshot(pair, candles1h, candles4h, candles15m);
          freshMarket.push(snapshot);
          currentPrices[pair] = snapshot.price;
          console.log(`[SIGNALS API] ${pair} fallback OK — trend:${snapshot.trend} loc:${snapshot.location} trig:${snapshot.trigger}`);
        } else {
          console.log(`[SIGNALS API] ${pair} fallback skipped — insufficient candles`);
        }
      } catch (e) {
        console.error(`[SIGNALS API] ${pair} fallback FAILED:`, e);
      }
    }
    marketData = freshMarket;
  } else {
    for (const m of marketData) {
      if (m.pair && m.price) currentPrices[m.pair] = m.price;
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
      const candles4h = await getCandles(krakenPairFormat(s.pair + "/USD"), 240);
      const p = currentPrices[s.pair] || s.entry;
      if (candles4h?.length > 30) holdAdvice = shouldHold(s, candles4h, p);
    } catch (e) {}

    return {
      ...s,
      meta: {
        status,
        ageMinutes: Math.round(ageMin),
        actionable: status === "ACTIVE",
      },
      holdAdvice
    };
  }));

  const response = NextResponse.json({
    signals: enriched,
    marketData: Array.isArray(marketData) ? marketData : [],
    history: Array.isArray(history) ? history : [],
    updatedAt: new Date().toISOString(),
  });

  response.headers.set("Cache-Control", "no-store, no-cache, must-revalidate, proxy-revalidate");
  response.headers.set("Pragma", "no-cache");
  response.headers.set("Expires", "0");

  return response;
}
