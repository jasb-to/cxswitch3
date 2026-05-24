import { NextResponse } from "next/server";
import { getSnapshot } from "@/lib/runtime-snapshot";
import { buildTradeViewModel, validateTradeViewModel } from "@/lib/trade-viewmodel";

export const dynamic = "force-dynamic";
export const revalidate = 0;

/**
 * PURE SNAPSHOT API
 * 
 * Returns the live scanner snapshot with TradeViewModels.
 * TradeViewModels ensure UI and alerts use the same consistent data.
 * 
 * CRITICAL: All cards are full TradeViewModels, even DO_NOT_TRADE.
 * NO stripping of fields based on state.
 */
export async function GET() {
  try {
    const snapshot = getSnapshot();
    
    // v8.4 FIX: Ensure all cards are complete TradeViewModels
    // Validate that snapshot contains full context for all states
    const validatedCards = snapshot.cards.map(card => {
      // If card is already a TradeViewModel (from cron), validate it
      if ("rejectionReason" in card && "entryPrice" in card) {
        validateTradeViewModel(card as any);
        return card;
      }
      // Otherwise build from raw card
      const viewModel = buildTradeViewModel(card as any);
      validateTradeViewModel(viewModel);
      return viewModel;
    });
    
    // DEBUG LOGGING: Verify all cards have full context
    if (validatedCards.length > 0) {
      console.log("[SIGNALS_API_DEBUG]", {
        cardCount: validatedCards.length,
        firstCard: {
          symbol: validatedCards[0].symbol,
          activationState: validatedCards[0].activationState,
          structureState: validatedCards[0].structureState,
          rejectionReason: validatedCards[0].rejectionReason,
        },
      });
    }
    
    return NextResponse.json({
      ...snapshot,
      cards: validatedCards,
    });
  } catch (error) {
    console.error('[GET /api/signals ERROR]', error);
    return NextResponse.json(
      { error: 'Internal error', cards: [], setups: [] },
      { status: 500 }
    );
  }
}
