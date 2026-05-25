import { NextResponse } from "next/server";
import { getSignals } from "@/lib/signal-store";
import { toViewModel } from "@/lib/signal-view-model";

export const dynamic = "force-dynamic";
export const revalidate = 0;

/**
 * VIEW LAYER API
 * Returns signals with UI display fields (view-model)
 */
export async function GET() {
  try {
    const signals = getSignals();
    const viewModels = signals.map(toViewModel);
    return NextResponse.json(viewModels);
  } catch (error) {
    console.error("[API/SIGNALS] Error:", error);
    return NextResponse.json([], { status: 500 });
  }
}



