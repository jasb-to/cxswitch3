import { NextResponse } from "next/server";
import { getSnapshot } from "@/lib/runtime-snapshot";

export const dynamic = "force-dynamic";
export const revalidate = 0;

/**
 * PURE SNAPSHOT API
 * 
 * Returns the live scanner snapshot directly.
 * NO card generation.
 * NO placeholders.
 * NO fallbacks.
 * 
 * Single source of truth.
 */
export async function GET() {
  try {
    const snapshot = getSnapshot();
    
    // DEBUG LOGGING: STEP 5 - Verify snapshot payload before serialization
    if (snapshot.cards.length > 0) {
      console.log("[SIGNALS_API_DEBUG]", {
        cardCount: snapshot.cards.length,
        firstCard: {
          symbol: snapshot.cards[0].symbol,
          activationState: snapshot.cards[0].activationState,
          signalState: (snapshot.cards[0] as any).signalState,
        },
      });
    }
    
    return NextResponse.json(snapshot);
  } catch (error) {
    console.error('[GET /api/signals ERROR]', error);
    return NextResponse.json(
      { error: 'Internal error', cards: [], setups: [] },
      { status: 500 }
    );
  }
}
