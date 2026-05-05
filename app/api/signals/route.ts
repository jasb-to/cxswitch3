import { NextResponse } from "next/server";
import { getAllSignals, getMarketContext, type MarketContext } from "@/lib/strategy";
import { supabase } from "@/lib/supabase-client";

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

export async function DELETE() {
  if (!supabase) {
    return NextResponse.json({ error: "No DB connection" }, { status: 500 });
  }

  try {
    const { error } = await supabase
      .from("signals")
      .delete()
      .neq("id", 0);

    if (error) {
      console.error("[DELETE SIGNALS] Error:", error);
      return NextResponse.json({ error: error.message }, { status: 500 });
    }

    return NextResponse.json({ cleared: true });
  } catch (err) {
    console.error("[DELETE SIGNALS] Exception:", err);
    return NextResponse.json(
      { error: err instanceof Error ? err.message : "Unknown error" },
      { status: 500 }
    );
  }
}
