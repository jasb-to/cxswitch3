import { NextResponse, NextRequest } from "next/server";
import { getAllSignals, getMarketContext, type MarketContext } from "@/lib/strategy";
import { supabase } from "@/lib/supabase-client";

export const dynamic = "force-dynamic";
export const maxDuration = 30; // Allow up to 30 seconds for retries

export async function GET() {
  try {
    // PRIMARY: Always fetch live market data from Kraken (never skip this)
    const symbols = ["BTC", "ETH", "SOL"];
    const market = await Promise.all(
      symbols.map((s) => getMarketContext(s).catch(err => {
        console.error(`[SIGNALS API] Failed to get context for ${s}:`, err);
        // Return a neutral market state without error flag so cards still display
        return {
          symbol: `${s}/USD`,
          price: 0,
          swingHigh: null,
          swingLow: null,
          distanceToHigh: null,
          distanceToLow: null,
          setup: "NO_SETUP",
          setupText: "Data unavailable — retrying...",
          error: false,
          trendlines: 0,
          adx: undefined,
        };
      }))
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
  } catch (error) {
    console.error('[GET /api/signals ERROR]', error);
    return NextResponse.json(
      { error: 'Internal error', details: error instanceof Error ? error.message : 'Unknown', signals: [], market: [] },
      { status: 500 }
    );
  }
}

export async function DELETE() {
  try {
    if (!supabase) {
      return NextResponse.json({ error: "No DB connection" }, { status: 500 });
    }

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
    console.error("[DELETE /api/signals ERROR]", err);
    return NextResponse.json(
      { error: err instanceof Error ? err.message : "Unknown error" },
      { status: 500 }
    );
  }
}

export async function PATCH(req: NextRequest) {
  try {
    const body = await req.json();
    const { symbol, state, exitPrice, outcome } = body;

    if (!symbol || !state) {
      return NextResponse.json({ error: "Missing symbol or state" }, { status: 400 });
    }

    if (!supabase) {
      return NextResponse.json({ error: "Supabase not connected" }, { status: 500 });
    }

    // Find the active signal for this symbol
    const { data: signal, error: fetchErr } = await supabase
      .from("signals")
      .select("*")
      .eq("symbol", symbol)
      .in("state", ["EARLY", "CONFIRMED"])
      .single();

    if (fetchErr || !signal) {
      return NextResponse.json({ error: "Signal not found or already ended" }, { status: 404 });
    }

    // Update signal to END state
    const updateData: Record<string, unknown> = { state };
    if (outcome) updateData.outcome = outcome;
    if (exitPrice !== undefined) {
      const pnl = signal.direction === "LONG"
        ? exitPrice - signal.entry_price
        : signal.entry_price - exitPrice;
      updateData.pnl = pnl;
    }

    const { error: updateErr } = await supabase
      .from("signals")
      .update(updateData)
      .eq("id", signal.id);

    if (updateErr) {
      return NextResponse.json({ error: updateErr.message }, { status: 500 });
    }

    console.log(`[PATCH /api/signals] Ended ${symbol} ${signal.direction} signal`);

    return NextResponse.json({ ok: true, signal: { ...signal, ...updateData } });
  } catch (error) {
    console.error("[PATCH /api/signals ERROR]", error);
    return NextResponse.json(
      { error: "Internal error", details: error instanceof Error ? error.message : "Unknown" },
      { status: 500 }
    );
  }
}
