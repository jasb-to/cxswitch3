import { NextResponse } from "next/server";
import { validateSignalLifecycle, debugAllSignals } from "@/lib/signal-lifecycle-validator";
import { supabase } from "@/lib/supabase-client";

export const dynamic = "force-dynamic";

export async function GET(request: Request) {
  const { searchParams } = new URL(request.url);
  const action = searchParams.get("action") || "validate";

  try {
    if (action === "validate") {
      // Full lifecycle validation with statistics
      const result = await validateSignalLifecycle();
      return NextResponse.json(result);
    } else if (action === "debug") {
      // List all signals with their states (debug only)
      const signals = await debugAllSignals();
      return NextResponse.json({
        totalSignals: signals.length,
        signals,
      });
    } else if (action === "count") {
      // Just return signal counts by state
      if (!supabase) {
        return NextResponse.json({ error: "Supabase not connected" }, { status: 500 });
      }

      const { data, error } = await supabase
        .from("signals")
        .select("state", { count: "exact" });

      if (error) {
        return NextResponse.json({ error: error.message }, { status: 500 });
      }

      const counts = {
        earlyOpen: data?.filter(s => s.state === "EARLY_OPEN").length ?? 0,
        confirmed: data?.filter(s => s.state === "CONFIRMED").length ?? 0,
        ended: data?.filter(s => s.state === "END").length ?? 0,
        total: data?.length ?? 0,
      };

      return NextResponse.json(counts);
    } else if (action === "active") {
      // Return only active signals (EARLY_OPEN + CONFIRMED)
      const signals = await debugAllSignals();
      const active = signals.filter(s => s.state === "EARLY_OPEN" || s.state === "CONFIRMED");
      return NextResponse.json({
        activeCount: active.length,
        active,
      });
    } else {
      return NextResponse.json(
        { error: "Unknown action. Valid actions: validate, debug, count, active" },
        { status: 400 }
      );
    }
  } catch (err) {
    console.error("[/api/signal-lifecycle ERROR]", err);
    return NextResponse.json(
      { error: err instanceof Error ? err.message : "Unknown error" },
      { status: 500 }
    );
  }
}
