import { NextResponse } from "next/server";
import { getSignals } from "@/lib/db";

export const dynamic = "force-dynamic";
export const revalidate = 0;

/**
 * Fixed API contract with exact field names
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


