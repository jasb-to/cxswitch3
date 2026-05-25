import { NextResponse } from "next/server";
import { sendTestMessage } from "@/lib/telegram-listener";

export const dynamic = "force-dynamic";

export async function POST() {
  try {
    const result = await sendTestMessage();
    return NextResponse.json(result, { status: result.ok ? 200 : 400 });
  } catch (error) {
    console.error('[POST /api/test-telegram ERROR]', error);
    return NextResponse.json(
      { ok: false, error: error instanceof Error ? error.message : 'Unknown error' },
      { status: 500 }
    );
  }
}

