import { NextResponse } from "next/server";
import { getSnapshot } from "@/lib/runtime-snapshot";

export const dynamic = "force-dynamic";
export const revalidate = 0;

/**
 * PURE SNAPSHOT API - v8.6 CRITICAL FIX
 * 
 * Returns EXACTLY what cron produced. No recomputation.
 * No rebuilding TradeViewModels. No fallback logic.
 * 
 * If cron wrote it, we serve it. Nothing else.
 * This is the ONLY source of truth for the UI.
 */
export async function GET() {
  try {
    const snapshot = getSnapshot();
    
    // CRITICAL: Zero transformation. Serve cron output as-is.
    // If UI needs different shape, that's a UI layer concern.
    // API is a pure read-through of what cron produced.
    
    console.log("[SIGNALS_API] Serving snapshot", {
      ready: snapshot.ready,
      cardCount: snapshot.cards.length,
      firstCard: snapshot.cards.length > 0 ? {
        symbol: snapshot.cards[0].symbol,
        activationState: (snapshot.cards[0] as any).activationState,
      } : null,
    });
    
    return NextResponse.json(snapshot);
  } catch (error) {
    console.error('[GET /api/signals ERROR]', error);
    return NextResponse.json(
      { error: 'Internal error', cards: [], setups: [] },
      { status: 500 }
    );
  }
}
