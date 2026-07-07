// app/api/signals/route.ts — v28 "Dashboard API with strategy sync"
// ============================================================

import { NextResponse } from "next/server";
import { getSignals, getSignalHistory } from "@/lib/state";
import {
  isSignalStillValid,
  shouldHold,
  getMarketSnapshot,
} from "@/lib/strategy";
import { getCandles, Symbol } from "@/lib/kraken";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";
export const revalidate = 0;

const TRACKED_PAIRS: Symbol[] = ["BTC", "ETH", "SOL", "HYPE"];

export async function GET() {
  const signals = await getSignals();
  const history = await getSignalHistory();

  const currentPrices: Record<string, number> = {};
  const freshMarket: any[] = [];

  for (const pair of TRACKED_PAIRS) {
    try {
      const [candles1h, candles4h] = await Promise.all([
        getCandles(pair, 60),
        getCandles(pair, 240),
      ]);

      if (!candles4h || candles4h.length < 30) {
        console.log(`[SIGNALS ROUTE] ${pair} — insufficient 4H candles`);
        continue;
      }

      const price = candles4h[candles4h.length - 1].close;
      currentPrices[pair] = price;

      // FIX: correct argument order — candles15m is 3rd, candles4h is 4th
      // We don't fetch 15m here, so pass empty array
      const marketSnapshot = getMarketSnapshot(pair, candles1h || [], candles4h, []);
      freshMarket.push(marketSnapshot);
    } catch (e) {
      console.error(`[SIGNALS ROUTE] ${pair} failed:`, e);
    }
  }

  const validSignals = (Array.isArray(signals) ? signals : []).filter((s: any) => {
    const price = currentPrices[s.pair];
    if (!price) return (Date.now() - s.timestamp) < 3 * 60 * 60 * 1000;
    return isSignalStillValid(s, price).valid;
  });

  const enriched = await Promise.all(
    validSignals.map(async (s: any) => {
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
        if (candles4h?.length > 30) {
          holdAdvice = shouldHold(s, candles4h, p);
        }
      } catch (e) {
        console.error(`[SIGNALS ROUTE] shouldHold failed for ${s.pair}:`, e);
      }

      return {
        ...s,
        meta: {
          status,
          ageMinutes: Math.round(ageMin),
          actionable: status === "ACTIVE" && s.confidence >= 55,
        },
        holdAdvice,
      };
    })
  );

  for (const m of freshMarket) {
    const signal = enriched.find((s: any) => s.pair === m.pair);

    if (signal) {
      m.phase = "EXPANSION";
    }
    // REMOVED: getPairState zone code — v28 has no zones
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
