import { NextResponse } from "next/server";
import { getSignals } from "@/lib/state";

export const runtime = "nodejs";

export async function GET() {
  return NextResponse.json({
    signals: getSignals(),
    updatedAt: new Date().toISOString(),
  });
}
