import { NextResponse } from "next/server";
import { getAllSignals } from "@/lib/strategy";

export const dynamic = "force-dynamic";

export async function GET() {
  return NextResponse.json({
    signals: getAllSignals(),
    fetchedAt: Date.now(),
  });
}
