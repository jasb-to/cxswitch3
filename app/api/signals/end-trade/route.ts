import { supabase } from "@/lib/supabase-client";
import type { Signal } from "@/lib/strategy";

export async function POST(req: Request) {
  try {
    const { signalId, exitPrice } = await req.json();

    if (!signalId || !exitPrice || exitPrice <= 0) {
      return Response.json(
        { error: "Missing or invalid signalId or exitPrice" },
        { status: 400 }
      );
    }

    if (!supabase) {
      return Response.json({ error: "Database not connected" }, { status: 500 });
    }

    // Get the signal
    const { data: signal, error: fetchErr } = (await supabase
      .from("signals")
      .select("*")
      .eq("id", signalId)
      .single()) as { data: Signal; error: any };

    if (fetchErr || !signal) {
      return Response.json(
        { error: "Signal not found" },
        { status: 404 }
      );
    }

    // Calculate PNL based on direction and exit price
    const pnl =
      signal.direction === "LONG"
        ? exitPrice - signal.entry_price
        : signal.entry_price - exitPrice;

    // Update signal to END with manual outcome
    const { error: updateErr } = await supabase
      .from("signals")
      .update({
        state: "END",
        outcome: "MANUAL",
        pnl,
        updated_at: new Date().toISOString(),
      })
      .eq("id", signalId);

    if (updateErr) {
      console.error("[end-trade] Update error:", updateErr.message);
      return Response.json(
        { error: "Failed to update signal" },
        { status: 500 }
      );
    }

    return Response.json({
      ok: true,
      signal: { ...signal, state: "END", outcome: "MANUAL", pnl },
    });
  } catch (err) {
    console.error("[end-trade] Error:", err);
    return Response.json(
      { error: err instanceof Error ? err.message : "Unknown error" },
      { status: 500 }
    );
  }
}
