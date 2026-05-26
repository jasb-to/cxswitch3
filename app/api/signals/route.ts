import { NextResponse } from "next/server";
import { readSignals } from "@/lib/persistent-store";
import { toViewModel } from "@/lib/signal-view-model";

export const dynamic = "force-dynamic";
export const revalidate = 0;

/**
 * VIEW LAYER API
 * Returns persisted signals with UI display fields (view-model)
 * Uses persistent store so symbols NEVER disappear between serverless invocations
 */
export async function GET() {
  try {
    const signals = await readSignals();
    const viewModels = signals.map(toViewModel);
    return NextResponse.json(viewModels);
  } catch (error) {
    console.error("[API/SIGNALS] Error:", error);
    return NextResponse.json([], { status: 500 });
  }
}



