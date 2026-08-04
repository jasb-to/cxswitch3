// app/api/signals/route.ts — v54 "Clean Separation"
// ============================================================
// Returns: { activeSignals, signalHistory, marketData }

import { NextResponse } from "next/server";
import { getActiveSignals, getSignalHistory, getMarketData } from "@/lib/state";
import { isSignalStillValid, shouldHold, getMarketSnapshot } from "@/lib/strategy";
import { getCandles, krakenPairFormat } from "@/lib/kraken";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";
export const revalidate = 0;

const PAIRS = ["BTC", "ETH", "SOL", "HYPE"];

export async function GET() {
  const activeSignals = await getActiveSignals();
  const signalHistory = await getSignalHistory();
  let marketData = await getMarketData();

  const currentPrices: Record<string, number> = {};

  // Fallback: generate market data if KV is empty
  if (!marketData || marketData.length === 0) {
    console.log("[SIGNALS API] KV marketData empty, generating fallback...");
    const freshMarket = [];
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

  // Enrich active signals with current status and hold advice
  const enrichedActive = await Promise.all(activeSignals.map(async (s) => {
    const ageMin = (Date.now() - s.timestamp) / (1000 * 60);
    const price = currentPrices[s.pair];

    let status = s.status;
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
      const p = price || s.entry;
      if (candles4h?.length > 30) {
        const signalLike = {
          ...s,
          scale: s.type,
          adx: 0, rsi: 0, stochK: 0, stochD: 0,
          expectedMove: 0, reason: "", trend: s.direction,
          location: "", trigger: "",
        };
        holdAdvice = shouldHold(signalLike as any, candles4h, p);
      }
    } catch (e) {}

    return {
      ...s,
      scale: s.type,
      meta: {
        status,
        ageMinutes: Math.round(ageMin),
        actionable: status === "ACTIVE",
      },
      holdAdvice
    };
  }));

  // Enrich history with age
  const enrichedHistory = signalHistory.map(h => ({
    ...h,
    scale: h.type,
    meta: {
      ageMinutes: Math.round((Date.now() - h.timestamp) / (1000 * 60)),
      status: h.status,
    }
  }));

  const response = NextResponse.json({
    activeSignals: enrichedActive,
    signalHistory: enrichedHistory,
    marketData: Array.isArray(marketData) ? marketData : [],
    updatedAt: new Date().toISOString(),
  });

  response.headers.set("Cache-Control", "no-store, no-cache, must-revalidate, proxy-revalidate");
  response.headers.set("Pragma", "no-cache");
  response.headers.set("Expires", "0");

  return response;
}
