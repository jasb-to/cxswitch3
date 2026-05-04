import { NextResponse } from "next/server";
import { getAllSignals, getMarketContext, type MarketContext } from "@/lib/strategy";

export const dynamic = "force-dynamic";

export async function GET() {
  // PRIMARY: Always fetch live market data from Kraken (never skip this)
  const symbols = ["BTC", "ETH", "SOL"];
  const market = await Promise.all(
    symbols.map((s) => getMarketContext(s))
  );

  // SECONDARY: Try Supabase for persisted signals (optional, won't crash if missing)
  let signals = [];
  try {
    signals = await getAllSignals();
  } catch (err) {
    console.error("[SUPABASE SIGNALS] Fetch failed, returning empty signals:", err);
  }

  return NextResponse.json({
    signals,
    market,
    fetchedAt: Date.now(),
  });
}
