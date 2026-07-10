// app/api/signals/route.ts — v29.1 READ-ONLY SIGNALS ENDPOINT
// ============================================================
// This endpoint NEVER evaluates strategy. It only reads the pre-computed
// dashboard snapshot that /api/cron saves every 10 minutes.
//
// NO Kraken calls. NO indicator calculations. NO strategy. NO logging.
// Response time target: 5–20ms.

import { NextRequest, NextResponse } from "next/server";
import { loadDashboardSnapshot } from "@/lib/state";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function GET(req: NextRequest) {
  const { searchParams } = new URL(req.url);
  const pair = searchParams.get("pair");

  try {
    const snapshot = await loadDashboardSnapshot();

    if (!snapshot) {
      return NextResponse.json(
        { error: "No snapshot available. Cron may not have run yet." },
        { status: 503 }
      );
    }

    if (pair && snapshot.markets) {
      const market = snapshot.markets.find((m: any) => m.pair === pair);
      return NextResponse.json({
        pair,
        snapshot: market || null,
        lastCronRun: snapshot.timestamp,
        activeSignals: (snapshot.activeSignals || []).filter((s: any) => s.pair === pair),
      });
    }

    return NextResponse.json({
      snapshot,
      activeSignals: snapshot.activeSignals || [],
      markets: snapshot.markets || [],
      lastCronRun: snapshot.timestamp,
    });
  } catch (e) {
    return NextResponse.json(
      { error: String(e) },
      { status: 500 }
    );
  }
}
