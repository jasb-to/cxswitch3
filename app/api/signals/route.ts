// app/api/signals/route.ts — v56 dashboard state API
// ============================================================
// Returns market state, setup state and position state separately.

import { NextResponse } from "next/server";
import { getActiveSignals, getSignalHistory, getMarketData, getLastCronRun } from "@/lib/state";
import { isExchangeSyncConfigured } from "@/lib/kraken";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";
export const revalidate = 0;

export async function GET() {
  const activeSignals = await getActiveSignals();
  const signalHistory = await getSignalHistory();
  const marketData = await getMarketData();
  const lastCronRun = await getLastCronRun();

  const enrichedActive = activeSignals.map((s) => {
    const ageMin = (Date.now() - s.timestamp) / (1000 * 60);
    const expectedMove = s.entry && s.target
      ? Math.round((Math.abs(s.target - s.entry) / s.entry) * 1000) / 10
      : 0;

    return {
      ...s,
      scale: s.type,
      expectedMove,
      meta: {
        status: s.status,
        ageMinutes: Math.round(ageMin),
        actionable: s.status === "ACTIVE",
        state: "POSITION_ACTIVE",
      },
    };
  });

  const enrichedHistory = signalHistory.map((h) => ({
    ...h,
    scale: h.type,
    meta: {
      ageMinutes: Math.round((Date.now() - h.timestamp) / (1000 * 60)),
      status: h.status,
    },
  }));

  const response = NextResponse.json({
    activeSignals: enrichedActive,
    signalHistory: enrichedHistory,
    marketData: Array.isArray(marketData) ? marketData : [],
    system: {
      lastCronRun,
      lastCronAgeMs: lastCronRun ? Date.now() - lastCronRun : null,
      exchangeSyncConfigured: isExchangeSyncConfigured(),
      activePositions: enrichedActive.length,
    },
    updatedAt: new Date().toISOString(),
  });

  response.headers.set("Cache-Control", "no-store, no-cache, must-revalidate, proxy-revalidate");
  response.headers.set("Pragma", "no-cache");
  response.headers.set("Expires", "0");
  return response;
}
