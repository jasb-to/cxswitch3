import { NextResponse } from "next/server";
import { getSignals } from "@/lib/signal-store";

export const dynamic = "force-dynamic";

export async function GET() {
  return NextResponse.json(getSignals());
}
