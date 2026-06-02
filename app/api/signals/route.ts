import { NextResponse } from "next/server";
import { getSignals } from "@/lib/state";

export const runtime = "nodejs";

export async function GET() {
  const signals = getSignals();

  return NextResponse.json({
    signals,
    updatedAt: new Date().toISOString(),
  });
}
