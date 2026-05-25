import { NextResponse } from "next/server";
import { getSignals } from "@/lib/db";

export const dynamic = "force-dynamic";
export const revalidate = 0;

/**
 * READ-ONLY API - Returns signals from Supabase
 * NO transformation, NO computation, NO interpretation
 * Pure passthrough of what cron stored
 */
export async function GET() {
  try {
    const signals = await getSignals();

    console.log("[API/SIGNALS] Fetched", signals.length, "signals");

    // Organize signals by state
    const activeTrades = signals.filter((s) => s.state === "SNIPER");
    const activeSymbols = signals.filter((s) => s.state !== "DO_NOT_TRADE");

    return NextResponse.json({
      symbols: signals,
      activeTrades,
      activeSymbols,
      lastUpdated: new Date().toISOString(),
    });
  } catch (error) {
    console.error("[API/SIGNALS] Error:", error);
    return NextResponse.json(
      {
        symbols: [],
        activeTrades: [],
        activeSymbols: [],
        lastUpdated: new Date().toISOString(),
      },
      { status: 500 }
    );
  }
}

