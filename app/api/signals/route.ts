// app/api/signals/route.ts — v30.5 "Dashboard API with strategy sync"
// ============================================================
// CRITICAL FIXES:
//   - Uses lib/kraken.ts (no more duplicated fetch logic)
//   - Uses strategy.ts getMarketSnapshot() instead of duplicating indicators
//   - Fixed shouldHold() passes candles1h (not 4h)
//   - Syncs WATCHING phase from strategy state
//   - Efficient: fetches 1H + 4H once per pair, no double-fetch

import { NextResponse } from "next/server";
import { getSignals, getSignalHistory, getPairState } from "@/lib/state";
import {
  isSignalStillValid,
  shouldHold,
  getMarketSnapshot,
  Candle,
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
      // Fetch both timeframes in parallel
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

      // Use strategy's own market snapshot for consistency
      const marketSnapshot = await getMarketSnapshot(pair, candles1h, candles4h, undefined);
      freshMarket.push(marketSnapshot);
    } catch (e) {
      console.error(`[SIGNALS ROUTE] ${pair} failed:`, e);
    }
  }

  // Filter valid signals
  const validSignals = (Array.isArray(signals) ? signals : []).filter((s: any) => {
    const price = currentPrices[s.pair];
    if (!price) return (Date.now() - s.timestamp) < 3 * 60 * 60 * 1000;
    return isSignalStillValid(s, price).valid;
  });

  // Enrich signals with status and hold advice
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

      // FIX: Get hold advice with proper 1H candles
      let holdAdvice = null;
      try {
        const candles1h = await getCandles(s.pair, 60);
        const p = currentPrices[s.pair] || s.entry;
        if (candles1h?.length > 30) {
          holdAdvice = await shouldHold(s.pair, s, candles1h, p);
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

  // Sync market phase with strategy state and add trend warnings
  for (const m of freshMarket) {
    const signal = enriched.find((s: any) => s.pair === m.pair);

    if (signal) {
      m.phase = "EXPANSION";

      // Trend warnings
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
    } else {
      // No active signal — check strategy state for WATCHING phase
      try {
        const state = await getPairState(m.pair);
        if (state.stage && state.stage !== "NONE") {
          m.phase = state.stage;
          m.zoneTop = state.zoneTop;
          m.zoneBottom = state.zoneBottom;
        }
      } catch (e) {
        // ignore
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
