import { NextResponse } from "next/server";
import { getAllSignals } from "@/lib/strategy";

export const dynamic = "force-dynamic";

export async function GET() {
  try {
    const signals = await getAllSignals();
    return NextResponse.json({
      signals,
      fetchedAt: Date.now(),
    });
  } catch (error) {
    console.error("[API ERROR]", error);
    return NextResponse.json({ error: "Failed to fetch signals", signals: [] }, { status: 500 });
  }
}
