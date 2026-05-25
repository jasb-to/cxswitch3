import { NextResponse } from "next/server";
import { getSignals } from "@/lib/signal-store";

export const dynamic = "force-dynamic";
export const revalidate = 0;

/**
 * CRITICAL API - Must ALWAYS return BTC, ETH, SOL (never empty array)
 */
export async function GET() {
  try {
    // Always returns 3 signals (with fallback if store is empty)
    const signals = getSignals();

    console.log("[API/SIGNALS] Returning", signals.length, "signals:", signals.map(s => `${s.symbol}:${s.state}`));

    // Organize signals by state
    const activeTrades = signals.filter((s) => s.state === "SNIPER");
    const activeSymbols = signals.filter((s) => s.state !== "DO_NOT_TRADE");

    const response = {
      symbols: signals,
      activeTrades,
      activeSymbols,
      lastUpdated: new Date().toISOString(),
    };

    return NextResponse.json(response);
  } catch (error) {
    console.error("[API/SIGNALS] Error:", error);
    // Even on error, return fallback structure
    return NextResponse.json(
      {
        symbols: [
          { symbol: "BTC", price: 0, state: "DO_NOT_TRADE", updated_at: new Date().toISOString() },
          { symbol: "ETH", price: 0, state: "DO_NOT_TRADE", updated_at: new Date().toISOString() },
          { symbol: "SOL", price: 0, state: "DO_NOT_TRADE", updated_at: new Date().toISOString() },
        ],
        activeTrades: [],
        activeSymbols: [],
        lastUpdated: new Date().toISOString(),
      },
      { status: 200 }
    );
  }
}



