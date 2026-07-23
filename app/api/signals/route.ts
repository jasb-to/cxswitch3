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

    // Normalize markets — v42.1 uses simpler fields, enrich for UI compatibility
    const markets = (snapshot.markets || []).map((m: any) => {
      // v42.1 fields: pair, price, timestamp, trend, trendDirection, trendStrength,
      //               stoch15m, adx, ema8, ema21, signal, debug

      // Derive v41-style fields from v42.1 data for backward UI compatibility
      const trendParts = (m.trend || "NONE").split(" ");
      const direction = trendParts[0]; // LONG or SHORT
      const strength = trendParts[1] || "WEAK"; // STRONG, MEDIUM, WEAK

      const stoch = m.stoch15m || { k: 50, d: 50 };

      // Compute readiness (v41 metric) from available data
      let readiness = 0;
      if (m.trendDirection) readiness += 25;
      if (m.trendStrength === "STRONG") readiness += 20;
      else if (m.trendStrength === "MEDIUM") readiness += 10;
      if (stoch.k < 20 || stoch.k > 80) readiness += 25;
      else if (stoch.k < 50 || stoch.k > 50) readiness += 10;
      if (m.adx >= 25) readiness += 10;
      if (m.signal) readiness += 10;
      readiness = Math.min(100, readiness);

      const isPullback = stoch.k < 50 && direction === "LONG" || stoch.k > 50 && direction === "SHORT";

      return {
        // v42.1 native fields
        pair: m.pair,
        price: m.price,
        timestamp: m.timestamp,
        trend: m.trend,
        trendDirection: m.trendDirection,
        trendStrength: m.trendStrength,
        stoch15m: m.stoch15m,
        adx: m.adx,
        ema8: m.ema8,
        ema21: m.ema21,
        signal: m.signal,
        debug: m.debug,

        // v41-compatible derived fields (for UI that expects them)
        bias: m.trendDirection ? { direction: m.trendDirection, strength: m.trendStrength === "STRONG" ? 80 : m.trendStrength === "MEDIUM" ? 60 : 30 } : null,
        trend1d: m.trendDirection ? { direction: m.trendDirection, strength: m.trendStrength } : null,
        trend1h: m.trendDirection ? { direction: m.trendDirection, strength: m.trendStrength } : null,
        stoch4h: m.stoch15m, // alias — UI might reference stoch4h
        stoch1h: m.stoch15m, // alias
        stochK: stoch.k,
        stochD: stoch.d,
        rsi: stoch.k, // approximate — StochRSI K is close to RSI in extreme zones
        volumeConfirmed: false, // v42.1 doesn't track this in snapshot, UI can ignore
        trendStrengthLabel: m.trendStrength,
        isPullback,
        pullbackTier: isPullback ? (stoch.k < 20 || stoch.k > 80 ? "DEEP" : "SHALLOW") : null,
        stochZone: stoch.k < 20 ? "EXTREME" : stoch.k < 50 ? "ZONE" : stoch.k > 80 ? "EXTREME" : stoch.k > 50 ? "ZONE" : "NEUTRAL",
        readiness,
        readinessLabel: readiness >= 80 ? "READY" : readiness >= 60 ? "WARM" : readiness >= 40 ? "WATCH" : "NO_TRADE",
        regime: m.trendDirection ? { direction: m.trendDirection, strength: m.trendStrength, confidence: m.trendStrength === "STRONG" ? 75 : 50 } : null,
        emaAligned: m.ema8 && m.ema21 ? (direction === "LONG" ? m.ema8 > m.ema21 : m.ema8 < m.ema21) : false,
        recommendedAction: m.signal ? `${m.signal.direction} ${m.signal.entryType || "PULLBACK"}` : null,
        entryTier: m.signal ? "PULLBACK_ENTRY" : null,
        entryMode: m.signal ? "PULLBACK" : null,
        positionSize: m.signal ? "2%" : null,
        summary: { status: m.signal ? "READY" : "WATCH", debug: m.debug || [] },
      };
    });

    // Normalize active signals
    const activeSignals = (snapshot.activeSignals || []).map((s: any) => ({
      ...s,
      // Ensure v42.1 signals have fields UI might expect
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
 
