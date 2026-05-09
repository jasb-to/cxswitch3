import { NextResponse } from "next/server";
import { getMarketSnapshot } from "@/lib/market-data-layer";

export const dynamic = "force-dynamic";
export const maxDuration = 10;

// PURE SNAPSHOT API - returns market data + cards
export async function GET() {
  try {
    const market = getMarketSnapshot();

    // Convert snapshot to card format - CRITICAL: never set price to null
    const cards = Object.entries(market).map(([symbol, priceData]) => ({
      symbol,
      price: priceData.price,
      source: priceData.source,
      degraded: priceData.source !== "kraken_live",
      
      // Default card state (gets enriched by strategy/cron)
      direction: "NEUTRAL",
      mode: "NONE",
      confidence: 0,
      structure: "NO_STRUCTURE",
      checklist: {
        trend4H: false,
        breakout15M: false,
        trigger5M: false,
        volatility: false,
        volume: false,
      },
      triggerActive: false,
      notes: "Waiting for setup",
      updatedAt: new Date().toISOString(),
    }));

    return NextResponse.json({
      cards,
      setups: [],
      fetchedAt: Date.now(),
    });
  } catch (error) {
    console.error('[GET /api/signals ERROR]', error);
    return NextResponse.json(
      { error: 'Internal error', cards: [], setups: [] },
      { status: 500 }
    );
  }
}
