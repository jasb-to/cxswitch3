import { NextResponse } from "next/server";
import { getSignals } from "@/lib/signal-store";

export const dynamic = "force-dynamic";
export const revalidate = 0;

/**
 * PURE PASS-THROUGH API
 * Returns exactly what store has, nothing more/less
 */
export async function GET() {
  try {
    const signals = getSignals();
    return NextResponse.json(signals);
  } catch (error) {
    console.error("[API/SIGNALS] Error:", error);
    return NextResponse.json([], { status: 500 });
  }
}



