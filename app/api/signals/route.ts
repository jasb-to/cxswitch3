// app/api/signals/route.ts — v54 "Clean Separation"
// ============================================================
// Returns: { activeSignals, signalHistory, marketData }
// NO candle fetching — all intelligence is pre-computed by cron.

import { NextResponse } from "next/server";
import { getActiveSignals, getSignalHistory, getMarketData } from "@/lib/state";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";
export const revalidate = 0;

export async function GET() {
  const activeSignals = await getActiveSignals();
  const signalHistory = await getSignalHistory();
  const marketData = await getMarketData();

  // Light enrichment: age + expectedMove + meta status
  const enrichedActive = activeSignals.map((s) => {
    const ageMin = (Date.now() - s.timestamp) / (1000 * 60);
    return {
      ...s,
      scale: s.type,
      expectedMove: s.entry && s.target
        ? Math.round(((s.target - s.entry) / s.entry) * 1000) / 10
        : 0,
      meta: {
        status: s.status,
        ageMinutes: Math.round(ageMin),
        actionable: s.status === "ACTIVE",
      },
    };
  });

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
