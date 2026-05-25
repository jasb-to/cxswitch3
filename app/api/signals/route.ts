import { NextResponse } from "next/server";
import { getSignals } from "@/lib/signal-store";

export const dynamic = "force-dynamic";
export const revalidate = 0;

/**
 * READ-ONLY API - Returns signals from memory
 */
export async function GET() {
  try {
    const signals = getSignals();

    console.log("[API/SIGNALS RAW]", JSON.stringify({
      symbolsCount: signals.length,
      symbols: signals.map(s => ({ symbol: s.symbol, state: s.state, price: s.price }))
    }, null, 2));

    // Organize signals by state
    const activeTrades = signals.filter((s) => s.state === "SNIPER");
    const activeSymbols = signals.filter((s) => s.state !== "DO_NOT_TRADE");

    const response = {
      symbols: Array.isArray(signals) ? signals : [],
      activeTrades,
      activeSymbols,
      lastUpdated: new Date().toISOString(),
    };

    console.log("[API/SIGNALS RESPONSE]", JSON.stringify(response, null, 2));

    return NextResponse.json(response);
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


