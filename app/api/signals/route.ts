import { NextRequest, NextResponse } from "next/server";
import { loadDashboardSnapshot } from "@/lib/state";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

// ─── Safe Access Helpers ───────────────────────────────────
function safeNum(val: any): number {
  return typeof val === "number" && isFinite(val) ? val : 0;
}
function safeStr(val: any): string {
  return typeof val === "string" ? val : "";
}

// ─── Build activeTrade from an activeSignal ────────────────
function buildActiveTrade(signal: any, currentPrice: number): any {
  if (!signal) return null;

  const entry = safeNum(signal.entry);
  const stop = safeNum(signal.stop);
  const target = safeNum(signal.target);
  const direction = signal.direction === "LONG" || signal.direction === "SHORT"
    ? signal.direction
    : "SHORT";

  // Compute PnL %
  let pnlPct = 0;
  if (entry > 0 && currentPrice > 0) {
    const raw = direction === "LONG"
      ? (currentPrice - entry) / entry
      : (entry - currentPrice) / entry;
    pnlPct = raw * 100;
  }
  const pnlStr = `${pnlPct >= 0 ? "+" : ""}${pnlPct.toFixed(2)}%`;

  // Compute R-multiple
  let currentR = 0;
  if (entry > 0 && stop > 0 && entry !== stop) {
    const risk = Math.abs(entry - stop);
    const move = direction === "LONG"
      ? currentPrice - entry
      : entry - currentPrice;
    currentR = move / risk;
  }
  const currentRStr = `${currentR >= 0 ? "+" : ""}${currentR.toFixed(2)}`;

  // Determine phase
  let phase = safeStr(signal.phase);
  if (!phase) {
    if (Math.abs(currentR) < 0.5) phase = "ENTRY";
    else if (currentR < 1) phase = "EARLY";
    else if (currentR < 2) phase = "RUNNING";
    else if (currentR < 3) phase = "EXTENDED";
    else phase = "DEEP";
  }

  // Determine next milestone
  let nextMilestone = safeStr(signal.nextMilestone);
  if (!nextMilestone) {
    if (currentR < 0) nextMilestone = "Breakeven";
    else if (currentR < 1) nextMilestone = "1R";
    else if (currentR < 2) nextMilestone = "2R";
    else if (currentR < 3) nextMilestone = "3R";
    else nextMilestone = "Trail";
  }

  return {
    signalId: safeStr(signal.id) || safeStr(signal.signalId),
    direction,
    pnl: pnlStr,
    entry,
    currentPrice,
    stop,
    target,
    currentR: currentRStr,
    phase,
    nextMilestone,
  };
}

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

    // Normalize active signals first (so we can map them into markets)
    const activeSignals = (snapshot.activeSignals || []).map((s: any) => ({
      ...s,
      entryType: "PULLBACK",
      entryMode: "PULLBACK",
      entryTier: "PULLBACK_ENTRY",
      regimeDirection: s.direction,
      conflictEntry: false,
      entryTimeframe: "15m",
    }));

    // Build a lookup map: pair -> signal
    const signalMap = new Map<string, any>();
    for (const s of activeSignals) {
      if (s.pair) signalMap.set(s.pair, s);
    }

    // Normalize markets — v46.1 snapshot includes triggerDiagnostics
    // CRITICAL FIX: map activeSignals into activeTrade for each market
    const markets = (snapshot.markets || []).map((m: any) => {
      const marketPair = m.pair || "UNKNOWN";
      const currentPrice = safeNum(m.price);

      // If the market already has activeTrade data, keep it.
      // Otherwise, try to build it from the activeSignals map.
      let activeTrade = m.activeTrade || null;
      if (!activeTrade) {
        const signal = signalMap.get(marketPair);
        if (signal) {
          activeTrade = buildActiveTrade(signal, currentPrice);
        }
      }

      return {
        pair: marketPair,
        price: currentPrice,
        timestamp: m.timestamp ?? Date.now(),
        bias: m.bias || "NONE",
        location: m.location || "—",
        locationType: m.locationType || null,
        trigger: m.trigger || "—",
        triggerDiagnostics: m.triggerDiagnostics || null,
        ready: m.ready || false,
        activeTrade,
      };
    });

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
