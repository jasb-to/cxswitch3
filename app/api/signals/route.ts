import { NextResponse, NextRequest } from "next/server";
import { supabase } from "@/lib/supabase-client";
import { getAllMarketData, isMarketDataFresh } from "@/lib/market-data-layer";

export const dynamic = "force-dynamic";
export const maxDuration = 30;

export async function GET() {
  try {
    const symbols = ["BTC", "ETH", "SOL"];
    const allPriceData = getAllMarketData();
    
    const freshnessStatus = symbols.map(s => ({
      symbol: s,
      fresh: isMarketDataFresh(s),
      hasData: allPriceData.length > 0,
    }));
    
    const allFresh = freshnessStatus.every(s => s.fresh && s.hasData);

    // PURE DB READ: Return all non-INVALIDATED signals
    // NO filtering by freshness, market health, or validation state
    // Reconciliation happens in cron, not in the API response
    let signals = [];
    if (supabase) {
      try {
        const { data, error } = await supabase
          .from("signals")
          .select("*")
          .neq("state", "INVALIDATED")
          .order("created_at", { ascending: false });

        if (!error && data) {
          signals = data;
          
          // DEBUG: Log sample signals to see actual symbol format
          if (signals.length > 0) {
            console.log(`[API /signals] Sample signals:`, signals.slice(0, 3).map(s => ({ 
              id: s.id, 
              symbol: s.symbol, 
              state: s.state,
              direction: s.direction 
            })));
          }
          console.log(`[API /signals] Returned ${signals.length} non-invalidated signals`);
        } else {
          console.error("[API /signals] Query error:", error);
        }
      } catch (err) {
        console.error("[API /signals] Fetch failed:", err);
      }
    }

    return NextResponse.json({
      signals,
      priceData: allPriceData,
      fetchedAt: Date.now(),
      cacheStatus: { allFresh, freshness: freshnessStatus },
    });
  } catch (error) {
    console.error('[GET /api/signals ERROR]', error);
    return NextResponse.json(
      { error: 'Internal error', signals: [], priceData: [] },
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

    const { data: signal, error: fetchErr } = await supabase
      .from("signals")
      .select("*")
      .eq("symbol", symbol)
      .in("state", ["EARLY_OPEN", "CONFIRMED"])
      .single();

    if (fetchErr || !signal) {
      return NextResponse.json({ error: "Signal not found or already ended" }, { status: 404 });
    }

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
