import { NextResponse } from "next/server";
import { supabase } from "@/lib/supabase-client";
import type { Signal } from "@/lib/strategy";

export const dynamic = "force-dynamic";

export async function POST() {
  try {
    const testSignal: Signal = {
      symbol: "BTC/USD",
      direction: "LONG",
      state: "EARLY_OPEN",
      entry_price: 85000,
      stop_loss: 84000,
      take_profit: 88000,
      confidence: 72,
      breakout_level: 84500,
    };

    const { error } = await supabase.from("signals").insert(testSignal);

    if (error) {
      console.error("[TEST-SIGNAL ERROR]", error);
      return NextResponse.json({ error: error.message }, { status: 500 });
    }

    return NextResponse.json({ success: true, signal: testSignal });
  } catch (err) {
    console.error("[TEST-SIGNAL CATCH]", err);
    return NextResponse.json(
      { error: err instanceof Error ? err.message : "Unknown error" },
      { status: 500 }
    );
  }
}
