import { NextResponse } from "next/server";
import { SYMBOLS, createSignal } from "@/lib/strategy-core";

export const dynamic = "force-dynamic";
export const revalidate = 0;

/**
 * LIVE STRATEGY API - Early Entry Mode v2
 * Computes signals live, applies hold rules
 * Returns clean signal data with state and entry information
 */
export async function GET() {
  try {
    console.log("[API/SIGNALS] Computing live strategy for all symbols");
    
    const signals = await Promise.all(
      SYMBOLS.map(symbol => createSignal(symbol))
    );

    console.log(`[API/SIGNALS] Computed ${signals.length} live signals`);
    signals.forEach(s => {
      console.log(`[API/SIGNALS] ${s.symbol}: state=${s.state}, confidence=${s.confidence}%, hold_remaining=${s.hold_remaining_ms}ms`);
    });

    return NextResponse.json(signals);
  } catch (error) {
    console.error("[API/SIGNALS] Error:", error);
    return NextResponse.json({ error: "Failed to compute signals" }, { status: 500 });
  }
}




