import { NextResponse } from "next/server";
import { getAllSignals, getMarketContext, type MarketContext } from "@/lib/strategy";

export const dynamic = "force-dynamic";

export async function GET() {
  try {
    const signals = await getAllSignals();
    const marketContexts = await Promise.all([
      getMarketContext("BTC"),
      getMarketContext("ETH"),
      getMarketContext("SOL"),
    ]);

    return NextResponse.json({
      signals,
      markets: marketContexts.filter(Boolean),
      fetchedAt: Date.now(),
    });
  } catch (error) {
    console.error("[API ERROR]", error);
    return NextResponse.json(
      { error: "Failed to fetch signals", signals: [], markets: [] },
      { status: 500 }
    );
  }
}
