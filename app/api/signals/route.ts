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

    // Normalize markets — ensure pair field exists on every market
    const markets = (snapshot.markets || []).map((m: any) => {
      // FIX: Ensure pair is always present
      const marketPair = m.pair || m.pairName || "UNKNOWN";

      const direction = m.trendDirection || m.bias?.direction || null;
      const strength = m.trendStrength || m.bias?.strength || "WEAK";
      const stoch15m = m.stoch15m || { k: 50, d: 50 };
      const stoch1h = m.stoch1h || { k: 50, d: 50 };
      const stoch4h = m.stoch4h || { k: 50, d: 50 };

      const emaAligned = m.ema8 && m.ema21 ? (direction === "LONG" ? m.ema8 > m.ema21 : m.ema8 < m.ema21) : false;

      // Compute readiness
      let readiness = 0;
      if (direction) readiness += 25;
      if (strength === "STRONG") readiness += 20;
      else if (strength === "MEDIUM") readiness += 10;
      if (stoch15m.k < 20 || stoch15m.k > 80) readiness += 25;
      else if (stoch15m.k < 50 || stoch15m.k > 50) readiness += 10;
      if (m.adx >= 25) readiness += 10;
      if (m.signal) readiness += 10;
      readiness = Math.min(100, readiness);

      const isPullback = (direction === "LONG" && stoch15m.k < 50) || (direction === "SHORT" && stoch15m.k > 50);

      return {
        // v42.1 native fields
        pair: marketPair,
        price: m.price ?? 0,
        timestamp: m.timestamp ?? Date.now(),
        trend: m.trend ?? (direction ? `${direction} ${strength}` : "NONE"),
        trendDirection: direction,
        trendStrength: strength,
        stoch15m,
        stoch1h,
        stoch4h,
        adx: m.adx ?? null,
        adx1d: m.adx1d ?? null,
        ema8: m.ema8 ?? 0,
        ema21: m.ema21 ?? 0,
        signal: m.signal || null,
        debug: m.debug || [],

        // v41-compatible derived fields
        bias: direction ? { direction, strength: strength === "STRONG" ? 80 : strength === "MEDIUM" ? 60 : 30 } : null,
        trend1d: m.trend1d || (direction ? { direction, strength } : null),
        trend4h: m.trend4h || (direction ? { direction, strength } : null),
        stochK: stoch15m.k,
        stochD: stoch15m.d,
        rsi: stoch15m.k,
        volumeConfirmed: m.volumeConfirmed ?? false,
        trendStrengthLabel: strength,
        isPullback,
        pullbackTier: isPullback ? (stoch15m.k < 20 || stoch15m.k > 80 ? "DEEP" : "SHALLOW") : null,
        stochZone: stoch15m.k < 20 ? "EXTREME" : stoch15m.k < 50 ? "ZONE" : stoch15m.k > 80 ? "EXTREME" : stoch15m.k > 50 ? "ZONE" : "NEUTRAL",
        readiness,
        readinessLabel: readiness >= 80 ? "READY" : readiness >= 60 ? "WARM" : readiness >= 40 ? "WATCH" : "NO_TRADE",
        regime: direction ? { direction, strength, confidence: strength === "STRONG" ? 75 : 50 } : null,
        emaAligned,
        recommendedAction: m.signal ? `${m.signal.direction} ${m.signal.entryType || "PULLBACK"}` : null,
        entryTier: m.signal ? "PULLBACK_ENTRY" : null,
        entryMode: m.signal ? "PULLBACK" : null,
        positionSize: m.signal ? "2%" : null,
        summary: { debug: m.debug || [] },

        // activeTrade from cron
        activeTrade: m.activeTrade || null,

        // v41 fields UI references
        isExhausted: m.isExhausted ?? false,
        exhaustionReason: m.exhaustionReason ?? "",
      };
    });

    // Normalize active signals
    const activeSignals = (snapshot.activeSignals || []).map((s: any) => ({
      ...s,
      entryType: s.entryType || "PULLBACK",
      entryMode: s.entryType || "PULLBACK",
      entryTier: "PULLBACK_ENTRY",
      positionSizePct: s.positionSizePct || 0.02,
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
