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

    // Normalize markets — v46.1 snapshot includes triggerDiagnostics
    const markets = (snapshot.markets || []).map((m: any) => {
      const marketPair = m.pair || "UNKNOWN";

      return {
        pair: marketPair,
        price: m.price ?? 0,
        timestamp: m.timestamp ?? Date.now(),
        bias: m.bias || "NONE",
        location: m.location || "—",
        locationType: m.locationType || null,
        trigger: m.trigger || "—",
        triggerDiagnostics: m.triggerDiagnostics || null,
        ready: m.ready || false,
        activeTrade: m.activeTrade || null,
      };
    });

    // Normalize active signals
    const activeSignals = (snapshot.activeSignals || []).map((s: any) => ({
      ...s,
      entryType: "PULLBACK",
      entryMode: "PULLBACK",
      entryTier: "PULLBACK_ENTRY",
      regimeDirection: s.direction,
      conflictEntry: false,
      entryTimeframe: "15m",
    }));

    if (pair && markets) {
      const market = markets.find((m: any) => m.pair === pair);
      return NextResponse.json({
        pair,
        snapshot: market || null,
        lastCronRun: snapshot.timestamp,
        activeSignals: activeSignals.filter((s: any) => s.pair === pair),
      });
    }

    return NextResponse.json({
      snapshot: { ...snapshot, markets, activeSignals },
      activeSignals,
      markets,
      lastCronRun: snapshot.timestamp,
    });
  } catch (e) {
    return NextResponse.json({ error: String(e) }, { status: 500 });
  }
}
