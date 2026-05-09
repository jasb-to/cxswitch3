import { NextResponse } from "next/server";
import { getMarketSnapshot } from "@/lib/market-data-layer";

export const dynamic = "force-dynamic";
export const maxDuration = 10;

// PURE SNAPSHOT API - only returns market data
export async function GET() {
  try {
    const market = getMarketSnapshot();

    // Convert snapshot to array format with health status
    const marketData = Object.entries(market).map(([symbol, priceData]) => ({
      symbol,
      price: priceData.price,
      source: priceData.source,
      degraded: priceData.source === "DEGRADED",
    }));

    return NextResponse.json({
      market: marketData,
      setups: [],
      fetchedAt: Date.now(),
    });
  } catch (error) {
    console.error('[GET /api/signals ERROR]', error);
    return NextResponse.json(
      { error: 'Internal error', market: [], setups: [] },
      { status: 500 }
    );
  }
}
