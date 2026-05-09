import { NextResponse, NextRequest } from "next/server";
import { getAllActiveSignals } from "@/lib/state-layer";
import { getAllMarketData } from "@/lib/market-data-layer";
import { supabase } from "@/lib/supabase-client";

export const dynamic = "force-dynamic";
export const maxDuration = 30;

export async function GET() {
  try {
    // PURE READ: Get all non-END signals from database
    // NEVER filter, hide, or interpret
    const signals = await getAllActiveSignals();

    // Get latest market snapshot (may have stale data, that's OK)
    const priceData = getAllMarketData();

    return NextResponse.json({
      signals,
      priceData,
      fetchedAt: Date.now(),
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
