import { NextResponse } from "next/server";
import { sendTestMessage } from "@/lib/telegram";

export const dynamic = "force-dynamic";

export async function POST() {
  const result = await sendTestMessage();
  return NextResponse.json(result, { status: result.ok ? 200 : 400 });
}
